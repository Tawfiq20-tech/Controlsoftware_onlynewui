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

const FEED_OVERRIDE_MIN = 50.0;
const FEED_OVERRIDE_MAX = 150.0;
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
            this._currentLine = lineNo;
            this.emit('sender:status', {
                total,
                sent: executed,
                received: lineNo,
                progress: total > 0 ? Math.round((executed / total) * 100) : 0,
                remaining: Math.max(0, total - executed),
                lineNo,
                pos: pos || this.state?.status?.mpos || { x: 0, y: 0, z: 0 },
            });
        });
        this.job.on('done', ({ jobId, failReason }) => {
            if (failReason) {
                this._resumeLine = 0;
                this._resumeGcode = null;
                this.emit('sender:error', { jobId, reason: failReason });
                // Plain Error instances lose .message when JSON-serialized over
                // Socket.IO (Error.message is non-enumerable -- JSON.stringify(new
                // Error('x')) === '{}'), so the frontend's controller:error handler
                // renders "Error undefined: undefined". Emit a plain object instead,
                // matching the convention already used in RTSController.js.
                this.emit('error', { message: `RSP job ${jobId} failed: ${failReason}` });
                this.emit('job:error', { message: failReason });
            } else {
                // Clean finish -- clear any resume point so a later START on
                // the same file runs from line 1, not "resume from the end".
                this._resumeLine = 0;
                this._resumeGcode = null;
                this.emit('sender:end', { jobId });
                // LOW#14: JobHistoryService listens for 'job:end'/'job:error'/
                // 'job:abort', not 'sender:*' -- those never existed on this
                // controller, so every run went unrecorded. Fire alongside
                // the existing sender:* emits the frontend already relies on.
                this.emit('job:end', {});
            }
        });
        this.job.on('aborted', () => {
            this.emit('sender:end', { aborted: true });
            this.emit('job:abort');
        });
        this.job.on('failed', (reason) => {
            const stopLine = this.job ? this.job.nextLineToRun() : 0;
            const totalLines = (this.job && this.job.totalLineCount) || 0;
            if (stopLine > 1 && totalLines > 0 && stopLine < totalLines) {
                this._resumeLine = stopLine;
                this._resumeGcode = this._loadedGcode;
            } else {
                this._resumeLine = 0;
                this._resumeGcode = null;
            }
            this.emit('console', `⚠️ Job failed: ${reason}`);
            this.emit('sender:error', { reason });
        });
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
            resumeLine = this.job.nextLineToRun();
            if (resumeLine > 1) {
                this._resumeLine = resumeLine;
                this._resumeGcode = this._loadedGcode;
            }
        }
        return { jobWasActive, resumeLine };
    }

    unbind() {
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
        };
        this.state.parserstate.feedrate = dict.feed;
        this.state.parserstate.spindle = dict.spindle_speed;

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
                
                // If a job was running, capture the resume line immediately and pause!
                if (this.job && this.job.active) {
                    // dict.last_executed_line is firmware's own telemetry
                    // counter, which is chunk-local (resets to 0 on every
                    // OP_JOB_START -- see job.js chunkStartLine's doc) once a
                    // file is split into >60,000-line chunks. Add
                    // chunkStartLine to land on the correct whole-file
                    // resume line instead of jumping back to an early line
                    // in the current chunk.
                    const stopLine = dict.last_executed_line
                        ? (this.job.chunkStartLine + dict.last_executed_line + 1)
                        : this.job.nextLineToRun();
                    if (stopLine > 1) {
                        this._resumeLine = stopLine;
                        this._resumeGcode = this._loadedGcode;
                        logger.info(`[RSP] Job halted by ${alarmType} at line ${stopLine}. Saved resume point.`);
                        this.emit('console', `⚠️ Job paused by ${alarmType.toUpperCase()} at line ${stopLine}. Clear alarm / unlock ($X) and press START to resume.`);
                    }
                    this.job.pause();
                    this.emit('sender:pause');
                }

                this.emit('alarm', {
                    type: alarmType,
                    code: dict.error_code || 0,
                    message: dict.estop_active ? 'E-Stop Triggered'
                        : `${dict.state_name || 'Alarm'} state`,
                    description: 'E-Stop was engaged or the controller entered an alarm/fault state. Click Clear / Unlock to reset.',
                    limitFlags: dict.limit_flags || 0,
                    faultFlags: dict.fault_flags || 0,
                });
            }
        } else {
            this._lastAlarmEmitted = null;
        }

        if (this.job && this.job.active) {
            // EV_EXECUTED is fire-and-forget/lossy (see job.js noteProgress
            // doc) -- telemetry's last_executed_line is the ground truth
            // that self-heals past any dropped event.
            this.job.noteProgress(dict.last_executed_line, dict.job_id);
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
                logger.warn(`[RSP] EV_FAULT axis=${axis} code=${code}`);
                if (this.job && this.job.active) {
                    const stopLine = this.job.nextLineToRun();
                    if (stopLine > 1) {
                        this._resumeLine = stopLine;
                        this._resumeGcode = this._loadedGcode;
                    }
                    this.job.pause();
                    this.emit('sender:pause');
                }
                this.emit('alarm', { type: 'fault', axis, code });
            } else if (op === defs.EV_ESTOP) {
                logger.warn('[RSP] EV_ESTOP received');
                if (this.job && this.job.active) {
                    const stopLine = this.job.nextLineToRun();
                    if (stopLine > 1) {
                        this._resumeLine = stopLine;
                        this._resumeGcode = this._loadedGcode;
                    }
                    this.job.pause();
                    this.emit('sender:pause');
                }
                this.emit('alarm', { type: 'estop' });
            } else if (op === defs.EV_COMM_LOST) {
                logger.warn('[RSP] EV_COMM_LOST received (device entered safe-stop)');
                if (this.job && this.job.active) {
                    const stopLine = this.job.nextLineToRun();
                    if (stopLine > 1) {
                        this._resumeLine = stopLine;
                        this._resumeGcode = this._loadedGcode;
                    }
                    this.job.pause();
                    this.emit('sender:pause');
                }
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
            this._dispatch(cmd, args);
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

        switch (cmd) {
            case 'jog': {
                const p = args[0] || {};
                const feed = p.feedRate || 500;
                const axes = [
                    ['x', AXIS_X], ['y', AXIS_Y], ['z', AXIS_Z],
                ];
                const requested = axes.filter(([key]) => p[key] !== undefined && p[key] !== null && p[key] !== 0);
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
                this._fireAndForget(defs.OP_HOME, codec.buildHome(AXIS_MASK_ALL));
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
                        this.emit('console', '[RSP] Alarm cleared / unlocked ($X)');
                        if (this._resumeLine > 1) {
                            this.emit('console', `▶️ Machine ready. Press START to resume from line ${this._resumeLine}.`);
                        }
                    })
                    .catch((exc) => {
                        this.emit('console', `⚠️ [RSP] Unlock command failed: ${exc.message || exc}. Machine may still be alarmed -- do not assume it is safe to run.`);
                    });
                break;
            }

            case 'reset':
                this._lastAlarmEmitted = null;
                this._fireAndForget(defs.OP_SOFT_RESET, Buffer.alloc(0));
                this.emit('console', '[RSP] Soft reset sent.');
                break;

            // Was missing entirely -- Header.tsx's "E-Stop" button and
            // HomingOverlay's abort button both call command('estop'), which
            // fell to the silent unknown-command default (no OP sent, no
            // error surfaced, operator believed it worked). OP_E_STOP has a
            // real firmware handler (rsp_handle_estop, allowlisted through
            // the alarm gate) -- just wire it.
            case 'estop':
                this._lastAlarmEmitted = null;
                this._fireAndForget(defs.OP_E_STOP, Buffer.alloc(0));
                this.emit('console', '🛑 [RSP] E-Stop sent.');
                break;

            case 'feedhold':
                this._fireAndForget(defs.OP_FEED_HOLD, Buffer.alloc(0));
                if (this.job) this.job.pause();
                break;

            case 'cyclestart':
                this._fireAndForget(defs.OP_RESUME, Buffer.alloc(0));
                if (this.job) this.job.resume();
                break;

            case 'wcs:zero': {
                const p = args[0] || {};
                let mask = 0;
                if (p.x !== undefined) mask |= AXIS_BIT_X;
                if (p.y !== undefined) mask |= AXIS_BIT_Y;
                if (p.z !== undefined) mask |= AXIS_BIT_Z;
                if (!mask) mask = AXIS_MASK_ALL;
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(mask));
                break;
            }
            case 'wcs:zeroAll':
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(AXIS_MASK_ALL));
                break;

            case 'gcode:load': {
                const [name, gcode, spindleDelaySeconds] = args;
                const incoming = gcode || '';
                // If a job is still active (e.g. user stopped mid-carve but
                // the JobStream hasn't fully wound down yet), abort it now so
                // the new file can be started cleanly -- without this the old
                // job's `active` flag stays true and _startJob() rejects the
                // next START with "a job is already running".
                if (this.job && this.job.active) {
                    logger.info('[RSP] gcode:load — aborting previous active job before loading new file');
                    this.job.abort();
                }
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
                    this._loadedGcode = text;
                    if (arcCount > 0) {
                        logger.info(`[RSP] gcode:load linearized ${arcCount} arc(s) into ${segmentCount} G1 segments`);
                        this.emit('console', `ℹ️ Converted ${arcCount} arc(s) into ${segmentCount} line segments for this machine (your file is unchanged).`);
                    }
                    if (insertedCount > 0) {
                        logger.info(`[RSP] gcode:load inserted ${insertedCount} spindle spin-up dwell(s) (G4 P${spindleDelaySeconds}) after M3/M4`);
                        this.emit('console', `ℹ️ Added a ${spindleDelaySeconds}s spindle spin-up dwell after each M3/M4 (your file is unchanged).`);
                    }
                } catch (err) {
                    logger.warn(`[RSP] gcode:load arc linearization failed: ${err.message}`);
                    this.emit('console', `⚠️ Could not load "${this._loadedName}": ${err.message}`);
                    this._loadedGcode = '';
                    this._loadedName = '';
                    break;
                }
                // Power-cut recovery is now handled by JobResumeService,
                // which intercepts at a higher level. Here we just treat
                // every load as a fresh start for the volatile in-session
                // resume bookkeeping.
                this._resumeLine = 0;
                this._resumeGcode = null;
                logger.info(`[RSP] gcode:load "${this._loadedName}" (${this._loadedGcode.length} bytes)`);
                break;
            }

            case 'gcode:unload':
                if (this.job && this.job.active) this.job.abort();
                this._loadedGcode = '';
                this._loadedName = '';
                this._resumeLine = 0;
                this._resumeGcode = null;
                break;

            case 'gcode:start': {
                const totalLines = (this.job && this.job.totalLineCount) || 0;
                if (this._resumeGcode !== null && this._resumeGcode === this._loadedGcode && this._resumeLine > 1) {
                    if (totalLines > 0 && this._resumeLine > totalLines) {
                        logger.info(`[RSP] resumeLine ${this._resumeLine} exceeds total lines ${totalLines}, starting fresh from line 1`);
                        this._resumeLine = 0;
                        this._resumeGcode = null;
                        this._startJob(this._loadedGcode);
                    } else {
                        logger.info(`[RSP] gcode:start resuming stopped job at line ${this._resumeLine}`);
                        this.emit('console', `▶️ Resuming from line ${this._resumeLine} (where it was stopped).`);
                        this._startJob(this._loadedGcode, this._resumeLine);
                    }
                } else {
                    this._startJob(this._loadedGcode);
                }
                break;
            }

            case 'gcode:startFromLine': {
                const lineNumber = args[0];
                this._startJob(this._loadedGcode, typeof lineNumber === 'number' ? lineNumber : 0);
                break;
            }

            case 'gcode:pause':
                if (this.job) this.job.pause();
                this._fireAndForget(defs.OP_FEED_HOLD, Buffer.alloc(0));
                this.emit('sender:pause');
                break;

            case 'gcode:resume':
                if (this.job) this.job.resume();
                this._fireAndForget(defs.OP_RESUME, Buffer.alloc(0));
                break;

            case 'gcode:stop': {
                // Capture the resume point BEFORE abort() -- nextLineToRun()
                // still reflects real progress at this instant; abort()
                // doesn't touch it, but the NEXT upload() (a fresh start)
                // would reset it to 1, so it has to be saved out here.
                const stopLine = this.job ? this.job.nextLineToRun() : 0;
                const totalLines = (this.job && this.job.totalLineCount) || 0;
                if (this.job) this.job.abort();
                if (stopLine > 1 && (!totalLines || stopLine <= totalLines)) {
                    this._resumeLine = stopLine;
                    this._resumeGcode = this._loadedGcode;
                    this.emit('console', `⏹️ Stopped at line ${stopLine}. Press START to resume from here, or load a new file to restart.`);
                } else {
                    this._resumeLine = 0;
                    this._resumeGcode = null;
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
                const [content] = args;
                this._startJob(content || '');
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
        this._fireAndForget(defs.OP_SET_FEED_OVERRIDE, codec.buildFeedOverride(clamped));
    }

    /**
     * @param {string} gcodeText
     * @param {number} [resumeLine] if > 1, skip lines 1..resumeLine-1 (already
     *   run) and start sending from resumeLine instead of line 1.
     */
    async _startJob(gcodeText, resumeLine = 0) {
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
        if (this.job.active) {
            logger.info('[RSP] gcode:start aborting previous active/paused job to restart/resume cleanly');
            this.job.abort();
            await new Promise(r => setTimeout(r, 100));
        }
        if (gen !== this._startJobGeneration) {
            logger.info('[RSP] gcode:start superseded by a newer start request during post-abort settle -- bailing out');
            return;
        }
        // If the machine is still running or actively decelerating from a
        // just-aborted move (ST_STOPPING), wait for it to actually reach
        // ST_IDLE before pipelining the next job's moves. ST_STOPPING was
        // previously NOT in this condition -- a job aborted immediately
        // before this call could leave the machine still winding down while
        // this code treated it as already idle and started sending.
        if (this.state && this.state.status && (
            this.state.status.state === defs.ST_RUNNING ||
            this.state.status.state === defs.ST_STREAMING ||
            this.state.status.state === defs.ST_STOPPING
        )) {
            logger.info(`[RSP] Machine is still in state ${this.state.status.activeState || this.state.status.state} -- waiting for motion to complete before starting job...`);
            const startWait = Date.now();
            while (this.state.status && (
                this.state.status.state === defs.ST_RUNNING ||
                this.state.status.state === defs.ST_STREAMING ||
                this.state.status.state === defs.ST_STOPPING
            )) {
                if (gen !== this._startJobGeneration) {
                    logger.info('[RSP] gcode:start superseded by a newer start request while waiting for idle -- bailing out');
                    return;
                }
                if (Date.now() - startWait > 8000) {
                    logger.warn('[RSP] Timed out waiting for machine to become idle before starting job.');
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
            }
        }
        if (gen !== this._startJobGeneration) {
            logger.info('[RSP] gcode:start superseded by a newer start request after idle-wait -- bailing out');
            return;
        }
        const lines = String(gcodeText || '').split(/\r?\n/);
        // Reset so the G-code panel doesn't show the previous job's last
        // highlighted line for the brief window before the first EV_EXECUTED
        // of this job arrives.
        this._currentLine = resumeLine > 1 ? resumeLine - 1 : 0;
        let jobId;
        try {
            jobId = this.job.upload(lines);
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
        this.emit('sender:start', { jobId, total: lines.length, resumedFrom: resumeLine > 1 ? resumeLine : undefined });
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
        this.job.start();
    }

    // ------------------------------------------------------------------
    // optional interface (guarded via typeof at CNCEngine call sites)
    // ------------------------------------------------------------------
    getWorkflowState() {
        if (!this.job) return 'idle';
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
