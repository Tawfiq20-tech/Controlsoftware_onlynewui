/**
 * JobStream: streams one compiled program to the RSP firmware as ONE firmware
 * job and keeps an exact record of what the machine has really executed.
 *
 * Rebuilt 2026-09-16 (plan r2, Batch B). What the previous version got wrong,
 * each one a way a long job ended early, resumed at the wrong line, or hung:
 *
 *  - Chunking (BE-6). Files over 60,000 lines were split into separate
 *    firmware jobs. OP_JOB_END makes the firmware drop to IDLE and switch the
 *    drivers off before the next OP_JOB_START -- mid-carve. Now a file is one
 *    job; wire line numbers are the file line modulo 65536 (the firmware only
 *    echoes them back) and are resolved here against what has been sent.
 *
 *  - Over-credit (BE-7). The firmware answers a no-motion line (M3, T1, G17)
 *    with EV_EXECUTED the moment it is RECEIVED, while earlier moves are still
 *    queued, and its telemetry last_executed_line then points past moves that
 *    have not run. Crediting "every line up to last_executed_line" put resume
 *    points past uncut lines and let the credit gate overfill the planner.
 *    Now only motion lines count: a motion line is done when its EV_EXECUTED
 *    (or a later motion line's) arrives, or telemetry proves it; the resume
 *    point is the contiguous watermark of done lines.
 *
 *  - Failure paths (BE-3). A stall sent OP_JOB_END (a clean finish) and
 *    reported 'done', which wiped the resume point; a rejected line never told
 *    the firmware to stop. Every failure now sends OP_JOB_ABORT and emits
 *    'failed' only, so the controller keeps the resume point.
 *
 *  - Stall detection (BE-19). "No EV_EXECUTED for 90 s" also fired on one long
 *    slow move. Now a stall means no line finished AND telemetry shows no
 *    motion at all.
 *
 *  - Program pauses (BE-14). M0/M1 were streamed as no-ops, so "Click Continue
 *    when the spindle is up to speed" (Buildbotics posts) cut with the spindle
 *    off. Streaming stops at a pause line; once every move before it has run
 *    the job holds until resume(). G4 dwells wait on the host the same way.
 *
 * Two-level acknowledgement is unchanged: the device ACKs a line into its
 * planner (ReliableStream) and emits EV_EXECUTED when the line's move ends.
 */
'use strict';

const EventEmitter = require('events');
const codec = require('./codec');
const defs = require('./defs');
const { FT_EVT } = require('./frame');
const { LinkLost } = require('./stream');
const { cleanGcodeLines } = require('../../lib/resumeFromLine');

// Sender tick: batch sends, watermark, holds, stall/link checks.
const TICK_MS = 10;

// Firmware text buffer is char[64] (rsp_handle_job_line); longer lines were
// silently truncated, which can drop an axis word.
const MAX_LINE_BYTES = 63;

// Coalesce 'progress' emits (they drive a socket broadcast per emit).
const PROGRESS_EMIT_MS = 100;

// Mirrors parse_gcode_text(): a line is a move when any X/Y/Z letter is
// followed by something strtof() reads as a number.
const MOTION_RE = /[XYZ]\s*[-+]?(?:\d|\.\d|inf|nan)/i;
// Compiled cutting move: "G21 G90 G1 [X..] [Y..] [Z..] F.."
const CUT_LINE_RE = /^G21 G90 G1((?: [XYZ]-?\d+\.\d+)+) F(\d+(?:\.\d)?)(.*)$/;
const AXIS_RE = /([XYZ])(-?\d+\.\d+)/g;

function isMotionLine(text) {
    return MOTION_RE.test(text);
}

function now() {
    return Date.now() / 1000;
}

class JobAborted extends Error {}

function defaultLogger() {
    return {
        debug: () => {},
        info: (...a) => console.log('[rsp.job]', ...a),
        warn: (...a) => console.warn('[rsp.job]', ...a),
        error: (...a) => console.error('[rsp.job]', ...a),
    };
}

class JobStream extends EventEmitter {
    constructor(stream, options = {}) {
        super();
        this.stream = stream;
        this._log = options.logger || defaultLogger();
        // Device planner capacity in MOVES (easycnc_protocol.c MOVE_RING_DEPTH
        // = 8). The executing leg counts too, so the ring never overflows.
        this._depth = Math.max(1, options.depth ?? 8);
        this._generation = 0;
        this._lastJobId = 0;
        this._tickHandle = null;
        this._resetState();

        this._onStreamEvent = this._onStreamEvent.bind(this);
        this._onStreamReject = this._onStreamReject.bind(this);
        this._onStreamGaveUp = this._onStreamGaveUp.bind(this);
        this.stream.on('event', this._onStreamEvent);
        this.stream.on('reject', this._onStreamReject);
        this.stream.on('gaveUp', this._onStreamGaveUp);
    }

    _resetState() {
        this._lines = [];
        this._isMotion = new Uint8Array(1);     // [abs line] -> 1 if a move
        this._motionPrefix = new Uint32Array(1); // [n] -> moves in lines 1..n
        this._total = 0;
        this._jobId = 0;
        this._startLine = 1;       // first line this run streams (resume skips earlier ones)
        this._sentUpTo = 0;        // lines 1..sentUpTo handed to the stream
        this._motionDoneUpTo = 0;  // every move at or before this line has executed
        this._watermark = 0;       // every line at or before this is done
        this._fwJobStarted = false; // OP_JOB_START acknowledged by the device
        this._active = false;
        this._started = false;
        this._paused = false;
        this._aborted = false;
        this._finishing = false;
        this._failReason = null;
        this._firmwareLost = null; // reason the device dropped the job (alarm, E-stop)
        this._holds = [];          // [{line, kind, seconds, message, optional}] sorted by line
        this._holdIdx = 0;         // next hold not yet reached
        this._activeHold = null;   // {line, kind, until?, message, optional}
        this._lastProgressAt = 0;
        this._lastActivityAt = 0;
        this._lastTelSig = '';
        this._stalled = false;
        this._linkDownSince = null;
        this._lastConfirmedPos = { x: 0, y: 0, z: 0 };
        this._progressEmittedAt = 0;
        this._progressDirty = false;
        this._feedScale = 1;               // feed override, applied to lines not yet sent
        this._fixedFeedLines = new Set();  // lines the override must not scale (resume plunge)
        this._feedLimits = null;           // {maxRate:{x,y,z}, maxFeed} for re-clamping
        this._sendPos = { x: null, y: null, z: null }; // position as sent (for the clamp)
        this._overrideClamped = 0;
    }

    // ------------------------------------------------------------------
    get totalLineCount() { return this._total; }
    get active() { return this._active; }
    /** Held by the operator, by a program pause (M0/M1), or by a lost firmware job. */
    get paused() { return this._paused || (!!this._activeHold && this._activeHold.kind === 'pause'); }
    get jobId() { return this._jobId; }
    get failReason() { return this._failReason; }
    get stalled() { return this._stalled; }
    get lines() { return this._lines; }
    get programPause() { return this._activeHold && this._activeHold.kind === 'pause' ? { ...this._activeHold } : null; }
    get firmwareLost() { return this._firmwareLost; }
    /** Kept for callers of the chunked version; a file is one job now. */
    get chunkStartLine() { return 0; }

    /** Every line up to and including this one has been executed. */
    get watermark() { return this._watermark; }

    get executed() {
        const s = new Set();
        for (let i = 1; i <= this._watermark; i++) s.add(i);
        return s;
    }

    get acked() { return new Set(); }

    get progress() { return [this._watermark, this._total]; }

    get lastConfirmedPos() { return { ...this._lastConfirmedPos }; }

    /** First line not known to have executed -- the exact resume point. */
    nextLineToRun() {
        return this._watermark + 1;
    }

    plannerState() {
        return {
            lastExecuted: this._watermark,
            firstUnconfirmed: this._watermark + 1,
            inPlannerCount: Math.max(0, this._sentUpTo - this._watermark),
        };
    }

    resetProgress() {
        if (this._active) return;
        const lastJobId = this._lastJobId;
        this._resetState();
        this._lastJobId = lastJobId;
    }

    // ------------------------------------------------------------------
    /**
     * Prepare a job. Returns its job id.
     * @param {string[]} lines program lines (compiled wire text)
     * @param {number|null} jobId
     * @param {{holds?: Array<{line:number, kind:'pause'|'dwell', seconds?:number, message?:string, optional?:boolean}>}} [opts]
     */
    upload(lines, jobId = null, opts = {}) {
        if (this._active) {
            throw new Error('job already active');
        }
        // Same cleaning as lib/resumeFromLine.js, so line numbers reported to
        // the UI index the same list Start From Line slices.
        const clean = cleanGcodeLines(lines.join('\n'));
        for (let i = 0; i < clean.length; i++) {
            if (Buffer.byteLength(clean[i], 'utf8') > MAX_LINE_BYTES) {
                throw new Error(`line ${i + 1} is longer than the machine's ${MAX_LINE_BYTES}-byte limit: ${clean[i].slice(0, 80)}`);
            }
        }
        // A tick of the previous job that is mid-flight must not touch this one.
        this._generation += 1;
        this._stopTick();
        const lastJobId = this._lastJobId;
        this._resetState();

        const n = clean.length;
        this._lines = clean;
        this._total = n;
        this._isMotion = new Uint8Array(n + 2);
        this._motionPrefix = new Uint32Array(n + 1);
        for (let i = 1; i <= n; i++) {
            const m = isMotionLine(clean[i - 1]) ? 1 : 0;
            this._isMotion[i] = m;
            this._motionPrefix[i] = this._motionPrefix[i - 1] + m;
        }

        // Never reuse the previous id: telemetry and late EV_EXECUTED of the
        // job just stopped would be credited to this one. 0 is never used.
        let id = (jobId !== null && jobId !== undefined) ? (jobId & 0xFFFF) : (Math.floor(Date.now() / 1000) & 0xFFFF);
        if (id === 0 || id === lastJobId) id = ((lastJobId + 1) & 0xFFFF) || 1;
        this._jobId = id;
        this._lastJobId = id;

        this._feedLimits = opts.feedLimits || null;
        this._feedScale = Math.max(0.1, Math.min(2, (Number(opts.feedOverridePct) || 100) / 100));
        // Lines the feed override must NOT touch: the resume preamble's slow
        // plunge back into the cut is a deliberate safety feed, not part of the
        // program's cutting speed. At 200% it would have gone in twice as fast.
        this._fixedFeedLines = new Set((opts.fixedFeedLines || []).map((n) => Math.floor(n)));
        this._holds = (opts.holds || [])
            .filter((h) => h && h.line >= 1 && h.line <= n)
            .map((h) => ({
                line: Math.floor(h.line),
                kind: h.kind === 'dwell' ? 'dwell' : 'pause',
                seconds: Math.max(0, Number(h.seconds) || 0),
                message: h.message || '',
                optional: !!h.optional,
            }))
            .sort((a, b) => a.line - b.line);

        this._active = true;
        this._lastProgressAt = now();
        this._lastActivityAt = now();
        // Interleaving normal-cadence heartbeats with pipelined lines slowed
        // the firmware; the stream still sends a keepalive when the wire has
        // been quiet for 2 s (firmware host watchdog is 5 s).
        try {
            this.stream.setHeartbeatPaused(true);
        } catch (_) { /* non-fatal */ }
        return this._jobId;
    }

    /** Begin streaming (after upload). Safe against double invocation. */
    start() {
        if (!this._active || this._started) return;
        this._started = true;
        this._runSenderLoop(this._generation);
    }

    /**
     * resume(fromLine > 0) before start(): skip lines 1..fromLine-1 (already
     * cut). resume() / resume(0) while running: continue after a pause.
     */
    resume(fromLine = 0) {
        if (!this._active) return;
        if (fromLine > 0 && !this._started) {
            const from = Math.min(Math.max(1, Math.floor(fromLine)), this._total + 1);
            this._startLine = from;
            this._sentUpTo = from - 1;
            this._motionDoneUpTo = from - 1;
            this._watermark = from - 1;
            while (this._holdIdx < this._holds.length && this._holds[this._holdIdx].line < from) this._holdIdx++;
        }
        if (this._activeHold) {
            // Resume also skips the rest of a G4 wait: an operator watching a
            // machine sit still needs a way to carry on, especially when a
            // post wrote milliseconds and the file asks for minutes.
            this._log.info(`${this._activeHold.kind === 'dwell' ? 'dwell' : 'program pause'} at line ${this._activeHold.line} released`);
            this._activeHold = null;
            this._holdIdx++;
        }
        this._paused = false;
        this._lastProgressAt = now();
        this._lastActivityAt = now();
        this._stalled = false;
    }

    pause() {
        if (!this._active) return;
        this._paused = true;
    }

    /** The job was uploaded but could not be started; the resume point stays where it was. */
    failBeforeStart(reason) {
        if (!this._active || this._started) return;
        this._fail(reason, { sendAbort: false });
    }

    /**
     * The device dropped this job on its own (driver alarm, E-stop, lost
     * host): its planner is cleared and further lines would be refused. Hold
     * the host side at the exact watermark; the controller restarts from
     * nextLineToRun() with a fresh job.
     */
    markFirmwareLost(reason) {
        if (!this._active) return;
        if (!this._firmwareLost) this._log.warn(`device dropped job ${this._jobId}: ${reason}`);
        this._firmwareLost = reason || 'device stopped the job';
        this._paused = true;
    }

    /**
     * Operator stop. Tells the firmware to stop now (forced past a full
     * window or a link blip) and keeps the watermark for resume.
     * @returns {boolean} true if a job was active
     */
    abort() {
        if (!this._active) return false;
        this._aborted = true;
        this._endLocal();
        this._sendAbortFrame();
        this.emit('aborted');
        return true;
    }

    destroy() {
        this._stopTick();
        this.stream.removeListener('event', this._onStreamEvent);
        this.stream.removeListener('reject', this._onStreamReject);
        this.stream.removeListener('gaveUp', this._onStreamGaveUp);
    }

    // ------------------------------------------------------------------
    // A job is stalled only when no line finished AND telemetry shows the
    // machine not moving for this long. A single long move is not a stall.
    static get STALL_WARN_S() { return 15.0; }
    static get STALL_ABORT_S() { return 60.0; }
    // Link silence tolerated mid-job before failing it (resume point kept).
    // The stream keeps sending keepalives meanwhile.
    static get LINK_GRACE_S() { return 15.0; }

    async _runSenderLoop(gen) {
        try {
            await this._sendJobStart();
        } catch (exc) {
            if (gen === this._generation && this._active) this._fail(String(exc.message || exc), { sendAbort: false });
            return;
        }
        if (gen !== this._generation || !this._active) return;
        this._fwJobStarted = true;
        this._lastProgressAt = now();
        this._lastActivityAt = now();
        this._tickHandle = setInterval(() => this._tick(gen), TICK_MS);
        if (typeof this._tickHandle.unref === 'function') this._tickHandle.unref();
    }

    _stopTick() {
        if (this._tickHandle) {
            clearInterval(this._tickHandle);
            this._tickHandle = null;
        }
    }

    _tick(gen) {
        if (gen !== this._generation || !this._active) {
            this._stopTick();
            return;
        }
        const t = now();
        this._advanceWatermark(t);
        if (this._progressDirty && (t * 1000 - this._progressEmittedAt) >= PROGRESS_EMIT_MS) this._emitProgress(t);

        if (this._watermark >= this._total) {
            this._stopTick();
            this._finishJob(gen);
            return;
        }

        if (this._firmwareLost) return; // waiting for the controller to restart the job

        this._checkHolds(t);
        if (this._activeHold || this._paused) {
            this._lastProgressAt = t;
            this._stalled = false;
            return;
        }

        if (!this.stream.linkOk) {
            if (this._linkDownSince === null) {
                this._linkDownSince = t;
                this._log.warn(`link down mid-job -- waiting up to ${JobStream.LINK_GRACE_S}s for it to recover`);
            }
            const downFor = t - this._linkDownSince;
            if (downFor >= JobStream.LINK_GRACE_S) {
                this._fail(`lost contact with the machine for ${downFor.toFixed(0)} s`);
            }
            return;
        }
        if (this._linkDownSince !== null) {
            this._log.info(`link recovered after ${(t - this._linkDownSince).toFixed(1)}s, continuing job`);
            this._linkDownSince = null;
            this._lastProgressAt = t;
        }

        this._sendNextBatch(gen);
        this._checkStall(t);
    }

    _inPlanner() {
        return this._motionPrefix[this._sentUpTo] - this._motionPrefix[this._motionDoneUpTo];
    }

    _sendNextBatch(gen) {
        const hold = this._holds[this._holdIdx];
        const limit = hold ? Math.min(hold.line, this._total) : this._total;
        while (this._sentUpTo < limit) {
            if (gen !== this._generation || !this._active) break;
            const next = this._sentUpTo + 1;
            // Execution credits: ACK means "accepted", not "slot freed".
            if (this._isMotion[next] && this._inPlanner() >= this._depth) break;
            if (this.stream.available <= 0) break;
            const payload = codec.buildJobLine(this._jobId, next & 0xFFFF, this._wireText(next));
            let seq;
            try {
                seq = this.stream.sendNowait(defs.OP_JOB_LINE, payload);
            } catch (exc) {
                if (exc instanceof LinkLost) break;
                throw exc;
            }
            if (seq < 0) break;
            if (this._isMotion[next]) this._trackSentPos(this._lines[next - 1]);
            this._sentUpTo = next;
        }
    }

    /**
     * Feed override (plan C11): the firmware stores OP_SET_FEED_OVERRIDE but
     * never applies it to a move, so "150%" changed nothing on the machine.
     * Every compiled cutting line carries an explicit F, so the host scales
     * that F on the lines it has not sent yet -- it takes effect as soon as
     * the planner works through the few queued moves, with no firmware change.
     * Rapids (G0) are not scaled, and no move ever goes above the machine's
     * per-axis maximum rate.
     * @param {number} pct 10..200
     */
    setFeedOverride(pct) {
        const scale = Math.max(0.1, Math.min(2, (Number(pct) || 100) / 100));
        this._feedScale = scale;
    }

    /** Position as streamed so far -- the baseline the override's rate clamp needs. */
    _trackSentPos(text) {
        AXIS_RE.lastIndex = 0;
        let a;
        while ((a = AXIS_RE.exec(text)) !== null) this._sendPos[a[1].toLowerCase()] = parseFloat(a[2]);
    }

    /** Wire text for line `n`, with the feed override applied. */
    _wireText(n) {
        const text = this._lines[n - 1];
        if (this._feedScale === 1 || !this._isMotion[n] || this._fixedFeedLines.has(n)) return text;
        const m = CUT_LINE_RE.exec(text);
        if (!m) return text; // rapid or a line shape the compiler did not produce
        const axes = m[1];
        const f = parseFloat(m[2]);
        const to = { ...this._sendPos };
        AXIS_RE.lastIndex = 0;
        let a;
        while ((a = AXIS_RE.exec(axes)) !== null) to[a[1].toLowerCase()] = parseFloat(a[2]);
        let limit = this._feedLimits ? this._feedLimits.maxFeed : 10000;
        if (this._feedLimits) {
            let len2 = 0;
            const d = {};
            for (const k of ['x', 'y', 'z']) {
                d[k] = (to[k] !== null && this._sendPos[k] !== null) ? to[k] - this._sendPos[k] : 0;
                len2 += d[k] * d[k];
            }
            const len = Math.sqrt(len2);
            if (len > 0) {
                for (const k of ['x', 'y', 'z']) {
                    const rate = this._feedLimits.maxRate[k];
                    if (Math.abs(d[k]) > 1e-9 && rate > 0) limit = Math.min(limit, (rate * len) / Math.abs(d[k]));
                }
            }
            // An axis whose start is not known yet could be moving alone.
            for (const k of ['x', 'y', 'z']) {
                if (this._sendPos[k] === null && to[k] !== null && this._feedLimits.maxRate[k] > 0) {
                    limit = Math.min(limit, this._feedLimits.maxRate[k]);
                }
            }
        }
        const scaled = Math.max(1, Math.min(f * this._feedScale, limit));
        if (scaled < f * this._feedScale - 0.05) this._overrideClamped += 1;
        // The compiler guaranteed the ORIGINAL line fits the firmware's 63-byte
        // buffer. A scaled feed can be longer ("F1000" -> "F1176.5"), and a line
        // over the limit is truncated on the wire -- losing an axis word and
        // cutting to the wrong place. Shorten the feed, then give up the
        // override for this one line rather than send something truncated.
        let out = `G21 G90 G1${axes} F${String(Math.round(scaled * 10) / 10)}${m[3]}`;
        if (out.length > MAX_LINE_BYTES) out = `G21 G90 G1${axes} F${String(Math.max(1, Math.round(scaled)))}${m[3]}`;
        if (out.length > MAX_LINE_BYTES) return text;
        return out;
    }

    /** Advance the contiguous done-watermark over finished moves and the no-motion lines between them. */
    _advanceWatermark(t = now()) {
        let w = this._watermark;
        const top = this._sentUpTo;
        while (w < top) {
            const n = w + 1;
            if (this._isMotion[n] && n > this._motionDoneUpTo) break;
            w = n;
        }
        if (w !== this._watermark) {
            this._watermark = w;
            this._lastProgressAt = t;
            this._stalled = false;
            this._progressDirty = true;
        }
    }

    _checkHolds(t) {
        const a = this._activeHold;
        if (a && a.kind === 'dwell') {
            if (t >= a.until) {
                this._activeHold = null;
                this._holdIdx++;
                this.emit('dwellDone', { line: a.line });
            }
            return;
        }
        if (a) return;
        const h = this._holds[this._holdIdx];
        if (!h || this._watermark < h.line) return;
        if (h.kind === 'dwell') {
            if (h.seconds <= 0) { this._holdIdx++; return; }
            this._activeHold = { ...h, until: t + h.seconds };
            this.emit('dwell', { line: h.line, seconds: h.seconds });
        } else {
            this._activeHold = { ...h };
            this.emit('programPause', { line: h.line, message: h.message, optional: h.optional });
        }
    }

    _checkStall(t) {
        if (!this._fwJobStarted) return;
        const idle = Math.min(t - this._lastProgressAt, t - this._lastActivityAt);
        this._stalled = idle >= JobStream.STALL_WARN_S;
        if (idle >= JobStream.STALL_ABORT_S) {
            this._fail(`no line finished and the machine did not move for ${idle.toFixed(0)} s (stopped at line ${this._watermark + 1})`);
        }
    }

    async _sendJobStart() {
        const op = defs.OP_JOB_START;
        const payload = codec.buildJobStart(this._jobId, Math.min(this._total, 0xFFFF));
        const rsp = await this.stream.sendCommand(op, payload, { timeout: 3.0 });
        if (!rsp || !rsp.payload || rsp.payload.length < 2) {
            throw new Error('Device returned invalid or empty reply to OP_JOB_START');
        }
        const status = rsp.payload[1];
        if (status !== defs.ST_OK) {
            const statusName = defs.ST_ERR_NAMES[status] || `0x${status.toString(16).padStart(2, '0')}`;
            const hint = status === defs.ST_ERR_STATE ? ' -- the machine is not idle (alarm, E-stop or still moving)' : '';
            throw new Error(`machine refused to start the job: ${statusName}${hint}`);
        }
    }

    async _finishJob(gen) {
        if (this._finishing) return;
        this._finishing = true;
        this._emitProgress(now());
        try {
            await this.stream.sendCommand(defs.OP_JOB_END, codec.buildJobEnd(this._jobId), { timeout: 5.0 });
        } catch (exc) {
            // Every line has executed; the controller's orphan-job check
            // aborts the device job if this never arrived.
            this._log.warn(`job end not acknowledged: ${exc.message || exc}`);
        }
        if (gen !== this._generation || !this._active) return;
        const jobId = this._jobId;
        this._endLocal();
        this.emit('done', { jobId, failReason: null });
    }

    /** Local teardown shared by finish / abort / fail. */
    _endLocal() {
        this._active = false;
        this._paused = false;
        this._activeHold = null;
        this._stalled = false;
        this._stopTick();
        try {
            this.stream.setHeartbeatPaused(false);
        } catch (_) { /* non-fatal */ }
    }

    /**
     * Stop, abort frame after it. Unacknowledged lines of this job are never
     * (re)sent once the host has ended the job -- the machine must not move
     * after "stopped". Their seqs are filled with PINGs so the abort is not
     * held behind them (stream.cancelPending).
     */
    _sendAbortFrame() {
        const jobId = this._jobId;
        try {
            this.stream.cancelPending((p) => p.payload[0] === defs.OP_JOB_LINE &&
                p.payload.length >= 3 && p.payload.readUInt16LE(1) === jobId, { fill: true });
        } catch (exc) {
            this._log.warn(`could not cancel in-flight lines: ${exc.message || exc}`);
        }
        try {
            this.stream.sendNowait(defs.OP_JOB_ABORT, codec.buildJobAbort(this._jobId), true, { force: true });
        } catch (exc) {
            this._log.warn(`could not queue job abort: ${exc.message || exc}`);
        }
    }

    /** Job cannot continue: stop the device, keep the watermark, report. */
    _fail(reason, { sendAbort = true } = {}) {
        if (!this._active) return;
        this._log.warn(`job ${this._jobId} failed at line ${this._watermark + 1}: ${reason}`);
        this._failReason = reason;
        this._endLocal();
        if (sendAbort) this._sendAbortFrame();
        this.emit('failed', reason);
    }

    _emitProgress(t) {
        this._progressDirty = false;
        this._progressEmittedAt = t * 1000;
        this.emit('progress', {
            executed: this._watermark,
            total: this._total,
            lineNo: this._watermark,
            pos: this._lastConfirmedPos,
        });
    }

    // ------------------------------------------------------------------
    /** Wire line number (u16) -> program line, or 0 if it is not a line this job sent. */
    _resolveLine(wire) {
        const top = this._sentUpTo;
        if (top <= 0 || typeof wire !== 'number') return 0;
        const abs = top - ((top - wire) & 0xFFFF);
        return abs >= this._startLine && abs <= top ? abs : 0;
    }

    _creditMotionThrough(abs) {
        const upTo = Math.min(abs, this._sentUpTo);
        if (upTo > this._motionDoneUpTo) {
            this._motionDoneUpTo = upTo;
            this._lastActivityAt = now();
        }
    }

    _payloadJobId(payload) {
        return payload && payload.length >= 3 ? payload.readUInt16LE(1) : null;
    }

    _onStreamEvent(f) {
        if (f.frameType !== FT_EVT || !f.payload || !f.payload.length) return;
        if (f.payload[0] === defs.EV_EXECUTED) this._onExecuted(f);
    }

    _onExecuted(f) {
        if (!this._fwJobStarted) return;
        let parsed;
        try {
            parsed = codec.parseEvExecuted(f.payload.subarray(1));
        } catch (_) {
            return;
        }
        if (parsed.jobId !== this._jobId) return; // a previous job's straggler
        if (!this._active) {
            // A move that finished between Stop and the firmware receiving the
            // abort really was cut: move the stopped job's resume point past it
            // so resume does not cut it again. (upload() resets _fwJobStarted,
            // so a new job never sees these.)
            if (!this._aborted && !this._failReason) return;
            const abs = this._resolveLine(parsed.lineNo);
            if (!abs || !this._isMotion[abs]) return;
            const before = this._watermark;
            this._motionDoneUpTo = Math.max(this._motionDoneUpTo, Math.min(abs, this._sentUpTo));
            this._lastConfirmedPos = { x: parsed.x, y: parsed.y, z: parsed.z };
            this._advanceWatermark();
            if (this._watermark !== before) this.emit('lateProgress', { nextLine: this._watermark + 1 });
            return;
        }
        const abs = this._resolveLine(parsed.lineNo);
        if (!abs) return;
        if (!this._isMotion[abs]) return; // receipt of a no-motion line, not execution
        // Moves run strictly in order: this one finishing means every earlier
        // move finished, even if its own EV_EXECUTED was lost.
        this._creditMotionThrough(abs);
        this._lastConfirmedPos = { x: parsed.x, y: parsed.y, z: parsed.z };
        this._advanceWatermark();
        // Refill the planner now rather than on the next tick: with short
        // raster moves a 10 ms wait leaves the machine idling between lines.
        if (!this._paused && !this._activeHold && !this._firmwareLost && this.stream.linkOk) {
            this._sendNextBatch(this._generation);
        }
    }

    /**
     * Feed every telemetry frame. Heals lost EV_EXECUTED events and tracks
     * machine activity for stall detection.
     */
    noteTelemetry(dict) {
        if (!this._active || !dict) return;
        const t = now();
        // What counts as "the machine is alive" is CHANGE, never a flag: the
        // step engine's own active flag stays set on a leg that is stuck (the
        // firmware cannot tell), so trusting it would disable stall detection
        // exactly when it is needed. dbg_steps_done counts up inside a leg and
        // x/y/z move when one finishes; a held machine is deliberately still.
        const sig = `${dict.dbg_steps_done}|${dict.dbg_steps_total}|${dict.x}|${dict.y}|${dict.z}`;
        if (sig !== this._lastTelSig || dict.state === defs.ST_HOLD) this._lastActivityAt = t;
        this._lastTelSig = sig;

        if (!this._fwJobStarted || dict.job_id !== this._jobId) return;
        const abs = this._resolveLine(dict.last_executed_line);
        if (!abs) return;
        if (this._isMotion[abs]) {
            // last_executed_line names a move only when that move completed.
            this._creditMotionThrough(abs);
        } else if (dict.state === defs.ST_RUNNING && dict.planner_depth === 0 && !dict.dbg_jog_active) {
            // It names a no-motion line the device has received. With nothing
            // queued and nothing moving, every move before it has run.
            this._creditMotionThrough(abs);
        }
        this._advanceWatermark(t);
    }

    /** Back-compat for callers that only have the line number. */
    noteProgress(lastLine, telemetryJobId = null) {
        if (telemetryJobId === null || telemetryJobId === undefined) return;
        const abs = this._resolveLine(lastLine);
        if (!this._active || !this._fwJobStarted || telemetryJobId !== this._jobId || !abs || !this._isMotion[abs]) return;
        this._creditMotionThrough(abs);
        this._advanceWatermark();
    }

    _onStreamReject({ op, reasonName, payload }) {
        if (!this._active) return;
        if (op !== defs.OP_JOB_LINE && op !== defs.OP_JOB_END) return;
        if (payload && this._payloadJobId(payload) !== this._jobId) return;
        // After an alarm/E-stop the lines still in flight bounce; the resume
        // point is already set, nothing more to do.
        if (this._firmwareLost) return;
        this._fail(`machine refused a job line (${reasonName})`);
    }

    _onStreamGaveUp({ op, payload }) {
        if (!this._active) return;
        if (op !== defs.OP_JOB_LINE && op !== defs.OP_JOB_START) return;
        if (payload && this._payloadJobId(payload) !== this._jobId) return;
        this._fail('a job line could not be delivered to the machine (USB link)');
    }
}

module.exports = {
    JobAborted,
    JobStream,
    isMotionLine,
    MAX_LINE_BYTES,
};
