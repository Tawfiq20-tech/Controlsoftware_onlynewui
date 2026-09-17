'use strict';

/**
 * Fake RSP firmware for host tests (plan item QA-2).
 *
 * Mirrors the RSP layer of the EasyCNC firmware (shortcut/firmware/source_*)
 * closely enough to test the host end to end, including the firmware
 * behaviours that caused real failures:
 *   - rsp_dispatch(): seq sync, seq 0 = session reset, single cached reply,
 *     SEQ_GAP NAK naming the expected seq, BUFFER NAK does not advance
 *   - rsp_handle_job_line(): no-motion lines ACKed + EV_EXECUTED on RECEIPT,
 *     motion lines into an 8-deep ring, arcs refused with NAK ERR_CMD
 *   - parse_gcode_text(): strtof() number reading (hex floats included), feed
 *     taken from last_feed at parse time, last_feed updated when a move pops;
 *     G20/G91 and last_feed survive from one job to the next
 *   - protocol_run_tick(): one leg at a time, EV_EXECUTED when a leg ends,
 *     5 s host watchdog while RUNNING, IDLE + drivers off when the ring is
 *     empty after JOB_END
 *   - JOB_ABORT / E_STOP / ALARM keep the partial position (POS_EXACT)
 *   - OP_JOG: accepted from IDLE or JOGGING, the target is built from the
 *     COMMITTED position (queued target, else in-flight target, else cur), so
 *     quick presses add up; x/y/z only move when the whole chain has drained;
 *     OP_JOB_ABORT stops a jog but leaves the board in JOGGING (Phase 1 D2-3)
 *   - OP_MOVE / OP_PROBE / OP_HOME block the firmware main loop until they end:
 *     nothing else is dispatched (heartbeats included), the reply comes after
 *     the motion, the state stays IDLE (HOMING for home) with x/y/z frozen at
 *     the start, EV_STATUS keeps flowing during OP_MOVE only (run_move calls
 *     protocol_status_tick; the probe and homing loops do not)
 *   - the physical E-stop interrupt (injectPhysicalEstop): stops the engine,
 *     cuts power, latches E-stop, and nothing else; unlock is refused while
 *     the input is still active
 *
 * fwVersion personalities:
 *   '0.1.1'  flashed 2026-09-15 (0.1.1-almfilter)
 *   '0.2.0'  shortcut/firmware/source_0.2.0 (the default)
 *   '0.2.1'  shortcut/firmware/source_0.2.1 including the Phase 2 amendments
 *            (contract: scratchpad reliability/contracts/firmware-0.2.1.md):
 *     F4   OP_JOB_ABORT and the end of a job leave the drivers powered
 *     F5   a no-motion job line is reported after the moves received before it
 *     F8   GET_CONFIG says "0.2.1"
 *     F9   OP_MOVE runs on the async engine: FT_ACK at once, state JOGGING,
 *          RSP when it ends (OK / ERR_FAULT / ERR_ESTOP / ERR_STATE if a stop
 *          ended it). While it runs every command is handled at once, as
 *          during a jog: reads and stops act, commands that need IDLE (ZERO,
 *          MOVE, PROBE, HOME, JOB_START) get ERR_STATE, OP_JOG gets ERR_BUSY;
 *          nothing is held. A target that is NaN or beyond +/-10 m: ERR_CMD.
 *          A new host session (seq 0) during the move: its RSP is never sent.
 *     F10  OP_PROBE / OP_HOME: FT_ACK at once, EV_STATUS during them, probe
 *          reports JOGGING; still blocking otherwise
 *     F11  OP_JOB_ABORT in JOGGING stops the jog and returns to IDLE (exact
 *          position, drivers on) -- the jog cancel; JOGGING with an empty engine
 *          falls back to IDLE by itself
 *     F12  at most one OP_JOG waits behind the leg in flight; more: ERR_BUSY
 *     F13  OP_JOB_START resets G21 G90 and last_feed 500
 *     F14  the physical E-stop also clears planner / job flags (as OP_E_STOP);
 *          probe / home stop on a latched E-stop even once the input reads
 *          released; the driver power-up reports an E-stop, not a driver alarm
 *     F15  the step counter (dbg_tim2_isr_count) also counts probe/home steps;
 *          GET_CONFIG carries "boot_id" and "uptime_ms"
 *
 * Runs on the global timers, so tests drive it with node:test mock timers.
 * Every executed leg is recorded in `executed` for exact path checks.
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const defs = require('../../services/rsp/defs');
const { FrameParser, buildFrame, FT_CMD, FT_RSP, FT_EVT, FT_ACK, FT_NAK, FT_HB } = require('../../services/rsp/frame');

const MOVE_RING_DEPTH = 8;
const STEPS_PER_MM = 200;
const WATCHDOG_MS = 5000;
const HOME_MAX_TRAVEL_MM = 400;
const DEFAULT_FEED = 500;
const JOB_ID_WILDCARD = 0xFFFF;
const TEL_FLAG_POWERED = 0x01;
const TEL_FLAG_ESTOP = 0x02;
const TEL_FLAG_JOB_ACTIVE = 0x08;
const TEL_FLAG_FEED_HOLD = 0x10;
const TEL_FLAG_POS_EXACT = 0x20;
// 0.2.1 rsp_handle_move() RSP_MOVE_COORD_LIMIT_MM
const MOVE_COORD_LIMIT_MM = 10000;

const f32 = Math.fround;

/** C strtof(): returns {value, len} or null if nothing numeric at s[0]. */
function strtof(s) {
    const m = /^[ \t]*([+-]?(?:0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?|nan))/i.exec(s);
    if (!m) return null;
    const txt = m[1];
    let v;
    const hex = /^([+-]?)0[xX]([0-9a-fA-F]*)\.?([0-9a-fA-F]*)(?:[pP]([+-]?\d+))?$/.exec(txt);
    if (hex) {
        const sign = hex[1] === '-' ? -1 : 1;
        const ip = hex[2] ? parseInt(hex[2], 16) : 0;
        let fp = 0;
        for (let i = 0; i < hex[3].length; i++) fp += parseInt(hex[3][i], 16) / 16 ** (i + 1);
        v = sign * (ip + fp) * 2 ** (hex[4] ? parseInt(hex[4], 10) : 0);
    } else if (/inf/i.test(txt)) {
        v = txt.startsWith('-') ? -Infinity : Infinity;
    } else if (/nan/i.test(txt)) {
        v = NaN;
    } else {
        v = parseFloat(txt);
    }
    return { value: f32(v), len: m[0].length };
}

/**
 * Firmware 0.2.0's own decimal-only scanner (FW-1), transliterated statement
 * for statement from source_0.2.0/Src/easycnc_protocol.c gcode_strtof().
 * Accepts [+-]?digits[.digits] and nothing else -- no hex, no exponent, no
 * inf/nan. Returns {value, len} or null.
 */
function gcodeStrtof(p) {
    let i = 0;
    while (p[i] === ' ' || p[i] === '\t') i++;
    let neg = 0;
    if (p[i] === '+' || p[i] === '-') { neg = p[i] === '-' ? 1 : 0; i++; }

    let intPart = 0;
    let intDigits = 0;
    let intBig = 0;
    let intOverflowed = 0;
    while (p[i] >= '0' && p[i] <= '9') {
        if (!intOverflowed && intDigits < 9) {
            intPart = (intPart * 10 + (p.charCodeAt(i) - 48)) >>> 0;
        } else {
            if (!intOverflowed) { intBig = f32(intPart); intOverflowed = 1; }
            intBig = f32(f32(intBig * 10) + (p.charCodeAt(i) - 48));
        }
        intDigits++;
        i++;
    }

    let fracPart = 0;
    let fracScale = 1;
    let fracDigits = 0;
    if (p[i] === '.') {
        const dot = i;
        i++;
        while (p[i] >= '0' && p[i] <= '9') {
            if (fracDigits < 9) { fracPart = (fracPart * 10 + (p.charCodeAt(i) - 48)) >>> 0; fracScale = (fracScale * 10) >>> 0; }
            fracDigits++;
            i++;
        }
        if (intDigits === 0 && fracDigits === 0) i = dot;
    }

    if (intDigits === 0 && fracDigits === 0) return null;

    let v = intOverflowed ? intBig : f32(intPart);
    if (fracDigits > 0) v = f32(v + f32(f32(fracPart) / f32(fracScale)));
    if (neg) v = -v;
    return { value: v, len: i };
}

class FakeFirmware extends EventEmitter {
    /**
     * @param {object} [o]
     * @param {string} [o.fwVersion='0.2.0'] '0.1.1' | '0.2.0' | '0.2.1'
     * @param {number} [o.legTimeScale=0.001] leg duration = real duration * scale (virtual ms)
     * @param {number} [o.latencyMs=1] delay for each output frame
     * @param {number} [o.powerOnMs=0] motion_power_start() settle while the drivers are off
     *   (the real board takes ~500 ms and runs nothing meanwhile); 0 keeps power-on instant
     * @param {number} [o.homeMs=1500] how long a homing cycle blocks (virtual ms)
     * @param {number} [o.homeSteps=2000] steps a homing cycle takes (0.2.1 step counter)
     * @param {string} [o.homeResult='ok'] 'ok' | 'no_switch'
     * @param {number|null} [o.probeContactAtMm=null] probe touches after this travel; null = never
     * @param {boolean} [o.strictWire=false] record job motion lines lacking G21, G90 or F in `wireViolations`
     */
    constructor(o = {}) {
        super();
        this.legTimeScale = o.legTimeScale ?? 0.001;
        this.minLegMs = o.minLegMs ?? 1;
        // false = pre-0.1.1 firmware: an aborted move drops the steps it took,
        // so x/y/z stay at the START of that move and POS_EXACT is not set.
        this.posExact = o.posExact !== false;
        // '0.1.1' = flashed 2026-09-15, '0.2.0' = source_0.2.0 (running on the
        // machine 2026-09-17), '0.2.1' = source_0.2.1 (built, not flashed).
        // The host must work on all of them.
        //   0.2.0: OP_JOB_ABORT allowed in ALARM/E-stop and accepts the 0xFFFF
        //          wildcard; OP_RESUME only lifts a HOLD (never starts motion
        //          from IDLE); driver faults clear the planner and cut power.
        this.fwVersion = o.fwVersion || '0.2.0';
        this.is021 = this.fwVersion === '0.2.1';
        // F9-F15 (Phase 2 amendments, 2026-09-17). o.fw021Original models the
        // 0.2.1 build before them (hex f9801ca1, never flashed) for before/after
        // proofs; nothing ships that build.
        this.amend021 = this.is021 && !o.fw021Original;
        // 0.1.x reads numbers with the C library's strtof (hex floats and all);
        // 0.2.x uses its own decimal-only scanner (FW-1).
        this.scan = this.fwVersion === '0.1.1' ? strtof : gcodeStrtof;
        this.latencyMs = o.latencyMs ?? 1;
        this.statusPeriodMs = o.statusPeriodMs ?? 100;
        this.powerOnMs = o.powerOnMs ?? 0;
        this.homeMs = o.homeMs ?? 1500;
        this.homeSteps = o.homeSteps ?? 2000;
        this.homeResult = o.homeResult || 'ok';
        this.probeContactAtMm = o.probeContactAtMm ?? null;
        this.strictWire = !!o.strictWire;
        // impairment hooks: return true to drop
        this.dropIn = null;   // (frame) => bool, host -> firmware
        this.dropOut = null;  // (frameType, payload) => bool, firmware -> host
        this.frozen = false;  // legs stop advancing (stuck step engine)
        this.txMuted = false; // firmware stops sending (host sees silence)
        this.almAtEnable = null; // axis: the next power-on finds that driver's ALM active

        this.parser = new FrameParser();
        this.expectedSeq = 0;
        this.seqSynced = false;
        this.lastReply = null; // {seq, frame}
        this.evtSeq = 0;

        this.state = defs.ST_IDLE;
        this.powered = false;
        this.cur = { x: 0, y: 0, z: 0 };
        this.planned = { x: 0, y: 0, z: 0 };
        this.lastFeed = DEFAULT_FEED;
        this.modal = { scale: 1, absolute: true };
        this.ring = [];
        this.jobId = 0;
        this.jobActive = false;
        this.lastExecutedLine = 0;
        this.leg = null; // {line, from, to, feed, startMs, durMs, steps[, jog, move, trail]}
        this.jogPending = null; // {to, feed}: the leg queued behind the jog in flight
        this.jogIsRsp = false;
        this.lastHostRxMs = Date.now();
        this.faultLatched = 0;
        this.isrCount = 0;
        this.blockingSteps = 0; // 0.2.1 (F15)
        this.lastLegSteps = { done: 0, total: 0 };
        this.estopInput = false;

        // The firmware main loop is inside a blocking handler (OP_MOVE on
        // 0.1.1/0.2.0, OP_PROBE, OP_HOME, motion_power_start): frames wait.
        this._block = null;
        this._held = [];        // frames received but not dispatched yet
        this.movePending = null; // 0.2.1 (F9): {seq[, replyDropped]} of the OP_MOVE whose RSP is owed
        this._estopIsrPending = false; // 0.2.1 (F14)

        this.bootId = crypto.randomBytes(4).readUInt32LE(0) || 1;
        this.bootAtMs = Date.now();

        // Checked per leg instead of stored, for million-line files.
        this.onExecuted = o.onExecuted || null;
        this.recordExecuted = o.recordExecuted !== false;
        this.executedCount = 0;
        this.executed = [];   // [{line, jobId, to:{x,y,z}, feed}] legs that completed
        this.received = [];   // [{jobId, line, text}] job lines accepted (ring push or no-motion)
        this.opLog = [];      // [{op, seq}] every command handled
        this.execOrders = [[]]; // per JOB_START: line numbers in EV_EXECUTED order (recordExecuted only)
        this.wireViolations = []; // strictWire: [{jobId, line, text}]
        this.moves = [];      // OP_MOVE / OP_PROBE / OP_HOME accepted: [{op, from, to, feed}]
        this.sentFrames = 0;

        this._timer = setInterval(() => this._loop(), 1);
        this._statusTimer = setInterval(() => this._statusTick(), this.statusPeriodMs);
    }

    destroy() {
        clearInterval(this._timer);
        clearInterval(this._statusTimer);
    }

    // ------------------------------------------------------------------ wire
    /** Bytes from the host. */
    receive(buf) {
        this.lastHostRxMs = Date.now();
        for (const f of this.parser.feed(buf)) {
            if (this.dropIn && this.dropIn(f)) continue;
            // Blocked in a handler: the RX ring keeps everything in arrival
            // order until the main loop reads it.
            if (this._block || this._held.length) { this._held.push(f); continue; }
            this._dispatch(f);
        }
    }

    _out(frameType, seq, payload) {
        if (this.txMuted) return;
        if (this.dropOut && this.dropOut(frameType, payload)) return;
        const frame = buildFrame(frameType, 0, seq, payload);
        this.sentFrames++;
        setTimeout(() => this.emit('tx', frame), this.latencyMs);
        return frame;
    }

    _reply(frameType, seq, payload) {
        const frame = buildFrame(frameType, 0, seq, payload);
        this.lastReply = { seq, frame };
        if (this.txMuted) return;
        if (this.dropOut && this.dropOut(frameType, payload)) return;
        setTimeout(() => this.emit('tx', frame), this.latencyMs);
    }

    _ack(seq) { this._reply(FT_ACK, seq, Buffer.alloc(0)); }
    _nak(seq, op, reason) { this._reply(FT_NAK, seq, Buffer.from([op, reason])); }
    _ok(seq, op, data) { this._reply(FT_RSP, seq, Buffer.concat([Buffer.from([op, defs.ST_OK]), data || Buffer.alloc(0)])); }
    _err(seq, op, status) { this._reply(FT_RSP, seq, Buffer.from([op, status])); }
    _evt(payload) { this._out(FT_EVT, (this.evtSeq++) & 0xFFFF, payload); }

    _dispatch(f) {
        if (f.frameType === FT_HB) { this._out(FT_HB, 0, Buffer.alloc(0)); return; }
        if (f.frameType !== FT_CMD || !f.payload.length) return;
        const op = f.payload[0];
        const pl = f.payload.subarray(1);
        if (!this.seqSynced) { this.expectedSeq = f.seq; this.seqSynced = true; }
        if (f.seq === 0) {
            // 0.2.1 rsp_move_reply_dropped: the OP_MOVE of the session that just
            // ended never answers into the new one (expected 0 = same session wrapping)
            if (this.amend021 && this.movePending && this.expectedSeq !== 0) this.movePending.replyDropped = true;
            this.expectedSeq = 0;
            this.seqSynced = true;
        }
        if (f.seq === this.expectedSeq) {
            this.opLog.push({ op, seq: f.seq });
            if (this._handle(f.seq, op, pl)) this.expectedSeq = (this.expectedSeq + 1) & 0xFFFF;
            return;
        }
        if (this.lastReply && this.lastReply.seq === f.seq) {
            if (!this.txMuted) setTimeout(() => this.emit('tx', this.lastReply.frame), this.latencyMs);
            return;
        }
        this._nak(this.expectedSeq, op, defs.ST_ERR_SEQ_GAP);
    }

    /** Frames that waited for a blocking handler. */
    _drainHeld() {
        while (!this._block && this._held.length) this._dispatch(this._held.shift());
    }

    _handle(seq, op, pl) {
        const alarmAllowed = [defs.OP_GET_STATUS, defs.OP_PING, defs.OP_GET_RUN_STATE, defs.OP_GET_CONFIG,
            defs.OP_UNLOCK, defs.OP_SOFT_RESET, defs.OP_E_STOP];
        if (this.fwVersion !== '0.1.1') alarmAllowed.push(defs.OP_JOB_ABORT); // FW-10
        if ((this.state === defs.ST_ALARM || this.state === defs.ST_ESTOP) && !alarmAllowed.includes(op)) {
            this._err(seq, op, defs.ST_ERR_STATE);
            return 1;
        }
        switch (op) {
            case defs.OP_GET_STATUS: this._ok(seq, op, this._telemetry()); return 1;
            case defs.OP_GET_CONFIG: {
                // build_config_json(): the firmware's own version string is how
                // the host tells the builds apart.
                const fw = this.fwVersion === '0.1.1' ? '0.1.1-almfilter' : this.fwVersion;
                let json = `{"fw":"${fw}","axes":3,`
                    + '"steps_per_mm":[200.0,200.0,200.0],"home_dir_neg":[1,1,0],'
                    + '"home_travel_ceiling_mm":400.0,"home_pulloff_mm":2.0,"calibrated":true';
                if (this.amend021) {
                    const uptime = (Date.now() - this.bootAtMs) >>> 0;
                    json += `,"boot_id":"${this.bootId.toString(16).padStart(8, '0')}","uptime_ms":${uptime}`;
                }
                this._ok(seq, op, Buffer.from(`${json}}`, 'utf8'));
                return 1;
            }
            case defs.OP_GET_RUN_STATE: {
                const d = Buffer.alloc(16);
                d.writeUInt16LE(this.jobId, 0);
                d.writeUInt16LE(this.lastExecutedLine & 0xFFFF, 2);
                d.writeFloatLE(this.cur.x, 4);
                d.writeFloatLE(this.cur.y, 8);
                d.writeFloatLE(this.cur.z, 12);
                this._ok(seq, op, d);
                return 1;
            }
            case defs.OP_PING: this._ok(seq, op); return 1;
            case defs.OP_UNLOCK:
                if (this.amend021) this._estopService();
                this._syncAbort();
                this.faultLatched = 0;
                if (this.state === defs.ST_ALARM) this.state = defs.ST_IDLE;
                else if (this.state === defs.ST_ESTOP && !this.estopInput) this.state = defs.ST_IDLE;
                this._ok(seq, op);
                return 1;
            case defs.OP_E_STOP: this._engageEstop(); this._ok(seq, op); return 1;
            case defs.OP_FEED_HOLD: if (this.state === defs.ST_RUNNING) this.state = defs.ST_HOLD; this._ok(seq, op); return 1;
            case defs.OP_RESUME:
                if (this.state === defs.ST_HOLD) this.state = defs.ST_RUNNING;
                else if (this.fwVersion === '0.1.1' && (this.state === defs.ST_IDLE || this.state === defs.ST_STREAMING) && this.ring.length) {
                    // legacy cycle-start: starts motion from IDLE on whatever
                    // is still queued (removed in 0.2.0, FW-10)
                    this.legacyCycleStarts = (this.legacyCycleStarts || 0) + 1;
                    this.state = defs.ST_RUNNING;
                }
                this._ok(seq, op);
                return 1;
            case defs.OP_SOFT_RESET: this._ok(seq, op); this.rebooted = true; return 1;
            case defs.OP_SET_FEED_OVERRIDE: this._ok(seq, op); return 1;
            case defs.OP_ZERO: {
                if (this.state !== defs.ST_IDLE) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
                const mask = pl[0];
                for (const [bit, k] of [[1, 'x'], [2, 'y'], [4, 'z']]) {
                    if (mask & bit) { this.cur[k] = 0; this.planned[k] = 0; }
                }
                this._ok(seq, op);
                return 1;
            }
            case defs.OP_JOG: return this._jog(seq, op, pl);
            case defs.OP_MOVE: return this.amend021 ? this._moveAsync(seq, op, pl) : this._moveBlocking(seq, op, pl);
            case defs.OP_PROBE: return this._probe(seq, op, pl);
            case defs.OP_HOME: return this._home(seq, op, pl);
            case defs.OP_JOB_START: {
                if (pl.length < 4) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
                if (this.state !== defs.ST_IDLE) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
                this.ring = [];
                this._syncAbort();
                this.planned = { ...this.cur };
                if (this.amend021) {
                    // F13: every job starts in G21 G90 at the default feed
                    this.modal = { scale: 1, absolute: true };
                    this.lastFeed = DEFAULT_FEED;
                }
                this.leg = null;
                this.jobId = pl.readUInt16LE(0);
                this.jobActive = true;
                this.lastExecutedLine = 0;
                this.state = defs.ST_RUNNING;
                this.jobStarts = (this.jobStarts || 0) + 1;
                if (this.recordExecuted) this.execOrders.push([]);
                this._ok(seq, op);
                return 1;
            }
            case defs.OP_JOB_LINE: return this._jobLine(seq, op, pl);
            case defs.OP_JOB_END: {
                const id = pl.readUInt16LE(0);
                if (id !== this.jobId) { this._err(seq, op, defs.ST_ERR_JOB); return 1; }
                this.jobActive = false;
                this.jobEnds = (this.jobEnds || 0) + 1;
                this._ok(seq, op);
                const b = Buffer.alloc(3); b[0] = defs.EV_JOB_DONE; b.writeUInt16LE(this.jobId, 1);
                this._evt(b);
                return 1;
            }
            case defs.OP_JOB_ABORT: {
                const id = pl.readUInt16LE(0);
                const wildcard = id === JOB_ID_WILDCARD && this.fwVersion !== '0.1.1'; // FW-19
                if (id !== this.jobId && !wildcard) { this._err(seq, op, defs.ST_ERR_JOB); return 1; }
                this._abortLeg();
                this.ring = [];
                this.planned = { ...this.cur };
                this.jobActive = false;
                if (this.state === defs.ST_RUNNING || this.state === defs.ST_HOLD) {
                    this.state = defs.ST_IDLE;
                    if (!this.is021) this.powered = false; // F4: 0.2.1 keeps the drivers on
                } else if (this.amend021 && this.state === defs.ST_JOGGING) {
                    this.state = defs.ST_IDLE; // F11: the jog cancel
                }
                this.jobAborts = (this.jobAborts || 0) + 1;
                this._moveFinish(defs.ST_ERR_STATE); // F9
                this._ok(seq, op);
                return 1;
            }
            default: this._err(seq, op, defs.ST_ERR_CMD); return 1;
        }
    }

    // --------------------------------------------------- jog / move / probe / home
    /** rsp_handle_jog() */
    _jog(seq, op, pl) {
        if (pl.length < 10) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
        if (this.state !== defs.ST_IDLE && this.state !== defs.ST_JOGGING) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
        const axis = pl[0];
        const dist = pl.readFloatLE(2);
        const feed = pl.readFloatLE(6);
        if (dist <= 0 || feed <= 0 || dist > HOME_MAX_TRAVEL_MM || feed > 10000) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
        // F12: one jog may wait behind the leg in flight, no more -- and none behind an OP_MOVE
        if (this.amend021 && (this.jogPending || this.movePending)) { this._err(seq, op, defs.ST_ERR_BUSY); return 1; }
        const key = ['x', 'y', 'z'][axis];
        if (!key) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
        // jogeng_get_committed(): queued target, else in-flight target, else cur
        const to = { ...(this.jogPending ? this.jogPending.to : this.leg ? this.leg.to : this.cur) };
        to[key] = f32(to[key] + (pl[1] ? dist : -dist));
        this.lastFeed = feed;
        this.jogIsRsp = true;
        this.state = defs.ST_JOGGING;
        this._powerOn(() => {
            if (this.leg) this.jogPending = { to, feed };
            else this.leg = this._newLeg(this.cur, to, feed, { jog: true });
            this._ok(seq, op);
        }, (why, axisIdx) => {
            if (why === 'estop') { this._err(seq, op, defs.ST_ERR_ESTOP); return; }
            this._enterFault(axisIdx, defs.FAULT_CODE_ALM_ENABLE);
            this._err(seq, op, defs.ST_ERR_FAULT);
        });
        return 1;
    }

    /** rsp_handle_move() up to 0.2.0: run_move() blocks the main loop. */
    _moveBlocking(seq, op, pl) {
        if (pl.length < 16) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
        if (this.state !== defs.ST_IDLE) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
        const to = { x: pl.readFloatLE(0), y: pl.readFloatLE(4), z: pl.readFloatLE(8) };
        const feed = pl.readFloatLE(12);
        if (feed <= 0 || feed > 10000) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
        this.lastFeed = feed;
        this._powerOn(() => {
            this.moves.push({ op, from: { ...this.cur }, to: { ...to }, feed });
            // run_move(): (int32_t)NaN is 0 on the FPU -- a NaN axis takes no
            // steps, and the finished move still sets it to the NaN target
            const stepTo = { ...to };
            for (const k of ['x', 'y', 'z']) if (Number.isNaN(stepTo[k])) stepTo[k] = this.cur[k];
            const leg = this._newLeg(this.cur, stepTo, feed, { finalTo: { ...to } });
            // state stays IDLE, x/y/z frozen at the start; run_move ticks EV_STATUS
            this._block = { kind: 'move', seq, op, leg, statusTicks: true };
        }, (why, axisIdx) => {
            if (why === 'estop') { this._err(seq, op, defs.ST_ERR_ESTOP); return; }
            this._enterFault(axisIdx, defs.FAULT_CODE_ALM_ENABLE);
            this._err(seq, op, defs.ST_ERR_FAULT);
        });
        return 1;
    }

    /** rsp_handle_move() 0.2.1 (F9): async engine, ACK now, RSP when it ends. */
    _moveAsync(seq, op, pl) {
        if (pl.length < 16) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
        if (this.state !== defs.ST_IDLE) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
        const to = { x: pl.readFloatLE(0), y: pl.readFloatLE(4), z: pl.readFloatLE(8) };
        const feed = pl.readFloatLE(12);
        if (!(feed > 0) || feed > 10000) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
        if (!['x', 'y', 'z'].every((k) => to[k] >= -MOVE_COORD_LIMIT_MM && to[k] <= MOVE_COORD_LIMIT_MM)) {
            this._err(seq, op, defs.ST_ERR_CMD); // NaN or beyond 10 m
            return 1;
        }
        if (this.leg || this.jogPending) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
        this.lastFeed = feed;
        this._ack(seq);
        this.jogIsRsp = true;
        this.state = defs.ST_JOGGING;
        this._powerOn(() => {
            this.moves.push({ op, from: { ...this.cur }, to: { ...to }, feed });
            this.movePending = { seq };
            this.leg = this._newLeg(this.cur, to, feed, { jog: true, move: true });
        }, (why, axisIdx) => {
            if (why === 'estop') {
                if (this.state === defs.ST_JOGGING) this.state = defs.ST_IDLE;
                this._err(seq, op, defs.ST_ERR_ESTOP);
                return;
            }
            this._enterFault(axisIdx, defs.FAULT_CODE_ALM_ENABLE);
            this._err(seq, op, defs.ST_ERR_FAULT);
        });
        return 1;
    }

    /** rsp_handle_probe() + probe_sequence(): blocking on every version. */
    _probe(seq, op, pl) {
        if (pl.length < 10) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
        if (this.state !== defs.ST_IDLE) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
        const axis = pl[0];
        const wire = pl[1];
        const maxTravel = pl.readFloatLE(2);
        const feed = pl.readFloatLE(6);
        if (axis > 2 || maxTravel <= 0 || maxTravel > HOME_MAX_TRAVEL_MM || feed <= 0 || feed > 10000) {
            this._err(seq, op, defs.ST_ERR_CMD);
            return 1;
        }
        // Where the count goes. The Z wire bit is inverted by the sender on
        // every version; 0.2.0 then counted Z the wrong way (off by twice the
        // travel), 0.2.1 (F6) converts the bit and counts the real motion.
        const dirNeg = (axis === 2 && this.is021) ? (wire ? 0 : 1) : (wire ? 1 : 0);
        if (this.amend021) { this._ack(seq); this.state = defs.ST_JOGGING; } // F10
        this._powerOn(() => {
            const contact = this.probeContactAtMm !== null && this.probeContactAtMm <= maxTravel;
            const distMm = contact ? this.probeContactAtMm : maxTravel;
            const key = ['x', 'y', 'z'][axis];
            const to = { ...this.cur };
            to[key] = f32(to[key] + (dirNeg ? -distMm : distMm));
            const leg = this._newLeg(this.cur, to, feed, {});
            this.moves.push({ op, from: { ...this.cur }, to: { ...to }, feed });
            this._block = { kind: 'probe', seq, op, axis, key, dirNeg, contact, distMm, leg, statusTicks: this.amend021 };
        }, (why, axisIdx) => {
            if (this.state === defs.ST_JOGGING) this.state = defs.ST_IDLE;
            this.powered = false;
            if (why === 'estop') { this._err(seq, op, defs.ST_ERR_ESTOP); return; }
            this._enterFault(axisIdx, defs.FAULT_CODE_ALM_MOTION);
            this._err(seq, op, defs.ST_ERR_FAULT);
        });
        return 1;
    }

    /** rsp_handle_home() + home_sequence(): blocking on every version. */
    _home(seq, op, pl) {
        if (this.state !== defs.ST_IDLE) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
        const mask = pl.length >= 1 ? pl[0] : 0x07;
        if (this.amend021) this._ack(seq); // F10
        this.state = defs.ST_HOMING;
        this._powerOn(() => {
            this.moves.push({ op, from: { ...this.cur }, to: null, feed: 0 });
            this._block = { kind: 'home', seq, op, mask, startMs: Date.now(), durMs: this.homeMs, statusTicks: this.amend021 };
        }, (why) => {
            this.powered = false;
            if (why === 'estop') { this._homeEstop(seq, op); return; }
            this.state = defs.ST_ALARM;
            this._err(seq, op, defs.ST_ERR_FAULT);
        });
        return 1;
    }

    _homeEstop(seq, op) {
        // 0.2.0 leaves HOMING when no E-stop edge latched the state; 0.2.1 (F14) latches it
        if (this.amend021) this._engageEstop();
        this._err(seq, op, this.state === defs.ST_ESTOP ? defs.ST_ERR_ESTOP : defs.ST_ERR_FAULT);
    }

    /** motion_power_start(): instant while powered, otherwise settles powerOnMs. */
    _powerOn(then, fail) {
        if (this.powered) { then(); return; }
        if (this.estopInput) { fail('estop'); return; }
        const finish = () => {
            // 0.2.1 (F14) re-checks the input and the latched state after the settle
            if (this.amend021 && (this.estopInput || this.state === defs.ST_ESTOP)) { this.powered = false; fail('estop'); return; }
            if (this.almAtEnable !== null) {
                const axis = this.almAtEnable;
                this.almAtEnable = null;
                this.powered = false;
                fail('alm', axis);
                return;
            }
            this.powered = true;
            then();
        };
        if (this.powerOnMs > 0) this._block = { kind: 'power', until: Date.now() + this.powerOnMs, finish, statusTicks: false };
        else finish();
    }

    /** The blocking handler the main loop is in. */
    _serviceBlock(now) {
        const b = this._block;
        if (b.kind === 'power') {
            if (now < b.until) return;
            this._block = null;
            b.finish();
            return;
        }
        // The loops watch the E-stop input; 0.2.1 also a latched E-stop whose
        // input already reads released (a short press)
        const estopNow = this.estopInput || (this.amend021 && this.state === defs.ST_ESTOP);
        if (b.kind === 'home') {
            if (estopNow) {
                this._block = null;
                this.powered = false;
                this._homeEstop(b.seq, b.op);
                return;
            }
            if (b.alarm !== undefined) {
                this._block = null;
                this.powered = false;
                this.state = defs.ST_ALARM;
                this._err(b.seq, b.op, defs.ST_ERR_FAULT);
                return;
            }
            if (now - b.startMs < b.durMs) return;
            this._block = null;
            this.powered = false; // home_sequence powers off on every exit
            if (this.amend021) this.blockingSteps += this.homeSteps;
            if (this.homeResult === 'ok') {
                for (const [bit, k] of [[1, 'x'], [2, 'y'], [4, 'z']]) {
                    if (b.mask & bit) { this.cur[k] = 0; this.planned[k] = 0; }
                }
                this.state = defs.ST_IDLE;
                this._ok(b.seq, b.op);
            } else {
                this.state = defs.ST_ALARM;
                this._err(b.seq, b.op, defs.ST_ERR_FAULT);
            }
            return;
        }
        // move / probe: a leg stepped in a loop
        const p = Math.min(1, (now - b.leg.startMs) / b.leg.durMs);
        const stopped = estopNow ? 'estop' : (b.alarm !== undefined ? 'alm' : (p >= 1 ? 'done' : null));
        if (!stopped) return;
        this._block = null;
        const doneP = stopped === 'done' ? 1 : p;
        const stepsTaken = Math.round(b.leg.steps * doneP);
        if (b.kind === 'probe') {
            const dist = f32(Math.round(b.distMm * doneP * STEPS_PER_MM) / STEPS_PER_MM);
            this.cur[b.key] = f32(b.leg.from[b.key] + (b.dirNeg ? -dist : dist));
            this.planned = { ...this.cur };
            this.powered = false; // probe_sequence powers off on every exit
            if (this.amend021) {
                this.blockingSteps += stepsTaken;
                if (this.state === defs.ST_JOGGING) this.state = defs.ST_IDLE;
            }
            if (stopped === 'estop') { this._err(b.seq, b.op, defs.ST_ERR_ESTOP); return; }
            if (stopped === 'alm') { this._enterFault(b.alarm, defs.FAULT_CODE_ALM_MOTION); this._err(b.seq, b.op, defs.ST_ERR_FAULT); return; }
            const d = Buffer.alloc(18);
            d[0] = b.contact ? defs.PROBE_RESULT_CONTACT : defs.PROBE_RESULT_NO_CONTACT;
            d[1] = b.axis;
            d.writeFloatLE(dist, 2);
            d.writeFloatLE(this.cur.x, 6);
            d.writeFloatLE(this.cur.y, 10);
            d.writeFloatLE(this.cur.z, 14);
            this._ok(b.seq, b.op, d);
            return;
        }
        // blocking OP_MOVE (0.1.1 / 0.2.0)
        if (stopped === 'done') {
            this.cur = { ...(b.leg.finalTo || b.leg.to) };
        } else if (this.posExact) {
            for (const k of ['x', 'y', 'z']) {
                const steps = Math.round((b.leg.from[k] + (b.leg.to[k] - b.leg.from[k]) * doneP) * STEPS_PER_MM);
                this.cur[k] = f32(steps / STEPS_PER_MM);
            }
        }
        this.planned = { ...this.cur };
        if (stopped === 'estop') { this._err(b.seq, b.op, defs.ST_ERR_ESTOP); return; }
        if (stopped === 'alm') { this._enterFault(b.alarm, defs.FAULT_CODE_ALM_MOTION); this._err(b.seq, b.op, defs.ST_ERR_FAULT); return; }
        this._ok(b.seq, b.op);
    }

    /** rsp_move_finish() -- 0.2.1 (F9): the reply an OP_MOVE in flight still owes. */
    _moveFinish(status) {
        if (!this.movePending) return;
        const { seq, replyDropped } = this.movePending;
        this.movePending = null;
        if (replyDropped) { this.droppedMoveReplies = (this.droppedMoveReplies || 0) + 1; return; }
        if (status === defs.ST_OK) this._ok(seq, defs.OP_MOVE);
        else this._err(seq, defs.OP_MOVE, status);
    }

    /** rsp_enter_fault() */
    _enterFault(axis, code) {
        this._abortLeg();
        this.powered = false;
        this.faultLatched |= 1 << axis;
        this._evt(Buffer.from([defs.EV_FAULT, axis, code]));
        this.ring = [];
        this.planned = { ...this.cur };
        this.jobActive = false;
        this.state = defs.ST_ALARM;
        this._moveFinish(defs.ST_ERR_FAULT);
    }

    /** 0.2.1 (F14) estop_isr_service() */
    _estopService() {
        if (!this._estopIsrPending) return;
        this._estopIsrPending = false;
        this._engageEstop();
    }

    _jobLine(seq, op, pl) {
        if (pl.length < 4 || !this.jobActive) { this._nak(seq, op, defs.ST_ERR_JOB); return 1; }
        const id = pl.readUInt16LE(0);
        const lineNo = pl.readUInt16LE(2);
        if (id !== this.jobId) { this._nak(seq, op, defs.ST_ERR_JOB); return 1; }
        const text = pl.subarray(4, Math.min(pl.length, 4 + 63)).toString('latin1');
        const r = this._parse(text);
        if (r.kind === 'arc') { this._nak(seq, op, defs.ST_ERR_CMD); return 1; }
        if (r.kind === 'none') {
            this.received.push({ jobId: id, line: lineNo, text });
            this._ack(seq);
            if (this.is021) {
                // F5 job_defer_no_motion_report(): rides on the newest queued
                // move, or on the leg in flight
                if (this.ring.length > 0) { this.ring[this.ring.length - 1].trail = lineNo; return 1; }
                if (this.leg && !this.leg.jog) { this.leg.trail = lineNo; return 1; }
            }
            this.lastExecutedLine = lineNo;
            this._sendExecuted(lineNo);
            return 1;
        }
        if (this.ring.length >= MOVE_RING_DEPTH) {
            // undo modal side effects? firmware parses modal words before the
            // push check too; compiled lines always restate G21 G90.
            this._nak(seq, op, defs.ST_ERR_BUFFER);
            this.bufferNaks = (this.bufferNaks || 0) + 1;
            return 0;
        }
        if (this.strictWire && !(/(^|\s)G21(\s|$)/i.test(text) && /(^|\s)G90(\s|$)/i.test(text) && /(^|\s)F\s*[-+]?\.?\d/i.test(text))) {
            this.wireViolations.push({ jobId: id, line: lineNo, text });
        }
        this.ring.push({ mv: r.mv, line: lineNo, text });
        this.planned = { x: r.mv.x, y: r.mv.y, z: r.mv.z };
        this.received.push({ jobId: id, line: lineNo, text });
        this._ack(seq);
        return 1;
    }

    /** parse_gcode_text() */
    _parse(s) {
        // line_has_arc
        for (let i = 0; i < s.length;) {
            const c = s[i++];
            if (c === ' ' || c === '\t') continue;
            const n = this.scan(s.slice(i));
            if (!n) continue;
            if (c.toUpperCase() === 'G' && (n.value === 2 || n.value === 3)) return { kind: 'arc' };
            i += n.len;
        }
        // modal pass
        for (let i = 0; i < s.length;) {
            const c = s[i++];
            if (c === ' ' || c === '\t') continue;
            const n = this.scan(s.slice(i));
            if (!n) continue;
            const L = c.toUpperCase();
            if (L === 'G') {
                if (n.value === 20) this.modal.scale = f32(25.4);
                else if (n.value === 21) this.modal.scale = 1;
                else if (n.value === 90) this.modal.absolute = true;
                else if (n.value === 91) this.modal.absolute = false;
            }
            i += n.len;
        }
        const mv = { x: this.planned.x, y: this.planned.y, z: this.planned.z, feed: this.lastFeed };
        let saw = 0;
        const w = { x: 0, y: 0, z: 0 };
        for (let i = 0; i < s.length;) {
            const c = s[i++];
            if (c === ' ' || c === '\t') continue;
            const n = this.scan(s.slice(i));
            if (!n) continue;
            const L = c.toUpperCase();
            if (L === 'X') { w.x = f32(n.value * this.modal.scale); saw |= 1; }
            else if (L === 'Y') { w.y = f32(n.value * this.modal.scale); saw |= 2; }
            else if (L === 'Z') { w.z = f32(n.value * this.modal.scale); saw |= 4; }
            else if (L === 'F') { mv.feed = f32(n.value * this.modal.scale); }
            i += n.len;
        }
        if (!saw) return { kind: 'none' };
        if (saw & 1) mv.x = this.modal.absolute ? w.x : f32(this.planned.x + w.x);
        if (saw & 2) mv.y = this.modal.absolute ? w.y : f32(this.planned.y + w.y);
        if (saw & 4) mv.z = this.modal.absolute ? w.z : f32(this.planned.z + w.z);
        return { kind: 'motion', mv };
    }

    _sendExecuted(lineNo) {
        if (this.recordExecuted) this.execOrders[this.execOrders.length - 1].push(lineNo);
        const b = Buffer.alloc(17);
        b[0] = defs.EV_EXECUTED;
        b.writeUInt16LE(this.jobId, 1);
        b.writeUInt16LE(lineNo & 0xFFFF, 3);
        b.writeFloatLE(this.cur.x, 5);
        b.writeFloatLE(this.cur.y, 9);
        b.writeFloatLE(this.cur.z, 13);
        this._evt(b);
    }

    // ---------------------------------------------------------------- motion
    _legSteps(from, to) {
        return Math.max(...['x', 'y', 'z'].map((k) => Math.abs(Math.round(to[k] * STEPS_PER_MM) - Math.round(from[k] * STEPS_PER_MM))));
    }

    _newLeg(from, to, feed, extra) {
        const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
        const realMs = feed > 0 ? (dist / feed) * 60000 : 0;
        return {
            line: 0, text: 'jog', from: { ...from }, to: { ...to }, feed,
            startMs: Date.now(), durMs: Math.max(this.minLegMs, realMs * this.legTimeScale),
            steps: this._legSteps(from, to), ...extra,
        };
    }

    _legProgress(now) {
        const l = this.leg;
        if (!l) return 1;
        if (this.frozen) return l.frozenAt ?? (l.frozenAt = Math.min(1, (now - l.startMs) / l.durMs));
        return Math.min(1, (now - l.startMs) / l.durMs);
    }

    /** jogeng_abort() + sync_position_after_abort(): the leg in flight and any queued jog. */
    _abortLeg() {
        this.jogPending = null;
        if (!this.leg) return;
        const p = this._legProgress(Date.now());
        const l = this.leg;
        if (this.posExact) {
            for (const k of ['x', 'y', 'z']) {
                // commit whole steps actually taken (POS_EXACT)
                const steps = Math.round((l.from[k] + (l.to[k] - l.from[k]) * p) * STEPS_PER_MM);
                this.cur[k] = f32(steps / STEPS_PER_MM);
            }
        } else {
            this.cur = { ...l.from }; // old firmware: the steps taken are lost
        }
        this.lastLegSteps = { done: Math.round(l.steps * p), total: l.steps };
        this.aborted = (this.aborted || []);
        this.aborted.push({ line: l.line, progress: p });
        this.leg = null;
    }

    _syncAbort() { /* position already committed in _abortLeg */ }

    _engageEstop() {
        this._abortLeg();
        this.powered = false;
        this.ring = [];
        this.planned = { ...this.cur };
        this.jobActive = false;
        this.state = defs.ST_ESTOP;
        this._moveFinish(defs.ST_ERR_ESTOP);
    }

    /** Test hook: driver ALM confirmed on `axis` while moving. */
    injectAlarm(axis = 0) {
        if (this._block && this._block.kind !== 'power') {
            // run_move / probe / homing loop sees it at its next check
            this._block.alarm = axis;
            return;
        }
        if (this.state === defs.ST_JOGGING) {
            // protocol_jog_poll(): JOGPOLL_FAULT
            this._abortLeg();
            this.powered = false;
            this.faultLatched |= 1 << axis;
            this._evt(Buffer.from([defs.EV_FAULT, axis, defs.FAULT_CODE_ALM_MOTION]));
            this.state = defs.ST_ALARM;
            this._moveFinish(defs.ST_ERR_FAULT);
            return;
        }
        // protocol_run_tick fault path
        this._abortLeg();
        this.powered = false;
        this.faultLatched |= 1 << axis;
        this._evt(Buffer.from([defs.EV_FAULT, axis, defs.FAULT_CODE_ALM_MOTION]));
        this.ring = [];
        this.planned = { ...this.cur };
        this.jobActive = false;
        this.state = defs.ST_ALARM;
    }

    /**
     * Test hook: the physical E-stop input goes active (HAL_GPIO_EXTI_Callback):
     * the engine stops (steps taken are kept), driver power is cut and the state
     * latches E-stop. Up to 0.2.0 that is all -- planner, job flags and the
     * reported job stay as they were; 0.2.1 (F14) clears them in the main loop.
     * Blocking handlers notice at their next check. Unlock is refused until
     * releasePhysicalEstop().
     */
    injectPhysicalEstop() {
        this.estopInput = true;
        this._abortLeg();
        this.powered = false;
        this.state = defs.ST_ESTOP;
        if (this.amend021) this._estopIsrPending = true;
    }

    /** Test hook: the physical E-stop input is released (the state stays latched). */
    releasePhysicalEstop() {
        this.estopInput = false;
    }

    /**
     * Test hook: the board reboots (brown-out, watchdog). X/Y/Z, the step
     * counter, the job and the session all start again from zero; 0.2.1 gets a
     * new boot_id. The host sees nothing until it talks to the board again.
     */
    simulateReboot() {
        this.state = defs.ST_IDLE;
        this.powered = false;
        this.cur = { x: 0, y: 0, z: 0 };
        this.planned = { x: 0, y: 0, z: 0 };
        this.lastFeed = DEFAULT_FEED;
        this.modal = { scale: 1, absolute: true };
        this.ring = [];
        this.jobId = 0;
        this.jobActive = false;
        this.lastExecutedLine = 0;
        this.leg = null;
        this.jogPending = null;
        this.jogIsRsp = false;
        this.faultLatched = 0;
        this.isrCount = 0;
        this.blockingSteps = 0;
        this.lastLegSteps = { done: 0, total: 0 };
        this.estopInput = false;
        this._block = null;
        this._held = [];
        this.movePending = null;
        this._estopIsrPending = false;
        this.expectedSeq = 0;
        this.seqSynced = false;
        this.lastReply = null;
        this.evtSeq = 0;
        this.parser = new FrameParser();
        this.bootId = crypto.randomBytes(4).readUInt32LE(0) || 1;
        this.bootAtMs = Date.now();
        this.reboots = (this.reboots || 0) + 1;
    }

    /** 0..1 progress of the leg in flight (test helper). */
    legProgress() {
        return this.leg ? this._legProgress(Date.now()) : 1;
    }

    /** protocol_run_tick()'s "service the leg in flight" step. */
    _serviceLeg(now) {
        if (!this.leg) return false;
        if (this._legProgress(now) < 1 || this.frozen) return false;
        const l = this.leg;
        this.cur = { ...l.to };
        this.lastLegSteps = { done: l.steps, total: l.steps };
        this.leg = null;
        const rec = { line: l.line, jobId: this.jobId, to: { ...l.to }, feed: l.feed, text: l.text };
        this.executedCount += 1;
        if (this.recordExecuted) this.executed.push(rec);
        if (this.onExecuted) this.onExecuted(rec);
        this.lastExecutedLine = l.line;
        this._sendExecuted(l.line);
        if (l.trail !== undefined) {
            // 0.2.1 (F5): the no-motion line that followed this move
            this.lastExecutedLine = l.trail;
            this._sendExecuted(l.trail);
        }
        return true;
    }

    _loop() {
        const now = Date.now();
        // TIM2 only runs while a move is stepping, so the ISR counter is
        // constant when the engine is idle (the host keys "same stale abort"
        // detection on it).
        if (this.leg && !this.frozen) this.isrCount += 1;

        // The main loop is inside a blocking handler: nothing else runs (not
        // even the F14 E-stop cleanup -- the loops only watch the input/state).
        if (this._block) {
            this._serviceBlock(now);
            if (this._block) return;
        }
        if (this.amend021) this._estopService();
        this._drainHeld();
        if (this._block) return;

        // protocol_jog_poll()
        if (this.amend021 && this.state !== defs.ST_JOGGING && this.movePending) {
            this._moveFinish(this.state === defs.ST_ESTOP ? defs.ST_ERR_ESTOP
                : this.state === defs.ST_ALARM ? defs.ST_ERR_FAULT : defs.ST_ERR_STATE);
        }
        if (this.state === defs.ST_JOGGING) {
            if (this.amend021 && this.jogIsRsp && !this.leg && !this.jogPending) {
                // F11: the engine emptied without a completion
                if (this.estopInput) { this._engageEstop(); return; }
                this.planned = { ...this.cur };
                this.state = defs.ST_IDLE;
                this._moveFinish(defs.ST_ERR_STATE);
                return;
            }
            if (this.leg && this._legProgress(now) >= 1 && !this.frozen) {
                const l = this.leg;
                this.lastLegSteps = { done: l.steps, total: l.steps };
                if (this.jogPending) {
                    // jogeng_poll(): the queued leg starts from this leg's
                    // target; x/y/z are only committed when the chain drains
                    const p = this.jogPending;
                    this.jogPending = null;
                    this.leg = this._newLeg(l.to, p.to, p.feed, { jog: true });
                    return;
                }
                this.cur = { ...l.to };
                this.planned = { ...this.cur };
                this.leg = null;
                if (this.jogIsRsp) this.state = defs.ST_IDLE;
                this._moveFinish(defs.ST_OK);
            }
            return;
        }

        if (this.state === defs.ST_HOLD) {
            // 0.1.1 returns immediately while held: the leg that was already
            // in flight keeps stepping but is neither committed nor reported,
            // the ALM lines are not watched, and the host watchdog is not
            // checked. 0.2.0 (F1) services all three, but still pops nothing.
            if (this.fwVersion === '0.1.1') return;
            if (now - this.lastHostRxMs >= WATCHDOG_MS) {
                this.watchdogTrips = (this.watchdogTrips || 0) + 1;
                this._engageEstop();
                return;
            }
            this._serviceLeg(now);
            return;
        }

        if (this.state !== defs.ST_RUNNING) return;
        if (now - this.lastHostRxMs >= WATCHDOG_MS) {
            this.watchdogTrips = (this.watchdogTrips || 0) + 1;
            this._engageEstop();
            return;
        }
        if (this.leg) {
            this._serviceLeg(now);
            return;
        }
        const qm = this.ring.shift();
        if (!qm) {
            if (this.jobActive) return;
            this.state = defs.ST_IDLE;
            if (!this.is021) this.powered = false; // F4: 0.2.1 keeps the drivers on
            return;
        }
        this.lastFeed = qm.mv.feed;
        this._powerOn(() => {
            if (this.state !== defs.ST_RUNNING) return; // stopped while the drivers settled
            const to = { x: qm.mv.x, y: qm.mv.y, z: qm.mv.z };
            this.leg = this._newLeg(this.cur, to, qm.mv.feed, { line: qm.line, text: qm.text });
            if (qm.trail !== undefined) this.leg.trail = qm.trail;
        }, (why, axisIdx) => {
            if (why === 'estop') return;
            // job_motion_fault(ALM_ENABLE): the popped move is lost with the ring
            this._enterFault(axisIdx, defs.FAULT_CODE_ALM_ENABLE);
        });
    }

    // ------------------------------------------------------------- telemetry
    _telemetry() {
        const now = Date.now();
        let flags = this.posExact ? TEL_FLAG_POS_EXACT : 0;
        if (this.powered) flags |= TEL_FLAG_POWERED;
        if (this.state === defs.ST_ESTOP) flags |= TEL_FLAG_ESTOP;
        if (this.jobActive) flags |= TEL_FLAG_JOB_ACTIVE;
        if (this.state === defs.ST_HOLD) flags |= TEL_FLAG_FEED_HOLD;
        const leg = this.leg;
        const steps = leg ? { done: Math.round(leg.steps * this._legProgress(now)), total: leg.steps } : this.lastLegSteps;
        // 0.2.1 (F15): steps of a probe in progress count as they are taken
        let blockingNow = 0;
        const b = this._block;
        if (this.amend021 && b && b.kind === 'probe') blockingNow = Math.round(b.leg.steps * Math.min(1, (now - b.leg.startMs) / b.leg.durMs));
        if (this.amend021 && b && b.kind === 'home') blockingNow = Math.round(this.homeSteps * Math.min(1, (now - b.startMs) / b.durMs));
        return defs.packTelemetry({
            state: this.state,
            faultFlags: this.faultLatched,
            limitFlags: 0,
            flags,
            x: this.cur.x, y: this.cur.y, z: this.cur.z,
            feed: this.lastFeed,
            spindleSpeed: 0,
            lastExecutedLine: this.lastExecutedLine,
            jobId: this.jobId,
            bufferFillPct: Math.round((this.ring.length * 100) / MOVE_RING_DEPTH),
            plannerDepth: this.ring.length,
            linkOk: 1,
            errorCode: 0,
            // jogeng_debug_get() reports the engine's own active flag. A leg
            // that is stuck (TIM2 not firing, driver not stepping) still has
            // that flag SET -- the firmware has no idea it is stuck. Reporting
            // 0 here would have handed the host a "not moving" signal the real
            // machine never sends, and the stall test would prove nothing.
            jogActive: leg ? 1 : 0,
            jogDoneEvt: 0,
            tim2IsrCount: this.frozen ? 12345 : ((this.isrCount + this.blockingSteps + blockingNow) >>> 0),
            stepsDone: steps.done,
            stepsTotal: steps.total,
        });
    }

    _statusTick() {
        // A blocking handler sends EV_STATUS only if its loop calls
        // protocol_status_tick() (run_move always; probe/homing from 0.2.1).
        if (this._block && !this._block.statusTicks) return;
        this._evt(Buffer.concat([Buffer.from([defs.EV_STATUS]), this._telemetry()]));
    }
}

/** Connection double for RSPController.bind(): wires host <-> FakeFirmware. */
class FakeConnection extends EventEmitter {
    constructor(fw) {
        super();
        this.isOpen = true;
        this.fw = fw;
        this.hostDrop = null; // (buf) => bool, drop host->firmware writes
        fw.on('tx', (frame) => { if (this.isOpen) this.emit('rawData', frame); });
    }

    writeRaw(buf) {
        if (!this.isOpen) return;
        if (this.hostDrop && this.hostDrop(buf)) return;
        // USB latency host -> device
        setTimeout(() => this.fw.receive(buf), 1);
    }

    emitToSockets() {}
}

module.exports = { FakeFirmware, FakeConnection, strtof, gcodeStrtof, MOVE_RING_DEPTH };
