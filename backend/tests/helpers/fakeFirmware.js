'use strict';

/**
 * Fake RSP firmware for host tests (plan item QA-2).
 *
 * Mirrors the RSP layer of fw 0.1.x easycnc_protocol.c closely enough to test
 * the host streaming engine end to end, including the firmware behaviours that
 * caused real failures:
 *   - rsp_dispatch(): seq sync, seq 0 = session reset, single cached reply,
 *     SEQ_GAP NAK naming the expected seq, BUFFER NAK does not advance
 *   - rsp_handle_job_line(): no-motion lines ACKed + EV_EXECUTED on RECEIPT,
 *     motion lines into an 8-deep ring, arcs refused with NAK ERR_CMD
 *   - parse_gcode_text(): strtof() number reading (hex floats included), feed
 *     taken from last_feed at parse time, last_feed updated when a move pops
 *   - protocol_run_tick(): one leg at a time, EV_EXECUTED when a leg ends,
 *     5 s host watchdog while RUNNING, IDLE + drivers off when the ring is
 *     empty after JOB_END
 *   - JOB_ABORT / E_STOP / ALARM keep the partial position (POS_EXACT)
 *
 * Runs on the global timers, so tests drive it with node:test mock timers.
 * Every executed leg is recorded in `executed` for exact path checks.
 */

const { EventEmitter } = require('events');
const defs = require('../../services/rsp/defs');
const { FrameParser, buildFrame, FT_CMD, FT_RSP, FT_EVT, FT_ACK, FT_NAK, FT_HB } = require('../../services/rsp/frame');

const MOVE_RING_DEPTH = 8;
const STEPS_PER_MM = 200;
const WATCHDOG_MS = 5000;
const TEL_FLAG_POWERED = 0x01;
const TEL_FLAG_ESTOP = 0x02;
const TEL_FLAG_JOB_ACTIVE = 0x08;
const TEL_FLAG_FEED_HOLD = 0x10;
const TEL_FLAG_POS_EXACT = 0x20;

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
     * @param {number} [o.legTimeScale=0.001] leg duration = real duration * scale (virtual ms)
     * @param {number} [o.latencyMs=1] delay for each output frame
     */
    constructor(o = {}) {
        super();
        this.legTimeScale = o.legTimeScale ?? 0.001;
        this.minLegMs = o.minLegMs ?? 1;
        // false = pre-0.1.1 firmware: an aborted move drops the steps it took,
        // so x/y/z stay at the START of that move and POS_EXACT is not set.
        this.posExact = o.posExact !== false;
        // '0.1.1' = what is flashed on the machine today, '0.2.0' = the build
        // in shortcut/firmware/source_0.2.0. The host must work on both.
        //   0.2.0: OP_JOB_ABORT allowed in ALARM/E-stop and accepts the 0xFFFF
        //          wildcard; OP_RESUME only lifts a HOLD (never starts motion
        //          from IDLE); driver faults clear the planner and cut power.
        this.fwVersion = o.fwVersion || '0.2.0';
        // 0.1.x reads numbers with the C library's strtof (hex floats and all);
        // 0.2.0 uses its own decimal-only scanner (FW-1).
        this.scan = this.fwVersion === '0.1.1' ? strtof : gcodeStrtof;
        this.latencyMs = o.latencyMs ?? 1;
        this.statusPeriodMs = o.statusPeriodMs ?? 100;
        // impairment hooks: return true to drop
        this.dropIn = null;   // (frame) => bool, host -> firmware
        this.dropOut = null;  // (frameType, payload) => bool, firmware -> host
        this.frozen = false;  // legs stop advancing (stuck step engine)
        this.txMuted = false; // firmware stops sending (host sees silence)

        this.parser = new FrameParser();
        this.expectedSeq = 0;
        this.seqSynced = false;
        this.lastReply = null; // {seq, frame}
        this.evtSeq = 0;

        this.state = defs.ST_IDLE;
        this.powered = false;
        this.cur = { x: 0, y: 0, z: 0 };
        this.planned = { x: 0, y: 0, z: 0 };
        this.lastFeed = 500;
        this.modal = { scale: 1, absolute: true };
        this.ring = [];
        this.jobId = 0;
        this.jobActive = false;
        this.lastExecutedLine = 0;
        this.leg = null; // {line, from, to, feed, startMs, durMs, steps}
        this.lastHostRxMs = Date.now();
        this.faultLatched = 0;
        this.isrCount = 0;
        this.lastLegSteps = { done: 0, total: 0 };

        // Checked per leg instead of stored, for million-line files.
        this.onExecuted = o.onExecuted || null;
        this.recordExecuted = o.recordExecuted !== false;
        this.executedCount = 0;
        this.executed = [];   // [{line, jobId, to:{x,y,z}, feed}] legs that completed
        this.received = [];   // [{jobId, line, text}] job lines accepted (ring push or no-motion)
        this.opLog = [];      // [{op, seq}] every command handled
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
        if (f.seq === 0) { this.expectedSeq = 0; this.seqSynced = true; }
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
                // the host tells 0.1.1 from 0.2.0.
                const json = `{"fw":"${this.fwVersion === '0.1.1' ? '0.1.1-almfilter' : '0.2.0'}","axes":3,`
                    + '"steps_per_mm":[200.0,200.0,200.0],"home_dir_neg":[1,1,1],'
                    + '"home_travel_ceiling_mm":900.0,"home_pulloff_mm":3.0,"calibrated":true}';
                this._ok(seq, op, Buffer.from(json, 'utf8'));
                return 1;
            }
            case defs.OP_PING: this._ok(seq, op); return 1;
            case defs.OP_UNLOCK:
                this._syncAbort();
                this.faultLatched = 0;
                if (this.state === defs.ST_ALARM || this.state === defs.ST_ESTOP) this.state = defs.ST_IDLE;
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
            case defs.OP_JOG: {
                // rsp_handle_jog(): accepted from IDLE or JOGGING, ACKed
                // immediately, and the machine stays SYS_JOGGING until the leg
                // drains (protocol_jog_poll). While it does, OP_ZERO and
                // OP_JOB_START are refused -- SYS_IDLE only.
                if (this.state !== defs.ST_IDLE && this.state !== defs.ST_JOGGING) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
                const dist = pl.readFloatLE(2);
                const feed = pl.readFloatLE(6);
                const axis = pl[0];
                const dir = pl[1] ? 1 : -1;
                const to = { ...this.cur };
                to[['x', 'y', 'z'][axis] || 'x'] += dir * dist;
                this.state = defs.ST_JOGGING;
                this.powered = true;
                const realMs = feed > 0 ? (dist / feed) * 60000 : 0;
                this.leg = {
                    line: 0, text: 'jog', from: { ...this.cur }, to, feed,
                    startMs: Date.now(), durMs: Math.max(this.minLegMs, realMs * this.legTimeScale),
                    steps: this._legSteps(this.cur, to), jog: true,
                };
                this._ok(seq, op);
                return 1;
            }
            case defs.OP_HOME: case defs.OP_MOVE: case defs.OP_PROBE:
                if (this.state !== defs.ST_IDLE) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
                this._ok(seq, op);
                return 1;
            case defs.OP_JOB_START: {
                if (pl.length < 4) { this._err(seq, op, defs.ST_ERR_CMD); return 1; }
                if (this.state !== defs.ST_IDLE) { this._err(seq, op, defs.ST_ERR_STATE); return 1; }
                this.ring = [];
                this._syncAbort();
                this.planned = { ...this.cur };
                this.leg = null;
                this.jobId = pl.readUInt16LE(0);
                this.jobActive = true;
                this.lastExecutedLine = 0;
                this.state = defs.ST_RUNNING;
                this.jobStarts = (this.jobStarts || 0) + 1;
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
                const wildcard = id === 0xFFFF && this.fwVersion !== '0.1.1'; // FW-19
                if (id !== this.jobId && !wildcard) { this._err(seq, op, defs.ST_ERR_JOB); return 1; }
                this._abortLeg();
                this.ring = [];
                this.planned = { ...this.cur };
                this.jobActive = false;
                if (this.state === defs.ST_RUNNING || this.state === defs.ST_HOLD) {
                    this.state = defs.ST_IDLE;
                    this.powered = false;
                }
                this.jobAborts = (this.jobAborts || 0) + 1;
                this._ok(seq, op);
                return 1;
            }
            default: this._err(seq, op, defs.ST_ERR_CMD); return 1;
        }
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

    _legProgress(now) {
        const l = this.leg;
        if (!l) return 1;
        if (this.frozen) return l.frozenAt ?? (l.frozenAt = Math.min(1, (now - l.startMs) / l.durMs));
        return Math.min(1, (now - l.startMs) / l.durMs);
    }

    _abortLeg() {
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
    }

    /** Test hook: driver ALM confirmed on `axis` while moving (protocol_run_tick fault path). */
    injectAlarm(axis = 0) {
        this._abortLeg();
        this.powered = false;
        this.faultLatched |= 1 << axis;
        this._evt(Buffer.from([defs.EV_FAULT, axis, defs.FAULT_CODE_ALM_MOTION]));
        this.ring = [];
        this.planned = { ...this.cur };
        this.jobActive = false;
        this.state = defs.ST_ALARM;
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
        return true;
    }

    _loop() {
        const now = Date.now();
        // TIM2 only runs while a move is stepping, so the ISR counter is
        // constant when the engine is idle (the host keys "same stale abort"
        // detection on it).
        if (this.leg && !this.frozen) this.isrCount += 1;

        // protocol_jog_poll(): a jog leg finishes on its own and the machine
        // drops back to IDLE. Until it does, a job cannot start.
        if (this.state === defs.ST_JOGGING) {
            if (this.leg && this._legProgress(now) >= 1 && !this.frozen) {
                this.cur = { ...this.leg.to };
                this.planned = { ...this.cur };
                this.leg = null;
                this.state = defs.ST_IDLE;
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
            this.powered = false;
            return;
        }
        this.lastFeed = qm.mv.feed;
        this.powered = true;
        const to = { x: qm.mv.x, y: qm.mv.y, z: qm.mv.z };
        const dist = Math.hypot(to.x - this.cur.x, to.y - this.cur.y, to.z - this.cur.z);
        const realMs = qm.mv.feed > 0 ? (dist / qm.mv.feed) * 60000 : 0;
        const durMs = Math.max(this.minLegMs, realMs * this.legTimeScale);
        this.leg = { line: qm.line, text: qm.text, from: { ...this.cur }, to, feed: qm.mv.feed, startMs: now, durMs, steps: this._legSteps(this.cur, to) };
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
            tim2IsrCount: this.frozen ? 12345 : this.isrCount,
            stepsDone: steps.done,
            stepsTotal: steps.total,
        });
    }

    _statusTick() {
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
