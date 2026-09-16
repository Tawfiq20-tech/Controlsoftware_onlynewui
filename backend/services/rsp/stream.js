/**
 * ReliableStream: host-side reliability engine for RSP over USB-CDC.
 *
 * Faithful port of the Python reference (backend/rsp/stream.py from
 * fw_m3_control_sw) -- SAME guarantees, SAME wire contract, SAME bug-fix
 * comments preserved verbatim below because they document real incidents
 * (stall-vs-heartbeat link-down, SEQ_GAP livelock, rx-error-storm, stale-
 * session catch-up). Only the concurrency model differs: Python used a
 * background thread polling transport.recv()/blocking condvars; Node is
 * single-threaded and event-driven, so:
 *   - inbound bytes arrive via the transport's 'data' event (pushed in,
 *     not polled) and are fed straight into the FrameParser
 *   - the periodic retransmit/stall/heartbeat sweep runs on a
 *     setInterval(TICK_MS) tick instead of a thread loop
 *   - sendCommand() returns a Promise (resolved on FT_RSP, rejected on
 *     timeout/LinkLost) instead of blocking on a threading.Condition
 *   - no locks are needed (no other thread can interleave)
 *
 * Guarantees:
 *   - no data loss        -> windowed transmission + retransmission on RTO
 *   - no corruption       -> CRC32 validated by the device; corrupted -> NAK -> resend
 *   - no duplication      -> every (re)send keeps its seq; duplicate ACKs ignored
 *   - strict ordering     -> seq enforced; a SEQ_GAP makes the host resend from the gap
 *   - flow control        -> device NAKs with ST_ERR_BUFFER when its planner is full;
 *                            the engine backs off and retries; telemetry exposes
 *                            buffer_fill_pct / planner_depth for the UI
 *
 * Wire contract (device side implements the mirror):
 *   - Every CMD carries F_ACK and a seq. Device replies ACK(seq) once the
 *     command is accepted (validated + buffered), or NAK(seq, reason).
 *   - Device executes buffered job lines strictly in seq order; each
 *     completed line emits EV_EXECUTED(job_id, line_no, x, y, z).
 *   - If the device has not been heard from for >3*heartbeat, the link is
 *     declared dead (LinkLost) -- callers decide recovery.
 *   - If a single command has been outstanding (unresolved by ACK/RSP) for
 *     longer than `stallTimeoutS`, the link is declared dead even if the
 *     device keeps validly NAK-ing it with ST_ERR_BUFFER. A device that is
 *     genuinely, permanently stuck (planner never drains) still replies
 *     with well-formed NAKs forever -- that resets the per-command retry
 *     counter on every NAK (see _handleNak), so pure retry-count
 *     exhaustion never fires and the heartbeat-liveness check never fires
 *     either (NAKs count as valid rx traffic). Without this, a stuck
 *     device produces an infinite, silent resend loop with no error ever
 *     surfaced to the caller.
 */
'use strict';

const EventEmitter = require('events');
const defs = require('./defs');
const {
    FT_ACK, FT_CMD, FT_EVT, FT_HB, FT_NAK, FT_RSP,
    F_ACK, FrameParser, buildFrame,
} = require('./frame');

// Transport-level window (frames in flight). Job streaming additionally
// honors execution credits (JobStream.depth) so we never overrun the
// device planner -- ACK means "accepted", not "slot freed".
const DEFAULT_WINDOW = 16;
// Widened from 0.25 to 0.75: accommodates USB CDC startup turnaround latency
// and prevents premature retransmission of commands before initial ACK arrives.
const DEFAULT_RTO_S = 0.75;
const MAX_RETRIES = 8;
const DEFAULT_HEARTBEAT_S = 1.0;
// Absolute cap on how long any single command may sit unresolved, regardless
// of how many times its retry counter gets reset by a valid BUFFER NAK.
const DEFAULT_STALL_TIMEOUT_S = 20.0;
// Max real silence on the wire during a job (heartbeat paused) before we
// fire a keepalive HB anyway. Must stay well under the firmware's
// HOST_WATCHDOG_TIMEOUT_MS=5000 (easycnc_protocol.c:112) -- confirmed root
// cause of Tawfiq's false mid-job ESTOP reports (msg11752, 2026-09-04): a
// single slow move or an exhausted execution-credit window (JobStream.depth)
// can leave zero bytes going host->device for >5s with the normal-cadence
// heartbeat suppressed the whole job, and the firmware self-ESTOPs assuming
// the host process is gone.
const DEFAULT_JOB_IDLE_HEARTBEAT_S = 2.0;

// Tick interval for the retransmit/stall/heartbeat sweep. Python polled
// transport.recv(0.005) i.e. a 5ms cadence; mirrored here.
const TICK_MS = 5;

// A SEQ_GAP for a seq this host already gave up on (or never tracked) is
// answered with a harmless OP_PING filler at that seq when it is this close
// behind the next seq to send; anything further away is a stale device and
// gets a seq-0 session reset instead.
const GAP_FILLER_WINDOW = 64;

function now() {
    return Date.now() / 1000;
}

/**
 * True when `a` comes before `b` in the 16-bit sequence space. Plain `<`
 * breaks at the 65535 -> 0 wrap: a 500k-line job wraps the sequence ~8
 * times, and a SEQ_GAP handled with `<` right after a wrap deleted frames
 * that had not been delivered yet (plan item BE-9).
 */
function seqBefore(a, b) {
    return a !== b && ((b - a) & 0xFFFF) < 0x8000;
}

class LinkLost extends Error {}
class RspTimeoutError extends Error {}

class Pending {
    constructor(seq, payload, sentAt, rto, durable, firstSentAt) {
        this.seq = seq;
        this.payload = payload; // Buffer, full frame payload including opcode byte
        this.sentAt = sentAt;
        this.retries = 0;
        this.rto = rto;
        this.durable = durable;
        this.bufferBackoffUntil = 0.0; // flow-control pause (BUFFER NAK)
        this.firstSentAt = firstSentAt; // set once at creation; NEVER reset by NAK handling
    }
}

/**
 * Minimal logger interface, defaults to console with level-aware calls.
 * Callers may pass their own `{debug,info,warn,error}` compatible logger
 * (e.g. winston) via options.logger.
 */
function defaultLogger() {
    return {
        debug: () => {},
        info: (...a) => console.log('[rsp.stream]', ...a),
        warn: (...a) => console.warn('[rsp.stream]', ...a),
        error: (...a) => console.error('[rsp.stream]', ...a),
    };
}

/**
 * transport contract expected by ReliableStream:
 *   transport.send(buffer)        -- may throw synchronously on tx failure
 *   transport.on('data', cb)      -- cb(Buffer) for each inbound chunk
 *   transport.on('error', cb)     -- cb(Error) on transport-level rx failure
 *   transport.close()             -- optional
 *   transport.reconnect()         -- optional
 */
class ReliableStream extends EventEmitter {
    constructor(transport, options = {}) {
        super();
        this.transport = transport;
        this.window = options.window ?? DEFAULT_WINDOW;
        this.rtoS = options.rtoS ?? DEFAULT_RTO_S;
        this.heartbeatS = options.heartbeatS ?? DEFAULT_HEARTBEAT_S;
        this.jobIdleHeartbeatS = options.jobIdleHeartbeatS ?? DEFAULT_JOB_IDLE_HEARTBEAT_S;
        this.maxRetries = options.maxRetries ?? MAX_RETRIES;
        this.stallTimeoutS = options.stallTimeoutS ?? DEFAULT_STALL_TIMEOUT_S;
        // Optional callback-style hooks (parity with the Python ctor args);
        // events 'event' / 'status' / 'link' are also emitted regardless.
        this.onEvent = options.onEvent || null;
        this.onStatus = options.onStatus || null;
        this.onLinkChange = options.onLinkChange || null;
        this._log = options.logger || defaultLogger();

        this._parser = new FrameParser();
        this._txSeq = 0;
        this._sent = new Map(); // seq -> Pending
        this._devAckSeq = -1; // device has ACKed every seq <= this

        this._linkOk = false;
        this._lastRx = 0.0;
        this._lastHb = 0.0;
        // Last time we actually put ANY frame on the wire (CMD, resend, or
        // HB) -- distinct from _lastHb, which only tracks the normal-cadence
        // HB. Drives the job-idle keepalive below.
        this._lastTx = 0.0;
        // While true (during an active job), the normal-cadence background
        // heartbeat is suppressed -- interleaving FT_HB frames with
        // pipelined job lines slows/stalls the firmware's move execution
        // (see JobStream.upload()/_finishJob()/abort()). Ported from
        // stream.py's _heartbeat_paused; missing here meant every JS-side
        // job ran with heartbeats still firing every heartbeatS the whole
        // time. Only the *normal-cadence* keepalive send is gated by this
        // flag -- the idle link-liveness check below still needs live
        // heartbeats when nothing else is happening, so the timeout side is
        // deliberately left ungated (matches Python). A SEPARATE, lower-
        // frequency job-idle keepalive (see jobIdleHeartbeatS in _tick())
        // fires even while this flag is true, to satisfy the firmware's own
        // host-silence watchdog during real gaps in job traffic -- see that
        // comment for the incident this fixes.
        this._heartbeatPaused = false;
        // rx-error-storm handling: a dead OS-level handle makes every rx
        // fail identically, forever, with no backoff -- these track that
        // streak so we can throttle the log, back off, and periodically
        // try to reopen the transport.
        this._rxErrorStreak = 0;
        this._lastRxErrorLog = 0.0;
        this._lastReconnectAttempt = 0.0;
        // "stall" link-loss (retries/absolute-timeout exhausted while the
        // device is STILL validly NAK-ing/emitting telemetry) must NOT be
        // auto-revived by generic rx like the heartbeat-silence case is --
        // that NAK/telemetry traffic is exactly what masked the original
        // DESIGN_CARVE_ERROR.txt bug (see _checkStalled). Only a real ACK/
        // RSP proves the device can actually complete a durable command
        // again; see _handle()'s FT_ACK/FT_RSP branches below.
        this._linkDownReason = '';
        this._lastGapNak = 0.0;
        // Ring buffer of link up/down transitions (reason mirrors the string
        // passed to _setLink: 'heartbeat', 'stall', 'tx_error', etc.) --
        // exposed via getLinkHealth() so /api/link-health can show *why* a
        // link dropped without the caller having to tail winston logs.
        this._linkEvents = [];

        this._replyWaiters = new Map(); // seq -> {resolve, reject, timer}

        this._rejectThrottle = { lastTime: 0, count: 0, lastKey: '' };
        this._lastSessionReset = 0.0;

        this._tickTimer = null;
        this._onData = this._onData.bind(this);
        this._onTransportError = this._onTransportError.bind(this);
    }

    // ------------------------------------------------------------------
    // state
    // ------------------------------------------------------------------
    get linkOk() {
        return this._linkOk;
    }

    get inFlight() {
        return this._sent.size;
    }

    get available() {
        // Seq 0 is a session reset on the firmware (rsp_dispatch() re-syncs
        // its expected seq to 0 whenever seq 0 arrives). Wrapping to 0 while
        // an earlier frame is still unacknowledged would let the frames after
        // the wrap overtake it -- e.g. a BUFFER-NAKed job line at 65535 would
        // be skipped. Drain first; _takeSeq() then puts a PING on seq 0.
        if (this._txSeq === 0 && this._sent.size > 0) return 0;
        return Math.max(0, this.window - this.inFlight);
    }

    /** Suppress/resume the background heartbeat. Pause during an active job. */
    setHeartbeatPaused(paused) {
        this._heartbeatPaused = !!paused;
    }

    /**
     * Remove not-yet-ACKed frames matching `predicate` from the pending/
     * retransmit set, without ever putting them on the wire again. Frames
     * the device already ACKed are gone from `_sent` before this runs (see
     * _handle()'s FT_ACK branch) -- this can only stop frames that are
     * still in flight on the HOST side (queued, or sent once and awaiting
     * ACK/retransmit), not undo work the device planner already accepted.
     *
     * Exists so JobStream.abort() can stop _retransmitReady() from
     * continuing to push an aborted job's not-yet-ACKed OP_JOB_LINE/
     * OP_JOB_START/OP_JOB_END frames onto the wire (and therefore into the
     * device planner) after the host has abandoned the job -- previously
     * abort() only sent OP_JOB_ABORT (best-effort, processed by firmware
     * in-order behind whatever was already queued ahead of it) with no way
     * to stop the host's own retransmit loop from keeping those older
     * frames alive in the meantime.
     *
     * With `fill` (what JobStream uses), every cancelled seq is immediately
     * re-sent as a harmless PING. The device processes strictly in seq
     * order, so a plain cancel left a hole it waited on: every later command
     * -- the job abort, E-stop -- was refused with SEQ_GAP until a filler was
     * negotiated (plan item BE-8). A filler for a frame the device already
     * processed is just a duplicate it ignores.
     *
     * @param {(p: Pending) => boolean} predicate
     * @param {{fill?: boolean}} [opts]
     * @returns {number} count of frames cancelled
     */
    cancelPending(predicate, { fill = false } = {}) {
        const cancelled = [];
        for (const [seq, p] of this._sent) {
            if (predicate(p)) {
                this._sent.delete(seq);
                cancelled.push(seq);
            }
        }
        if (fill && cancelled.length) {
            // oldest first, in the wrapping seq space
            const base = this._txSeq;
            cancelled.sort((a, b) => ((a - base) & 0xFFFF) - ((b - base) & 0xFFFF));
            for (const seq of cancelled) this._sendRawPing(seq);
        }
        return cancelled.length;
    }

    _setLink(ok, reason = '') {
        if (ok) {
            this._linkDownReason = '';
        } else if (!this._linkOk) {
            // already down, don't clobber an existing reason
        } else {
            this._linkDownReason = reason;
        }
        if (ok !== this._linkOk) {
            this._linkOk = ok;
            this._linkEvents.push({ ts: now(), linkOk: ok, reason: ok ? 'restored' : (reason || 'unknown') });
            if (this._linkEvents.length > 5) this._linkEvents.shift();
            if (this.onLinkChange) this.onLinkChange(ok);
            this.emit('link', ok);
        }
    }

    /**
     * Snapshot for /api/link-health -- one-glance answer to "is the RSP
     * link actually alive, and if not, why/when did it last drop."
     */
    getLinkHealth() {
        const n = now();
        return {
            linkOk: this._linkOk,
            lastRxAgoS: this._lastRx > 0 ? Number((n - this._lastRx).toFixed(2)) : null,
            heartbeatS: this.heartbeatS,
            heartbeatTimeoutS: this.heartbeatS * 3.0,
            inFlight: this.inFlight,
            recentEvents: this._linkEvents.slice(),
        };
    }

    // -------------------------------------------------------------------------
    // transmit API
    // -------------------------------------------------------------------------
    /**
     * Send a command and resolve once its RSP reply arrives.
     * @returns {Promise<import('./frame').ParsedFrame>}
     */
    sendCommand(op, payload, { durable = true, timeout = 3.0 } = {}) {
        if (!this._linkOk) {
            return Promise.reject(new LinkLost('link not up'));
        }
        const seq = this._takeSeq();
        const body = Buffer.concat([Buffer.from([op & 0xFF]), payload || Buffer.alloc(0)]);
        const now0 = now();
        this._sent.set(seq, new Pending(seq, body, now0, this.rtoS, durable, now0));

        return new Promise((resolve, reject) => {
            // NOTE: intentionally NOT unref()'d -- this timer is the only
            // mechanism that guarantees the returned Promise ever settles.
            // Unref'ing it (as the tick interval below does) let Node exit
            // the process before an unanswered command's timeout fired in
            // testing, leaving the caller's await hanging forever with no
            // error surfaced. Found via stream_smoke.js test 5.
            const timer = setTimeout(() => {
                this._replyWaiters.delete(seq);
                reject(new RspTimeoutError(`no reply for seq ${seq}`));
            }, Math.max(0, timeout) * 1000);
            this._replyWaiters.set(seq, { resolve, reject, timer });

            try {
                this.transport.send(buildFrame(FT_CMD, F_ACK, seq, body));
                this._lastTx = now();
            } catch (exc) {
                // Same class of transient stall _retransmitReady() already
                // tolerates for queued resends. Killing the whole job on the
                // FIRST such blip -- while the identical failure on a
                // background resend is treated as recoverable -- was the
                // bug: leave the packet queued so the retry loop naturally
                // resends it.
                this._log.warn(`tx error sending seq ${seq}: ${exc.message || exc}`);
                this._setLink(false, 'tx_error');
            }
        });
    }

    /**
     * Queue a command without blocking; returns its seq, or -1 if the
     * window is full (caller should back off / wait for ACKs).
     *
     * `force` is for stop-type commands (job abort, E-stop): they are queued
     * even when the window is full or the link is momentarily down, so a
     * Stop pressed during a busy stream or a USB blip is never dropped. The
     * retransmit loop delivers them in seq order as soon as the device
     * answers again.
     */
    sendNowait(op, payload, durable = true, { force = false } = {}) {
        if (!this._linkOk && !force) {
            throw new LinkLost('link not up');
        }
        if (this.available <= 0 && !force) {
            return -1;
        }
        const seq = this._takeSeq();
        const body = Buffer.concat([Buffer.from([op & 0xFF]), payload || Buffer.alloc(0)]);
        const now0 = now();
        this._sent.set(seq, new Pending(seq, body, now0, this.rtoS, durable, now0));
        try {
            this.transport.send(buildFrame(FT_CMD, F_ACK, seq, body));
            this._lastTx = now0;
        } catch (exc) {
            // See sendCommand()'s matching comment: a transient tx stall
            // must not kill the job here either -- leave it queued for
            // _retransmitReady() to pick up like any other pending seq.
            this._log.warn(`tx error sending seq ${seq}: ${exc.message || exc}`);
            this._setLink(false, 'tx_error');
        }
        return seq;
    }

    // -------------------------------------------------------------------------
    // lifecycle
    // -------------------------------------------------------------------------
    start() {
        if (this._tickTimer) return; // already started
        this._setLink(true);
        this._lastRx = now();
        this._lastHb = now();
        this._lastTx = now();
        if (typeof this.transport.on === 'function') {
            this.transport.on('data', this._onData);
            this.transport.on('error', this._onTransportError);
        }
        // Session start: seq 0 is a PING, so the firmware's seq-0 re-sync
        // never lands on a real command (see _takeSeq()).
        if (this._txSeq === 0) {
            this._sendRawPing(0);
            this._txSeq = 1;
        }
        this._tickTimer = setInterval(() => this._tick(), TICK_MS);
        if (typeof this._tickTimer.unref === 'function') this._tickTimer.unref();
    }

    stop() {
        if (this._tickTimer) {
            clearInterval(this._tickTimer);
            this._tickTimer = null;
        }
        if (typeof this.transport.removeListener === 'function') {
            this.transport.removeListener('data', this._onData);
            this.transport.removeListener('error', this._onTransportError);
        }
        // reject any still-outstanding sendCommand() waiters so callers
        // don't hang forever after an explicit stop()
        for (const [seq, waiter] of this._replyWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(new LinkLost('stream stopped'));
        }
        this._replyWaiters.clear();
    }

    close() {
        this.stop();
        if (typeof this.transport.close === 'function') {
            this.transport.close();
        }
    }

    // ------------------------------------------------------------------
    // internal
    // ------------------------------------------------------------------
    /**
     * Seq 0 is reserved for a PING: the firmware treats any seq-0 frame as a
     * session reset, so a retransmitted seq-0 job line would run twice and
     * re-sync the device behind frames it had already accepted. The PING is
     * sent raw and never retransmitted; if it is lost the device's SEQ_GAP
     * asks for seq 0 again and _handleNak() re-sends a filler.
     */
    _takeSeq() {
        if (this._txSeq === 0) {
            this._sendRawPing(0);
            this._txSeq = 1;
        }
        const s = this._txSeq;
        this._txSeq = (this._txSeq + 1) & 0xFFFF;
        return s;
    }

    _sendRawPing(seq) {
        try {
            this.transport.send(buildFrame(FT_CMD, F_ACK, seq, Buffer.from([defs.OP_PING])));
            this._lastTx = now();
        } catch (exc) {
            this._log.warn(`tx error sending seq ${seq} PING: ${exc.message || exc}`);
        }
    }

    _onData(data) {
        const n = now();
        this._rxErrorStreak = 0;
        if (data && data.length) {
            this._lastRx = n;
            // Silence-based link-down (heartbeat timeout / tx error)
            // genuinely means "we don't know if the device is even there"
            // -- any rx is real proof of life, revive now. Stall-based
            // link-down means the device IS talking (NAKs, telemetry) but
            // a durable command never actually completes -- that traffic
            // must NOT count as recovery, or we're back to the exact bug
            // this fixes. Only an ACK/RSP proves it, handled in _handle().
            if (!this._linkOk && this._linkDownReason !== 'stall') {
                this._log.info('rx while link down -- link restored');
                this._setLink(true);
            }
            let frames;
            try {
                frames = this._parser.feed(data);
            } catch (exc) {
                this._log.warn(`frame parse error: ${exc.message || exc}`);
                return;
            }
            for (const f of frames) {
                this._handle(f, n);
            }
        }
    }

    _onTransportError(exc) {
        // A dead OS-level handle (e.g. Windows ClearCommError/
        // PermissionError after the USB-CDC device drops off the bus)
        // makes every recv() fail identically and instantly -- confirmed
        // live 2026-08-27 (Tawfiq's job 31739): 9957 identical "rx error"
        // lines in ~2.5 minutes, link never recovering, because nothing
        // throttled the log, backed off the poll rate, or ever reopened
        // the handle. Fix: throttle the log to once per streak-start +
        // once per 2s, and periodically try to reopen the transport.
        const n = now();
        this._rxErrorStreak += 1;
        if (this._rxErrorStreak === 1 || (n - this._lastRxErrorLog) >= 2.0) {
            this._log.warn(`rx error: ${exc.message || exc} (streak=${this._rxErrorStreak})`);
            this._lastRxErrorLog = n;
        }
        this._setLink(false, 'tx_error');
        if (
            this._rxErrorStreak % 10 === 0 &&
            (n - this._lastReconnectAttempt) >= 2.0 &&
            typeof this.transport.reconnect === 'function'
        ) {
            this._lastReconnectAttempt = n;
            try {
                this.transport.reconnect();
                this._log.info(`reconnect attempt after ${this._rxErrorStreak} consecutive rx errors`);
            } catch (reconnectExc) {
                this._log.warn(`reconnect failed: ${reconnectExc.message || reconnectExc}`);
            }
        }
    }

    _tick() {
        const n = now();

        // retransmit due
        this._retransmitReady(n);

        // absolute stall check -- catches a device that keeps validly
        // NAK-ing (ST_ERR_BUFFER) forever, which otherwise resets retry
        // counters indefinitely and never trips LinkLost
        this._checkStalled(n);

        // ...and a way back out of that state once the device recovers
        this._probeStalledLink(n);

        // heartbeat liveness
        const n2 = now();
        if (this._linkOk && (n2 - this._lastRx) > this.heartbeatS * 3.0) {
            this._log.warn('heartbeat timeout -- link lost');
            this._setLink(false, 'heartbeat');
            this._lastRx = n2;
        }

        // Normal cadence HB (idle, no job): every heartbeatS, as before.
        //
        // Job-idle keepalive: setHeartbeatPaused(true) (see its doc above)
        // suppresses this normal cadence during a job to avoid interleaving
        // FT_HB with pipelined job lines. Job traffic (OP_JOB_LINE sends)
        // normally keeps the firmware's own host-silence watchdog fed
        // instead (HOST_WATCHDOG_TIMEOUT_MS=5000, easycnc_protocol.c:112,
        // engage_estop() at protocol_run_tick() ~line 2164) -- but a single
        // slow move, or the execution-credit window (JobStream.depth)
        // blocking new sends while waiting on EV_EXECUTED, can leave the
        // wire genuinely silent past 5s with nothing else queued to send.
        // Confirmed root cause of Tawfiq's multi-file false-ESTOP reports
        // (msg11752, 2026-09-04: trips at unrelated lines in 3 unrelated
        // files, no position/content correlation -- a pure timing bug, not
        // hardware/EMI). Fire an HB once real tx has been idle for
        // jobIdleHeartbeatS (default 2s, well under the firmware's 5s trip)
        // regardless of the pause flag, so the host never actually goes
        // silent for the firmware's whole watchdog window.
        const idleSinceTx = n2 - this._lastTx;
        // Not gated on _linkOk either: a link declared down by the stall path
        // only comes back when the device answers something, and nothing else
        // is allowed to be sent while it is down -- so without a heartbeat to
        // answer, "down" was permanent and every later command was refused
        // until the port was reopened.
        const normalHbDue = !this._heartbeatPaused && (n2 - this._lastHb) >= this.heartbeatS;
        // Not gated on _linkOk: "link down" only means the host has heard
        // nothing for 3 s. The device may still be receiving fine, and going
        // silent here is exactly what trips its 5 s host watchdog into an
        // E-stop in the middle of a job.
        const jobKeepaliveDue = this._heartbeatPaused && idleSinceTx >= this.jobIdleHeartbeatS;
        if (normalHbDue || jobKeepaliveDue) {
            this._lastHb = n2;
            this._lastTx = n2;
            try {
                this.transport.send(buildFrame(FT_HB, 0, 0, Buffer.alloc(0)));
            } catch (exc) {
                this._setLink(false, 'tx_error');
            }
        }
    }

    /**
     * A 'stall' link-down only lifts when a durable command this side is
     * waiting on gets a real ACK/RSP (see _handle). If the stall killed the
     * last pending frame there is nothing left to be answered, and every new
     * send is refused because the link is down -- a dead end the operator
     * could only escape by reopening the port. Ask the device, gently, whether
     * it can complete a command again.
     */
    _probeStalledLink(n) {
        if (this._linkOk || this._linkDownReason !== 'stall') return;
        if (this._sent.size > 0) return; // something is already waiting on an answer
        if (n - (this._lastStallProbe || 0) < 2.0) return;
        this._lastStallProbe = n;
        const seq = this._takeSeq();
        const body = Buffer.from([defs.OP_PING]);
        this._sent.set(seq, new Pending(seq, body, n, this.rtoS, true, n));
        try {
            this.transport.send(buildFrame(FT_CMD, F_ACK, seq, body));
            this._lastTx = n;
        } catch (exc) {
            this._sent.delete(seq);
        }
    }

    /** A durable frame was dropped without ever being acknowledged. */
    _emitGaveUp(p, why) {
        this.emit('gaveUp', { seq: p.seq, op: p.payload[0], payload: p.payload, why });
    }

    _retransmitReady(n) {
        const toResend = [];
        for (const [seq, p] of this._sent) {
            if (n - p.sentAt >= p.rto) {
                toResend.push(seq);
            }
        }
        for (const seq of toResend) {
            const p = this._sent.get(seq);
            if (!p) continue;
            p.retries += 1;
            if (p.retries > this.maxRetries) {
                const op = p.payload[0];
                const opName = defs.OP_NAMES[op] || `OP_0x${op.toString(16).padStart(2, '0')}`;
                this._log.warn(`seq ${seq} retries exhausted`);
                // job-63998 stall investigation (2026-09-04): this used to be
                // logger-only, so a durable frame (e.g. OP_JOB_LINE) that
                // never got ACKed silently vanished from the pipeline with no
                // trace in the ndjson session log Tawfiq sends us -- we could
                // see the freeze in telemetry but not WHY. Surface it as a
                // 'console' event (same channel CNCEngine.sessionLogger.
                // logConsole() already captures) so the next repro pins the
                // exact seq/op instead of another round of inference.
                this.emit('console', `⚠️ RSP: seq ${seq} (${opName}) got no ACK after ${this.maxRetries} retries -- giving up.`);
                this._sent.delete(seq);
                if (p.durable) {
                    this._setLink(false, 'stall');
                    this._emitGaveUp(p, 'retries');
                }
                continue;
            }
            p.sentAt = n;
            p.rto = Math.min(p.rto * 2.0, 5.0);
            try {
                this.transport.send(buildFrame(FT_CMD, F_ACK, seq, p.payload));
                this._lastTx = n;
            } catch (exc) {
                // Same class of fault as the rx-side handler above and the
                // heartbeat send below: a dead transport must not be
                // allowed to throw out of the tick -- an uncaught
                // exception here would kill the interval permanently,
                // silently, with no LinkLost ever surfacing to callers.
                this._log.warn(`tx error resending seq ${seq}: ${exc.message || exc}`);
                this._setLink(false, 'tx_error');
                continue;
            }
            this._log.info(`resend seq ${seq} (retry ${p.retries})`);
        }
    }

    _checkStalled(n) {
        const stalled = [];
        for (const [seq, p] of this._sent) {
            if (n - p.firstSentAt >= this.stallTimeoutS) {
                stalled.push(seq);
            }
        }
        if (stalled.length === 0) return;
        const gaveUp = [];
        for (const seq of stalled) {
            const p = this._sent.get(seq);
            this._sent.delete(seq);
            if (!p) continue;
            this._log.warn(
                `seq ${seq} stalled -- unresolved for ${(n - p.firstSentAt).toFixed(1)}s despite ` +
                `${p.retries} retries (device likely stuck, not momentarily busy)`
            );
            if (p.durable) gaveUp.push(p);
        }
        if (gaveUp.length) {
            this._setLink(false, 'stall');
            for (const p of gaveUp) this._emitGaveUp(p, 'stall');
        }
    }

    // ------------------------------------------------------------------
    // inbound
    // ------------------------------------------------------------------
    _handle(f, n) {
        this._lastRx = n;
        if (f.frameType === FT_ACK) {
            const hadPending = this._sent.has(f.seq);
            this._sent.delete(f.seq);
            if (this._devAckSeq < 0 || seqBefore(this._devAckSeq, f.seq)) {
                this._devAckSeq = f.seq;
            }
            // A stall-downed link only recovers once a durable command
            // this side is actually waiting on gets a real ACK -- proof
            // the device can complete work again, not just that it's
            // still chattering NAKs/telemetry (see _onData's rx-revival
            // guard).
            if (hadPending && !this._linkOk && this._linkDownReason === 'stall') {
                this._log.info(`ACK for pending seq ${f.seq} -- link restored`);
                this._setLink(true);
            }
        } else if (f.frameType === FT_NAK) {
            this._handleNak(f);
        } else if (f.frameType === FT_RSP) {
            const pending = this._sent.get(f.seq);
            const hadPending = !!pending;
            const waiter = this._replyWaiters.get(f.seq);
            const errStatus = (f.payload && f.payload.length >= 2 && f.payload[1] !== defs.ST_OK) ? f.payload[1] : 0;
            if (waiter) {
                clearTimeout(waiter.timer);
                this._replyWaiters.delete(f.seq);
                if (errStatus) {
                    // A reply is not a success. The device says ST_ERR_STATE
                    // when it refuses a jog/zero/home/move (wrong machine
                    // state), and resolving that as success meant the refusal
                    // was completely silent: the UI moved on as if the machine
                    // had done it. Callers that inspect the status themselves
                    // see the same information in the rejection.
                    const op = f.payload[0];
                    const opName = defs.OP_NAMES[op] || `OP_0x${op.toString(16).padStart(2, '0')}`;
                    const reasonName = defs.ST_ERR_NAMES[errStatus] || `0x${errStatus.toString(16).padStart(2, '0')}`;
                    const err = new Error(`${opName} refused by the machine: ${reasonName}`);
                    err.op = op;
                    err.status = errStatus;
                    err.frame = f;
                    waiter.reject(err);
                } else {
                    waiter.resolve(f);
                }
            }
            // also drop from pending (acknowledged by the reply itself)
            this._sent.delete(f.seq);
            // A queued (sendNowait) frame answered with an error status, e.g. a
            // job line refused with ST_ERR_STATE because the machine went into
            // ALARM. Nobody awaits that reply -- without this the line looked
            // delivered and silently vanished from the toolpath.
            if (!waiter && pending && errStatus) {
                const op = f.payload[0];
                const opName = defs.OP_NAMES[op] || `OP_0x${op.toString(16).padStart(2, '0')}`;
                const reasonName = defs.ST_ERR_NAMES[errStatus] || `0x${errStatus.toString(16).padStart(2, '0')}`;
                this._throttleRejectConsole(f.seq, opName, reasonName);
                this.emit('reject', { seq: f.seq, op, reason: errStatus, opName, reasonName, payload: pending.payload });
            }
            if (hadPending && !this._linkOk && this._linkDownReason === 'stall') {
                this._log.info(`RSP for pending seq ${f.seq} -- link restored`);
                this._setLink(true);
            }
        } else if (f.frameType === FT_EVT) {
            if (f.payload && f.payload.length) {
                const op = f.payload[0];
                if (op === defs.EV_STATUS) {
                    try {
                        const t = new defs.Telemetry(f.payload.subarray(1));
                        const dict = t.asDict();
                        if (this.onStatus) this.onStatus(dict);
                        this.emit('status', dict);
                    } catch (exc) {
                        this._log.warn(`bad telemetry: ${exc.message || exc}`);
                    }
                }
                if (this.onEvent) this.onEvent(f);
                this.emit('event', f);
            }
        }
        // FT_HB: nothing to do
    }

    _handleNak(f) {
        if (!f.payload || f.payload.length < 2) return;
        const op = f.payload[0];
        const reason = f.payload[1];
        const opName = defs.OP_NAMES[op] || `OP_0x${op.toString(16).padStart(2, '0')}`;
        const reasonName = defs.ST_ERR_NAMES[reason] || `0x${reason.toString(16).padStart(2, '0')}`;
        // BUFFER/SEQ_GAP are expected flow-control chatter (device planner
        // full, or resync after reconnect) -- log at debug so they don't
        // drown out real faults; anything else is a genuine rejection.
        if (reason === defs.ST_ERR_BUFFER || reason === defs.ST_ERR_SEQ_GAP) {
            this._log.debug(`NAK seq=${f.seq} op=${opName} reason=${reasonName}`);
        } else {
            this._log.warn(`NAK seq=${f.seq} op=${opName} reason=${reasonName}`);
        }
        const n = now();
        if (reason === defs.ST_ERR_BUFFER) {
            // flow control -- the device said "slow down", not "give up":
            // reset retry accounting and re-send after a fixed backoff
            const p = this._sent.get(f.seq);
            if (p) {
                p.retries = 0;
                p.rto = Math.max(this.rtoS, 0.5);
                p.sentAt = n;
                p.bufferBackoffUntil = n + 0.45;
            }
        } else if (reason === defs.ST_ERR_SEQ_GAP) {
            // device wants us to resend from `f.seq` (the first seq it
            // needs). Throttle + normal-RTO pacing so we never NAK-flood
            // the link.
            if (n - this._lastGapNak < 0.05) return;
            this._lastGapNak = n;
            const gap = f.seq;
            // How far behind the next seq to send is the seq the device wants?
            // Within the filler window it is one of ours; otherwise the device
            // is on another session's numbering.
            const behind = (this._txSeq - gap) & 0xFFFF;
            if (behind === 0) {
                // The device already has everything up to the next seq we would
                // send (a duplicate retransmit crossed its ACK) -- nothing is
                // missing, just forget frames it has processed.
                for (const s of Array.from(this._sent.keys())) {
                    if (seqBefore(s, gap)) this._sent.delete(s);
                }
                return;
            }
            const recent = behind <= GAP_FILLER_WINDOW;
            if (!recent && !this._sent.has(gap)) {
                // Stale session (device kept its counter across a reconnect,
                // or the seq-0 PING was lost). The old fix jumped _txSeq
                // forward and deleted every pending frame "before" the gap --
                // commands the device had never received. Re-sync the device
                // to our numbering instead: a seq-0 PING resets its expected
                // seq, and the pending frames follow in order.
                if (n - this._lastSessionReset >= 1.0) {
                    this._lastSessionReset = n;
                    this._log.warn(`SEQ_GAP for seq ${gap} (next to send ${this._txSeq}) -- re-syncing device to this session`);
                    // Seq 0 makes the device reset its expected seq to 0, so it
                    // will want 1 next. Sending the PING alone left our own
                    // counter untouched: the device asked for 1, we kept
                    // sending 40000-something, and both sides repeated
                    // themselves forever. Renumber what is still unacknowledged
                    // and re-send it in order. The device has processed none of
                    // it -- it has been refusing everything with SEQ_GAP -- so
                    // nothing can be executed twice.
                    this._sendRawPing(0);
                    this._txSeq = 1;
                    const pending = [...this._sent.values()].sort((a, b) => a.firstSentAt - b.firstSentAt);
                    this._sent.clear();
                    for (const p of pending) {
                        const seq = this._takeSeq();
                        const waiter = this._replyWaiters.get(p.seq);
                        if (waiter) {
                            this._replyWaiters.delete(p.seq);
                            this._replyWaiters.set(seq, waiter);
                        }
                        this._sent.set(seq, new Pending(seq, p.payload, n, this.rtoS, p.durable, p.firstSentAt));
                        try {
                            this.transport.send(buildFrame(FT_CMD, F_ACK, seq, p.payload));
                            this._lastTx = n;
                        } catch (exc) {
                            this._setLink(false, 'tx_error');
                            break;
                        }
                    }
                    if (pending.length) this._log.info(`re-sent ${pending.length} unacknowledged frame(s) under the new numbering`);
                }
                return;
            }
            let resend = null;
            // Frames before the gap were processed by the device (their ACK
            // was lost) -- they are done.
            for (const s of Array.from(this._sent.keys())) {
                if (seqBefore(s, gap)) this._sent.delete(s);
            }
            this._devAckSeq = (gap - 1) & 0xFFFF;
            for (const [s, p] of this._sent) {
                // leave head-of-line frames under BUFFER backoff alone --
                // resetting their timer would starve them forever
                if (!seqBefore(s, gap) && n >= (p.bufferBackoffUntil || 0.0)) {
                    p.retries = 0;
                    p.rto = this.rtoS;
                    p.sentAt = n;
                    if (s === gap) {
                        resend = [s, p.payload];
                    }
                }
            }
            if (resend === null) {
                // The device waits for a frame this host already gave up on
                // (retries exhausted) or cancelled. Nothing will ever resend
                // it, so without a filler every later command -- including
                // Stop and E-stop -- is refused with SEQ_GAP forever (plan
                // item BE-8, the Stop deadlock). A PING in that slot is
                // harmless; the job layer already failed any job line lost
                // this way ('gaveUp').
                // Fill the whole run of dropped seqs in one go, up to the next
                // frame that is still pending (that one is resent instead) --
                // one filler per NAK took an RTO per hole to catch up.
                let filled = 0;
                let s = gap;
                while (s !== this._txSeq && filled < GAP_FILLER_WINDOW) {
                    const p = this._sent.get(s);
                    if (p) {
                        p.retries = 0;
                        p.rto = this.rtoS;
                        p.sentAt = n;
                        try {
                            this.transport.send(buildFrame(FT_CMD, F_ACK, s, p.payload));
                            this._lastTx = n;
                        } catch (exc) {
                            this._setLink(false, 'tx_error');
                        }
                        break;
                    }
                    this._sendRawPing(s);
                    filled += 1;
                    s = (s + 1) & 0xFFFF;
                }
                this._log.warn(`SEQ_GAP for seq ${gap}, no longer pending -- sent ${filled} PING filler(s) to re-align the device`);
                return;
            }
            // Resetting sentAt above only re-arms _retransmitReady()'s RTO
            // timer for later -- it does NOT itself put a frame on the
            // wire. If SEQ_GAP NAKs keep arriving faster than that RTO
            // (which they will: every other in-window frame the device
            // rejects as out-of-order re-triggers one), the reset keeps
            // re-arming before the timer ever elapses and the
            // head-of-line frame is silently never retransmitted again --
            // a livelock, not a timeout, so neither the retry-exhaustion
            // nor the stall-timeout safety net ever fires. Actually resend
            // it here, on the spot, using the exact seq the device told
            // us it's waiting for.
            if (resend !== null) {
                const [seq, payload] = resend;
                try {
                    this.transport.send(buildFrame(FT_CMD, F_ACK, seq, payload));
                    this._lastTx = n;
                } catch (exc) {
                    this._log.warn(`tx error resending seq ${seq} after SEQ_GAP: ${exc.message || exc}`);
                    this._setLink(false, 'tx_error');
                }
            }
        } else {
            // Real rejection (not flow-control/reorder chatter):
            // Throttle console output to prevent UI freezes/event loop lockup when
            // bursts of rejections happen (e.g. invalid state). Emit 'reject' so
            // JobStream can immediately abort instead of blasting hundreds more frames.
            this._throttleRejectConsole(f.seq, opName, reasonName);
            const pending = this._sent.get(f.seq);
            this._sent.delete(f.seq);
            this.emit('reject', { seq: f.seq, op, reason, opName, reasonName, payload: pending ? pending.payload : null });
        }
    }

    _throttleRejectConsole(seq, opName, reasonName) {
        const n = now();
        const key = `${opName}:${reasonName}`;
        if (key === this._rejectThrottle.lastKey && (n - this._rejectThrottle.lastTime) < 1.0) {
            this._rejectThrottle.count++;
            return;
        }
        let countSuffix = '';
        if (this._rejectThrottle.count > 0 && key === this._rejectThrottle.lastKey) {
            countSuffix = ` (${this._rejectThrottle.count} similar rejections suppressed)`;
        }
        this._rejectThrottle.lastTime = n;
        this._rejectThrottle.count = 0;
        this._rejectThrottle.lastKey = key;
        this.emit('console', `⚠️ RSP: seq ${seq} (${opName}) rejected -- ${reasonName}.${countSuffix}`);
    }
}

module.exports = {
    DEFAULT_WINDOW, DEFAULT_RTO_S, MAX_RETRIES, DEFAULT_HEARTBEAT_S,
    DEFAULT_STALL_TIMEOUT_S, DEFAULT_JOB_IDLE_HEARTBEAT_S,
    LinkLost, RspTimeoutError,
    Pending,
    ReliableStream,
    seqBefore,
};
