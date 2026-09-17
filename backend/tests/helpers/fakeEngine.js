'use strict';

/**
 * Test doubles for the cloud-link tests: a CNCEngine stand-in with a
 * scriptable controller, and a fake monotonic/wall clock with timers.
 */

const { EventEmitter } = require('events');

class FakeController extends EventEmitter {
    constructor(type = 'RSP') {
        super();
        this.type = type;
        this.job = { active: false };
        this.workflow = 'idle';
        this.sender = { executed: 0, total: 0, received: 0, sent: 0, progress: 0, failReason: null, stalled: false };
        this.linkOk = true;
        this.feedOverridePct = 100;
        this.state = {
            status: { activeState: 'Idle', mpos: { x: 0, y: 0, z: 0 }, wpos: { x: 0, y: 0, z: 0 }, feedrate: 0, spindle: 0 },
            parserstate: {},
        };
        this.commands = [];
        this.cancelPendingJogsCalls = 0;
    }

    getSenderStatus() {
        return { ...this.sender, active: !!this.job.active, feedOverridePct: this.feedOverridePct };
    }

    getWorkflowState() {
        return this.workflow;
    }

    getLinkHealth() {
        return { linkOk: this.linkOk };
    }

    cancelPendingJogs() {
        this.cancelPendingJogsCalls += 1;
        return 0;
    }

    command(cmd, ...args) {
        this.commands.push({ cmd, args });
    }
}

class FakeEngine extends EventEmitter {
    constructor({ controllerType = 'RSP', connected = true } = {}) {
        super();
        this.controllerType = controllerType;
        this.connected = connected;
        this.controller = controllerType ? new FakeController(controllerType) : null;
        this.loadedFile = null;
        this._jobPaused = false;
        this.calls = [];
        this.fileLoads = [];
        // string | (cmd, args) => string|null
        this.serialErrorFor = null;
        this.controllerErrorFor = null;
    }

    _script(value, cmd, args) {
        return typeof value === 'function' ? value(cmd, args) : value;
    }

    _handleCommand(socket, portPath, cmd, ...args) {
        this.calls.push({ cmd, args, socketId: socket && socket.id });
        if (!this.controller) {
            socket.emit('serialport:error', { error: 'No active controller' });
            return;
        }
        const serialErr = this._script(this.serialErrorFor, cmd, args);
        if (serialErr) socket.emit('serialport:error', { error: serialErr });
        const ctrlErr = this._script(this.controllerErrorFor, cmd, args);
        if (ctrlErr) this.controller.emit('error', { message: ctrlErr });
        this.controller.command(cmd, ...args);
    }

    _handleFileLoad(socket, data) {
        this.fileLoads.push({ name: data.name, content: data.content, socketId: socket && socket.id });
        this.loadedFile = { name: data.name, total: String(data.content).split(/\r?\n/).length, size: data.content.length };
    }

    getState() {
        return { connected: this.connected, controllerType: this.connected ? this.controllerType : this.controllerType };
    }

    getLinkHealth() {
        return this.controller ? this.controller.getLinkHealth() : { linkOk: false };
    }

    commandNames() {
        return this.calls.map(c => c.cmd);
    }

    setStatus(partial = {}) {
        const st = { ...this.controller.state.status, ...partial };
        this.controller.state.status = st;
        this.controller.emit('status', st);
        return st;
    }

    emitAlarm(alarm = { type: 'alarm', code: 1, message: 'Hard limit' }) {
        this.controller.emit('alarm', alarm);
    }

    bindNewController(type = this.controllerType) {
        this.controllerType = type;
        this.controller = new FakeController(type);
        this.emit('controller:bound', this.controller);
        return this.controller;
    }

    startJob() {
        this.controller.job.active = true;
        this.controller.workflow = 'running';
        this.controller.emit('sender:start', {});
        this.controller.emit('workflow:state', 'running');
        this.setStatus({ activeState: 'Run' });
    }

    pauseJob() {
        this._jobPaused = true;
        this.controller.emit('sender:pause');
        this.controller.workflow = 'paused';
        this.controller.emit('workflow:state', 'paused');
        this.setStatus({ activeState: 'Hold' });
    }

    endJob() {
        this.controller.job.active = false;
        this._jobPaused = false;
        this.controller.workflow = 'idle';
        this.controller.emit('sender:end', {});
        this.controller.emit('workflow:state', 'idle');
        this.setStatus({ activeState: 'Idle' });
    }
}

/**
 * Deterministic clock + timers. advance(ms) runs due timers in time order,
 * moving mono and wall together; stepWall() moves only the wall clock.
 */
function createFakeClock({ mono = 10000, wall = 1789500000000 } = {}) {
    let m = mono;
    let w = wall;
    let nextId = 1;
    const timers = new Map();

    function add(fn, ms, interval) {
        const id = nextId++;
        const t = { id, fn, due: m + Math.max(0, Number(ms) || 0), interval: interval ? Math.max(1, Number(ms) || 1) : 0, unref() { return t; }, ref() { return t; } };
        timers.set(id, t);
        return t;
    }
    function clear(t) {
        if (t && typeof t === 'object') timers.delete(t.id);
        else timers.delete(t);
    }
    function advance(ms) {
        const target = m + ms;
        for (;;) {
            let next = null;
            for (const t of timers.values()) {
                if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
            }
            if (!next) break;
            w += next.due - m;
            m = next.due;
            if (next.interval) next.due += next.interval;
            else timers.delete(next.id);
            next.fn();
        }
        w += target - m;
        m = target;
    }
    return {
        mono: () => m,
        wall: () => w,
        setTimeout: (fn, ms) => add(fn, ms, false),
        clearTimeout: clear,
        setInterval: (fn, ms) => add(fn, ms, true),
        clearInterval: clear,
        advance,
        stepWall(delta) { w += delta; },
        pendingTimers: () => timers.size,
    };
}

function silentLogger() {
    const lines = [];
    const rec = (level) => (...args) => {
        lines.push({ level, text: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
    };
    return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

module.exports = { FakeEngine, FakeController, createFakeClock, silentLogger };
