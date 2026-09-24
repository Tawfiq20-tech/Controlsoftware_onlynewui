/**
 * MachineAdapter (spec §9.3, §5.9) -- the ONLY module in cloudLink/ that
 * touches engine._handleCommand / engine._handleFileLoad.
 *
 * plan() is a pure mapping from (controllerType, gate type, validated args)
 * to engine steps; run() executes them. Every `cmd` step is re-checked
 * against a frozen allowlist at run time, so a bug in plan() or in the gate
 * still cannot reach raw G-code, config, firmware or alarm-clear commands.
 */
'use strict';

const ALLOWED_CMDS = Object.freeze([
    'jog', 'jogcancel', 'gcode:pause', 'gcode:resume', 'gcode:stop', 'gcode:startFromLine', 'gcode:start', 'gcode:startFresh',
    'feedhold', 'wcs:zero',
    'homing', 'homing:X', 'homing:Y', 'homing:Z',
    'feedOverride:reset', 'feedOverride:coarsePlus', 'feedOverride:coarseMinus', 'feedOverride:finePlus', 'feedOverride:fineMinus',
    'gcode',
]);

const GCODE_RE = [/^M3 S\d{1,5}$/, /^M5$/];

const FEED_OVERRIDE_ACTIONS = Object.freeze(['reset', 'coarsePlus', 'coarseMinus', 'finePlus', 'fineMinus']);

const NONE = Object.freeze({
    jogStep: false, jogContinuous: false, jogCancel: false, zero: false, home: false,
    spindle: false, feedOverride: 'none', start: false, load: false, files: true, snapshot: true,
});

// §9.2.2, with Decision D2: RTS remote jog (step and continuous) is disabled in v1.
const CAPABILITIES = Object.freeze({
    RSP: Object.freeze({
        jogStep: true, jogContinuous: true, jogCancel: false, zero: true, home: false,
        spindle: false, feedOverride: 'unverified', start: true, load: true, files: true, snapshot: true,
    }),
    Grbl: Object.freeze({
        jogStep: true, jogContinuous: true, jogCancel: true, zero: true, home: false,
        spindle: true, feedOverride: 'real', start: true, load: true, files: true, snapshot: true,
    }),
    GrblHAL: Object.freeze({
        jogStep: true, jogContinuous: true, jogCancel: true, zero: true, home: false,
        spindle: true, feedOverride: 'real', start: true, load: true, files: true, snapshot: true,
    }),
    RTS: Object.freeze({
        jogStep: false, jogContinuous: false, jogCancel: true, zero: true, home: false,
        spindle: false, feedOverride: 'none', start: true, load: true, files: true, snapshot: true,
    }),
    Generic: NONE,
});

const BASE_LIMITS = Object.freeze({
    jogStepMaxMm: 10, jogStepMaxFeed: 3000, jogContMaxFeed: 0,
    maxRttMs: 300, deadmanMs: 400, keepaliveMs: 100,
});

function controllerKey(controllerType) {
    if (controllerType === 'FluidNC') return 'Grbl';
    return Object.hasOwn(CAPABILITIES, controllerType) ? controllerType : null;
}

function getCapabilities(controllerType) {
    const key = controllerKey(controllerType);
    return { ...(key ? CAPABILITIES[key] : NONE) };
}

function getLimits(controllerType) {
    const key = controllerKey(controllerType);
    const limits = { ...BASE_LIMITS };
    if (key === 'RTS') limits.jogStepMaxMm = 1;
    if (key === 'RSP') limits.jogContMaxFeed = 600;
    if (key === 'Grbl' || key === 'GrblHAL') limits.jogContMaxFeed = 1500;
    return limits;
}

/** Largest single continuous-jog step (§9.4). */
function maxStepMm(controllerType) {
    return controllerKey(controllerType) === 'RSP' ? 1.0 : 2.0;
}

function cmd(name, ...args) {
    return { fn: 'cmd', cmd: name, args };
}

function notSupported() {
    return new Error('NOT_SUPPORTED');
}

/**
 * §9.2.4 job.stop. `snap` = {hasController, jobActive, jobPaused, state, spindleRpm, remoteSpindleOn}.
 * Returns {steps, message, acted} where acted means step 3 or 4 did something
 * (drives stop verification).
 */
function planStop(controllerType, snap) {
    const key = controllerKey(controllerType);
    const caps = getCapabilities(controllerType);
    const steps = [];
    // Step 1 is also the gate's job (cancelAllJogs), but the RSP host purge
    // belongs here so a stop always clears unsent jog retransmits.
    if (key === 'RSP') steps.push({ fn: 'rspCancelPendingJogs' });
    if (!snap.hasController) return { steps: [], message: 'no-controller', acted: false };

    let message = null;
    let acted = false;
    if (snap.jobActive || snap.jobPaused) {
        if (key === 'RSP') {
            if (snap.jobActive && !snap.jobPaused) steps.push(cmd('feedhold'));
            steps.push(cmd('gcode:stop'));
        } else if (key === 'Grbl' || key === 'GrblHAL' || key === 'RTS') {
            steps.push(cmd('gcode:stop'));
        } else {
            steps.push(cmd('feedhold'));
        }
        message = 'job-stopped';
        acted = true;
    } else if (snap.state === 'jogging' || snap.state === 'running' || snap.state === 'homing') {
        if (key === 'RSP') {
            message = 'rsp-cannot-cancel: use the machine E-stop';
        } else if (key === 'Grbl' || key === 'GrblHAL' || key === 'RTS') {
            steps.push(snap.state === 'jogging' ? cmd('jogcancel') : cmd('feedhold'));
            message = 'motion-halted';
        } else {
            steps.push(cmd('feedhold'));
            message = 'motion-halted';
        }
        acted = true;
    }
    if (!snap.jobActive && !snap.jobPaused && caps.spindle && (Number(snap.spindleRpm) > 0 || snap.remoteSpindleOn)) {
        steps.push(cmd('gcode', 'M5'));
        message = message ? `${message}+spindle-off` : 'spindle-off';
    }
    if (!message) message = 'nothing-to-stop';
    return { steps, message, acted };
}

/**
 * plan(controllerType, type, args, snapshot) -> steps[]. Throws
 * Error('NOT_SUPPORTED') for a type/controller combination with no mapping.
 * `snapshot` carries what a mapping needs beyond args (job.stop state,
 * job.load/job.start file content).
 */
function plan(controllerType, type, args, snapshot = {}) {
    const key = controllerKey(controllerType);
    const caps = getCapabilities(controllerType);
    args = args || {};
    switch (type) {
        case 'job.stop':
            return planStop(controllerType, snapshot).steps;
        case 'job.pause':
            if (!caps.start) throw notSupported();
            return [cmd('gcode:pause')];
        case 'job.resume':
            if (!caps.start) throw notSupported();
            return [cmd('gcode:resume')];
        case 'feed.override':
            if (caps.feedOverride === 'none' || !FEED_OVERRIDE_ACTIONS.includes(args.action)) throw notSupported();
            return [cmd(`feedOverride:${args.action}`)];
        case 'job.load':
            if (!caps.load) throw notSupported();
            return [{ fn: 'fileLoad', name: snapshot.fileName, content: snapshot.content }];
        case 'job.start': {
            if (!caps.start) throw notSupported();
            const steps = [];
            if (snapshot.content !== undefined) {
                steps.push({ fn: 'fileLoad', name: snapshot.fileName, content: snapshot.content });
            }
            // RSP gcode:start may resume from the last stop line; a remote
            // start is always a fresh run from the beginning.
            //
            // This used to be cmd('gcode:startFromLine', 0). Line 0 is outside
            // the file, so buildResumeProgram() rejected it every time and the
            // remote operator was told the job had started while the machine
            // had not moved. 'gcode:startFresh' is the command that actually
            // means "line 1, or refuse" -- and it refuses out loud.
            steps.push(key === 'RSP' ? cmd('gcode:startFresh') : cmd('gcode:start'));
            return steps;
        }
        case 'jog.step':
        case 'jog.cont.step':
            if (!(type === 'jog.step' ? caps.jogStep : caps.jogContinuous)) throw notSupported();
            return [cmd('jog', { [args.axis]: args.distanceMm, feedRate: args.feed })];
        case 'jog.cancel':
            if (key === 'RSP') return [{ fn: 'rspCancelPendingJogs' }];
            if (caps.jogCancel) return [cmd('jogcancel')];
            return [];
        case 'zero':
            if (!caps.zero || !Array.isArray(args.axes) || args.axes.length === 0) throw notSupported();
            return [cmd('wcs:zero', { axes: args.axes.slice() })];
        case 'home':
            if (!caps.home) throw notSupported();
            return [args.axis === 'all' ? cmd('homing') : cmd(`homing:${String(args.axis).toUpperCase()}`)];
        case 'spindle.on':
            if (!caps.spindle) throw notSupported();
            return [cmd('gcode', `M3 S${args.rpm}`)];
        case 'spindle.off':
            if (!caps.spindle) throw notSupported();
            return [cmd('gcode', 'M5')];
        default:
            throw notSupported();
    }
}

function assertAllowed(step) {
    if (!step || typeof step !== 'object') throw new Error('bad step');
    if (step.fn === 'cmd') {
        if (!ALLOWED_CMDS.includes(step.cmd)) throw new Error(`command not allowed: ${String(step.cmd).slice(0, 40)}`);
        if (step.cmd === 'gcode') {
            const line = step.args && step.args[0];
            if (typeof line !== 'string' || !GCODE_RE.some(re => re.test(line))) throw new Error('gcode line not allowed');
        }
        return;
    }
    if (step.fn === 'fileLoad') {
        if (typeof step.name !== 'string' || typeof step.content !== 'string') throw new Error('bad file load');
        return;
    }
    if (step.fn === 'rspCancelPendingJogs') return;
    throw new Error('unknown step');
}

/**
 * Executes steps in order, stopping at the first error. Errors are detected
 * the only ways real controllers report them synchronously: a
 * `serialport:error` on the socket, or a controller 'error' emit during the
 * call (RSPController.command() swallows every throw into one).
 */
function run(engine, identity, steps) {
    const errors = [];
    const who = (identity && (identity.connId || identity.socketId)) || 'unknown';
    const fakeSocket = {
        id: 'remote:' + who,
        data: { identity },
        emit(ev, d) { if (ev === 'serialport:error') errors.push(d); },
        join() {},
        to() { return this; },
    };
    try {
        for (const step of steps) assertAllowed(step);
    } catch (err) {
        return { ok: false, error: err.message };
    }
    if (!engine) return { ok: false, error: 'No engine' };
    for (const step of steps) {
        const ctrl = engine.controller;
        const ctrlErrors = [];
        const onErr = (e) => ctrlErrors.push(e);
        if (ctrl && typeof ctrl.on === 'function') ctrl.on('error', onErr);
        try {
            if (step.fn === 'cmd') {
                engine._handleCommand(fakeSocket, null, step.cmd, ...step.args);
            } else if (step.fn === 'fileLoad') {
                engine._handleFileLoad(fakeSocket, { name: step.name, content: step.content });
            } else if (step.fn === 'rspCancelPendingJogs') {
                if (ctrl && typeof ctrl.cancelPendingJogs === 'function') ctrl.cancelPendingJogs();
            }
        } catch (err) {
            ctrlErrors.push({ message: err && err.message });
        } finally {
            if (ctrl && typeof ctrl.removeListener === 'function') ctrl.removeListener('error', onErr);
        }
        if (errors.length > 0 || ctrlErrors.length > 0) {
            const message = (errors[0] && errors[0].error) || (ctrlErrors[0] && ctrlErrors[0].message) || 'engine error';
            return { ok: false, error: String(message) };
        }
    }
    return { ok: true, error: null };
}

module.exports = {
    ALLOWED_CMDS,
    CAPABILITIES,
    FEED_OVERRIDE_ACTIONS,
    controllerKey,
    getCapabilities,
    getLimits,
    maxStepMm,
    plan,
    planStop,
    run,
};
