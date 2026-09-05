/**
 * JobStream: reliable job streaming on top of ReliableStream.
 *
 * Faithful port of the Python reference (backend/rsp/job.py from
 * fw_m3_control_sw) -- same two-level ack model, same windowed pipelining,
 * same pause/resume/abort + resume-from-last-executed-line semantics, same
 * stall thresholds and reasoning preserved verbatim in comments below.
 *
 * Concurrency model differs the same way stream.js differs from stream.py:
 * Python's `_sender_loop` ran on a dedicated thread, blocking on a
 * threading.Condition while "blocked" (credit-gated or fully sent) and
 * waking on EV_EXECUTED/EV_JOB_DONE/note_progress(). Node has no threads,
 * so the loop becomes a periodic tick (setInterval) that no-ops while
 * blocked instead of condvar-waiting, and reacts to EV_EXECUTED/EV_JOB_DONE
 * via the ReliableStream's 'event' EventEmitter channel instead of a
 * direct callback wire-up from Machine. No locks are needed (single
 * threaded), so every `with self._lock:` block below has no JS equivalent.
 *
 * Sends an entire G-code file as a sequence of RSP job lines with two-level
 * acknowledgement:
 *   - device ACKs each line once accepted into its planner (windowed)
 *   - device emits EV_EXECUTED(job, line) once each line actually runs
 *
 * The engine keeps an `executed` ledger so a resumable job can answer
 * "exactly what has run" after a comm drop. It implements:
 *   - windowed pipelining (up to `window` lines in flight)
 *   - retransmission on RTO / SEQ_GAP / BUFFER NAK (all handled by the
 *     underlying ReliableStream)
 *   - pause / resume / abort
 *   - resume-from-last-executed-line recovery
 */
'use strict';

const EventEmitter = require('events');
const codec = require('./codec');
const defs = require('./defs');
const { FT_EVT } = require('./frame');
const { LinkLost } = require('./stream');

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

// Tick cadence for the sender loop (batch sends + stall/finish checks).
// Python used a 5ms sleep on the actively-sending path and 0.1s/2.0s
// condvar waits while blocked (paused / credit-gated); a single fast tick
// here is simpler and cheap since each tick that has nothing to do is an
// O(1) no-op.
const TICK_MS = 10;

// Firmware's job line numbers are a wire-level uint16_t -- confirmed
// 2026-09-05 while diagnosing a stalled 465,862-line job: codec.js's
// buildJobLine/parseEvExecuted both truncate to 16 bits, and firmware
// itself stores line_no as uint16_t (QueuedMove.line_no, rsp_last_executed_line,
// rsp_send_executed() in easycnc_protocol.c) -- it's not a host-only limit.
// Once a single job's line numbers exceed 65,535 they wrap and collide with
// an earlier line number already in this._executed, permanently capping its
// size and wedging the execution-credit gate in _tick()/_sendNextBatch()
// below, which times out as a false "no progress" stall. Splitting any long
// file into sequential JOB_START/JOB_END chunks, each well under that
// ceiling, sidesteps the wire-format limit entirely -- no firmware change,
// no protocol version bump, each chunk is just an ordinary job like before.
const MAX_LINES_PER_CHUNK = 60000;

class JobStream extends EventEmitter {
    constructor(stream, options = {}) {
        super();
        this.stream = stream;
        this._log = options.logger || defaultLogger();
        this._depth = Math.max(1, options.depth ?? 8); // device planner capacity (execution credits)

        this._lines = [];
        // Chunking state (see MAX_LINES_PER_CHUNK above). this._lines holds
        // only the CURRENT chunk; this._allLines is the whole file. Every
        // other field below (_sentUpTo, _executed, _sentLines, _nextLine,
        // _jobId) is chunk-local and gets reset by _advanceChunk()/resume()
        // -- callers that need a whole-file-relative number (progress,
        // nextLineToRun, plannerState) add _chunkStartLine/_completedBeforeChunk.
        this._allLines = [];
        this._totalLineCount = 0;
        this._chunkStartLine = 0;
        this._completedBeforeChunk = 0;
        this._baseJobId = 0;
        this._jobId = 0;
        this._sentUpTo = 0;          // next line index to transmit
        this._executed = new Set();  // line numbers that completed (EV_EXECUTED)
        this._acked = new Set();     // line numbers accepted by device (reserved for parity; not populated, mirrors Python which also never populates it)
        this._sentLines = new Set(); // line numbers sent to the device's planner (sent but not necessarily executed)
        this._active = false;
        this._paused = false;
        this._aborted = false;
        this._nextLine = 1;
        this._jobDone = false;
        this._started = false;
        this._reconciledUpto = 0;    // watermark for noteProgress()
        this._failReason = null;
        this._lastProgressAt = 0.0;  // monotonic time of last executed-set change
        this._stalled = false;       // no progress for STALL_WARN_S, still trying
        this._linkDownSince = null;  // set while waiting out a link drop, see LINK_GRACE_S
        // Bumped on every upload(). The tick loop captures its generation
        // at start and refuses to touch this._lines/_jobId/_sentUpTo/etc.
        // once it goes stale -- see abort()+upload() race note in upload()
        // for why _aborted alone can't gate this.
        this._generation = 0;
        // Last confirmed position from EV_EXECUTED events (x, y, z).
        // Used by the checkpoint system to capture where the tool was.
        this._lastConfirmedPos = { x: 0, y: 0, z: 0 };

        this._tickHandle = null;

        // Wire EV_EXECUTED / EV_JOB_DONE straight off the stream's generic
        // 'event' channel (Python's Machine did this wiring externally via
        // on_event=job._on_executed-dispatch; folding it in here keeps
        // JobStream self-contained).
        this._onStreamEvent = this._onStreamEvent.bind(this);
        this.stream.on('event', this._onStreamEvent);
    }

    // ------------------------------------------------------------------
    get active() {
        return this._active;
    }

    get paused() {
        return this._paused;
    }

    get jobId() {
        return this._jobId;
    }

    get executed() {
        return new Set(this._executed);
    }

    get acked() {
        return new Set(this._acked);
    }

    get progress() {
        return [this._completedBeforeChunk + this._executed.size, this._totalLineCount];
    }

    get failReason() {
        return this._failReason;
    }

    get stalled() {
        return this._stalled;
    }

    /** Last confirmed machine position from EV_EXECUTED. */
    get lastConfirmedPos() {
        return { ...this._lastConfirmedPos };
    }

    // Offset of the current chunk's line 1 within the whole file. Firmware's
    // own telemetry (EV_STATUS's last_executed_line) is chunk-local -- it
    // resets to 0 on every OP_JOB_START (easycnc_protocol.c
    // rsp_handle_job_start(), rsp_last_executed_line = 0) -- so any caller
    // combining that raw telemetry value with a whole-file line number (e.g.
    // to compute a resume point) must add this offset first, exactly like
    // nextLineToRun() does internally.
    get chunkStartLine() {
        return this._chunkStartLine;
    }

    /** First not-yet-executed line (for resume), absolute across all chunks. */
    nextLineToRun() {
        return this._chunkStartLine + this._nextLine;
    }

    /**
     * Planner buffer state — used by the checkpoint system to determine
     * the correct resume point accounting for lines that were ACK'd
     * (accepted into the device's planner) but not yet confirmed as
     * executed. After a pause/stop, these lines may or may not have
     * actually run on the device.
     *
     * @returns {{ lastExecuted: number, firstUnconfirmed: number, inPlannerCount: number }}
     */
    plannerState() {
        const lastExecuted = this._chunkStartLine + this._nextLine - 1;
        // Find the earliest line that was sent but NOT executed.
        let firstUnconfirmed = this._chunkStartLine + this._nextLine;
        for (const ln of this._sentLines) {
            const abs = this._chunkStartLine + ln;
            if (!this._executed.has(ln) && abs < firstUnconfirmed) {
                firstUnconfirmed = abs;
            }
        }
        // Count lines in the planner (sent but not executed).
        let inPlannerCount = 0;
        for (const ln of this._sentLines) {
            if (!this._executed.has(ln)) inPlannerCount++;
        }
        return { lastExecuted, firstUnconfirmed, inPlannerCount };
    }

    // ------------------------------------------------------------------
    /**
     * Validate + start streaming a job. Returns jobId.
     * @param {string[]} lines
     * @param {number|null} jobId
     */
    upload(lines, jobId = null) {
        const clean = lines
            .map((l) => l.trim())
            .filter((l) => l && !(l.startsWith(';') || l.startsWith('(') || l.startsWith('%')));
        if (this._active) {
            throw new Error('job already active');
        }
        // A just-aborted job's tick can be between "decided not blocked, go
        // send" and actually calling _sendNextBatch() -- at that instant
        // _aborted is still about to be checked against THIS job's fields
        // below, not the old job's. Bumping the generation here, and having
        // the stale tick compare its captured generation before every send,
        // is what actually stops it (mirrors a real race found in the
        // Python version via trace: a leftover job1 sender sent a JOB_LINE
        // carrying job2's id+gcode before job2's own JOB_START went out).
        this._generation += 1;
        this._allLines = clean;
        this._totalLineCount = clean.length;
        this._chunkStartLine = 0;
        this._completedBeforeChunk = 0;
        this._lines = clean.length > MAX_LINES_PER_CHUNK ? clean.slice(0, MAX_LINES_PER_CHUNK) : clean;
        this._baseJobId = jobId !== null && jobId !== undefined ? jobId : (Math.floor(Date.now() / 1000) & 0xFFFF);
        this._jobId = this._baseJobId;
        this._sentUpTo = 0;
        this._executed = new Set();
        this._acked = new Set();
        this._sentLines = new Set();
        this._nextLine = 1;
        this._active = true;
        this._paused = false;
        this._aborted = false;
        this._jobDone = false;
        this._started = false;
        this._reconciledUpto = 0;
        this._failReason = null;
        this._lastProgressAt = now();
        this._stalled = false;
        this._lastConfirmedPos = { x: 0, y: 0, z: 0 };
        this._linkDownSince = null;
        // Interleaving FT_HB heartbeats with pipelined job lines slows/stalls
        // the firmware's move execution -- suppress them for the job's
        // duration (matches job.py's upload()).
        try {
            this.stream.setHeartbeatPaused(true);
        } catch (exc) {
            // non-fatal -- worst case heartbeats keep running during the job
        }
        return this._jobId;
    }

    /**
     * Begin streaming (after upload). Guarded against double-invocation: a
     * caller re-entering start() (e.g. a double-click or a retried API
     * call) must not spawn a second sender loop racing the first and
     * double-sending OP_JOB_START.
     */
    start() {
        if (!this._active || this._started) return;
        this._started = true;
        const gen = this._generation;
        this._runSenderLoop(gen);
    }

    /** Resume from the given line (0 = next un-executed), absolute across all chunks. */
    resume(fromLine = 0) {
        if (!this._active) return;
        if (fromLine > 0) {
            // fromLine is absolute across the whole file (see nextLineToRun()),
            // not just the current chunk -- a checkpoint resume can land
            // several chunks past upload()'s default chunk 0, e.g. line
            // 200,000 of a 465,862-line file split into 60,000-line chunks.
            // Re-derive which chunk that falls in and re-slice _allLines
            // directly instead of streaming/skipping through earlier chunks.
            const chunkIdx = Math.floor((fromLine - 1) / MAX_LINES_PER_CHUNK);
            this._chunkStartLine = chunkIdx * MAX_LINES_PER_CHUNK;
            this._completedBeforeChunk = this._chunkStartLine;
            this._lines = this._allLines.slice(this._chunkStartLine, this._chunkStartLine + MAX_LINES_PER_CHUNK);
            this._jobId = (this._baseJobId + chunkIdx) & 0xFFFF;
            const localFromLine = fromLine - this._chunkStartLine; // 1-based, within this chunk
            // Lines before localFromLine are being deliberately skipped
            // (already ran in an earlier stopped attempt), not just left
            // unsent -- _tick()'s completion check is
            // `_executed.size >= _lines.length`, so without marking them
            // here that size can never reach the total and a genuinely-
            // finished chunk spins until STALL_ABORT_S (90s) and reports a
            // false "no progress" failure instead of finishing cleanly. See
            // RSPController.js's gcode:stop/gcode:start resume-from-stop
            // feature for the caller.
            this._executed = new Set();
            for (let ln = 1; ln < localFromLine; ln++) this._executed.add(ln);
            this._nextLine = localFromLine;
            this._sentUpTo = Math.max(0, localFromLine - 1);
            this._sentLines = new Set();
            this._jobDone = false;
            this._reconciledUpto = 0;
        }
        this._lastProgressAt = now();
        this._stalled = false;
        this._paused = false;
        this._aborted = false;
    }

    pause() {
        this._paused = true;
        this._lastProgressAt = now();
    }

    abort() {
        this._aborted = true;
        this._paused = false;
        // The tick loop breaks out on _aborted WITHOUT going through
        // _finishJob() (that path is job-completion only), so nothing else
        // would ever clear _active -- upload() would refuse every future
        // job with "job already active" until process restart.
        this._active = false;
        const jobId = this._jobId;
        this._stopTick();
        try {
            this.stream.setHeartbeatPaused(false);
        } catch (exc) {
            // non-fatal
        }
        this.emit('aborted');
        // Best-effort notify the firmware to drop its planner NOW. Without
        // this, lines already accepted into the device's planner keep
        // executing after the host has abandoned the job, emitting
        // EV_EXECUTED/EV_JOB_DONE for a job_id nothing is listening for --
        // the job_id guards in _onExecuted()/_onJobDone() below stop those
        // stragglers from being credited to whatever job runs next, but
        // sending JOB_ABORT is what stops them at the source.
        try {
            this.stream.sendNowait(defs.OP_JOB_ABORT, codec.buildJobAbort(jobId));
        } catch (exc) {
            if (!(exc instanceof LinkLost)) throw exc;
        }
    }

    destroy() {
        this._stopTick();
        this.stream.removeListener('event', this._onStreamEvent);
    }

    // ------------------------------------------------------------------
    // A job is only ever declared stalled after this much continuous time
    // with zero forward progress (no EV_EXECUTED, no noteProgress()
    // advance, no EV_JOB_DONE). STALL_WARN_S is when the UI first sees a
    // warning; STALL_ABORT_S is when the host gives up waiting on the
    // device.
    //
    // Widened 2026-08-27: firmware now ramps accel/decel per move (up to
    // 200 steps at up to 3ms/step tapering to cruise) instead of stepping
    // at constant commanded feed -- individual in-material moves,
    // especially short ones near a corner, legitimately take longer
    // wall-clock time now. The old 8s/30s thresholds were already
    // borderline per field reports (false "device may be stuck" warnings
    // on real jobs with no actual stall); the ramp made that worse.
    // 20s/90s gives real slow-but-alive moves headroom while still
    // catching a genuinely dead device.
    static get STALL_WARN_S() { return 20.0; }
    static get STALL_ABORT_S() { return 90.0; }

    // Tawfiq msg11378 (2026-08-31): field logs showed the RSP link
    // genuinely flapping (heartbeat silence >3s, see stream.js's
    // heartbeatS*3.0 check) during real jobs, and _tick() killed the job
    // outright on the very first tick it observed stream.linkOk===false --
    // no retry, no wait to see if it was a transient blip. stream.js
    // already self-heals the moment any rx arrives (_onData's "rx while
    // link down -- link restored" path) or a reconnect succeeds
    // (_onTransportError's periodic transport.reconnect()), so the fix
    // here is to give it a bounded window to do that before giving up,
    // the same way STALL_ABORT_S already gives a genuinely-stuck device
    // time before the host gives up on it. Kept shorter than
    // STALL_ABORT_S -- a dead link is a different, usually faster-recovering
    // failure mode (cable reseat / driver hiccup) than a wedged planner.
    static get LINK_GRACE_S() { return 15.0; }

    async _runSenderLoop(gen) {
        try {
            await this._sendJobStart();
        } catch (exc) {
            this._onSenderError(gen, exc);
            return;
        }
        if (gen !== this._generation || this._aborted) return;
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
        if (this._aborted || gen !== this._generation) {
            this._stopTick();
            return;
        }
        if (this._paused) {
            return; // just wait for the next tick
        }
        if (this._jobDone || this._executed.size >= this._lines.length) {
            this._stopTick();
            this._finishJob();
            return;
        }
        // "blocked" = nothing new CAN be pushed right now, either because
        // the whole file is already transmitted, or the execution-credit
        // gate (_sendNextBatch) refuses to send more until the device
        // works through its planner. The credit-gated case used to fall
        // straight through to _sendNextBatch() -- a guaranteed no-op while
        // blocked -- and spin with NO stall/link check, so a device that
        // died mid-job (not just at the tail) was invisible to this loop
        // even after the stream itself declared LinkLost.
        const allSent = this._sentUpTo >= this._lines.length;
        const creditBlocked = (this._sentUpTo - this._executed.size) >= this._depth;
        if (allSent || creditBlocked) {
            if (!this.stream.linkOk) {
                // Give the link LINK_GRACE_S to self-heal (stream.js already
                // retries the transport and revives linkOk the moment rx or
                // a reconnect succeeds) before treating it as fatal -- see
                // LINK_GRACE_S's comment for why the old instant-abort was
                // wrong.
                if (this._linkDownSince === null) {
                    this._linkDownSince = now();
                    this._log.warn(
                        `link down mid-job -- waiting up to ${JobStream.LINK_GRACE_S}s ` +
                        'for it to recover before aborting'
                    );
                }
                const downFor = now() - this._linkDownSince;
                if (downFor >= JobStream.LINK_GRACE_S) {
                    this._stopTick();
                    this._onSenderError(gen, new LinkLost(`link down for ${downFor.toFixed(0)}s mid-job, gave up`));
                    return;
                }
                return; // keep waiting -- next tick re-checks stream.linkOk
            }
            if (this._linkDownSince !== null) {
                this._log.info(
                    `link recovered after ${(now() - this._linkDownSince).toFixed(1)}s, ` +
                    'resuming job'
                );
                this._linkDownSince = null;
            }
            const idle = now() - this._lastProgressAt;
            this._stalled = idle >= JobStream.STALL_WARN_S;
            if (this._jobDone || this._executed.size >= this._lines.length) {
                this._stopTick();
                this._finishJob();
                return;
            }
            if (idle >= JobStream.STALL_ABORT_S) {
                this._log.warn(
                    `execution stalled at ${this._executed.size}/${this._lines.length} for ` +
                    `${idle.toFixed(0)}s -- giving up`
                );
                this._failReason = `no progress for ${idle.toFixed(0)}s ` +
                    `(${this._executed.size}/${this._lines.length} executed)`;
                this._stopTick();
                this._finishJob();
                return;
            }
            return;
        }
        this._sendNextBatch(gen);
    }

    _onSenderError(gen, exc) {
        this._log.warn(`job stream interrupted: ${exc.message || exc}`);
        if (gen === this._generation) {
            this._active = false;
            this._failReason = String(exc.message || exc);
            this.emit('failed', this._failReason);
        }
    }

    async _sendJobStart() {
        const op = defs.OP_JOB_START;
        const payload = codec.buildJobStart(this._jobId, this._lines.length);
        await this.stream.sendCommand(op, payload);
    }

    /**
     * Send lines while the device has execution credit (planner room) and
     * the transport window has space.
     */
    _sendNextBatch(gen) {
        while (true) {
            if (this._aborted || gen !== this._generation) break;
            if (this._sentUpTo >= this._lines.length) break;
            // execution credits: ACK != slot freed -- never let
            // sent-but-not-executed lines exceed the planner depth,
            // otherwise every top-up ends in BUFFER NAK + backoff
            if (this._sentUpTo - this._executed.size >= this._depth) break;
            if (this.stream.available <= 0) break;
            const idx = this._sentUpTo;
            const lineNo = idx + 1;
            const gcode = this._lines[idx];
            const payload = codec.buildJobLine(this._jobId, lineNo, gcode);
            const seq = this.stream.sendNowait(defs.OP_JOB_LINE, payload);
            if (seq < 0) break; // window full
            this._sentLines.add(lineNo);
            this._sentUpTo += 1;
        }
    }

    /**
     * Reposition onto the next chunk of _allLines after the current chunk's
     * JOB_END. Returns false once _allLines is exhausted (real end of file).
     */
    _advanceChunk() {
        const nextStart = this._chunkStartLine + this._lines.length;
        if (nextStart >= this._allLines.length) return false;
        this._completedBeforeChunk = nextStart;
        this._chunkStartLine = nextStart;
        this._lines = this._allLines.slice(nextStart, nextStart + MAX_LINES_PER_CHUNK);
        const chunkIdx = Math.floor(this._chunkStartLine / MAX_LINES_PER_CHUNK);
        this._jobId = (this._baseJobId + chunkIdx) & 0xFFFF;
        this._sentUpTo = 0;
        this._executed = new Set();
        this._acked = new Set();
        this._sentLines = new Set();
        this._nextLine = 1;
        this._jobDone = false;
        this._reconciledUpto = 0;
        return true;
    }

    async _finishJob() {
        try {
            await this.stream.sendCommand(defs.OP_JOB_END, codec.buildJobEnd(this._jobId));
        } catch (exc) {
            this._log.warn(`job end failed: ${exc.message || exc}`);
        }
        // More of the file left past this chunk (see MAX_LINES_PER_CHUNK) --
        // start the next chunk's own JOB_START/tick loop instead of
        // declaring the whole job done. Failures here go through the same
        // _onSenderError() path _runSenderLoop() uses for chunk 0.
        if (this._advanceChunk()) {
            const gen = this._generation;
            try {
                await this._sendJobStart();
            } catch (exc) {
                this._onSenderError(gen, exc);
                return;
            }
            if (gen !== this._generation || this._aborted) return;
            this._lastProgressAt = now();
            this._stalled = false;
            this._tickHandle = setInterval(() => this._tick(gen), TICK_MS);
            if (typeof this._tickHandle.unref === 'function') this._tickHandle.unref();
            return;
        }
        try {
            this.stream.setHeartbeatPaused(false);
        } catch (exc) {
            // non-fatal
        }
        this._active = false;
        this._stalled = false;
        this.emit('done', { jobId: this._jobId, failReason: this._failReason });
    }

    // ------------------------------------------------------------------
    _onStreamEvent(f) {
        if (f.frameType !== FT_EVT || !f.payload || !f.payload.length) return;
        const op = f.payload[0];
        if (op === defs.EV_EXECUTED) {
            this._onExecuted(f);
        } else if (op === defs.EV_JOB_DONE) {
            this._onJobDone(f);
        }
    }

    /** Called on EV_EXECUTED. */
    _onExecuted(f) {
        let parsed;
        try {
            parsed = codec.parseEvExecuted(f.payload.subarray(1));
        } catch (exc) {
            return;
        }
        // A previous job's already-accepted planner lines can keep
        // executing after abort() (firmware only stops on JOB_ABORT, which
        // is best-effort/non-blocking) -- without this guard their
        // EV_EXECUTED events get silently credited to whatever job is
        // active NOW, corrupting its executed-set.
        if (parsed.jobId !== this._jobId) return;
        this._executed.add(parsed.lineNo);
        this._sentLines.delete(parsed.lineNo); // confirmed executed — no longer "in planner"
        this._nextLine = Math.max(this._nextLine, parsed.lineNo + 1);
        this._lastConfirmedPos = { x: parsed.x, y: parsed.y, z: parsed.z };
        this._lastProgressAt = now();
        this._stalled = false;
        // executed/total/lineNo must be whole-file-absolute, not chunk-local
        // -- RSPController._bindJobListeners() forwards these straight
        // through as sender:status's progress-bar (total/sent) and
        // current-line highlight (received/lineNo) fields. Emitting the
        // chunk-local this._executed.size/this._lines.length/parsed.lineNo
        // here would reset the progress bar to 0% and jump the highlighted
        // line backward at every MAX_LINES_PER_CHUNK boundary.
        this.emit('progress', {
            executed: this._completedBeforeChunk + this._executed.size,
            total: this._totalLineCount,
            lineNo: this._chunkStartLine + parsed.lineNo,
            pos: this._lastConfirmedPos,
        });
    }

    /** Called on EV_JOB_DONE. */
    _onJobDone(f) {
        let jobId;
        try {
            jobId = codec.parseEvJobDone(f.payload.subarray(1));
        } catch (exc) {
            return;
        }
        if (jobId !== this._jobId) return;
        this._jobDone = true;
        this._lastProgressAt = now();
        this._stalled = false;
    }

    /**
     * Reconcile execution credits from a reliable ground-truth source.
     *
     * EV_EXECUTED is a fire-and-forget EVT frame (see stream.js's frame
     * contract) -- unlike CMD/ACK/NAK/RSP it is never retried, so a single
     * dropped EV_EXECUTED permanently desyncs the executed-set from what
     * the device actually did, wedging _sendNextBatch()'s execution-credit
     * gate forever (sentUpTo - executed.size never drops below depth). The
     * device's own EV_STATUS telemetry carries `last_executed_line` as a
     * running high-water mark, independent of the lossy EVT channel --
     * trust it to self-heal past any gap. Idempotent + monotonic: only
     * walks forward from the last-seen watermark, so repeated calls with
     * the same or stale lastLine are cheap no-ops.
     */
    noteProgress(lastLine) {
        if (lastLine <= this._reconciledUpto) return;
        const start = this._reconciledUpto + 1;
        this._reconciledUpto = Math.max(this._reconciledUpto, lastLine);
        let changed = false;
        for (let ln = start; ln <= lastLine; ln++) {
            if (!this._executed.has(ln)) {
                this._executed.add(ln);
                changed = true;
            }
        }
        if (lastLine + 1 > this._nextLine) {
            this._nextLine = lastLine + 1;
        }
        if (changed) {
            this._lastProgressAt = now();
            this._stalled = false;
        }
    }
}

module.exports = {
    JobAborted,
    JobStream,
};
