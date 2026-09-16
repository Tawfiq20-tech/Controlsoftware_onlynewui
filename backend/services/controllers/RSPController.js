/**
 * RSPController - AXIO controller for the custom RSP (Reliable Stream
 * Protocol) firmware from fw_m3_control_sw (0x7E-framed, CRC32-checked,
 * ARQ-reliable binary protocol over USB-CDC).
 *
 * Wraps rsp/stream.js (ReliableStream) + rsp/job.js (JobStream) behind the
 * same controller interface CNCEngine.js expects of every controller
 * (GenericController.js is the structural template; RTSController.js is
 * the reference for the crash-guard pattern below -- see comments).
 *
 * CRASH-SAFETY CONTRACT (read before touching this file):
 * CNCEngine.js calls several controller members WITHOUT any try/catch or
 * existence guard at some call sites (grepped directly from CNCEngine.js):
 *   - controller.state.status / controller.state.parserstate  (unguarded
 *     property access inside the 'status'/'parserstate' event relays)
 *   - controller.debugMonitor.getEntries(count, type)          (socket
 *     'debug:getEntries' handler, no try/catch)
 *   - controller.healthMonitor.recordPong()                    (socket
 *     'hPing' handler, no try/catch)
 *   - controller.getEventTriggers()                            (socket
 *     'trigger:list' handler, no try/catch)
 *   - controller.write(data, context) / controller.writeln(...)  (called
 *     with only `if (!this.controller) return;` -- no try/catch)
 * Every one of those MUST exist and MUST NOT throw, even before bind()
 * has run or after unbind() has cleared state, or an uncaught exception
 * inside a bare socket.on() handler kills the whole Node process. This is
 * exactly the crash-bug class a prior port of this controller found and
 * fixed -- do not reintroduce it by lazily returning undefined/null for
 * any of the five items above.
 */
'use strict';

const { EventEmitter } = require('events');
const logger = require('../../logger');
const defs = require('../rsp/defs');
const codec = require('../rsp/codec');
const { ReliableStream, LinkLost, RspTimeoutError } = require('../rsp/stream');
const { JobStream } = require('../rsp/job');
const linearizeArcs = require('../../lib/linearizeArcs');
const injectSpindleDelay = require('../../lib/injectSpindleDelay');
const { cleanGcodeLines, buildResumeProgram, scanModalState } = require('../../lib/resumeFromLine');
const { compileWire } = require('../../lib/wireCompiler');

// Power-cut survival: durable checkpoint persistence is now handled
// entirely by JobResumeService (services/jobresume/), which owns the
// single job_resume.json file with CRC32 protection and atomic writes.
// RSPController no longer writes rsp_resume_state.json directly.
// The volatile _resumeLine/_resumeGcode bookkeeping below is still
// kept for fast in-session pause/resume (same process, no restart).

// --------------------------------------------------------------------------
// Axis encoding assumption (NOT explicitly defined anywhere in the ported
// Python reference -- defs.py/codec.py treat `axis` as an opaque u8).
// Standard 0=X/1=Y/2=Z convention assumed here, matching the ordering used
// throughout fw_m3_control_sw's own X/Y/Z field ordering (Telemetry.x/y/z,
// build_move's x,y,z,feed argument order). UNVERIFIED against the actual
// firmware C source (fw_m3/Src/*.c) -- flagged in BUILD_REPORT.md as a gap
// to confirm against real hardware/firmware source before shipping to a
// real board.
// --------------------------------------------------------------------------
const AXIS_X = 0;
const AXIS_Y = 1;
const AXIS_Z = 2;
const AXIS_BIT_X = 0x01;
const AXIS_BIT_Y = 0x02;
const AXIS_BIT_Z = 0x04;
const AXIS_MASK_ALL = AXIS_BIT_X | AXIS_BIT_Y | AXIS_BIT_Z;

const FEED_OVERRIDE_MIN = 10.0;
const FEED_OVERRIDE_MAX = 200.0;
const FEED_OVERRIDE_COARSE = 10.0;
const FEED_OVERRIDE_FINE = 1.0;

// FIX-7: on a failed ad-hoc probe (no contact within maxTravelMm, rejected
// status, or a timed-out/lost reply), the tool is left wherever it stopped --
// at/near the workpiece with no automatic retreat. This dispatch path (the
// single quick-probe UI action, not the multi-step corner routine in
// ProbingService.js) has no configStore wired in, so use a small, always-safe
// hardcoded Z retreat rather than plumbing config through for one constant.
const PROBE_FAIL_RETRACT_MM = 5.0;
const PROBE_FAIL_RETRACT_FEED = 500;

// Commands refused while a job is running (see _dispatch()).
const MOTION_COMMANDS = new Set([
    'jog', 'homing', 'home', 'homing:x', 'home:x', 'homing:y', 'home:y', 'homing:z', 'home:z',
    'zero', 'wcs:zero', 'zero:x', 'zero:y', 'zero:z', 'wcs:zeroAll', 'zero:all',
    'probe', 'macro:run', 'reset:hard',
]);

/**
 * Transport adapter bridging AXIO's Connection (rawData events / writeRaw)
 * to the ReliableStream transport contract:
 *   send(buffer), on('data', cb), on('error', cb), close(), reconnect()?
 */
class ConnectionTransport extends EventEmitter {
    constructor(connection) {
        super();
        this._connection = connection;
        this._onRawData = (buf) => this.emit('data', buf);
        this._onError = (err) => this.emit('error', err);
        this._connection.on('rawData', this._onRawData);
        this._connection.on('error', this._onError);
    }

    send(buffer) {
        // connection.writeRaw() already no-ops safely if the underlying
        // port isn't open -- but a closed/torn-down connection during an
        // in-flight retransmit tick must not throw synchronously out of
        // stream.js's tick handler either way, so double-guard here.
        if (!this._connection || !this._connection.isOpen) {
            throw new Error('connection not open');
        }
        this._connection.writeRaw(buffer);
    }

    close() {
        if (this._connection) {
            this._connection.removeListener('rawData', this._onRawData);
            this._connection.removeListener('error', this._onError);
        }
        this._connection = null;
    }

    // no reconnect() -- Connection.js owns reconnect/open lifecycle;
    // ReliableStream's reconnect-attempt path is guarded with typeof and
    // simply skipped when absent.
}

class RSPController extends EventEmitter {
    /**
     * @param {string} [type='RSP']
     */
    constructor(type = 'RSP') {
        super();
        this.type = type;

        /** @type {import('../Connection').Connection|null} */
        this.connection = null;
        this.bound = false;

        /** @type {ConnectionTransport|null} */
        this._transport = null;
        /** @type {ReliableStream|null} */
        this.stream = null;
        /** @type {JobStream|null} */
        this.job = null;
        // Line number of the most recently executed job line -- mirrors what
        // GRBLController's Sender.js calls `received`. Used by getSenderStatus()
        // for the initial-sync sender:status emit.
        this._currentLine = 0;
        this._lastAlarmEmitted = null;

        // Always a real object -- CNCEngine.js reads controller.state.status
        // / controller.state.parserstate unguarded from its 'status' and
        // 'parserstate' event relays (see file header). Never let this be
        // null/undefined, even pre-bind.
        this.state = {
            status: { activeState: 'Unknown', mpos: { x: 0, y: 0, z: 0 }, feedrate: 0, spindle: 0 },
            parserstate: { modal: {}, feedrate: 0, spindle: 0 },
        };

        // Stub subsystems CNCEngine.js calls unconditionally from bare
        // socket handlers (no try/catch, no typeof guard) -- see file
        // header. RSP has no real debug-entry ring buffer or ping/pong
        // health monitor of its own, so these are minimal-but-real,
        // never-throwing implementations rather than omissions.
        this._debugLog = [];
        this.debugMonitor = {
            getEntries: (count, type) => {
                let entries = this._debugLog;
                if (type) entries = entries.filter((e) => e.type === type);
                if (typeof count === 'number' && count > 0) entries = entries.slice(-count);
                return entries;
            },
        };
        this._lastPongAt = 0;
        this.healthMonitor = {
            recordPong: () => { this._lastPongAt = Date.now(); },
        };

        this._eventTriggers = {};

        // job load/run bookkeeping
        this._loadedGcode = '';
        this._loadedLines = [];     // compiled wire lines (lib/wireCompiler.js), cached once per load
        this._loadedMeta = null;    // compile report: pauses, tools, extents, warnings
        this.lastLoadResult = null; // { ok, name, meta } -- read by CNCEngine to broadcast or refuse
        this._loadedName = '';
        // Resume-after-stop bookkeeping (Tawfiq msg11237: "if started job and
        // stopped it should continue from where it stopped"). _resumeLine is
        // the first not-yet-executed line at the moment gcode:stop was
        // pressed; _resumeGcode is the exact gcode text that was running, so
        // a later gcode:start only resumes if it's the SAME file still
        // loaded -- loading a different file (or the same file finishing
        // cleanly) clears it, so a genuinely new run always starts at line 1.
        this._resumeLine = 0;
        this._resumeGcode = null;
        this._resumeReason = '';
        this._resumeAt = 0;
        // Start-from-line runs a rebuilt program (safe-Z preamble + the file
        // from line N, see lib/resumeFromLine.js). Job line L of that program
        // is file line L + _lineOffset; preamble lines map to _lineOffsetMin
        // (line N itself) so a stop during the preamble resumes at line N.
        this._lineOffset = 0;
        this._lineOffsetMin = 0;
        // Last EV_FAULT from firmware -- the telemetry alarm state arrives
        // ~0.5 s later, this is what says WHICH driver tripped.
        this._lastFault = null;
        this._almGlitchLastConsole = {};
        // Set when an interrupted move left the controller's x/y/z wrong
        // (firmware without the POS_EXACT capability drops the steps of an
        // aborted move). Blocks resume until the operator re-zeroes/homes.
        this._positionUncertain = null;
        this._positionUncertainSig = '';
        this._feedOverridePct = 100.0;
        this._debugEnabled = false;
        // Bumped at the top of every _startJob() call. _startJob() awaits
        // twice (post-abort settle delay, up-to-3s idle-wait) before it
        // ever touches this.job -- a second gcode:start firing during
        // either await (e.g. Stop -> load a different file -> Start again
        // while the machine is still decelerating from the first request)
        // must not let the FIRST, now-stale call resume past its await and
        // silently upload/start whatever G-code is current at THAT point,
        // superseding the second call's job with the first call's. Each
        // call captures its own generation and re-checks it after every
        // await; a stale call bails instead of proceeding.
        this._startJobGeneration = 0;
        // Orphan-job guard (plan BE-4): when the host job ended, and when an
        // orphan abort was last sent -- see _abortOrphanJob().
        this._jobEndedAt = 0;
        this._lastOrphanAbortAt = 0;

        this._bindJobListeners = this._bindJobListeners.bind(this);
    }

    // ------------------------------------------------------------------
    // lifecycle
    // ------------------------------------------------------------------
    /**
     * @param {import('../Connection').Connection} connection
     */
    bind(connection) {
        if (this.bound) {
            logger.warn('[RSP] Controller already bound, unbinding first');
            this.unbind();
        }
        if (!connection) {
            logger.error('[RSP] bind() called with no connection');
            return;
        }

        this.connection = connection;
        this.bound = true;

        this._transport = new ConnectionTransport(connection);
        this.stream = new ReliableStream(this._transport, {
            // NOTE: winston's default console format (winston.format.simple())
            // does not render extra positional args as "splat" text -- calling
            // logger.info('[RSP]', msg) silently drops `msg` from the printed
            // line (found while diagnosing the lossy-link stress test: log
            // lines showed as bare "[RSP] {json meta}" with the actual
            // message missing). Fold everything into one template string.
            logger: {
                debug: () => {},
                info: (...a) => logger.info(`[RSP] ${a.join(' ')}`),
                warn: (...a) => logger.warn(`[RSP] ${a.join(' ')}`),
                error: (...a) => logger.error(`[RSP] ${a.join(' ')}`),
            },
        });
        this.stream.on('status', (dict) => this._onTelemetry(dict));
        this.stream.on('link', (ok) => this._onLinkChange(ok));
        this.stream.on('event', (f) => this._onStreamEvent(f));
        // job-63998 stall investigation (2026-09-04): stream.js now surfaces
        // retry-exhaustion/NAK-rejection diagnostics via 'console' so they
        // land in the ndjson session log -- without this bridge they'd only
        // ever reach the Node logger, invisible in what Tawfiq sends us.
        this.stream.on('console', (msg) => this.emit('console', msg));

        this.job = new JobStream(this.stream, {
            logger: {
                debug: () => {},
                info: (...a) => logger.info(`[RSP job] ${a.join(' ')}`),
                warn: (...a) => logger.warn(`[RSP job] ${a.join(' ')}`),
                error: (...a) => logger.error(`[RSP job] ${a.join(' ')}`),
            },
        });
        this._bindJobListeners();

        this.stream.start();

        logger.info('[RSP] Controller bound and stream started');
        this.emit('initialized', { firmwareType: this.type, firmwareVersion: 'RSP/fw_m3' });
        this.connection.emitToSockets('controller:type', this.type);
        this.connection.emitToSockets('controller:initialized', {
            firmwareType: this.type,
            firmwareVersion: 'RSP (Reliable Stream Protocol)',
        });

        // A previous session's job may still be running on the board: hold it
        // at the next line now; the first telemetry frame then aborts it by
        // its real job id (_abortOrphanJob -- OP_JOB_ABORT(0) never matched).
        this._sendFeedHold();
        this._requestStatus();
        this._requestConfig();
    }

    // ------------------------------------------------------------------
    // Modal state — used by JobResumeService to capture the current
    // machine state for checkpoints (WCS, units, distance mode, feed,
    // spindle, coolant, tool).
    // ------------------------------------------------------------------
    /**
     * Returns the current modal state of the machine, extracted from
     * telemetry and parser state. Used by the checkpoint system.
     *
     * @returns {object} Modal state object matching JobResumeStore schema.
     */
    getModalState() {
        const st = this.state?.status || {};
        const ps = this.state?.parserstate || {};
        const modal = ps.modal || {};

        return {
            wcs:             modal.wcs || 'G54',
            units:           modal.units || 'G21',
            distanceMode:    modal.distance || 'G90',
            feedMode:        modal.feedmode || 'G94',
            spindleState:    modal.spindle || (st.spindle > 0 ? 'M3' : 'M5'),
            spindleRpm:      st.spindle || ps.spindle || 0,
            coolantState:    modal.coolant || 'M9',
            feedRate:        st.feedrate || ps.feedrate || 0,
            toolNumber:      modal.tool || 0,
            feedOverridePct: this._feedOverridePct,
        };
    }

    _bindJobListeners() {
        if (!this.job) return;
        this.job.on('progress', ({ executed, total, lineNo, pos }) => {
            // Emit under the same field names GRBLController/Sender.js uses
            // (received/total/progress) instead of RSP-only names -- the
            // frontend's sender:status listener (backendConnection.ts) reads
            // status.received to drive the current-line highlight and
            // status.progress for the job progress bar, shared across both
            // controller types. Previously this emitted {executed,total,
            // remaining}, which don't exist on SenderStatus, so the
            // highlight/progress bar silently never updated on RSP boards.
            const fileLine = this._fileLine(lineNo);
            this._currentLine = fileLine;
            // A resume streams a REBUILT program (preamble + the rest of the
            // file), so counting its own lines restarted the bar at 0% and
            // called a job that is 80% cut "just started". Count file lines.
            const fileTotal = this._lineOffsetMin ? this._loadedLines.length : total;
            const fileDone = this._lineOffsetMin ? fileLine : executed;
            this.emit('sender:status', {
                total: fileTotal,
                sent: fileDone,
                received: fileLine,
                progress: fileTotal > 0 ? Math.round((fileDone / fileTotal) * 100) : 0,
                remaining: Math.max(0, fileTotal - fileDone),
                lineNo: fileLine,
                pos: pos || this.state?.status?.mpos || { x: 0, y: 0, z: 0 },
            });
        });
        // 'done' is a clean finish only; every failure arrives as 'failed'.
        this.job.on('done', ({ jobId }) => {
            this._jobEndedAt = Date.now();
            // Clean finish -- clear any resume point so a later START on
            // the same file runs from line 1, not "resume from the end".
            if (!this._jobIsMacro) this._clearResumePoint();
            this.emit('sender:end', { jobId });
            // LOW#14: JobHistoryService listens for 'job:end'/'job:error'/
            // 'job:abort', not 'sender:*'.
            this.emit('job:end', {});
            this.emit('workflow:state', 'idle');
        });
        this.job.on('aborted', () => {
            this._jobEndedAt = Date.now();
            this._feedHoldSent = false;
            this.emit('sender:end', { aborted: true });
            this.emit('job:abort');
        });
        this.job.on('failed', (reason) => {
            this._jobEndedAt = Date.now();
            const stopLine = this.job ? this._fileLine(this.job.nextLineToRun()) : 0;
            const totalLines = this._fileTotalLines();
            // A failed job always keeps its resume point (it used to be wiped
            // when the failure came through the old 'done' path).
            if (stopLine > 1 && (!totalLines || stopLine <= totalLines)) {
                this._setResumePoint(stopLine, `job stopped: ${reason}`);
                this.emit('console', `⚠️ Job stopped at line ${stopLine}: ${reason}. Press START to continue from line ${stopLine}.`);
            } else {
                this.emit('console', `⚠️ Job stopped: ${reason}`);
            }
            this.emit('sender:error', { reason });
            // Plain object: Error.message does not survive Socket.IO JSON.
            this.emit('error', { message: `Job stopped: ${reason}` });
            this.emit('job:error', { message: reason });
            this.emit('workflow:state', 'idle');
        });
        // M0/M1 in the program: every move before it has run. Hold the
        // machine and wait for the operator (plan BE-14).
        this.job.on('programPause', ({ line, message, optional }) => {
            const fileLine = this._fileLine(line);
            this._sendFeedHold();
            const text = message ? `: ${message}` : '';
            logger.info(`[RSP] program pause (${optional ? 'M1' : 'M0'}) at line ${fileLine}${text}`);
            this.emit('console', `⏸️ Program paused at line ${fileLine} (${optional ? 'M1' : 'M0'})${text}. Press Resume to continue.`);
            this.emit('job:programPause', { line: fileLine, message: message || '', optional: !!optional });
            this.emit('sender:pause');
            this.emit('workflow:state', 'paused');
        });
        // A move finished just after Stop/failure: it was cut, so the saved
        // resume point moves past it (only forward, only for this job's point).
        this.job.on('lateProgress', ({ nextLine }) => {
            if (this.job.active || this._jobIsMacro) return;
            const line = this._fileLine(nextLine);
            if (this._resumeLine > 1 && line > this._resumeLine && this._resumeGcode === this._loadedGcode) {
                const total = this._fileTotalLines();
                if (!total || line <= total) this._setResumePoint(line, this._resumeReason);
            }
        });
        // G4: the machine sits still for a while. Shown in the same banner as a
        // program pause so it never looks like the job has hung, and it can be
        // skipped (a post that writes milliseconds asks for minutes here).
        this.job.on('dwell', ({ line, seconds }) => {
            const fileLine = this._fileLine(line);
            this.emit('console', `⏳ Line ${fileLine}: waiting ${seconds} s (G4 dwell). Press Resume to skip the wait.`);
            this.emit('job:programPause', {
                line: fileLine,
                message: `Waiting ${seconds} s (G4 dwell in the file)`,
                optional: false,
                kind: 'dwell',
                seconds,
            });
        });
        this.job.on('dwellDone', ({ line }) => {
            this.emit('console', `▶️ Line ${this._fileLine(line)}: wait finished, continuing.`);
            this.emit('job:programPause', null);
        });
    }

    /**
     * The device dropped the running job by itself (driver alarm, E-stop,
     * lost host). Record the exact resume point and hold the host job so
     * Resume/START restart from there with the safe preamble.
     */
    _onFirmwareJobLost(cause) {
        if (!this.job || !this.job.active || this.job.firmwareLost) return;
        const stopLine = this._fileLine(this.job.nextLineToRun());
        if (stopLine > 1) this._setResumePoint(stopLine, cause);
        this.job.markFirmwareLost(cause);
        this.emit('sender:pause');
        return stopLine;
    }

    /**
     * Firmware still RUNNING/HOLD with no host job behind it (a previous
     * session's job, or a job whose OP_JOB_END was lost). Abort it by the job
     * id it reports -- the old OP_JOB_ABORT(0) never matched, and the old
     * OP_FEED_HOLD left it stuck in HOLD so the next job could not start
     * (plan BE-4). Rate-limited; skipped right after a host job ends while
     * the firmware finishes switching to IDLE.
     */
    _abortOrphanJob(dict) {
        const t = Date.now();
        if (t - this._jobEndedAt < 1500 || t - this._lastOrphanAbortAt < 2000) return;
        this._lastOrphanAbortAt = t;
        logger.warn(`[RSP] firmware is ${dict.state_name} with job ${dict.job_id} but no job is running here -- aborting it`);
        try {
            // 0xFFFF is "stop whatever job you are running" (firmware 0.2.0,
            // FW-19) -- used when telemetry has not told us the id yet. Older
            // firmware answers ERR_JOB to it, which is harmless.
            const id = dict.job_id || 0xFFFF;
            this.stream.sendNowait(defs.OP_JOB_ABORT, codec.buildJobAbort(id), true, { force: true });
        } catch (exc) {
            logger.warn(`[RSP] orphan job abort not queued: ${exc.message || exc}`);
        }
    }

    /**
     * Called by CNCEngine._onConnectionClose() BEFORE unbind() when the raw
     * OS-level serial port itself drops (cable pull, driver hiccup, Windows
     * USB power-saving) -- a structurally different failure than the
     * RSP-protocol link-loss job.js's LINK_GRACE_S already handles, since
     * here the transport is gone outright, not just quiet. There's nothing
     * to wait out, so unlike the job.js grace period this reports
     * immediately -- but it still owes the same "don't lose more progress
     * than necessary" duty: checkpoint the resume point right now instead
     * of leaving it to the periodic per-N-lines save, which may be stale.
     * @returns {{jobWasActive: boolean, resumeLine: number}}
     */
    notifyConnectionLost() {
        const jobWasActive = !!(this.job && this.job.active);
        let resumeLine = 0;
        if (jobWasActive) {
            resumeLine = this._fileLine(this.job.nextLineToRun());
            if (resumeLine > 1) {
                this._setResumePoint(resumeLine, 'connection lost');
            }
        }
        return { jobWasActive, resumeLine };
    }

    // ------------------------------------------------------------------
    // resume point / line mapping
    // ------------------------------------------------------------------
    /** Job-local line number -> line number in the loaded file. */
    _fileLine(jobLine) {
        if (!jobLine) return 0;
        if (!this._lineOffset && !this._lineOffsetMin) return jobLine;
        return Math.max(jobLine + this._lineOffset, this._lineOffsetMin);
    }

    _fileTotalLines() {
        if (this._lineOffsetMin) return this._loadedLines.length;
        return (this.job && this.job.totalLineCount) || 0;
    }

    /** Work zero (or homing) changed -- flag any resume point that predates it. */
    _noteOriginChanged(how) {
        if (!(this._resumeLine > 1)) return;
        this._originChangedSinceStop = true;
        this.emit('console', `⚠️ You ${how} after the job stopped. Resume from line ${this._resumeLine} only if this is the SAME zero the job started from -- otherwise everything from here will be cut in the wrong place.`);
        this._emitResumePoint();
    }

    _setResumePoint(line, reason) {
        if (this._jobIsMacro) return;
        this._originChangedSinceStop = false;
        this._resumeLine = line;
        this._resumeGcode = this._loadedGcode;
        this._resumeReason = reason || '';
        this._resumeAt = Date.now();
        this._emitResumePoint();
    }

    _clearResumePoint() {
        const had = this._resumeLine > 0;
        this._resumeLine = 0;
        this._resumeGcode = null;
        this._resumeReason = '';
        this._resumeAt = 0;
        if (had) this._emitResumePoint();
    }

    getResumePoint() {
        const valid = this._resumeLine > 1 && this._resumeGcode !== null && this._resumeGcode === this._loadedGcode;
        return {
            line: valid ? this._resumeLine : 0,
            total: this._loadedLines.length,
            name: this._loadedName,
            reason: valid ? this._resumeReason : '',
            at: valid ? this._resumeAt : 0,
            positionExact: !this._positionUncertain,
            positionWarning: this._positionUncertain ? this._positionUncertain.message : '',
            // The work zero was re-set after the job stopped. Resuming is only
            // right if it was re-set to the SAME origin; otherwise everything
            // from here on is cut in the wrong place.
            originChanged: valid && !!this._originChangedSinceStop,
        };
    }

    _emitResumePoint() {
        this.emit('job:resumePoint', this.getResumePoint());
    }

    /**
     * EV_ALM_GLITCH (fw 0.1.1+): ALM blips the firmware filtered out -- the
     * job was NOT affected. Firmware 0.1.1 reports up to 10x/s; logging each
     * one as a warning flooded app.log (2026-09-15 19:13, ~3,500 lines in 7
     * min for Y1). Summed per axis and written once a minute at info level;
     * the console gets one plain explanation per axis per 10 minutes.
     */
    _noteAlmGlitch({ axis, count, maxMs }) {
        const nowMs = Date.now();
        if (!this._almNoise) this._almNoise = { since: nowMs, axes: {} };
        const a = this._almNoise.axes[axis] || (this._almNoise.axes[axis] = { count: 0, maxMs: 0, saturated: false });
        a.count += count;
        a.maxMs = Math.max(a.maxMs, maxMs);
        if (count >= 0xFFFF) a.saturated = true;

        const axisName = this._faultAxisName(axis);
        if (!this._almGlitchLastConsole[axis] || nowMs - this._almGlitchLastConsole[axis] > 10 * 60 * 1000) {
            this._almGlitchLastConsole[axis] = nowMs;
            this.emit('console', `ℹ️ ${axisName} motor-driver alarm (ALM) wire is noisy: short blips under ${Math.max(1, maxMs)} ms are being ignored and the job keeps running. To remove them, check the ${axisName} ALM wiring (see firmware README).`);
        }
        if (nowMs - this._almNoise.since >= 60 * 1000) this._flushAlmNoise(nowMs);
    }

    _flushAlmNoise(nowMs = Date.now()) {
        if (!this._almNoise) return;
        const secs = Math.max(1, (nowMs - this._almNoise.since) / 1000);
        const summary = [];
        for (const [axis, a] of Object.entries(this._almNoise.axes)) {
            if (!a.count) continue;
            summary.push({ axis: this._faultAxisName(Number(axis)), blips: a.count, perSecond: Math.round(a.count / secs), longestMs: a.maxMs, saturated: a.saturated });
        }
        this._almNoise = { since: nowMs, axes: {} };
        if (!summary.length) return;
        logger.info(`[RSP] ALM noise ignored over ${Math.round(secs)} s (job not affected): ${summary.map((s) => `${s.axis} ${s.blips}${s.saturated ? '+' : ''} blips (~${s.perSecond}/s, longest ${s.longestMs} ms)`).join(', ')}`);
        this.emit('alm:noise', { seconds: Math.round(secs), axes: summary });
    }

    /** "X", "Y1", ... for an EV_FAULT axis index. */
    _faultAxisName(axis) {
        return defs.FAULT_AXIS_NAMES[axis] || `axis ${axis}`;
    }

    /**
     * Refuse to resume while the controller's position is known to be wrong.
     * @returns {boolean} true if blocked (and a console message was emitted)
     */
    _blockIfPositionUncertain(what) {
        if (!this._positionUncertain) return false;
        this.emit('console', `⛔ ${what} blocked: ${this._positionUncertain.message} Re-zero X/Y/Z at the job's original origin (or home), then try again.`);
        return true;
    }

    unbind() {
        try { this._flushAlmNoise(); } catch (_) { /* never throw from unbind */ }
        if (this.job) {
            try { this.job.destroy(); } catch (_) { /* never throw from unbind */ }
        }
        if (this.stream) {
            try { this.stream.close(); } catch (_) { /* never throw from unbind */ }
        }
        if (this._transport) {
            try { this._transport.close(); } catch (_) { /* never throw from unbind */ }
        }
        this.job = null;
        this.stream = null;
        this._transport = null;
        this.connection = null;
        this.bound = false;
        this.emit('close');
    }

    destroy() {
        this.unbind();
        this.removeAllListeners();
    }

    // ------------------------------------------------------------------
    // inbound: telemetry / link / events
    // ------------------------------------------------------------------
    _onTelemetry(dict) {
        // RSP has no WCS/G54 offset table -- confirmed against real firmware
        // source (fw_m3/Src/easycnc_protocol.c:776-779, handle_jog_cmd() doc
        // comment): "cur_x/cur_y/cur_z ARE both machine position and work
        // position simultaneously ... mpos and wpos are always identical
        // here." OP_ZERO redefines the coordinate directly rather than
        // subtracting an offset, so wpos is not a separate computed value --
        // it's the same telemetry position mirrored under both keys, purely
        // so the frontend's existing wpos/mpos-keyed rendering path (shared
        // with GRBL/RTS controllers, which DO have a real WCO) has something
        // to read for RSP too.
        const pos = { x: dict.x, y: dict.y, z: dict.z };
        this._lastTelemetryJobId = dict.job_id;
        this.state.status = {
            activeState: dict.state_name,
            state: dict.state,
            mpos: pos,
            wpos: pos,
            feedrate: dict.feed,
            spindle: dict.spindle_speed,
            bufferFillPct: dict.buffer_fill_pct,
            plannerDepth: dict.planner_depth,
            linkOk: !!dict.link_ok,
            errorCode: dict.error_code,
            jobActive: dict.job_active,
            feedHold: dict.feed_hold,
            estop: dict.estop_active,
            feedOverridePct: this._feedOverridePct,
            lastExecutedLine: dict.last_executed_line,
            /* job-63998 debug extension (fw_m3 stepper.c jogeng_debug_get(),
             * defs.js asDict()) -- passed through so SessionLogger can record
             * it. Previously dropped here, so every past stall log only had
             * x/y/z; no way to tell "TIM2 ISR dead" from "ISR looping,
             * steps_done stuck" from "leg finished, poll() never drained it"
             * after the fact. Remove alongside the firmware fields once
             * root-caused. */
            dbgJogActive: dict.dbg_jog_active,
            dbgJogDoneEvt: dict.dbg_jog_done_evt,
            dbgTim2IsrCount: dict.dbg_tim2_isr_count,
            dbgStepsDone: dict.dbg_steps_done,
            dbgStepsTotal: dict.dbg_steps_total,
            faultFlags: dict.fault_flags,
            limitFlags: dict.limit_flags,
            posExact: !!dict.pos_exact,
        };
        this.state.parserstate.feedrate = dict.feed;
        this.state.parserstate.spindle = dict.spindle_speed;

        if (this.job && this.job.active) {
            // Before any alarm handling below, so the resume point includes
            // every move this frame proves finished (heals lost EV_EXECUTED).
            this.job.noteTelemetry(dict);
            // A program pause (M0) or a host-side hold shows as Hold, not Run,
            // so the UI offers Resume rather than Pause.
            if (this.job.paused && dict.state === defs.ST_RUNNING) {
                this.state.status.activeState = 'Hold';
            }
            // The machine is held but nobody here asked for it (a hold from
            // another client, or the firmware's own). Without this the job
            // would sit forever: no line finishes, and a hold is deliberately
            // not treated as a stall, so nothing would ever say so.
            if (dict.state === defs.ST_HOLD && !this.job.paused) {
                this.job.pause();
                this.emit('sender:pause');
                this.emit('workflow:state', 'paused');
                this.emit('console', '⏸️ The machine is on feed hold. Press Resume to continue the job.');
            }
        }

        // An interrupted move (steps_done < steps_total with the engine
        // stopped) on firmware WITHOUT the POS_EXACT capability means x/y/z
        // still hold the START of that move -- every later move, resume or
        // start-from-line would be offset by the steps that did run (the
        // 2026-09-15 log: ~20 mm in X). Remember it until the operator
        // re-establishes position. Keyed on the engine counters so the same
        // stale abort doesn't re-flag right after a re-zero.
        // dbg_steps_done === 0 means the move never started stepping: nothing
        // was lost, so that is not an uncertain position.
        if (!dict.pos_exact && !dict.dbg_jog_active && dict.dbg_steps_total > 0 &&
            dict.dbg_steps_done > 0 && dict.dbg_steps_done < dict.dbg_steps_total) {
            const sig = `${dict.dbg_tim2_isr_count}/${dict.dbg_steps_done}/${dict.dbg_steps_total}`;
            if (sig !== this._positionUncertainSig) {
                this._positionUncertainSig = sig;
                const lost = dict.dbg_steps_done;
                this._positionUncertain = {
                    at: Date.now(),
                    message: `A move was interrupted after ${lost} of ${dict.dbg_steps_total} steps and this firmware does not keep those steps, so the X/Y/Z shown can be off by up to ${(lost / 200).toFixed(1)} mm.`,
                };
                logger.warn(`[RSP] position uncertain after interrupted move (${sig}); firmware lacks POS_EXACT`);
                this.emit('console', `⚠️ Position may be wrong: ${this._positionUncertain.message} Flash firmware 0.1.1-almfilter to fix this permanently.`);
                this._emitResumePoint();
            }
        }

        // Board running a job nobody here is streaming (previous session, or
        // a lost OP_JOB_END): stop it by its real job id.
        if ((dict.state === defs.ST_RUNNING || dict.state === defs.ST_HOLD) && (!this.job || !this.job.active)) {
            this._abortOrphanJob(dict);
        }

        // Alarm / Fault / E-Stop detection: surface telemetry alarm states to frontend UI
        //
        // limit_flags/fault_flags come off the wire (Telemetry.asDict()) but were
        // never checked here -- only the coarse `state` enum and the estop_active
        // bit were. If firmware sets a fault bit without also flipping `state` to
        // ST_ALARM/ST_ESTOP/ST_FAULT, the alarm was silently never detected/
        // emitted -- matching the "alarm only visible after a refresh" report
        // (Tawfiq msg12053/12060).
        //
        // Both limit_flags AND fault_flags are now intentionally NOT used as
        // triggers here. limit_flags was dropped first (Tawfiq msg12074:
        // unwired switches float, stuck at 0x0f at rest). fault_flags was
        // believed to be a trustworthy driver/motor ALM signal -- until
        // Tawfiq's msg12208 session log (2026-09-09T05-11-03-243Z_COM12.ndjson)
        // proved otherwise: `state` stayed ST_RUNNING(5) the entire time (per
        // rsp/defs.js, confirmed never ST_ALARM/ST_ESTOP/ST_FAULT) and
        // estop_active was false throughout, so fault_flags was the only
        // possible trigger for the repeated "Job paused by FAULT" messages --
        // yet dbg_steps_done/dbg_tim2_isr_count kept climbing the whole time
        // (motion never actually stalled) and job.pause() doesn't reach into
        // firmware to halt real stepping anyway, so each flap just spammed a
        // pause+resume-point capture (_lastAlarmEmitted resets to null on any
        // non-alarm poll -- see the `else` branch below -- so a bouncing bit
        // re-fires as a "new" alarm every time it toggles back on) until the
        // job was force-aborted well before completion. Same class of noisy/
        // unverified GPIO bug as limit_flags, just a different pin. Still
        // decoded and included in the alarm payload for diagnostics; re-enable
        // as a trigger once Tawfiq confirms the ALM lines are actually wired
        // to the drivers and a real fault event has been reproduced cleanly.
        if (dict.state === defs.ST_ALARM || dict.state === defs.ST_ESTOP || dict.state === defs.ST_FAULT || dict.estop_active) {
            const alarmType = dict.estop_active ? 'estop'
                : (dict.state_name ? dict.state_name.toLowerCase() : 'alarm');
            if (!this._lastAlarmEmitted || this._lastAlarmEmitted !== alarmType) {
                this._lastAlarmEmitted = alarmType;
                logger.warn(`[RSP] Controller in alarm state: ${alarmType} (state=${dict.state}, estop=${dict.estop_active}, limit_flags=${dict.limit_flags}, fault_flags=${dict.fault_flags})`);

                // EV_FAULT arrives just before the state flips -- it's the
                // only thing that says which driver tripped.
                const recentFault = (!dict.estop_active && this._lastFault && (Date.now() - this._lastFault.at) < 5000)
                    ? this._lastFault : null;
                const cause = dict.estop_active ? 'E-STOP'
                    : recentFault ? `${this._faultAxisName(recentFault.axis)}-axis driver alarm (ALM)`
                        : alarmType.toUpperCase();

                // A running job was dropped by the firmware: keep the exact
                // resume point (the job's executed watermark -- telemetry's
                // last_executed_line can name a line received but not cut).
                if (this.job && this.job.active) {
                    const stopLine = this.job.firmwareLost
                        ? this._resumeLine
                        : this._onFirmwareJobLost(cause);
                    if (stopLine > 1) {
                        logger.info(`[RSP] Job halted by ${alarmType} at line ${stopLine}. Saved resume point.`);
                        const how = dict.pos_exact
                            ? 'press START to continue from the exact spot (the tool lifts, returns and plunges), or use Start From Line.'
                            : 'check the position (see warning), then press START.';
                        this.emit('console', `⚠️ Job paused by ${cause} at line ${stopLine}. Clear alarm / unlock ($X), then ${how}`);
                    }
                }

                this.emit('alarm', {
                    type: alarmType,
                    code: recentFault ? recentFault.code : (dict.error_code || 0),
                    axis: recentFault ? this._faultAxisName(recentFault.axis) : undefined,
                    message: dict.estop_active ? 'E-Stop Triggered'
                        : recentFault ? `${this._faultAxisName(recentFault.axis)}-axis driver alarm`
                            : `${dict.state_name || 'Alarm'} state`,
                    description: dict.estop_active
                        ? 'E-Stop was engaged. Release it, then click Clear / Unlock.'
                        : recentFault
                            ? `The ${this._faultAxisName(recentFault.axis)} motor driver signalled an alarm and motion was stopped. Check that driver (alarm LED, wiring, binding), then click Clear / Unlock.`
                            : 'The controller entered an alarm/fault state. Click Clear / Unlock to reset.',
                    limitFlags: dict.limit_flags || 0,
                    faultFlags: dict.fault_flags || 0,
                });
            }
        } else {
            this._lastAlarmEmitted = null;
        }

        this.emit('status', this.state.status);
    }

    _onLinkChange(ok) {
        const msg = ok ? 'RSP link up' : 'RSP link lost';
        logger.info(`[RSP] ${msg}`);
        this._debugLog.push({ type: 'link', ts: Date.now(), ok });
        if (this.connection) this.connection.emitToSockets('serialport:read', msg);
        this.emit('console', msg);
        if (!ok) {
            this.emit('error', { message: msg });
        }
    }

    _onStreamEvent(f) {
        if (!f || !f.payload || !f.payload.length) return;
        const op = f.payload[0];
        try {
            if (op === defs.EV_FAULT) {
                const { axis, code } = codec.parseEvFault(f.payload.subarray(1));
                const axisName = this._faultAxisName(axis);
                this._lastFault = { axis, code, at: Date.now() };
                logger.warn(`[RSP] EV_FAULT axis=${axis} (${axisName}) code=${code}`);
                const detail = code === defs.FAULT_CODE_ALM_MOTION ? ' (alarm held for 50 ms while moving)'
                    : code === defs.FAULT_CODE_ALM_ENABLE ? ' (alarm already active when the drivers were enabled)'
                        : '';
                this.emit('console', `🛑 ${axisName}-axis motor driver ALARM${detail} -- firmware stopped motion.`);
                this._onFirmwareJobLost(`${axisName}-axis driver alarm (ALM)`);
                this.emit('alarm', { type: 'fault', axis, axisName, code });
            } else if (op === defs.EV_ALM_GLITCH) {
                this._noteAlmGlitch(codec.parseEvAlmGlitch(f.payload.subarray(1)));
            } else if (op === defs.EV_ESTOP) {
                logger.warn('[RSP] EV_ESTOP received');
                this._onFirmwareJobLost('E-STOP');
                this.emit('alarm', { type: 'estop' });
            } else if (op === defs.EV_COMM_LOST) {
                logger.warn('[RSP] EV_COMM_LOST received (device entered safe-stop)');
                this._onFirmwareJobLost('device lost contact with the PC');
                this.emit('alarm', { type: 'comm_lost' });
            }
            // EV_EXECUTED / EV_JOB_DONE / EV_STATUS are consumed internally
            // by job.js / the stream's 'status' event respectively.
        } catch (exc) {
            logger.warn(`[RSP] error handling stream event: ${exc.message || exc}`);
        }
    }

    // ------------------------------------------------------------------
    // outbound: write / writeln (console passthrough)
    // ------------------------------------------------------------------
    /**
     * CNCEngine calls this with only `if (!this.controller) return;` --
     * no try/catch. Must be crash-safe unconditionally, including before
     * bind() / after unbind().
     */
    write(data, context) {
        // RSP is a binary framed protocol; there is no raw-text passthrough
        // channel to the firmware (unlike GRBL's serial console). Rather
        // than silently dropping user input, surface it back as a console
        // line explaining why, so the UI console doesn't look broken.
        if (!this.connection) return;
        const msg = `[RSP] raw text write not supported by this protocol (ignored: ${String(data).slice(0, 64)})`;
        logger.warn(msg);
        this.emit('console', msg);
    }

    writeln(data, context) {
        this.write(data, context);
    }

    // ------------------------------------------------------------------
    // command dispatch
    // ------------------------------------------------------------------
    /**
     * Handle commands from CNCEngine/Socket.IO. Internally try/catch'd in
     * full -- some call sites in CNCEngine.js invoke controller.command()
     * without their own try/catch (e.g. socket.on('debug:enable', ...)),
     * so this method must never throw regardless of caller.
     */
    command(cmd, ...args) {
        try {
            return this._dispatch(cmd, args);
        } catch (exc) {
            logger.error(`[RSP] command "${cmd}" failed: ${exc.message || exc}`);
            // Emit a plain object, not the raw Error -- Error.message is
            // non-enumerable so it vanishes over Socket.IO's JSON encoding
            // (frontend would render "Error undefined: undefined").
            this.emit('error', { message: exc.message || String(exc) });
        }
    }

    _dispatch(cmd, args) {
        if (!this.stream) {
            logger.warn(`[RSP] command "${cmd}" ignored -- controller not bound`);
            return;
        }

        // Job interlock (plan BE-11): nothing else moves the machine or
        // changes its zero while a job owns it. A job the firmware already
        // dropped (alarm / E-stop) is excluded -- recovering from it needs
        // jog, re-zero and home before Resume.
        if (MOTION_COMMANDS.has(cmd) && this.job && this.job.active && !this.job.firmwareLost) {
            this.emit('console', `⛔ "${cmd}" is not available while a job is running. Pause is not enough -- stop the job first.`);
            return;
        }

        switch (cmd) {
            case 'jog': {
                const p = args[0] || {};
                const feed = Math.min(Number(p.feedRate) || 500, 10000);
                const axes = [
                    ['x', AXIS_X], ['y', AXIS_Y], ['z', AXIS_Z],
                ];
                const requested = axes.filter(([key]) => p[key] !== undefined && p[key] !== null && !isNaN(Number(p[key])) && Math.abs(Number(p[key])) > 0.0001);
                if (requested.length > 1) {
                    // Diagonal jog (>1 axis nonzero): OP_JOG only moves one axis at
                    // a time, so firing it per-axis in a loop moved X to completion
                    // then Y, not together (Tawfiq msg11347 item 3). OP_MOVE takes
                    // an absolute x/y/z/feed target and the firmware coordinates
                    // all axes in one motion, same as it does for G-code moves --
                    // compute the target off the last-known telemetry position
                    // (this.state.status.mpos) and send a single frame.
                    const mpos = this.state.status.mpos || { x: 0, y: 0, z: 0 };
                    const target = {
                        x: mpos.x + (Number(p.x) || 0),
                        y: mpos.y + (Number(p.y) || 0),
                        z: mpos.z + (Number(p.z) || 0),
                    };
                    this._fireAndForget(defs.OP_MOVE, codec.buildMove(target.x, target.y, target.z, feed));
                    break;
                }
                for (const [key, axisCode] of requested) {
                    const dist = Math.abs(Number(p[key]));
                    // Direction bit convention confirmed inverted on real RSP hardware
                    // (Tawfiq msg11223: all axes moved opposite of the requested sign).
                    const direction = Number(p[key]) < 0 ? 0 : 1;
                    this._fireAndForget(defs.OP_JOG, codec.buildJog(axisCode, direction, dist, feed));
                }
                break;
            }

            case 'homing':
            case 'home':
                this._clearPositionUncertain('homed');
                this._noteOriginChanged('homed the machine');
                this._fireAndForget(defs.OP_HOME, codec.buildHome(AXIS_MASK_ALL));
                break;
            case 'homing:x':
            case 'home:x':
                this._fireAndForget(defs.OP_HOME, codec.buildHome(AXIS_BIT_X));
                break;
            case 'homing:y':
            case 'home:y':
                this._fireAndForget(defs.OP_HOME, codec.buildHome(AXIS_BIT_Y));
                break;
            case 'homing:z':
            case 'home:z':
                this._fireAndForget(defs.OP_HOME, codec.buildHome(AXIS_BIT_Z));
                break;

            // The E-STOP button (frontend controller.reset()) and 'estop' both
            // land here. It used to send FEED_HOLD + SOFT_RESET: the hold only
            // takes effect at the end of the current move, and the reboot
            // wiped the work zero and dropped USB. OP_E_STOP stops the step
            // engine at once, disables the drivers and keeps the exact
            // position, so the job can be resumed (plan BE-12).
            case 'estop':
            case 'emergency_stop':
            case 'reset':
                this._emergencyStop();
                break;

            // 'motor:reset'/'motor:resetAll'/'estop:clear'/'limit:clear' used
            // to fall through to the unknown-command default (silently
            // ignored -- confirmed by re-reading this switch end to end,
            // flagged msg11410, now hit again msg11440: Tawfiq has to
            // power-cycle the machine because the "Reset Motors"/"Clear
            // Alarm"/"Clear Limit" UI buttons sent commands this switch
            // never handled). defs.js's RSP opcode set (0x01-0x13) has
            // exactly ONE alarm-recovery primitive -- OP_UNLOCK (GRBL $X
            // equivalent) -- no separate motor-fault-clear or limit-clear
            // opcode exists. Routing all four here so the buttons actually
            // reach the firmware instead of doing nothing.
            // CAVEAT (told to Tawfiq, not silently assumed): if the motor
            // driver IC latches EV_FAULT in hardware (common for stepper
            // driver ALM outputs), OP_UNLOCK may not clear it -- that would
            // need firmware-side EN-pin toggling or a real power cycle, a
            // firmware/hardware-layer fix this file cannot make.
            case 'unlock':
            case 'motor:reset':
            case 'motor:resetAll':
            case 'estop:clear':
            case 'limit:clear': {
                // FW-3: this used to be _fireAndForget + an unconditional
                // "Alarm cleared / unlocked" console line -- claiming success
                // even when the device NAK'd or never replied. sendCommand()
                // resolves only on a real ACK for this seq and rejects on
                // NAK/timeout/LinkLost, so use that instead of guessing.
                if (!this.stream) {
                    this.emit('console', '⚠️ [RSP] Unlock not sent -- controller not bound.');
                    break;
                }
                this.stream.sendCommand(defs.OP_UNLOCK, Buffer.alloc(0), { timeout: 3.0 })
                    .then(() => {
                        this._lastAlarmEmitted = null;
                        // The reply means "unlock was received", NOT "the
                        // machine is clear": the firmware refuses to leave
                        // E-stop while the button is still pressed
                        // (handle_unlock -> estop_is_active). Forcing the state
                        // to Idle here showed a ready machine that was still
                        // latched. Telemetry (10 Hz) says what really happened.
                        this.emit('console', '[RSP] Alarm cleared / unlocked ($X)');
                        this._requestStatus();
                        if (this._resumeLine > 1) {
                            this.emit('console', `▶️ Press START to resume from line ${this._resumeLine} once the machine reads Idle.`);
                        }
                    })
                    .catch((exc) => {
                        this.emit('console', `⚠️ [RSP] Unlock command failed: ${exc.message || exc}. Machine may still be alarmed -- do not assume it is safe to run.`);
                    });
                break;
            }

            case 'reset:hard':
                if (this.job && this.job.active) {
                    this.emit('console', '⛔ Controller restart refused while a job is running. Stop the job first.');
                    break;
                }
                this._lastAlarmEmitted = null;
                this._fireAndForget(defs.OP_SOFT_RESET, Buffer.alloc(0));
                this._setPositionUncertain('the controller restarted, so its X/Y/Z position was reset to 0');
                this.emit('console', '[RSP] Controller restart sent.');
                break;

            case 'feedhold':
                return this._dispatch('gcode:pause', []);

            case 'cyclestart':
                return this._dispatch('gcode:resume', []);

            case 'zero':
            case 'wcs:zero': {
                const p = args[0] || {};
                let mask = 0;
                if (Array.isArray(p.axes)) {
                    if (p.axes.includes('X') || p.axes.includes('x')) mask |= AXIS_BIT_X;
                    if (p.axes.includes('Y') || p.axes.includes('y')) mask |= AXIS_BIT_Y;
                    if (p.axes.includes('Z') || p.axes.includes('z')) mask |= AXIS_BIT_Z;
                }
                if (p.x !== undefined) mask |= AXIS_BIT_X;
                if (p.y !== undefined) mask |= AXIS_BIT_Y;
                if (p.z !== undefined) mask |= AXIS_BIT_Z;
                if (!mask) mask = AXIS_MASK_ALL;
                if (mask === AXIS_MASK_ALL) this._clearPositionUncertain('re-zeroed X/Y/Z');
                this._noteOriginChanged('set a new work zero');
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(mask));
                break;
            }
            case 'zero:x':
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(AXIS_BIT_X));
                break;
            case 'zero:y':
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(AXIS_BIT_Y));
                break;
            case 'zero:z':
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(AXIS_BIT_Z));
                break;
            case 'wcs:zeroAll':
            case 'zero:all':
                this._clearPositionUncertain('re-zeroed X/Y/Z');
                this._noteOriginChanged('set a new work zero');
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(AXIS_MASK_ALL));
                break;

            case 'gcode:load': {
                const [name, gcode, spindleDelaySeconds, compileOptions] = args;
                const incoming = gcode || '';
                // Never replace the program under a running job (CNCEngine
                // re-announces the same file itself; this guards every other
                // caller). A job the firmware already dropped (alarm) is fine
                // to replace: its resume point survives a same-file reload.
                if (this.job && this.job.active && !this.job.firmwareLost) {
                    logger.warn(`[RSP] gcode:load "${name || ''}" refused: a job is running`);
                    this.emit('console', '⛔ A job is running. Stop it before loading another file.');
                    this.lastLoadResult = { ok: false, busy: true, name: name || '', meta: { errorCount: 1, errors: [{ line: null, msg: 'A job is running. Stop it before loading another file.' }], warnings: [] } };
                    break;
                }
                if (this.job && this.job.active) this.job.abort();
                // MED#10: an aborted job object's .progress getter still
                // reports its old executed/total counts (abort() doesn't
                // clear _executed), and _currentLine was never reset here
                // either -- so until the new job's first EV_EXECUTED came
                // in, getSenderStatus() kept reporting the PREVIOUS file's
                // line count/percentage overlaid on the newly loaded file
                // (Tawfiq's "old-job-bleed" report).
                if (this.job) this.job.resetProgress();
                this._currentLine = 0;
                this._loadedName = name || '';

                // Firmware (easycnc_protocol.c, GcodeMove struct) has no
                // arc-center field and rejects G2/G3 outright. Linearize
                // here so ANY file the user loads just runs -- this only
                // rewrites the in-memory copy sent to firmware, never the
                // user's original file on disk.
                try {
                    const { text: linearized, arcCount, segmentCount } = linearizeArcs(incoming);
                    // Same host-side rewrite pattern as arc linearization:
                    // insert a spin-up dwell after every M3/M4 so the tool
                    // isn't plunging before the spindle is at speed. Without
                    // this, preferences.spindleDelay was stored but never
                    // read anywhere (FIXFILE.html FIX-16).
                    const { text, insertedCount } = injectSpindleDelay(linearized, spindleDelaySeconds);
                    // BE-1: compile to the exact wire lines the firmware reads
                    // correctly (absolute G21 on the step grid, explicit feed,
                    // no hex-float pattern) or refuse the file with line numbers.
                    const compiled = compileWire(text, compileOptions || {});
                    const meta = compiled.meta;
                    if (meta.errorCount > 0) {
                        const shown = meta.errors.slice(0, 5)
                            .map((e) => (e.line ? `line ${e.line}: ${e.msg}` : e.msg)).join(' | ');
                        const more = meta.errorCount > 5 ? ` (+${meta.errorCount - 5} more)` : '';
                        logger.warn(`[RSP] gcode:load refused "${this._loadedName}": ${meta.errorCount} problem(s): ${shown}${more}`);
                        this.emit('console', `⛔ "${this._loadedName}" cannot run on this machine: ${shown}${more}`);
                        this._setLoadRejected(name, meta);
                        break;
                    }
                    this._loadedGcode = compiled.text;
                    this._loadedLines = compiled.lines;
                    this._loadedMeta = meta;
                    this._lastCompileOptions = compileOptions || {};
                    this.lastLoadResult = { ok: true, name: this._loadedName, meta };
                    if (arcCount > 0) {
                        logger.info(`[RSP] gcode:load linearized ${arcCount} arc(s) into ${segmentCount} G1 segments`);
                        this.emit('console', `ℹ️ Converted ${arcCount} arc(s) into ${segmentCount} line segments for this machine (your file is unchanged).`);
                    }
                    if (insertedCount > 0) {
                        logger.info(`[RSP] gcode:load inserted ${insertedCount} spindle spin-up dwell(s) (G4 P${spindleDelaySeconds}) after M3/M4`);
                        this.emit('console', `ℹ️ Added a ${spindleDelaySeconds}s spindle spin-up dwell after each M3/M4 (your file is unchanged).`);
                    }
                    for (const w of meta.warnings.slice(0, 8)) {
                        this.emit('console', `ℹ️ ${w.line ? `Line ${w.line}: ` : ''}${w.msg}`);
                    }
                    logger.info(`[RSP] gcode:load compiled ${meta.lineCount} lines (${meta.motionCount} moves, ${meta.clampedCount} feed-clamped, ${meta.pauses.length} program pause(s), ${meta.warnings.length} warning(s))`);
                } catch (err) {
                    logger.warn(`[RSP] gcode:load failed: ${err.message}`);
                    this.emit('console', `⛔ "${this._loadedName}" cannot run on this machine: ${err.message}`);
                    this._setLoadRejected(name, { errorCount: 1, errors: [{ line: null, msg: err.message }], warnings: [] });
                    break;
                }
                // Power-cut recovery is now handled by JobResumeService,
                // which intercepts at a higher level. A load of a DIFFERENT
                // file drops the in-session resume point; re-sending the SAME
                // file keeps it -- the frontend re-uploads the open file on
                // reconnect/refresh, and on 2026-09-15 that silently wiped the
                // line-3237 resume point and forced a restart from scratch.
                if (this._resumeGcode !== null && this._resumeGcode === this._loadedGcode && this._resumeLine > 1) {
                    logger.info(`[RSP] gcode:load same file re-sent -- keeping resume point at line ${this._resumeLine}`);
                    this._emitResumePoint();
                } else {
                    this._clearResumePoint();
                }
                logger.info(`[RSP] gcode:load "${this._loadedName}" (${this._loadedGcode.length} bytes)`);
                break;
            }

            case 'gcode:unload':
                if (this.job && this.job.active) this.job.abort();
                this._loadedGcode = '';
                this._loadedLines = [];
                this._loadedMeta = null;
                this.lastLoadResult = null;
                this._loadedName = '';
                this._clearResumePoint();
                break;

            case 'gcode:start': {
                // A double-click or a second client pressing START used to
                // abort the running job and restart the file from line 1.
                if (this.job && this.job.active && !this.job.firmwareLost) {
                    if (this.job.paused) return this._dispatch('gcode:resume', []);
                    this.emit('console', 'ℹ️ The job is already running.');
                    return undefined;
                }
                const totalLines = this._loadedLines.length;
                if (this._resumeGcode !== null && this._resumeGcode === this._loadedGcode && this._resumeLine > 1) {
                    if (totalLines > 0 && this._resumeLine > totalLines) {
                        logger.info(`[RSP] resumeLine ${this._resumeLine} exceeds total lines ${totalLines}, starting fresh from line 1`);
                        this._clearResumePoint();
                        return this._startJob(this._loadedGcode, 0, null, this._holdsForFile(1));
                    }
                    return this._resumeFromPoint();
                }
                return this._startJob(this._loadedGcode, 0, null, this._holdsForFile(1));
            }

            case 'gcode:startFromLine': {
                if (this.job && this.job.active && !this.job.firmwareLost) {
                    this.emit('console', '⛔ Start From Line is not available while a job is running. Stop the job first.');
                    return undefined;
                }
                // Always the safe program: lift to safe Z, travel to where line
                // N starts, plunge, continue. (The bare [line] form streamed
                // the file from line N with no retract or travel -- a straight
                // cut from wherever the tool was.)
                const [lineNumber, opts] = args;
                return this._startFromLineSafe(Number(lineNumber), (opts && typeof opts === 'object') ? opts : {});
            }

            case 'gcode:resumePoint':
                this._emitResumePoint();
                break;

            case 'gcode:resumePreview': {
                const [lineNumber, opts] = args;
                this.emit('job:resumePreview', this._resumePreview(Number(lineNumber), opts || {}));
                break;
            }

            case 'gcode:pause':
                if (!this.job || !this.job.active) break;
                this.job.pause();
                this._sendFeedHold();
                this.emit('sender:pause');
                this.emit('workflow:state', 'paused');
                break;

            case 'gcode:resume':
                if (this.job && this.job.active && !this.job.firmwareLost) {
                    this.job.resume();
                    // Only ever sent to lift a hold. On firmware up to 0.1.2
                    // OP_RESUME also acts as the legacy "cycle start": from
                    // IDLE it sets the machine running on whatever is left in
                    // the planner. Sending it unconditionally (as this used
                    // to) could therefore start motion that nobody asked for.
                    // 0.2.0 refuses that firmware-side as well (FW-10).
                    if (this._firmwareIsHolding()) {
                        this._feedHoldSent = false;
                        this._fireAndForget(defs.OP_RESUME, Buffer.alloc(0));
                    }
                    this.emit('sender:resume');
                    this.emit('workflow:state', 'running');
                    break;
                }
                // The firmware dropped the job (alarm / E-stop) or it was
                // stopped: continue from the saved point with a fresh job.
                if (this.getResumePoint().line > 1) return this._resumeFromPoint();
                break;

            case 'gcode:stop': {
                const wasActive = !!(this.job && this.job.active);
                if (wasActive && this._jobIsMacro) {
                    // A macro is not the loaded file: stopping one must not
                    // touch (or claim to set) the file's resume point.
                    this.job.abort();
                    this.emit('workflow:state', 'idle');
                    this.emit('console', '⏹️ Macro stopped.');
                    break;
                }
                // Capture before abort(): the exact executed watermark.
                const stopLine = wasActive ? this._fileLine(this.job.nextLineToRun()) : 0;
                const totalLines = this._fileTotalLines();
                if (wasActive) {
                    // Sends OP_JOB_ABORT (forced), which also takes the firmware
                    // out of HOLD to IDLE -- no blind OP_RESUME needed.
                    this.job.abort();
                } else {
                    const st = this.state && this.state.status;
                    if (st && (st.state === defs.ST_RUNNING || st.state === defs.ST_HOLD)) {
                        this._lastOrphanAbortAt = 0;
                        this._jobEndedAt = 0;
                        this._abortOrphanJob({ state_name: st.activeState, job_id: this._lastTelemetryJobId || 0 });
                    }
                    this.emit('sender:end', { aborted: true });
                }
                this.emit('workflow:state', 'idle');
                if (wasActive && stopLine > 1 && (!totalLines || stopLine <= totalLines)) {
                    // Stopping an already alarm-paused job keeps the alarm as the reason.
                    const reason = (this._resumeLine === stopLine && this._resumeReason) ? this._resumeReason : 'stopped';
                    this._setResumePoint(stopLine, reason);
                    this.emit('console', `⏹️ Stopped at line ${stopLine}. Press START to resume from here, use Start From Line, or load a new file to restart.`);
                } else if (wasActive) {
                    this._clearResumePoint();
                }
                break;
            }

            case 'statusreport':
                this._requestStatus();
                break;

            case 'probe': {
                const p = args[0] || {};
                const axis = Number(p.axis);
                const dirNeg = p.dirNeg ? 1 : 0;
                const maxTravelMm = Number(p.maxTravelMm || p.distance || 25);
                const feed = Number(p.feed || p.feedRate || 100);
                this.probeAxis(axis, dirNeg, maxTravelMm, feed).then((out) => {
                    // FIX-7: contact:false is a normal resolution (firmware
                    // ran out of travel without triggering), not a thrown
                    // error -- still needs the same retract-on-fail as a
                    // rejected/timed-out probe, or the bit is left sitting at
                    // the far end of maxTravelMm with no automatic retreat.
                    if (!out.contact) this._probeFailRetract('no contact within travel');
                }).catch((exc) => {
                    const msg = (exc instanceof RspTimeoutError)
                        ? 'no reply from firmware before timeout -- check link/wiring'
                        : (exc.message || String(exc));
                    logger.warn(`[RSP] probe failed: ${msg}`);
                    this.emit('probe', { success: false, error: msg });
                    this._probeFailRetract(msg);
                });
                break;
            }

            case 'feedOverride:reset':
                this._setFeedOverride(100.0);
                break;
            case 'feedOverride:coarsePlus':
                this._setFeedOverride(this._feedOverridePct + FEED_OVERRIDE_COARSE);
                break;
            case 'feedOverride:coarseMinus':
                this._setFeedOverride(this._feedOverridePct - FEED_OVERRIDE_COARSE);
                break;
            case 'feedOverride:finePlus':
                this._setFeedOverride(this._feedOverridePct + FEED_OVERRIDE_FINE);
                break;
            case 'feedOverride:fineMinus':
                this._setFeedOverride(this._feedOverridePct - FEED_OVERRIDE_FINE);
                break;

            case 'debug:enable':
                this._debugEnabled = true;
                break;
            case 'debug:disable':
                this._debugEnabled = false;
                break;

            case 'trigger:set': {
                const [eventName, config] = args;
                this._eventTriggers[eventName] = config;
                break;
            }
            case 'trigger:loadAll': {
                const [triggers] = args;
                if (triggers && typeof triggers === 'object') {
                    this._eventTriggers = { ...triggers };
                }
                break;
            }

            case 'macro:run': {
                // Macros go through the same arc conversion + wire compiler as
                // files -- raw text hit the firmware's hex-float and feed-lag
                // parsing bugs. A macro job has no file line mapping or resume.
                const [content] = args;
                let compiled;
                try {
                    compiled = compileWire(linearizeArcs(String(content || '')).text, this._lastCompileOptions || {});
                } catch (err) {
                    this.emit('console', `⛔ Macro not run: ${err.message}`);
                    break;
                }
                if (compiled.meta.errorCount > 0) {
                    const e = compiled.meta.errors[0];
                    this.emit('console', `⛔ Macro not run: ${e.line ? `line ${e.line}: ` : ''}${e.msg}`);
                    break;
                }
                this._startJob(compiled.text, 0, { lineOffset: 0, lineOffsetMin: 0, macro: true }, this._holdsFromMeta(compiled.meta));
                break;
            }

            // Finding #8: SpindleLaserControl.tsx / CoolantControl.tsx send bare
            // M-codes via sendBackendCommand() -> sendGcode() -> command('gcode',
            // line) -- there was no case 'gcode' at all, so every click fell
            // straight to the silent unknown-command default: no OP sent, no
            // error surfaced, while the UI optimistically flipped its own
            // running/coolant badges as if it had worked. This board has no
            // spindle/coolant/laser hardware wired (Tawfiq confirmed), so there
            // is no OP to send -- but a real, visible failure is a fix in
            // itself: it stops the panel from lying about machine state, and
            // for the M5/M9 stop commands it tells the operator to use a
            // physical stop instead of trusting a software stop that never
            // reached the board.
            // Scoped narrowly to the M-codes this panel actually sends --
            // any other single-line 'gcode' traffic (MDI console, etc.) is a
            // separate, wider RSP gcode-passthrough gap left untouched here.
            case 'gcode': {
                const line = String(args[0] || '').trim().toUpperCase();
                if (/^M0*3\b/.test(line) || /^M0*4\b/.test(line)) {
                    throw new Error(`RSP firmware does not support spindle/laser control -- no spindle or laser hardware wired on this board ("${line}" was not sent).`);
                }
                if (/^M0*5\b/.test(line)) {
                    throw new Error(`RSP firmware does not support spindle/laser control -- M5 was not sent to the board. If the spindle or laser is running, stop it physically.`);
                }
                if (/^M0*7\b/.test(line) || /^M0*8\b/.test(line)) {
                    throw new Error(`RSP firmware does not support coolant control -- no coolant hardware wired on this board ("${line}" was not sent).`);
                }
                if (/^M0*9\b/.test(line)) {
                    throw new Error(`RSP firmware does not support coolant control -- M9 was not sent to the board. If coolant is running, stop it physically.`);
                }
                logger.warn(`[RSP] command "gcode" ignored -- unsupported line "${line}"`);
                break;
            }

            // Not supported by the RSP opcode set (no spindle/coolant/
            // tool-change/rapid-override commands in defs.py) --
            // graceful no-op + warning, matching GenericController's
            // degrade-don't-crash philosophy rather than throwing.
            case 'rapidOverride:reset':
            case 'rapidOverride:medium':
            case 'rapidOverride:low':
            case 'spindleOverride:reset':
            case 'spindleOverride:plus':
            case 'spindleOverride:minus':
            case 'coolant:flood':
            case 'coolant:mist':
            case 'toolchange:confirm':
            case 'toolchange:cancel':
                logger.warn(`[RSP] command "${cmd}" not supported by RSP firmware -- ignored`);
                break;

            default:
                logger.warn(`[RSP] unknown command "${cmd}" -- ignored`);
                break;
        }
    }

    /** Fire a command without blocking the caller; logs and swallows LinkLost. */
    _fireAndForget(op, payload) {
        if (!this.stream) return;
        try {
            this.stream.sendCommand(op, payload, { timeout: 3.0 }).catch((exc) => {
                logger.warn(`[RSP] op 0x${op.toString(16)} failed: ${exc.message || exc}`);
            });
        } catch (exc) {
            if (!(exc instanceof LinkLost)) throw exc;
            logger.warn(`[RSP] op 0x${op.toString(16)} not sent -- link down`);
        }
    }

    /**
     * Ask the board what it actually is. Nothing here used to: the UI showed a
     * hardcoded "RSP (Reliable Stream Protocol)" whatever was flashed, so there
     * was no way to tell 0.1.1 from 0.2.0 short of reading hex files -- and the
     * hex file NAMES in the firmware folder had already drifted from their
     * contents. GET_CONFIG carries the firmware's own version string.
     */
    _requestConfig() {
        if (!this.stream) return;
        this.stream.sendCommand(defs.OP_GET_CONFIG, Buffer.alloc(0), { timeout: 3.0 })
            .then((rsp) => {
                if (!rsp || !rsp.payload || rsp.payload.length < 3) return;
                const json = rsp.payload.subarray(2).toString('utf8').replace(/\0+$/, '');
                let cfg;
                try {
                    cfg = JSON.parse(json);
                } catch (_) {
                    logger.warn(`[RSP] GET_CONFIG reply was not JSON: ${json.slice(0, 80)}`);
                    return;
                }
                this.firmwareVersion = cfg.fw || 'unknown';
                this.firmwareConfig = cfg;
                const steps = Array.isArray(cfg.steps_per_mm) ? ` steps/mm ${cfg.steps_per_mm.join('/')}` : '';
                logger.info(`[RSP] controller firmware ${this.firmwareVersion}${steps}`);
                this.emit('console', `ℹ️ Controller firmware: ${this.firmwareVersion}${steps}`);
                this.emit('initialized', { firmwareType: this.type, firmwareVersion: `RSP ${this.firmwareVersion}` });
                if (this.connection) {
                    this.connection.emitToSockets('controller:initialized', {
                        firmwareType: this.type,
                        firmwareVersion: `RSP ${this.firmwareVersion}`,
                    });
                }
            })
            .catch((exc) => {
                logger.warn(`[RSP] could not read the firmware version: ${exc.message || exc}`);
            });
    }

    _requestStatus() {
        if (!this.stream) return;
        this.stream.sendCommand(defs.OP_GET_STATUS, Buffer.alloc(0), { timeout: 2.0 })
            .then((rsp) => {
                // FT_RSP payload layout is [op, status, ...body] (2 header
                // bytes, not 1 -- FT_EVT/EV_STATUS frames are the ones with
                // just [op, ...body]). Mirrors machine.py's
                // `Telemetry(rsp.payload[2:])` exactly; confirmed via the
                // TCP-bridged simulator integration test, which surfaced a
                // "Telemetry: expected 46 bytes, got 47" error before this
                // fix -- do not regress back to subarray(1).
                if (!rsp.payload || rsp.payload.length < 2 + defs.TEL_LEN) return;
                const tel = new defs.Telemetry(rsp.payload.subarray(2));
                this._onTelemetry(tel.asDict());
            })
            .catch((exc) => {
                logger.warn(`[RSP] statusreport failed: ${exc.message || exc}`);
            });
    }

    /**
     * Native single-axis probe (RSP OP_PROBE). RSP's job-line gcode parser
     * (fw_m3/Src/easycnc_protocol.c parse_gcode_text()) has no G38.x/G10
     * support, so the GRBL-style raw-gcode probing path (ProbingService.js
     * + ProbeStrategies.js, which write() G38.2 lines and parse `[PRB:...]`
     * replies) cannot drive this firmware -- this is the RSP-native
     * replacement for a single axis touch-off.
     *
     * @param {number} axis 0=X,1=Y,2=Z
     * @param {number} dirNeg 1=negative direction, 0=positive (caller-facing
     *   semantic direction -- the wire-level bit sent below is inverted from
     *   this to match hardware, see comment at the buildProbe() call)
     * @param {number} maxTravelMm
     * @param {number} feedMmPerMin
     * @returns {Promise<{contact:boolean, axis:number, distMm:number, x:number, y:number, z:number}>}
     */
    probeAxis(axis, dirNeg, maxTravelMm, feedMmPerMin) {
        if (!this.stream) return Promise.reject(new Error('controller not bound'));
        // Direction bit: firmware's probe_axis_single() (fw_m3/Src/main.c:681)
        // writes the DIR pin for whichever axis is selected with ONE
        // uninverted line (dir_neg ? RESET : SET) -- unlike OP_MOVE's
        // motion_set_dir_pins() (main.c:382-390), which XORs Z_DIR_INVERT
        // for Z only (X and Y1 have no invert #define at all). So probe's
        // wire bit already matches move's physical convention for X/Y with
        // NO inversion needed, but is backwards for Z specifically.
        // msg11358's fix inverted ALL axes to fix Z-only-moved-up, which
        // silently broke X/Y probing from that point on -- msg11499/11514
        // (X, then X+Y, moving away from the block during actual probing)
        // is that regression. Invert ONLY for Z.
        const wireDir = (axis === 2) ? (dirNeg ? 0 : 1) : dirNeg;
        const payload = codec.buildProbe(axis, wireDir, maxTravelMm, feedMmPerMin);
        // Firmware blocks for the full probe move before replying (same
        // shape as OP_MOVE/OP_HOME) -- size the wait off the commanded
        // travel/feed instead of the ~3s default used by fire-and-forget
        // commands, plus margin for the ESTOP/FAULT debounce passes.
        const travelMinutes = maxTravelMm / Math.max(1, feedMmPerMin);
        const timeout = Math.max(10, travelMinutes * 60 * 1.5 + 5);
        return this.stream.sendCommand(defs.OP_PROBE, payload, { timeout }).then((rsp) => {
            const status = rsp.payload[1];
            if (status !== defs.ST_OK) {
                const name = defs.ST_ERR_NAMES[status] || `0x${status.toString(16)}`;
                throw new Error(`probe rejected: ${name}`);
            }
            const r = codec.parseProbeResult(rsp.payload.subarray(2));
            const out = {
                contact: r.result === defs.PROBE_RESULT_CONTACT,
                axis: r.axis,
                distMm: r.distMm,
                x: r.x, y: r.y, z: r.z,
            };
            this.emit('probe', { success: out.contact, x: out.x, y: out.y, z: out.z, axis: out.axis, distMm: out.distMm });
            return out;
        });
    }

    /**
     * Awaitable RSP OP_ENTER_BOOTLOADER trigger for the no-BOOT0 USB DFU
     * firmware-update path. Firmware only accepts this from SYS_IDLE
     * (ST_ERR_STATE otherwise) and ACKs ST_OK *before* jumping into the
     * STM32H723 system bootloader (fw_m3/Inc/rsp_defs.h:31-40, fw_m3/Inc/
     * dfu_bootloader.h) -- so resolving on that ACK is the correct signal
     * for the caller to start polling for the DFU USB device (VID 0x0483,
     * PID 0xDF11). The CDC serial port disappears immediately after the
     * ACK, same as this.stream will observe a LinkLost right after.
     * @returns {Promise<void>}
     */
    enterBootloader() {
        if (!this.stream) return Promise.reject(new Error('controller not bound'));
        return this.stream.sendCommand(defs.OP_ENTER_BOOTLOADER, Buffer.alloc(0), { timeout: 5.0 }).then((rsp) => {
            const status = rsp.payload[1];
            if (status !== defs.ST_OK) {
                const name = defs.ST_ERR_NAMES[status] || `0x${status.toString(16)}`;
                throw new Error(`enter-bootloader rejected: ${name} (machine must be IDLE -- clear any job/alarm/estop first)`);
            }
            this.emit('console', '[RSP] Bootloader entry ACKed -- device jumping to USB DFU, CDC port will disappear now.');
        });
    }

    /**
     * Awaitable absolute move (RSP OP_MOVE), used by ProbingService's
     * RSP-native multi-axis routines to reposition BETWEEN probe touches
     * (e.g. clear Z before approaching in X) where the next probe must not
     * fire until this move has physically finished. The 'jog' dispatch
     * case fires OP_MOVE with _fireAndForget for a UI jog button, where
     * that's fine (nothing waits on it); a probing sequence needs strict
     * ordering, so this awaits the firmware's post-move reply instead,
     * same blocking-until-complete contract as probeAxis().
     *
     * The reply carries NO position payload -- confirmed against real
     * firmware source, not assumed: rsp_handle_move() in
     * fw_m3/Src/easycnc_protocol.c ends with `rsp_reply_ok(seq, op, NULL,
     * 0)` (line ~1353), and the Python FakeFirmware simulator mirrors this
     * exactly (`self._send_rsp(op, defs.ST_OK, b"", req_seq)`). An earlier
     * version of this method called the unused/unverified `codec.parseMove`
     * on the reply body expecting an x/y/z/feed echo -- that payload does
     * not exist and threw ERR_BUFFER_OUT_OF_BOUNDS the first time this was
     * driven against the real simulator. Resolve with the commanded values
     * instead; the caller already has them.
     * @returns {Promise<{x:number,y:number,z:number,feed:number}>}
     */
    _moveAbsolute(x, y, z, feed) {
        if (!this.stream) return Promise.reject(new Error('controller not bound'));
        const mpos = this.state.status.mpos || { x: 0, y: 0, z: 0 };
        const dist = Math.hypot(x - mpos.x, y - mpos.y, z - mpos.z);
        const travelMinutes = dist / Math.max(1, feed);
        const timeout = Math.max(10, travelMinutes * 60 * 1.5 + 5);
        return this.stream.sendCommand(defs.OP_MOVE, codec.buildMove(x, y, z, feed), { timeout }).then((rsp) => {
            const status = rsp.payload[1];
            if (status !== defs.ST_OK) {
                const name = defs.ST_ERR_NAMES[status] || `0x${status.toString(16)}`;
                throw new Error(`move rejected: ${name}`);
            }
            return { x, y, z, feed };
        });
    }

    /**
     * FIX-7: best-effort Z-only retreat after a failed ad-hoc probe (no
     * contact, rejected status, timeout, or link loss), so the bit doesn't
     * sit at the far end of maxTravelMm -- often at or just above the
     * workpiece -- until the next unrelated move happens to clear it. Only
     * moves Z (not X/Y) since a failed probe gives no information about
     * whether a lateral move is obstructed. Deliberately swallows its own
     * failure (e.g. link genuinely down) rather than throwing -- this runs
     * inside a .then()/.catch() tail with nothing left to propagate to, and
     * a failed safety retreat is not itself a new user-facing error.
     */
    _probeFailRetract(reason) {
        if (!this.stream) return;
        const mpos = this.state.status.mpos || { x: 0, y: 0, z: 0 };
        this._moveAbsolute(mpos.x, mpos.y, mpos.z + PROBE_FAIL_RETRACT_MM, PROBE_FAIL_RETRACT_FEED)
            .then(() => {
                this.emit('console', `⚠️ Probe failed (${reason}) -- retracted Z ${PROBE_FAIL_RETRACT_MM}mm as a precaution.`);
            })
            .catch((exc) => {
                logger.warn(`[RSP] probe-fail retract could not complete: ${exc.message || exc}`);
                this.emit('console', `⚠️ Probe failed (${reason}) -- automatic retract ALSO failed (${exc.message || exc}). Check machine position before jogging.`);
            });
    }

    _setFeedOverride(pct) {
        const clamped = Math.min(FEED_OVERRIDE_MAX, Math.max(FEED_OVERRIDE_MIN, pct));
        this._feedOverridePct = clamped;
        if (this.state && this.state.status) {
            this.state.status.feedOverridePct = clamped;
        }
        // Applied by the host, on the lines not yet streamed: the firmware
        // accepts OP_SET_FEED_OVERRIDE but never applies it to a move
        // (easycnc_protocol.c, rsp_feed_override_pct is stored and unused), so
        // sending it changed nothing on the machine. Not sent any more, so a
        // future firmware that does apply it cannot scale the feed twice.
        if (this.job) this.job.setFeedOverride(clamped);
        this.emit('console', `Feed override ${clamped}%${this.job && this.job.active ? ' — takes effect within the next few moves.' : ''}`);
        this.emit('status', this.state);
        this.emit('sender:status', { feedOverridePct: clamped });
    }

    /**
     * @param {string} gcodeText
     * @param {number} [resumeLine] if > 1, skip lines 1..resumeLine-1 (already
     *   run) and start sending from resumeLine instead of line 1.
     */
    /** A file that cannot run correctly is never left loaded (nothing to Start). */
    _setLoadRejected(name, meta) {
        this._loadedGcode = '';
        this._loadedLines = [];
        this._loadedMeta = null;
        this._loadedName = '';
        this._clearResumePoint();
        this.lastLoadResult = { ok: false, name: name || '', meta };
        this.emit('job:loadRejected', {
            name: name || '',
            errorCount: meta.errorCount,
            errors: (meta.errors || []).slice(0, 20),
            warnings: (meta.warnings || []).slice(0, 20),
        });
    }

    _clearPositionUncertain(how) {
        if (!this._positionUncertain) return;
        this._positionUncertain = null;
        logger.info(`[RSP] position-uncertain flag cleared (${how})`);
        this.emit('console', `✅ Position warning cleared (${how}). Resume is allowed again -- make sure the zero is at the job's original origin.`);
        this._emitResumePoint();
    }

    /** Resume preamble uses the same rapid / Z rate / headroom the file was compiled with. */
    _resumeBuildOptions(opts = {}) {
        const o = (this._loadedMeta && this._loadedMeta.options) || {};
        const mpos = (this.state && this.state.status && this.state.status.mpos) || null;
        const ext = this._loadedMeta && this._loadedMeta.extents;
        return {
            safeZMm: opts.safeZ,
            plungeFeedMm: opts.plungeFeed,
            rapidFeedMm: o.rapidFeed,
            zRateMm: o.maxRate ? o.maxRate.z : undefined,
            xRateMm: o.maxRate ? o.maxRate.x : undefined,
            yRateMm: o.maxRate ? o.maxRate.y : undefined,
            zHeadroomMm: o.zHeadroom,
            // the highest Z the program itself uses -- always clear of the work
            fileMaxZMm: ext && ext.max && Number.isFinite(ext.max.z) ? ext.max.z : undefined,
            // so the first move never descends to reach the safe height
            currentZMm: mpos && Number.isFinite(mpos.z) ? mpos.z : undefined,
        };
    }

    /**
     * What Start From Line would do for `line`, without moving anything.
     * Drives the dialog's context view and its "will move to X/Y, plunge to
     * Z" summary, so the operator sees the plan before pressing Start.
     */
    _resumePreview(line, opts) {
        const lines = this._loadedLines;
        const total = lines.length;
        const n = Math.floor(line) || 1;
        const from = Math.max(1, n - 5);
        const to = Math.min(total, n + 5);
        const context = [];
        for (let i = from; i <= to; i++) context.push({ num: i, text: lines[i - 1] });
        const plan = buildResumeProgram(lines, n, this._resumeBuildOptions(opts));
        return {
            line: n,
            total,
            name: this._loadedName,
            context,
            plan: plan.ok
                ? { ok: true, preamble: plan.preamble, startMm: plan.startMm, retractMm: plan.retractMm, units: plan.units, warnings: plan.warnings }
                : { ok: false, error: plan.error },
            resumePoint: this.getResumePoint(),
        };
    }

    /**
     * Start From Line (safe): lift to safe Z in work coordinates, travel to
     * where `line` starts, plunge back to its depth, then run the file from
     * `line`. Reported line numbers stay those of the loaded file.
     */
    _startFromLineSafe(line, opts, { resume = false } = {}) {
        const lines = this._loadedLines;
        const what = resume ? `Resume from line ${line}` : `Start From Line ${line}`;
        const plan = buildResumeProgram(lines, line, this._resumeBuildOptions(opts));
        if (!plan.ok) {
            this.emit('console', `⚠️ ${what} not started: ${plan.error}`);
            return undefined;
        }
        if (this._blockIfPositionUncertain(what)) return undefined;
        const p = plan.startMm;
        logger.info(`[RSP] ${what}: ${plan.preamble.join(' | ')}`);
        this.emit('console', `▶️ ${what}: raise Z to ${plan.retractMm.toFixed(2)} mm, move to X${p.x.toFixed(3)} Y${p.y.toFixed(3)}${p.z === null ? '' : `, lower to Z${p.z.toFixed(3)}`} (mm), then continue.`);
        for (const w of plan.warnings) this.emit('console', `ℹ️ ${w}`);

        // Job line L of the program is file line L + lineOffset.
        const holds = this._holdsForFile(line, plan.lineOffset);
        // Spindle was on at this line: the program stops after the travel, at
        // safe height, so the operator confirms the spindle is running before
        // the tool goes back into the material.
        const spindleIdx = plan.preamble.findIndex((l) => /^M[34]\b/.test(l));
        if (spindleIdx >= 0 && p.z !== null) {
            holds.push({
                line: spindleIdx + 1,
                kind: 'pause',
                message: `Tool is above line ${line}. Make sure the spindle is running at speed, then press Resume to lower the tool and continue`,
            });
        }
        return this._startJob(plan.program.join('\n'), 0, {
            lineOffset: plan.lineOffset,
            lineOffsetMin: line,
            // the preamble's own feeds (lift, travel, slow plunge) are safety
            // choices -- the feed override applies to the program, not to them
            fixedFeedLines: plan.preamble.map((_, idx) => idx + 1),
        }, holds);
    }

    /**
     * Continue a stopped / alarmed job from its saved resume point, always
     * through the safe program (retract, travel, plunge) -- the tool may have
     * been jogged or stopped mid-move since (plan BE-25).
     */
    _resumeFromPoint() {
        const point = this.getResumePoint();
        const line = point.line;
        if (!(line > 1)) return undefined;
        const opts = { safeZ: (this._loadedMeta && this._loadedMeta.options && this._loadedMeta.options.safeHeight) || 10 };
        const st = scanModalState(this._loadedLines, line);
        if (st.pos.x === null || st.pos.y === null) {
            // No X/Y move before the resume point: nothing has been cut yet,
            // running the file from line 1 is the same work.
            if (this._blockIfPositionUncertain(`Resume from line ${line}`)) return undefined;
            this.emit('console', `▶️ Line ${line} is before the first X/Y move -- starting the file from line 1.`);
            this._clearResumePoint();
            return this._startJob(this._loadedGcode, 0, null, this._holdsForFile(1));
        }
        if (point.originChanged) {
            this.emit('console', `⚠️ The work zero was changed after this job stopped. Resuming at line ${line} assumes the SAME zero the job started from.`);
        }
        logger.info(`[RSP] resuming stopped job at line ${line}`);
        return this._startFromLineSafe(line, opts, { resume: true });
    }

    /** Program pauses (M0/M1) and dwells (G4) of the loaded file at or after `fromLine`, as job lines. */
    _holdsForFile(fromLine, lineOffset = 0) {
        return this._holdsFromMeta(this._loadedMeta, fromLine, lineOffset);
    }

    _holdsFromMeta(meta, fromLine = 1, lineOffset = 0) {
        if (!meta) return [];
        const holds = [];
        // Operator choice (preferences.honorProgramPauses, default off): the
        // "Click Continue when the spindle is up to speed" M0 of Buildbotics
        // posts stopped every job at line 5 waiting for Resume. Off = M0/M1
        // run straight through; G4 dwells are still honoured.
        const honorPauses = !!(this._lastCompileOptions && this._lastCompileOptions.honorProgramPauses);
        for (const p of honorPauses ? (meta.pauses || []) : []) {
            if (p.line >= fromLine) holds.push({ line: p.line - lineOffset, kind: 'pause', message: p.message, optional: p.optional });
        }
        for (const d of meta.dwells || []) {
            if (d.line >= fromLine) holds.push({ line: d.line - lineOffset, kind: 'dwell', seconds: d.seconds });
        }
        return holds;
    }

    /** E-STOP: stop motion now, keep position and the resume point. */
    _emergencyStop() {
        this._lastAlarmEmitted = 'estop';
        let stopLine = 0;
        const jobActive = !!(this.job && this.job.active);
        if (jobActive) {
            stopLine = this.job.firmwareLost ? this._resumeLine : this._fileLine(this.job.nextLineToRun());
        }
        // Job abort first: it fills the seqs of cancelled in-flight lines, so
        // E_STOP directly behind it is processed at once instead of waiting on
        // a seq hole. Both are forced past a full window / link blip.
        if (jobActive) {
            this.job.abort();
            const totalLines = this._fileTotalLines();
            if (stopLine > 1 && (!totalLines || stopLine <= totalLines)) this._setResumePoint(stopLine, 'E-STOP');
        }
        try {
            this.stream.sendNowait(defs.OP_E_STOP, Buffer.alloc(0), true, { force: true });
        } catch (exc) {
            logger.error(`[RSP] E-STOP could not be queued: ${exc.message || exc}`);
        }
        this.emit('workflow:state', 'alarm');
        this.emit('console', `🛑 EMERGENCY STOP: motion stopped and drivers disabled.${stopLine > 1 ? ` Resume from line ${stopLine} is saved.` : ''} Check the machine, then Clear Alarm.`);
    }

    /**
     * Is the machine held, or have we just asked it to hold? Telemetry is only
     * 10 Hz, so a resume pressed right after a pause must not be judged on a
     * status frame that predates the hold.
     */
    _firmwareIsHolding() {
        const st = this.state && this.state.status;
        return !!(this._feedHoldSent || (st && (st.state === defs.ST_HOLD || st.feedHold)));
    }

    /** Every OP_FEED_HOLD this controller sends goes through here. */
    _sendFeedHold() {
        this._feedHoldSent = true;
        this._fireAndForget(defs.OP_FEED_HOLD, Buffer.alloc(0));
    }

    _setPositionUncertain(message) {
        this._positionUncertain = { at: Date.now(), message: `Position may be wrong: ${message}.` };
        this._emitResumePoint();
    }

    async _startJob(gcodeText, resumeLine = 0, mapping = null, holds = []) {
        if (!this.job) return;
        if (!gcodeText || !String(gcodeText).trim()) {
            logger.warn('[RSP] gcode:start called but no G-code is loaded -- START is a no-op. Did file:load fire?');
            this.emit('console', '⚠️ START pressed but no G-code is loaded on the controller — re-upload the file.');
            return;
        }
        if (this.state && this.state.status && (this.state.status.state === defs.ST_ALARM || this.state.status.state === defs.ST_ESTOP)) {
            this.emit('console', '⚠️ Cannot start job: Machine is in ALARM or E-STOP state. Clear alarm ($X) first.');
            return;
        }
        // Claim this call's generation. Any earlier, still-in-flight
        // _startJob() call becomes stale the instant a newer one is
        // claimed -- every await point below re-checks this before
        // touching this.job, so a stale call bails instead of resuming
        // and silently uploading/starting superseded G-code.
        const gen = ++this._startJobGeneration;
        this._feedHoldSent = false; // a new run is never a continuation of an old hold
        if (this.job.active) {
            logger.info('[RSP] gcode:start aborting previous active/paused job to restart/resume cleanly');
            this.job.abort();
        }
        if (gen !== this._startJobGeneration) {
            logger.info('[RSP] gcode:start superseded by a newer start request -- bailing out');
            return;
        }

        const lines = String(gcodeText || '').split(/\r?\n/);
        this._lineOffset = mapping ? mapping.lineOffset : 0;
        this._lineOffsetMin = mapping ? mapping.lineOffsetMin : 0;
        // A macro is not the loaded file: its progress must never become the
        // file's resume point, and finishing it must not clear that point.
        this._jobIsMacro = !!(mapping && mapping.macro);
        const firstFileLine = mapping ? mapping.lineOffsetMin : resumeLine;
        // Reset so the G-code panel doesn't show the previous job's last
        // highlighted line for the brief window before the first EV_EXECUTED
        // of this job arrives.
        this._currentLine = firstFileLine > 1 ? firstFileLine - 1 : 0;
        let jobId;
        try {
            const o = (this._loadedMeta && this._loadedMeta.options) || {};
            jobId = this.job.upload(lines, null, {
                holds,
                feedOverridePct: this._feedOverridePct,
                feedLimits: { maxRate: o.maxRate || { x: 5000, y: 5000, z: 3000 }, maxFeed: o.maxFeed || 10000 },
                fixedFeedLines: (mapping && mapping.fixedFeedLines) || [],
            });
        } catch (uploadErr) {
            logger.error(`[RSP] Failed to upload job: ${uploadErr.message || uploadErr}`);
            this.emit('console', `⚠️ Failed to upload job: ${uploadErr.message || uploadErr}`);
            return;
        }
        // Must resume() BEFORE start() kicks the async sender loop -- see
        // JobStream.resume()'s completion-detection fix (job.js) for why
        // lines before resumeLine are marked executed, not just skipped.
        if (typeof resumeLine === 'number' && resumeLine > 1) {
            this.job.resume(resumeLine);
        }
        this.emit('sender:start', {
            jobId,
            total: mapping ? this._fileTotalLines() : lines.length,
            resumedFrom: firstFileLine > 1 ? firstFileLine : undefined,
        });
        // LOW#14: matching job:start for JobHistoryService (see job:end/
        // job:abort/job:error alongside the sender:* emits below).
        const modal = this.getModalState();
        this.emit('job:start', {
            filename: this._loadedName,
            gcode: gcodeText,
            controller: 'RSP',
            wcs: modal.wcs,
            toolNumber: modal.toolNumber,
        });
        this.emit('workflow:state', 'running');

        // OP_JOB_START needs the firmware IDLE. Right after a stop it can
        // still report RUNNING/HOLD for a frame or two; a job left over from
        // an earlier session stays that way until aborted by its own id.
        // (This used to send a blind OP_RESUME and then pretend the state was
        // Idle, which resumed whatever was held.)
        // Jogging and homing count as busy too: the firmware gates OP_JOB_START
        // on SYS_IDLE, so a START pressed while a jog is still finishing was
        // refused outright instead of waiting the half second for it to stop.
        const busy = (s) => s && (s.state === defs.ST_RUNNING || s.state === defs.ST_STREAMING ||
            s.state === defs.ST_STOPPING || s.state === defs.ST_HOLD ||
            s.state === defs.ST_JOGGING || s.state === defs.ST_HOMING);
        if (busy(this.state && this.state.status)) {
            logger.info(`[RSP] Machine is still ${this.state.status.activeState || this.state.status.state} -- waiting for IDLE before starting the job`);
            const startWait = Date.now();
            let abortedOrphan = false;
            let saidWaiting = false;
            // A jog or a homing cycle is motion the operator started and it
            // ends by itself, so wait it out (a long traverse legitimately
            // takes half a minute). Anything else is our own leftover and
            // should be gone in a moment.
            const waitLimitMs = () => {
                const st = this.state.status.state;
                return (st === defs.ST_JOGGING || st === defs.ST_HOMING) ? 60000 : 6000;
            };
            while (busy(this.state.status)) {
                if (gen !== this._startJobGeneration) {
                    logger.info('[RSP] gcode:start superseded by a newer start request while waiting for idle -- bailing out');
                    return;
                }
                // the port can close (or the controller be unbound) while we wait
                if (!this.job || !this.stream) return;
                const waited = Date.now() - startWait;
                if (!saidWaiting && waited > 700) {
                    saidWaiting = true;
                    const st = this.state.status.state;
                    if (st === defs.ST_JOGGING || st === defs.ST_HOMING) {
                        this.emit('console', `⏳ Waiting for ${st === defs.ST_HOMING ? 'homing' : 'the jog'} to finish, then the job will start.`);
                    }
                }
                if (!abortedOrphan && waited > 1500 && this._lastTelemetryJobId !== jobId
                    && this.state.status.state !== defs.ST_JOGGING && this.state.status.state !== defs.ST_HOMING) {
                    abortedOrphan = true;
                    this._lastOrphanAbortAt = 0;
                    this._jobEndedAt = 0;
                    this._abortOrphanJob({ state_name: this.state.status.activeState, job_id: this._lastTelemetryJobId || 0 });
                }
                if (waited > waitLimitMs()) {
                    const reason = `the machine did not become idle (still ${this.state.status.activeState || this.state.status.state})`;
                    logger.warn(`[RSP] job not started: ${reason}`);
                    this.job.failBeforeStart(reason);
                    return;
                }
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        if (gen !== this._startJobGeneration) {
            logger.info('[RSP] gcode:start superseded by a newer start request after idle-wait -- bailing out');
            return;
        }

        this.job.start();
    }

    // ------------------------------------------------------------------
    // optional interface (guarded via typeof at CNCEngine call sites)
    // ------------------------------------------------------------------
    getWorkflowState() {
        if (!this.job) return 'idle';
        if (this.job.active && this.job.paused) return 'paused';
        if (this.job.active) return this.job.stalled ? 'stalled' : 'running';
        return 'idle';
    }

    getSenderStatus() {
        if (!this.job) return null;
        const [executed, total] = this.job.progress;
        return {
            active: this.job.active,
            jobId: this.job.jobId,
            executed,
            total,
            sent: executed,
            // Same field names as _bindJobListeners()'s live 'progress'
            // emit -- this is the initial-sync value sent on socket connect
            // (CNCEngine.js socket.emit('sender:status', ...)), so it must
            // match or the current-line highlight starts wrong on page load
            // until the next executed line arrives.
            received: this._currentLine || 0,
            progress: total > 0 ? Math.round((executed / total) * 100) : 0,
            stalled: this.job.stalled,
            failReason: this.job.failReason,
            feedOverridePct: this._feedOverridePct,
        };
    }

    getHealthMetrics() {
        return {
            linkOk: this.stream ? this.stream.linkOk : false,
            inFlight: this.stream ? this.stream.inFlight : 0,
            lastPongAt: this._lastPongAt,
        };
    }

    getLinkHealth() {
        if (!this.stream) {
            return { linkOk: false, lastRxAgoS: null, heartbeatS: null, heartbeatTimeoutS: null, inFlight: 0, recentEvents: [] };
        }
        return this.stream.getLinkHealth();
    }

    /**
     * Active on-demand link test: sends a real RSP_OP_PING to the firmware
     * right now and waits for its reply, instead of reading passively
     * observed traffic (getLinkHealth()). rsp_handle_ping() just ACKs with
     * an empty payload (fw_m3/Src/easycnc_protocol.c:1173-1176) -- the RSP
     * seq-matching in ReliableStream already guarantees the reply is really
     * this ping's, so RTT is simply send-to-resolve wall time.
     */
    async pingNow() {
        if (!this.stream) {
            return { ok: false, rttMs: null, error: 'no stream (not connected)' };
        }
        const t0 = Date.now();
        try {
            await this.stream.sendCommand(defs.OP_PING, Buffer.alloc(0), { timeout: 2.0 });
            return { ok: true, rttMs: Date.now() - t0, error: null };
        } catch (exc) {
            const reason = (exc instanceof LinkLost) ? 'link down'
                : (exc instanceof RspTimeoutError) ? 'no reply within 2s -- unlinked'
                : (exc.message || String(exc));
            return { ok: false, rttMs: null, error: reason };
        }
    }

    getEventTriggers() {
        return { ...this._eventTriggers };
    }

    getState() {
        return {
            type: this.type,
            status: this.state.status,
            parserstate: this.state.parserstate,
            linkOk: this.stream ? this.stream.linkOk : false,
            job: this.getSenderStatus(),
        };
    }
}

module.exports = { RSPController, ConnectionTransport };
