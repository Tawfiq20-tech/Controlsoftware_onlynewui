/**
 * Machine telemetry for remote viewers and for the gate's safety checks
 * (spec §5.5).
 *
 * Reads controller events directly instead of engine.getState(), whose
 * activeState/position/overrides are wrong for RSP. The alarm latch lives
 * here: once any alarm signal is seen it stays set until an Idle status
 * without estop arrives, so a flapping state byte cannot re-enable motion.
 */
'use strict';

const { EventEmitter } = require('events');
const defaultClock = require('./clock');

const CONTROLLER_EVENTS = Object.freeze([
    'status', 'workflow:state',
    'sender:status', 'sender:start', 'sender:end', 'sender:pause', 'sender:resume', 'sender:error',
    'alarm', 'close',
    'toolchange:start', 'toolchange:complete', 'toolchange:cancel',
    'hostmotion',
]);

// Controller entry points observed so the gate learns what actually reaches
// the controller, whatever the caller (socket, HTTP, ProbingService,
// JobResumeService, Telegram, gamepad ...), not only what its taps saw.
const OBSERVED_METHODS = Object.freeze(['command', 'write', 'writeln']);

const ALARM_RAW = Object.freeze(['Alarm', 'EStop', 'Fault']);
const ALARM_TYPES = Object.freeze(['alarm', 'estop', 'fault', 'comm_lost']);
const RSP_ALARM_STATES = Object.freeze([8, 9, 10]);
const FAST_STATES = Object.freeze(['running', 'jogging', 'homing', 'stopping']);
const GRBL_FAMILY = Object.freeze(['Grbl', 'GrblHAL', 'FluidNC']);
const STATE_REPORT_MAX_BYTES = 4096;

function round3(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

function int(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : fallback;
}

function clip(s, max) {
    return typeof s === 'string' ? s.slice(0, max) : null;
}

function normalizeStatus(p) {
    return (p && p.status && p.status.activeState !== undefined) ? p.status : p;
}

function mapRawState(rawState, connected, jobActive) {
    if (!connected) return 'disconnected';
    const raw = typeof rawState === 'string' ? rawState : '';
    if (raw === 'Idle') return 'idle';
    if (raw === 'Jog') return 'jogging';
    if (raw === 'Home' || raw === 'Homing') return 'homing';
    if (raw === 'Run' || raw === 'Stream') return 'running';
    if (raw === 'Hold' || raw.startsWith('Hold:') || raw === 'Door' || raw.startsWith('Door')) return 'paused';
    if (raw === 'Stop') return 'stopping';
    if (ALARM_RAW.includes(raw)) return 'alarm';
    if (raw === 'Boot') return 'boot';
    return jobActive ? 'running' : 'idle';
}

class TelemetryBuilder extends EventEmitter {
    constructor({
        clock = defaultClock, isLanOnly = () => false, getRttMs = () => null,
        getExtras = () => ({}), setIntervalFn = setInterval, clearIntervalFn = clearInterval,
        pollMs = 1000,
    } = {}) {
        super();
        this.clock = clock;
        this.isLanOnly = isLanOnly;
        this.getRttMs = getRttMs;
        this.getExtras = getExtras;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.pollMs = pollMs;

        this.engine = null;
        this.ctrl = null;
        this._handlers = null;
        this._pollTimer = null;
        this._onBound = (ctrl) => this._handleBound(ctrl);

        this.lastStatus = null;
        this.lastStatusAt = null;
        this._positions = [];
        this._senderStatus = null;
        this._workflow = null;
        this.jobStartedAt = null;
        this.toolchangePending = false;
        this.alarm = null;
        this._alarmLatchedAt = null;
        this._connected = false;
        this._controllerType = null;
    }

    attachEngine(engine) {
        if (this.engine === engine) return;
        this.detach();
        this.engine = engine;
        if (!engine) return;
        if (typeof engine.on === 'function') engine.on('controller:bound', this._onBound);
        if (engine.controller) this.bindController(engine.controller);
        this._readEngineState();
        this._pollTimer = this.setIntervalFn(() => this._poll(), this.pollMs);
        if (this._pollTimer && typeof this._pollTimer.unref === 'function') this._pollTimer.unref();
    }

    detach() {
        if (this.engine && typeof this.engine.removeListener === 'function') {
            this.engine.removeListener('controller:bound', this._onBound);
        }
        this._unbindController();
        if (this._pollTimer) this.clearIntervalFn(this._pollTimer);
        this._pollTimer = null;
        this.engine = null;
    }

    bindController(ctrl) {
        this._unbindController();
        this.ctrl = ctrl || null;
        this.lastStatus = null;
        this.lastStatusAt = null;
        this._positions = [];
        this._senderStatus = null;
        this._workflow = null;
        this.toolchangePending = false;
        if (!ctrl || typeof ctrl.on !== 'function') return;
        const h = {};
        for (const ev of CONTROLLER_EVENTS) {
            h[ev] = (...args) => this._onControllerEvent(ev, args);
            ctrl.on(ev, h[ev]);
        }
        this._handlers = h;
        this._wrapController(ctrl);
    }

    /**
     * Wraps command/write/writeln on the bound controller instance and emits
     * 'controller-call' (method, args) BEFORE the controller acts, so the
     * gate's seqs and locks move no later than the machine does. Calls made
     * from inside an observed call (a controller re-entering itself, or the
     * gate reacting to the observation) are not reported again.
     */
    _wrapController(ctrl) {
        const self = this;
        const wraps = [];
        let depth = 0;
        for (const method of OBSERVED_METHODS) {
            if (typeof ctrl[method] !== 'function') continue;
            const hadOwn = Object.prototype.hasOwnProperty.call(ctrl, method);
            const original = ctrl[method];
            const wrapper = function observedControllerCall(...args) {
                depth += 1;
                try {
                    if (depth === 1) {
                        try { self.emit('controller-call', method, args); } catch (_) { /* observer must not block the machine */ }
                    }
                    return original.apply(this, args);
                } finally {
                    depth -= 1;
                }
            };
            try {
                ctrl[method] = wrapper;
                wraps.push({ method, hadOwn, original, wrapper });
            } catch (_) { /* frozen controller: fall back to taps only */ }
        }
        this._wraps = wraps;
    }

    _unwrapController() {
        const ctrl = this.ctrl;
        const wraps = this._wraps || [];
        this._wraps = null;
        if (!ctrl) return;
        for (const w of wraps) {
            if (ctrl[w.method] !== w.wrapper) continue;
            try {
                if (w.hadOwn) ctrl[w.method] = w.original;
                else delete ctrl[w.method];
            } catch (_) { /* leave the pass-through wrapper */ }
        }
    }

    _unbindController() {
        if (this.ctrl && this._handlers && typeof this.ctrl.removeListener === 'function') {
            for (const ev of Object.keys(this._handlers)) this.ctrl.removeListener(ev, this._handlers[ev]);
        }
        this._unwrapController();
        this._handlers = null;
        this.ctrl = null;
    }

    _handleBound(ctrl) {
        const isNew = ctrl !== this.ctrl;
        this.bindController(ctrl);
        this._readEngineState();
        this.emit('controller-bound', ctrl, isNew);
    }

    _onControllerEvent(ev, args) {
        switch (ev) {
            case 'status': {
                const st = normalizeStatus(args[0]);
                if (!st || typeof st !== 'object') return;
                this.lastStatus = st;
                this.lastStatusAt = this.clock.mono();
                if (st.mpos) {
                    this._positions.push({ x: round3(st.mpos.x), y: round3(st.mpos.y), z: round3(st.mpos.z) });
                    if (this._positions.length > 2) this._positions.shift();
                }
                this._updateAlarmFromStatus(st);
                this.emit('status', st, this.lastStatusAt);
                return;
            }
            case 'workflow:state':
                this._workflow = args[0];
                this.emit('workflow', args[0]);
                return;
            case 'sender:status':
                if (args[0] && typeof args[0] === 'object') {
                    this._senderStatus = { ...(this._senderStatus || {}), ...args[0] };
                }
                return;
            case 'sender:start':
                this.jobStartedAt = this.clock.wall();
                this.emit('sender', 'start', args[0]);
                return;
            case 'sender:end':
            case 'sender:error':
                this.emit('sender', ev.slice(7), args[0]);
                return;
            case 'sender:pause':
            case 'sender:resume':
                this.emit('sender', ev.slice(7), args[0]);
                return;
            case 'alarm': {
                const a = args[0] || {};
                this._latchAlarm({
                    type: ALARM_TYPES.includes(a.type) ? a.type : 'alarm',
                    code: Number.isFinite(Number(a.code)) && a.code !== null && a.code !== undefined ? int(a.code) : null,
                    message: clip(a.message, 200),
                });
                return;
            }
            case 'close':
                this.emit('close');
                return;
            case 'hostmotion': {
                const m = args[0] || {};
                if (m.phase === 'start' || m.phase === 'end') this.emit('host-motion', m.phase, clip(m.op, 16));
                return;
            }
            case 'toolchange:start':
                this.toolchangePending = true;
                this.emit('toolchange', 'start');
                return;
            case 'toolchange:complete':
            case 'toolchange:cancel':
                this.toolchangePending = false;
                this.emit('toolchange', ev.slice(11));
                return;
            default:
        }
    }

    _updateAlarmFromStatus(st) {
        const raw = st.activeState;
        const numericAlarm = typeof st.state === 'number' && RSP_ALARM_STATES.includes(st.state);
        if (ALARM_RAW.includes(raw) || st.estop || numericAlarm) {
            let type = 'alarm';
            if (st.estop || raw === 'EStop' || st.state === 9) type = 'estop';
            else if (raw === 'Fault' || st.state === 10) type = 'fault';
            this._latchAlarm({ type, code: null, message: `${raw || 'Alarm'} state` });
            return;
        }
        if (this.alarm && raw === 'Idle' && !st.estop && this.lastStatusAt > this._alarmLatchedAt) {
            this.alarm = null;
            this._alarmLatchedAt = null;
            this.emit('alarm-cleared');
        }
    }

    _latchAlarm(alarm) {
        if (this.alarm) return;
        this.alarm = { ...alarm, since: this.clock.wall() };
        this._alarmLatchedAt = this.clock.mono();
        this.emit('alarm-latched', this.alarm);
    }

    _readEngineState() {
        const engine = this.engine;
        let connected = false;
        let controllerType = null;
        if (engine && typeof engine.getState === 'function') {
            try {
                const s = engine.getState() || {};
                connected = !!s.connected;
                controllerType = s.controllerType || null;
            } catch (_) { /* engine mid-teardown */ }
        }
        const was = this._connected;
        this._connected = connected;
        this._controllerType = controllerType;
        return { was, connected };
    }

    _poll() {
        const { was, connected } = this._readEngineState();
        if (was && !connected) this.emit('disconnected');
        else if (!was && connected) this.emit('connected');
        this.emit('poll');
    }

    get connected() {
        return this._connected;
    }

    get controllerType() {
        return this._controllerType;
    }

    /** Refresh connected/controllerType now (used by the gate before checks). */
    refresh() {
        const { was, connected } = this._readEngineState();
        if (was && !connected) this.emit('disconnected');
        else if (!was && connected) this.emit('connected');
    }

    telemetryAgeMs() {
        if (this.lastStatusAt === null || !this.lastStatus || !this.lastStatus.mpos) return Infinity;
        return Math.max(0, this.clock.mono() - this.lastStatusAt);
    }

    rawState() {
        return this.lastStatus && typeof this.lastStatus.activeState === 'string' ? this.lastStatus.activeState : null;
    }

    position() {
        const st = this.lastStatus;
        if (!st || !st.mpos) return null;
        return { x: round3(st.mpos.x), y: round3(st.mpos.y), z: round3(st.mpos.z) };
    }

    /** The last two received positions (stop verification). */
    lastTwoPositions() {
        return this._positions.slice();
    }

    jobInfo() {
        const engine = this.engine || {};
        const ctrl = engine.controller || null;
        let wf = this._workflow;
        if (ctrl && typeof ctrl.getWorkflowState === 'function') {
            try { wf = ctrl.getWorkflowState(); } catch (_) { /* keep last event */ }
        }
        const isRsp = this._controllerType === 'RSP' || (ctrl && ctrl.type === 'RSP');
        let sender = this._senderStatus;
        if (isRsp && ctrl && typeof ctrl.getSenderStatus === 'function') {
            try { sender = ctrl.getSenderStatus() || sender; } catch (_) { /* keep last event */ }
        }
        const active = !!(ctrl && ctrl.job && ctrl.job.active) || ['running', 'paused', 'stalled'].includes(wf);
        const paused = engine._jobPaused === true || wf === 'paused';
        const stalled = wf === 'stalled' || !!(sender && sender.stalled);
        const s = sender || {};
        const executed = isRsp ? s.executed : (s.received !== undefined ? s.received : s.sent);
        return {
            active,
            paused,
            stalled,
            executed: int(executed),
            total: int(s.total),
            progressPct: int(s.progress),
            failReason: clip(s.failReason, 200) || null,
            workflow: wf || null,
        };
    }

    feedOverridePct() {
        const st = this.lastStatus || {};
        const ctrl = this.engine && this.engine.controller;
        if (this._controllerType === 'RSP') {
            if (Number.isFinite(Number(st.feedOverridePct))) return int(st.feedOverridePct, 100);
            if (ctrl && typeof ctrl.getSenderStatus === 'function') {
                try {
                    const ss = ctrl.getSenderStatus();
                    if (ss && Number.isFinite(Number(ss.feedOverridePct))) return int(ss.feedOverridePct, 100);
                } catch (_) { /* fall through */ }
            }
            return 100;
        }
        if (GRBL_FAMILY.includes(this._controllerType) && st.ov && Number.isFinite(Number(st.ov.feed))) {
            return int(st.ov.feed, 100);
        }
        return 100;
    }

    boardLinkOk() {
        if (this._controllerType === 'RSP' && this.engine && typeof this.engine.getLinkHealth === 'function') {
            try { return !!this.engine.getLinkHealth().linkOk; } catch (_) { return false; }
        }
        return this._connected;
    }

    machineState() {
        return mapRawState(this.rawState(), this._connected, this.jobInfo().active);
    }

    /** report.state body (§3.4.3) without seq. */
    snapshot() {
        this._readEngineState();
        const st = this.lastStatus || {};
        const engine = this.engine || {};
        const job = this.jobInfo();
        const extras = this.getExtras() || {};
        const pos = st.mpos ? { x: round3(st.mpos.x), y: round3(st.mpos.y), z: round3(st.mpos.z) } : { x: 0, y: 0, z: 0 };
        const w = st.wpos || st.mpos;
        const wpos = w ? { x: round3(w.x), y: round3(w.y), z: round3(w.z) } : { x: 0, y: 0, z: 0 };
        const age = this.telemetryAgeMs();
        const loadedFile = engine.loadedFile || null;
        const loadSeq = int(extras.loadSeq);
        const body = {
            seq: 0,
            at: this.clock.wall(),
            controllerType: this._controllerType,
            connected: this._connected,
            machine: {
                state: mapRawState(st.activeState, this._connected, job.active),
                rawState: clip(st.activeState, 32),
                pos,
                wpos,
                feedrate: int(st.feedrate),
                spindleRpm: int(st.spindle),
                feedOverridePct: this.feedOverridePct(),
                boardLinkOk: this.boardLinkOk(),
                telemetryAgeMs: Number.isFinite(age) ? int(age) : null,
            },
            alarm: this.alarm ? { ...this.alarm } : null,
            job: (job.active || job.paused) ? {
                active: job.active,
                paused: job.paused,
                stalled: job.stalled,
                name: loadedFile ? clip(loadedFile.name, 120) : null,
                progressPct: job.progressPct,
                executed: job.executed,
                total: job.total,
                startedAt: this.jobStartedAt,
                failReason: job.failReason,
            } : null,
            file: loadedFile ? {
                name: clip(loadedFile.name, 120),
                total: int(loadedFile.total),
                size: int(loadedFile.size),
                loadSeq,
            } : null,
            // Also top-level: job.start with a libraryId must echo loadSeq
            // even when nothing is loaded yet.
            loadSeq,
            wcsSeq: int(extras.wcsSeq),
            pause: extras.pause || null,
            link: { cloudRttMs: this.getRttMs(), lanOnly: !!this.isLanOnly() },
        };
        return body;
    }
}

function stateChangeKey(body) {
    if (!body) return '';
    return JSON.stringify([
        body.machine && body.machine.state,
        body.alarm && body.alarm.type,
        !!(body.job && body.job.active),
        !!(body.job && body.job.paused),
        body.file && body.file.name,
        body.connected,
    ]);
}

/**
 * Latest-only report sender (spec §5.5 "Report throttle"). Never queues:
 * when the socket is backed up a report is skipped, and a skipped tier or
 * state change is retried every 100 ms with the newest snapshot.
 */
class ReportThrottle {
    constructor({
        clock = defaultClock, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
        getState, getTier, isFast = () => false, canSend = () => true, send,
    }) {
        this.clock = clock;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.getState = getState;
        this.getTier = getTier;
        this.isFast = isFast;
        this.canSend = canSend;
        this.send = send;
        this.seq = 0;
        this.tierDirty = false;
        this.stateDirty = false;
        this._lastKey = null;
        this._lastStateAt = -Infinity;
        this._lastTierAt = -Infinity;
        this._timer = null;
        this._coalesceTimer = null;
        this._running = false;
    }

    start() {
        this._running = true;
        this.tierDirty = true;
        this.stateDirty = true;
        this._lastStateAt = -Infinity;
        this.attempt();
        this._schedule();
    }

    stop() {
        this._running = false;
        if (this._timer) this.clearTimeoutFn(this._timer);
        this._timer = null;
        if (this._coalesceTimer) this.clearTimeoutFn(this._coalesceTimer);
        this._coalesceTimer = null;
    }

    markTierDirty() {
        this.tierDirty = true;
        if (this._running) this.attempt();
    }

    poke() {
        if (this._running) this.attempt();
    }

    _schedule() {
        if (!this._running) return;
        this._timer = this.setTimeoutFn(() => {
            this._timer = null;
            this.attempt();
            this._schedule();
        }, 100);
        if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    }

    _trySend(t, body) {
        if (!this.canSend()) return false;
        try {
            return this.send(t, body) !== false;
        } catch (_) {
            return false;
        }
    }

    attempt() {
        if (!this._running) return;
        const now = this.clock.mono();
        if (this.tierDirty || now - this._lastTierAt >= 30000) {
            if (this._trySend('report.tier', this.getTier())) {
                this.tierDirty = false;
                this._lastTierAt = now;
            } else {
                this.tierDirty = true;
            }
        }
        const body = this.getState();
        const key = stateChangeKey(body);
        if (this._lastKey !== null && key !== this._lastKey) this.stateDirty = true;
        const period = (this.isFast(body) || FAST_STATES.includes(body && body.machine && body.machine.state)) ? 200 : 1000;
        const due = this.stateDirty ? now - this._lastStateAt >= 100 : now - this._lastStateAt >= period;
        if (!due) {
            // A coalesced change goes out exactly 100 ms after the previous
            // report, not on the next tick of the retry grid.
            if (this.stateDirty && !this._coalesceTimer) {
                this._coalesceTimer = this.setTimeoutFn(() => {
                    this._coalesceTimer = null;
                    this.attempt();
                }, Math.max(1, 100 - (now - this._lastStateAt)));
                if (this._coalesceTimer && typeof this._coalesceTimer.unref === 'function') this._coalesceTimer.unref();
            }
            return;
        }
        body.seq = this.seq + 1;
        if (Buffer.byteLength(JSON.stringify(body)) > STATE_REPORT_MAX_BYTES) {
            if (body.job) body.job.failReason = null;
            if (body.alarm) body.alarm.message = null;
        }
        if (this._trySend('report.state', body)) {
            this.seq += 1;
            this.stateDirty = false;
            this._lastKey = key;
            this._lastStateAt = now;
        } else if (this._lastKey === null || key !== this._lastKey) {
            this.stateDirty = true;
        }
    }
}

module.exports = {
    TelemetryBuilder,
    ReportThrottle,
    normalizeStatus,
    mapRawState,
    stateChangeKey,
    CONTROLLER_EVENTS,
    STATE_REPORT_MAX_BYTES,
};
