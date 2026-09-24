/**
 * RemoteCommandGate -- the machine-side ceiling for every non-operator
 * identity (cloud relay AND LAN phones), spec §5.2 / §9.
 *
 * The relay's ACL is necessary but never sufficient: a compromised relay can
 * forge any user, so tiers, grants, locks, latency and preconditions are all
 * decided here, from state that only the machine screen can change. The
 * closed COMMAND_TABLE is the whole remote vocabulary; anything else has no
 * representation and reaches nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const defaultClock = require('./clock');
const MachineAdapter = require('./MachineAdapter');
const { JogDeadman } = require('./JogDeadman');
const { TelemetryBuilder } = require('./TelemetryBuilder');
const { HostLoadMonitor } = require('./HostLoadMonitor');
const { TTL_MAX, USER_ID_RE, JOG_ID_RE, LIBRARY_ID_RE } = require('./protocol');

const TIERS = Object.freeze(['monitor', 'job', 'motion']);
const TIER_RANK = Object.freeze({ monitor: 0, job: 1, motion: 2 });
const CHANNELS = Object.freeze(['lan', 'cloud']);
const GRANT_MINUTES = Object.freeze([5, 15, 30]);
const GRANT_BLOCKING_LOCKS = Object.freeze(['alarm', 'disconnected', 'no-controller', 'board-link-down']);
const LOCK_ORDER = Object.freeze(['alarm', 'disconnected', 'no-controller', 'board-link-down', 'lan-only', 'host-busy', 'local-activity']);

const WATCHDOG_MS = 1000;
const LOCAL_ACTIVITY_MS = 5000;
const LATCH_IDLE_AFTER_MS = 250;
const STEP_SPACING_MS = 150;
const MOTION_PER_SEC = 20;
const RTT_CANCEL_MS = 600;
const STALE_MOTION_MS = 1500;
const STOP_VERIFY_MS = 2000;
const STOP_UNCONFIRMED_SHOW_MS = 60000;
const REMOTE_PAUSE_ATTRIBUTION_MS = 2000;
const REPLAY_IDLE_MS = 10 * 60 * 1000;
const IDEM_TTL_MS = 10 * 60 * 1000;
const IDEM_MAX = 256;
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const AUDIT_MAX_BYTES = 20 * 1024 * 1024;
const LAN_JOG_DISCONNECT_MS = 1000;

const AXES = Object.freeze(['x', 'y', 'z']);
const FEED_ACTIONS = MachineAdapter.FEED_OVERRIDE_ACTIONS;

const COMMAND_TABLE = Object.freeze({
    'job.stop': Object.freeze({ cls: 'stop', tier: 'any', capability: null }),
    'jog.cont.stop': Object.freeze({ cls: 'stop', tier: 'any', capability: null }),
    'tier.dropMotion': Object.freeze({ cls: 'stop', tier: 'any', capability: null }),
    'spindle.off': Object.freeze({ cls: 'stop', tier: 'any', capability: 'spindle' }),
    'job.pause': Object.freeze({ cls: 'job', tier: 'job', capability: 'start' }),
    'job.resume': Object.freeze({ cls: 'job', tier: 'job', capability: 'start' }),
    'feed.override': Object.freeze({ cls: 'job', tier: 'job', capability: 'feedOverride' }),
    'job.load': Object.freeze({ cls: 'motion', tier: 'motion', capability: 'load' }),
    'job.start': Object.freeze({ cls: 'motion', tier: 'motion', capability: 'start' }),
    'jog.step': Object.freeze({ cls: 'motion', tier: 'motion', capability: 'jogStep' }),
    'jog.cont.start': Object.freeze({ cls: 'motion', tier: 'motion', capability: 'jogContinuous' }),
    'jog.cont.keepalive': Object.freeze({ cls: 'motion', tier: 'motion', capability: 'jogContinuous' }),
    'zero': Object.freeze({ cls: 'motion', tier: 'motion', capability: 'zero' }),
    'home': Object.freeze({ cls: 'motion', tier: 'motion', capability: 'home' }),
    'spindle.on': Object.freeze({ cls: 'motion', tier: 'motion', capability: 'spindle' }),
});

const LAN_CLASSIFICATION = Object.freeze({
    'gcode:stop': Object.freeze({ tier: 'stop', gateType: 'job.stop' }),
    'feedhold': Object.freeze({ tier: 'stop', gateType: 'job.stop' }),
    'jogcancel': Object.freeze({ tier: 'stop', gateType: 'jog.cont.stop' }),
    'gcode:pause': Object.freeze({ tier: 'job', gateType: 'job.pause' }),
    'gcode:resume': Object.freeze({ tier: 'job', gateType: 'job.resume' }),
    'cyclestart': Object.freeze({ tier: 'job', gateType: 'job.resume' }),
    'feedOverride:reset': Object.freeze({ tier: 'job', gateType: 'feed.override' }),
    'feedOverride:coarsePlus': Object.freeze({ tier: 'job', gateType: 'feed.override' }),
    'feedOverride:coarseMinus': Object.freeze({ tier: 'job', gateType: 'feed.override' }),
    'feedOverride:finePlus': Object.freeze({ tier: 'job', gateType: 'feed.override' }),
    'feedOverride:fineMinus': Object.freeze({ tier: 'job', gateType: 'feed.override' }),
    'jog': Object.freeze({ tier: 'motion', gateType: 'jog.step' }),
    'gcode:start': Object.freeze({ tier: 'motion', gateType: 'job.start' }),
    'gcode:startFromLine': Object.freeze({ tier: 'motion', gateType: 'job.start' }),
    'gcode:startFresh': Object.freeze({ tier: 'motion', gateType: 'job.start' }),
    'wcs:zero': Object.freeze({ tier: 'motion', gateType: 'zero' }),
    'wcs:zeroAll': Object.freeze({ tier: 'motion', gateType: 'zero' }),
    'file:load': Object.freeze({ tier: 'motion', gateType: 'job.load' }),
    'file:unload': Object.freeze({ tier: 'motion', gateType: 'job.load' }),
    'statusreport': Object.freeze({ tier: 'monitor', gateType: null }),
    'safety:remoteDiagStatus': Object.freeze({ tier: 'monitor', gateType: null }),
});

const LOCAL_MOTION_CMDS = Object.freeze(['jog', 'jog:safe', 'move', 'probe', 'gcode:start', 'gcode:startFresh', 'gcode:startFromLine', 'gcode:resume', 'cyclestart', 'macro:run', 'gcode', 'wcs:zero', 'wcs:zeroAll']);
const LOCAL_MOTION_PREFIXES = Object.freeze(['homing', 'probe:', 'zero:']);
const LOCAL_MOTION_EVENTS = Object.freeze(['command:raw', 'write', 'writeln', 'gamepad:axes', 'gamepad:button', 'macro:run', 'job:resume:confirm']);
// Engine commands that change which work zero a job would cut against.
const WCS_CHANGE_CMDS = Object.freeze(['wcs:zero', 'wcs:zeroAll', 'wcs:set', 'zero', 'zero:x', 'zero:y', 'zero:z', 'zero:all']);
// G10 (set offsets), G92 (temporary offset) and G54-G59 (select WCS) in MDI
// or macro text.
const WCS_GCODE_RE = /(?:^|[^A-Za-z0-9.])G0*(?:10|92|5[4-9])(?:\.\d)?(?![0-9])/i;
// Raw console text that commands motion (Grbl-family): jog, home, cycle
// start, or any G/M word or axis word. '$$', '$#', '$G', '?' ... do not.
const RAW_MOTION_RE = /\$J=|\$H|~|(?:^|[^A-Za-z$])[GMgm]\s*\d|(?:^|[^A-Za-z$])[XYZABCxyzabc]\s*[-+]?\d/;
const RUNNING_RAW = Object.freeze(['Run', 'Jog', 'Home', 'Homing', 'Stream']);
const LAN_PASS_MS = 1000;
const LAN_ZERO_WCS_RE = /^G5[4-9]$/;

function isLocalMotionCmd(cmd) {
    return typeof cmd === 'string'
        && (LOCAL_MOTION_CMDS.includes(cmd) || LOCAL_MOTION_PREFIXES.some(p => cmd.startsWith(p)));
}

function isHoldRaw(raw) {
    return raw === 'Hold' || (typeof raw === 'string' && raw.startsWith('Hold:'));
}

function isAbsent(v) {
    return v === undefined || v === null;
}

// ─── pure helpers ─────────────────────────────────────────────────────

function classifyLanCommand(engineCmd) {
    if (typeof engineCmd !== 'string' || !Object.hasOwn(LAN_CLASSIFICATION, engineCmd)) {
        return { tier: 'never', gateType: null };
    }
    const c = LAN_CLASSIFICATION[engineCmd];
    return { tier: c.tier, gateType: c.gateType };
}

function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function onlyKeys(obj, allowed) {
    return Object.keys(obj).every(k => allowed.includes(k));
}

function isInt(v, lo, hi) {
    return Number.isInteger(v) && v >= lo && v <= hi;
}

/**
 * Strict per-row argument validation (§9.2.3). Returns normalised args, or
 * null for BAD_ARGS. Unknown keys are always an error.
 */
function validateArgs(type, rawArgs, limits) {
    const args = rawArgs === undefined ? {} : rawArgs;
    if (!isPlainObject(args)) return null;
    switch (type) {
        case 'job.stop':
        case 'tier.dropMotion':
        case 'spindle.off':
        case 'job.pause':
        case 'job.resume':
            return Object.keys(args).length === 0 ? {} : null;
        case 'jog.cont.stop':
            if (!onlyKeys(args, ['jogId'])) return null;
            if (args.jogId !== undefined && (typeof args.jogId !== 'string' || !JOG_ID_RE.test(args.jogId))) return null;
            return args.jogId === undefined ? {} : { jogId: args.jogId };
        case 'feed.override':
            if (!onlyKeys(args, ['action']) || !FEED_ACTIONS.includes(args.action)) return null;
            return { action: args.action };
        case 'job.load':
            if (!onlyKeys(args, ['libraryId']) || typeof args.libraryId !== 'string' || !LIBRARY_ID_RE.test(args.libraryId)) return null;
            return { libraryId: args.libraryId };
        case 'job.start': {
            if (!onlyKeys(args, ['libraryId', 'fromBeginning', 'expect'])) return null;
            if (args.libraryId !== undefined && (typeof args.libraryId !== 'string' || !LIBRARY_ID_RE.test(args.libraryId))) return null;
            if (args.fromBeginning !== true) return null;
            const e = args.expect;
            if (!isPlainObject(e) || !onlyKeys(e, ['name', 'size', 'loadSeq', 'wcsSeq'])) return null;
            if (typeof e.name !== 'string' || e.name.length > 200) return null;
            if (!isInt(e.size, 0, Number.MAX_SAFE_INTEGER) || !isInt(e.loadSeq, 0, Number.MAX_SAFE_INTEGER)
                || !isInt(e.wcsSeq, 0, Number.MAX_SAFE_INTEGER)) return null;
            const out = { fromBeginning: true, expect: { name: e.name, size: e.size, loadSeq: e.loadSeq, wcsSeq: e.wcsSeq } };
            if (args.libraryId !== undefined) out.libraryId = args.libraryId;
            return out;
        }
        case 'jog.step': {
            if (!onlyKeys(args, ['axis', 'distanceMm', 'feed'])) return null;
            if (!AXES.includes(args.axis)) return null;
            const d = args.distanceMm;
            if (typeof d !== 'number' || !Number.isFinite(d) || Math.abs(d) < 0.001 || Math.abs(d) > limits.jogStepMaxMm) return null;
            if (!isInt(args.feed, 1, limits.jogStepMaxFeed)) return null;
            return { axis: args.axis, distanceMm: d, feed: args.feed };
        }
        case 'jog.cont.start': {
            if (!onlyKeys(args, ['jogId', 'axis', 'dir', 'feed'])) return null;
            if (typeof args.jogId !== 'string' || !JOG_ID_RE.test(args.jogId)) return null;
            if (!AXES.includes(args.axis) || (args.dir !== 1 && args.dir !== -1)) return null;
            // Controllers without continuous jog have no feed cap; let the
            // capability check answer NOT_SUPPORTED instead of BAD_ARGS.
            if (!isInt(args.feed, 1, limits.jogContMaxFeed || 1500)) return null;
            return { jogId: args.jogId, axis: args.axis, dir: args.dir, feed: args.feed };
        }
        case 'jog.cont.keepalive':
            if (!onlyKeys(args, ['jogId']) || typeof args.jogId !== 'string' || !JOG_ID_RE.test(args.jogId)) return null;
            return { jogId: args.jogId };
        case 'zero': {
            if (!onlyKeys(args, ['axes']) || !Array.isArray(args.axes) || args.axes.length === 0 || args.axes.length > 3) return null;
            if (!args.axes.every(a => AXES.includes(a)) || new Set(args.axes).size !== args.axes.length) return null;
            return { axes: args.axes.slice() };
        }
        case 'home':
            if (!onlyKeys(args, ['axis']) || !['all', 'x', 'y', 'z'].includes(args.axis)) return null;
            return { axis: args.axis };
        case 'spindle.on':
            if (!onlyKeys(args, ['rpm']) || !isInt(args.rpm, 1, 24000)) return null;
            return { rpm: args.rpm };
        default:
            return null;
    }
}

function grantMatches(scope, identity) {
    if (!scope || !identity) return false;
    if (scope.channel === 'lan') return identity.kind === 'lan';
    if (scope.channel === 'cloud') {
        if (identity.kind !== 'cloud') return false;
        return !scope.userId || identity.userId === scope.userId;
    }
    return false;
}

function sanitize(value, maxBytes = 1024) {
    try {
        const json = JSON.stringify(value === undefined ? null : value);
        if (json === undefined) return null;
        if (json.length > maxBytes) return { truncated: true };
        return JSON.parse(json);
    } catch (_) {
        return null;
    }
}

function str(v, max = 80) {
    return typeof v === 'string' ? v.slice(0, max) : null;
}

function result(status, code, message = null, duplicate = false) {
    return { status, code, message, duplicate };
}

// ─── gate ─────────────────────────────────────────────────────────────

class RemoteCommandGate extends EventEmitter {
    constructor({
        store, logger, getEngine, libraryService, auditFile,
        isLanOnly = () => false,
        isLocalBusy = () => false,
        onChange = () => {}, onAudit = () => {}, onJogActivity = () => {}, onMotionExpired = () => {},
        clock = defaultClock,
        setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
        setIntervalFn = setInterval, clearIntervalFn = clearInterval,
        hostLoadMonitor,
    } = {}) {
        super();
        this.store = store;
        this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
        this.getEngine = getEngine || (() => null);
        this.libraryService = libraryService || null;
        this.auditFile = auditFile || null;
        this.isLanOnly = isLanOnly;
        // Long-running local routines (probing, macros) the host sequences
        // itself; true for their whole duration holds 'local-activity'.
        this.isLocalBusy = isLocalBusy;
        this._onChange = onChange;
        this._onAudit = onAudit;
        this._onJogActivity = onJogActivity;
        this._onMotionExpired = onMotionExpired;
        this.clock = clock;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;

        this.motionGrant = null;
        this._grantTimer = null;
        this.pause = null;              // {origin, channel, at(wall)}
        this._pendingRemotePause = null; // {channel, until(mono)}
        this.loadSeq = 0;
        this.wcsSeq = 0;
        this._motionDispatchedAt = null;
        this._idleSeenAt = null;
        this._lastStepAt = -Infinity;
        this._motionTimes = [];
        this._localActivityUntil = -Infinity;
        this.remoteSpindleOn = null;
        this._replay = new Map();
        this._idem = new Map();
        this._stopTimer = null;
        this._stopUnconfirmedAt = null;
        this._stopUnconfirmedUntil = null;
        this._lanJogs = new Map();
        this._rttSamples = [];
        this._cloudLinkUp = false;
        this._recentUsers = new Map();
        this._remoteLoaded = null;
        this._locksKey = '';
        this._hardLocks = new Set();
        this._lastStatusLockCheck = -Infinity;
        this._disposed = false;
        // >0 while the gate itself is driving the engine, so the controller
        // observer does not mistake remote dispatches for operator activity.
        this._selfDispatch = 0;
        // Engine commands a LAN check just let through: {cmd, until(mono)}.
        this._lanPasses = [];
        // Host-sequenced local moves in flight (RSP 'hostmotion').
        this._hostMotionActive = 0;
        // The program the controller last received: {name, size} |
        // {unloaded:true} | null (unknown, trust engine.loadedFile).
        this._program = null;
        // True while the controller holds a checkpoint-resume program (a
        // preamble that rapids to the checkpoint XY and plunges, then only the
        // lines after the checkpoint) under the original file name. Start
        // would run that partial program "from the beginning", so remote
        // job.start without a libraryId is refused until a plain load or an
        // unload replaces it. Set by the resume taps (which run before the
        // resume service loads), cleared by the next load outside the arm
        // window.
        this._resumeProgram = false;
        this._resumeArmUntil = -Infinity;

        this.telemetry = new TelemetryBuilder({
            clock,
            isLanOnly,
            getRttMs: () => this.cloudRttMs(),
            getExtras: () => ({ loadSeq: this.loadSeq, wcsSeq: this.wcsSeq, pause: this._publicPause() }),
            setIntervalFn,
            clearIntervalFn,
        });
        this._wireTelemetry();

        this.deadman = new JogDeadman({
            clock,
            setIntervalFn,
            clearIntervalFn,
            getEngine: () => this.getEngine(),
            getControllerType: () => this._controllerType(),
            getPosition: () => this.telemetry.position(),
            getTelemetryAgeMs: () => this.telemetry.telemetryAgeMs(),
            getLocks: (identity) => this.getLocks(identity && identity.kind),
            getOwnerTier: (identity) => this.effectiveTier(identity),
            dispatch: (steps, identity) => this._runSteps(identity, steps),
            isJobActive: () => {
                const j = this.telemetry.jobInfo();
                return j.active || j.paused;
            },
            onStep: () => { this._motionDispatchedAt = this.clock.mono(); },
            onActivity: (activeJog) => {
                try { this._onJogActivity(activeJog); } catch (_) { /* observer must not break the jog */ }
                this.emit('jog', activeJog);
                this._notify();
            },
            onCancel: (info) => this._onJogCancelled(info),
        });

        this._ownsMonitor = !hostLoadMonitor;
        this.hostLoadMonitor = hostLoadMonitor || new HostLoadMonitor({ clock, setIntervalFn, clearIntervalFn });
        this._onHostLoad = (busy) => this._handleHostBusy(busy);
        if (typeof this.hostLoadMonitor.on === 'function') this.hostLoadMonitor.on('change', this._onHostLoad);
        if (this._ownsMonitor) this.hostLoadMonitor.start();

        this._watchdog = this.setIntervalFn(() => this._watchdogTick(), WATCHDOG_MS);
        if (this._watchdog && typeof this._watchdog.unref === 'function') this._watchdog.unref();
    }

    // ─── engine / telemetry wiring ───────────────────────────────────

    attachEngine(engine) {
        this.telemetry.attachEngine(engine);
        this._locksKey = this.getLocks('cloud').join(',');
    }

    getTelemetry() {
        return this.telemetry.snapshot();
    }

    _controllerType() {
        this.telemetry.refresh();
        return this.telemetry.controllerType;
    }

    _wireTelemetry() {
        const t = this.telemetry;
        t.on('controller-call', (method, args) => this._onControllerCall(method, args));
        t.on('host-motion', (phase) => this._onHostMotion(phase));
        t.on('controller-bound', (ctrl, isNew) => {
            if (!isNew) return;
            this.pause = null;
            this._pendingRemotePause = null;
            this._hostMotionActive = 0;
            this._lanPasses = [];
            // A fresh controller holds no program, whatever engine.loadedFile
            // still says.
            this._program = ctrl ? { unloaded: true } : null;
            this._resumeProgram = false;
            this._resumeArmUntil = -Infinity;
            this.loadSeq += 1;
            this.wcsSeq += 1;
            if (this.motionGrant) this.revokeMotion('controller-changed', { kind: 'system' });
            else this.cancelAllJogs('controller-changed');
            this._checkLocks();
        });
        t.on('alarm-latched', () => {
            if (this.motionGrant) this.revokeMotion('alarm', { kind: 'system' });
            this.cancelAllJogs('alarm');
            this._notify();
        });
        t.on('alarm-cleared', () => this._notify());
        t.on('disconnected', () => {
            this.cancelAllJogs('controller disconnected');
            this._checkLocks();
        });
        t.on('connected', () => this._checkLocks());
        t.on('poll', () => this._checkLocks());
        t.on('status', (st, at) => this._onStatus(st, at));
        t.on('sender', (kind) => {
            if (kind === 'start' || kind === 'end' || kind === 'error') {
                this.pause = null;
                this._pendingRemotePause = null;
            } else if (kind === 'pause') {
                this._onPauseObserved();
            } else if (kind === 'resume') {
                this._onResumeObserved();
            }
            this._notify();
        });
        t.on('workflow', (state) => {
            if (state === 'paused') this._onPauseObserved();
            else if (state === 'running' && this.pause) this._onResumeObserved();
            else if (state === 'idle') {
                this.pause = null;
                this._pendingRemotePause = null;
            }
        });
        t.on('toolchange', (kind) => {
            if (kind === 'start') {
                this.pause = { origin: 'toolchange', channel: null, at: this.clock.wall() };
            } else if (this.pause && this.pause.origin === 'toolchange') {
                this.pause = null;
            }
            this._notify();
        });
    }

    _onStatus(st, at) {
        const raw = typeof st.activeState === 'string' ? st.activeState : '';
        if (raw === 'Idle') this._idleSeenAt = at;
        const p = this.pause;
        if (p && (p.origin === 'remote' || p.origin === 'local' || p.origin === 'program')) {
            // An attribution covers exactly one hold. Once that hold has been
            // seen and the machine is moving again, it was resumed -- by a
            // path that may have emitted no event at all (Grbl cycle-start
            // pin, gamepad '~', Telegram) -- so a later hold must be
            // classified afresh, never inherit this origin.
            if (isHoldRaw(raw)) {
                p.holdSeen = true;
            } else if (RUNNING_RAW.includes(raw) && p.holdSeen) {
                this.pause = null;
            }
        }
        if (raw.startsWith('Door') && !this.telemetry.toolchangePending) {
            if (!this.pause || this.pause.origin !== 'door') {
                this.pause = { origin: 'door', channel: null, at: this.clock.wall() };
            }
        } else if (isHoldRaw(raw) && !this.pause) {
            const j = this.telemetry.jobInfo();
            if (j.active || j.paused) {
                this._onPauseObserved();
                if (this.pause) this.pause.holdSeen = true;
            }
        }
        // Status can arrive at tens of Hz; lock transitions only need ~10 Hz.
        if (!(at - this._lastStatusLockCheck < 100)) {
            this._lastStatusLockCheck = at;
            this._checkLocks();
        }
    }

    _onPauseObserved() {
        const now = this.clock.mono();
        if (this.telemetry.toolchangePending) {
            this.pause = { origin: 'toolchange', channel: null, at: this.clock.wall() };
        } else if (this._pendingRemotePause && now <= this._pendingRemotePause.until) {
            this.pause = { origin: 'remote', channel: this._pendingRemotePause.channel, at: this.clock.wall(), atMono: now };
            this._pendingRemotePause = null;
        } else if (this.pause && (this.pause.origin === 'door' || this.pause.origin === 'toolchange'
            || ((this.pause.origin === 'remote' || this.pause.origin === 'local')
                && now - this.pause.atMono <= REMOTE_PAUSE_ATTRIBUTION_MS))) {
            // Already attributed. A remote/local attribution only covers the
            // pause events of that one hold; an older one whose resume we never
            // saw must not be inherited by a later program hold.
        } else if ((this.telemetry.rawState() || '').startsWith('Door')) {
            this.pause = { origin: 'door', channel: null, at: this.clock.wall() };
        } else {
            this.pause = { origin: 'program', channel: null, at: this.clock.wall() };
        }
    }

    _onResumeObserved() {
        if (this.telemetry.toolchangePending) return;
        this.pause = null;
        this._pendingRemotePause = null;
    }

    _publicPause() {
        if (!this.pause) return null;
        const j = this.telemetry.jobInfo();
        const raw = this.telemetry.rawState() || '';
        const held = j.paused || raw === 'Hold' || raw.startsWith('Door')
            || this.pause.origin === 'toolchange' || this.pause.origin === 'door';
        if (!held && !(this.pause.origin === 'remote' || this.pause.origin === 'local')) return null;
        const out = { origin: this.pause.origin, since: this.pause.at };
        // Additive fields so a client can tell which remote pauses it may
        // resume: a remote pause is resumable only on its own channel, and
        // never while a tool change is pending.
        if (this.pause.origin === 'remote' && (this.pause.channel === 'lan' || this.pause.channel === 'cloud')) {
            out.channel = this.pause.channel;
        }
        if (this.telemetry.toolchangePending) out.toolchangePending = true;
        return out;
    }

    _handleHostBusy(busy) {
        if (busy) {
            this.cancelAllJogs('host-busy');
            this._spindleAutoOff('host-busy', () => true);
        }
        this._notify();
    }

    // ─── locks and tiers ─────────────────────────────────────────────

    /**
     * Locks as seen by an identity kind; 'lan-only' only applies to cloud.
     */
    getLocks(kind = 'cloud') {
        const engine = this.getEngine();
        const t = this.telemetry;
        const set = new Set();
        if (t.alarm) set.add('alarm');
        if (!t.connected) set.add('disconnected');
        if (!engine || !engine.controller) set.add('no-controller');
        if (t.connected && engine && engine.controller && t.boardLinkOk() === false) set.add('board-link-down');
        if (kind === 'cloud' && this.isLanOnly()) set.add('lan-only');
        if (this.hostLoadMonitor && typeof this.hostLoadMonitor.isBusy === 'function' && this.hostLoadMonitor.isBusy()) set.add('host-busy');
        let localBusy = false;
        try { localBusy = !!this.isLocalBusy(); } catch (_) { localBusy = true; }
        // Refreshed while busy, so the lock also covers the usual window after
        // the routine ends.
        if (localBusy) this._localActivityUntil = Math.max(this._localActivityUntil, this.clock.mono() + LOCAL_ACTIVITY_MS);
        if (localBusy || this._hostMotionActive > 0 || this.clock.mono() < this._localActivityUntil) set.add('local-activity');
        return LOCK_ORDER.filter(l => set.has(l));
    }

    hasLock(lock, kind = 'cloud') {
        return this.getLocks(kind).includes(lock);
    }

    _checkLocks() {
        if (this._disposed) return;
        this.telemetry.refresh();
        const locks = this.getLocks('cloud');
        const hard = new Set(locks.filter(l => l === 'disconnected' || l === 'no-controller' || l === 'board-link-down'));
        for (const l of hard) {
            if (!this._hardLocks.has(l) && this.motionGrant) this.revokeMotion(l, { kind: 'system' });
        }
        this._hardLocks = hard;
        const key = locks.join(',');
        if (key !== this._locksKey) {
            this._locksKey = key;
            this._notify();
        }
    }

    _jobControl() {
        const snap = this.store && typeof this.store.get === 'function' ? this.store.get() : null;
        const jc = snap && snap.tiers && snap.tiers.jobControl ? snap.tiers.jobControl : {};
        return { lan: jc.lan === true, cloud: jc.cloud === true };
    }

    _grantActive() {
        return !!(this.motionGrant && this.clock.mono() < this.motionGrant.untilMono);
    }

    effectiveTier(identity) {
        if (!identity || (identity.kind !== 'lan' && identity.kind !== 'cloud')) return 'monitor';
        if (this._grantActive() && grantMatches(this.motionGrant.scope, identity)) return 'motion';
        if (this._jobControl()[identity.kind]) return 'job';
        return 'monitor';
    }

    getState(channel = 'cloud') {
        const view = channel === 'lan' ? 'lan' : channel === 'operator' ? 'operator' : 'cloud';
        const tierChannel = view === 'lan' ? 'lan' : 'cloud';
        const type = this._controllerType();
        const jc = this._jobControl();
        const grant = this._grantActive() ? this.motionGrant : null;
        const matchesChannel = !!(grant && grant.scope.channel === tierChannel);
        let tier = 'monitor';
        if (matchesChannel) tier = 'motion';
        else if (jc[tierChannel]) tier = 'job';
        const remaining = grant ? Math.max(0, Math.round(grant.untilMono - this.clock.mono())) : null;
        const showGrant = view === 'operator' ? !!grant : matchesChannel;
        const now = this.clock.wall();
        const activeJog = this.deadman.activeJog();
        let motionScope = null;
        if (grant) {
            motionScope = { channel: grant.scope.channel, userId: view === 'lan' ? null : (grant.scope.userId || null) };
            if (view === 'operator') {
                const known = grant.scope.userId ? this._recentUsers.get(grant.scope.userId) : null;
                motionScope.userLabel = known ? known.userLabel : null;
            }
        }
        const state = {
            tier,
            jobControlEnabled: jc[tierChannel],
            motionExpiresAt: showGrant ? now + remaining : null,
            motionRemainingMs: showGrant ? remaining : null,
            serverNow: now,
            scope: {
                jobControl: CHANNELS.filter(c => jc[c]),
                motion: motionScope,
            },
            locks: this.getLocks(view === 'lan' ? 'lan' : 'cloud'),
            capabilities: MachineAdapter.getCapabilities(type),
            limits: { ...MachineAdapter.getLimits(type), deadmanMs: this.deadman.deadmanMs },
            activeJog: activeJog ? { ...activeJog, userLabel: view === 'lan' ? null : activeJog.userLabel } : null,
            stats: this.deadman.getStats(),
        };
        if (this._stopUnconfirmedAt !== null && this.clock.mono() < this._stopUnconfirmedUntil) {
            state.stopUnconfirmedAt = this._stopUnconfirmedAt;
        }
        if (view === 'operator') {
            state.jobControl = { ...jc };
            state.tierByChannel = {
                lan: grant && grant.scope.channel === 'lan' ? 'motion' : (jc.lan ? 'job' : 'monitor'),
                cloud: grant && grant.scope.channel === 'cloud' ? 'motion' : (jc.cloud ? 'job' : 'monitor'),
            };
            state.pause = this._publicPause();
        }
        return state;
    }

    isJogActive() {
        return this.deadman.isActive();
    }

    /** FileIngest §5.7 step 6. */
    isBusyForIngest() {
        const j = this.telemetry.jobInfo();
        return j.active || j.paused || this.deadman.isActive() || this.hasLock('host-busy');
    }

    cloudRttMs() {
        if (!this._rttSamples.length) return null;
        const s = this._rttSamples.slice().sort((a, b) => a - b);
        return Math.round(s[Math.floor(s.length / 2)]);
    }

    getRecentCloudUsers(sinceMs = 24 * 60 * 60 * 1000) {
        const cutoff = this.clock.wall() - sinceMs;
        return [...this._recentUsers.entries()]
            .filter(([, u]) => u.lastSeenAt >= cutoff)
            .map(([userId, u]) => ({ userId, userLabel: u.userLabel, lastSeenAt: u.lastSeenAt }))
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }

    // ─── operator actions ────────────────────────────────────────────

    setJobControl(channel, enabled, identity) {
        if (!identity || identity.kind !== 'operator') throw new Error('operator_only');
        if (!CHANNELS.includes(channel)) throw new Error('bad_scope');
        const on = !!enabled;
        this.store.update((d) => {
            if (!d.tiers || typeof d.tiers !== 'object') d.tiers = {};
            const jc = d.tiers.jobControl && typeof d.tiers.jobControl === 'object' ? d.tiers.jobControl : {};
            d.tiers.jobControl = { lan: jc.lan === true, cloud: jc.cloud === true, [channel]: on };
        });
        this._audit(identity, { event: 'tier.job', args: { channel, enabled: on } });
        if (!on && this.motionGrant && this.motionGrant.scope.channel === channel) {
            this.revokeMotion('job-control-off', identity);
        } else {
            this._notify();
        }
        return this.getState('operator');
    }

    grantMotion(minutes, identity, scope) {
        if (!identity || identity.kind !== 'operator') throw new Error('operator_only');
        if (!GRANT_MINUTES.includes(minutes)) throw new Error('bad_duration');
        if (!scope || typeof scope !== 'object' || !CHANNELS.includes(scope.channel)) throw new Error('bad_scope');
        let normalized;
        if (scope.channel === 'lan') {
            normalized = { channel: 'lan' };
        } else {
            const userId = scope.userId === undefined ? null : scope.userId;
            if (userId !== null && (typeof userId !== 'string' || !USER_ID_RE.test(userId))) throw new Error('bad_scope');
            normalized = { channel: 'cloud', userId };
        }
        const blocking = this.getLocks('cloud').filter(l => GRANT_BLOCKING_LOCKS.includes(l));
        if (blocking.length) {
            const err = new Error('locked');
            err.locks = blocking;
            throw err;
        }
        const previous = this.motionGrant;
        if (previous && (previous.scope.channel !== normalized.channel || (previous.scope.userId || null) !== (normalized.userId || null))) {
            this.deadman.cancelWhere(owner => !grantMatches(normalized, owner), 'tier');
        }
        if (this._grantTimer) this.clearTimeoutFn(this._grantTimer);
        const now = this.clock.mono();
        this.motionGrant = { untilMono: now + minutes * 60000, grantedAtWall: this.clock.wall(), scope: normalized, minutes };
        this._grantTimer = this.setTimeoutFn(() => this._expireIfDue(), minutes * 60000);
        if (this._grantTimer && typeof this._grantTimer.unref === 'function') this._grantTimer.unref();
        this._audit(identity, { event: 'tier.motion.grant', args: { minutes, scope: normalized } });
        this._notify();
        return this.getState('operator');
    }

    revokeMotion(reason, identity) {
        const grant = this.motionGrant;
        if (!grant) return this.getState('operator');
        this.motionGrant = null;
        this.cancelAllJogs(reason);
        this._spindleAutoOff(reason, () => true);
        if (this._grantTimer) this.clearTimeoutFn(this._grantTimer);
        this._grantTimer = null;
        this._notify();
        this._audit(identity || { kind: 'system' }, {
            event: reason === 'expired' ? 'tier.motion.expire' : 'tier.motion.revoke',
            args: { reason: str(reason, 60), scope: grant.scope },
        });
        return this.getState('operator');
    }

    _expireIfDue() {
        const grant = this.motionGrant;
        if (!grant) return;
        if (this.clock.mono() < grant.untilMono) {
            // Timer fired early (clock drift between timers and mono): re-arm.
            if (this._grantTimer) this.clearTimeoutFn(this._grantTimer);
            this._grantTimer = this.setTimeoutFn(() => this._expireIfDue(), Math.max(10, grant.untilMono - this.clock.mono()));
            return;
        }
        this.revokeMotion('expired', { kind: 'system' });
        try {
            this._onMotionExpired({ channel: grant.scope.channel, at: this.clock.wall() });
        } catch (_) { /* observer */ }
    }

    // ─── jog lifecycle hooks ─────────────────────────────────────────

    cancelAllJogs(reason) {
        return this.deadman.cancel(reason);
    }

    onRttSample(ms) {
        const v = Number(ms);
        if (!Number.isFinite(v)) return;
        this._rttSamples.push(v);
        if (this._rttSamples.length > 5) this._rttSamples.shift();
        if (v > RTT_CANCEL_MS) this.deadman.cancelWhere(owner => owner.kind === 'cloud', 'latency');
    }

    onLinkUp(kind = 'cloud') {
        if (kind !== 'cloud') return;
        if (!this._cloudLinkUp) {
            this._cloudLinkUp = true;
            this._audit({ kind: 'system' }, { event: 'link.up', args: { kind } });
        }
    }

    onLinkDown(kind, reason = 'link-down') {
        if (kind !== 'cloud') return;
        this.deadman.cancelWhere(owner => owner.kind === 'cloud', reason);
        this._spindleAutoOff(reason, s => s.identityKind === 'cloud');
        this._rttSamples = [];
        if (this._cloudLinkUp) {
            this._cloudLinkUp = false;
            this._audit({ kind: 'system' }, { event: 'link.down', args: { kind, reason: str(reason, 40) } });
        }
        this._notify();
    }

    onClientGone(connId) {
        if (typeof connId !== 'string') return;
        this.deadman.cancelWhere(owner => owner.kind === 'cloud' && owner.connId === connId, 'client-gone');
        this._spindleAutoOff('client-gone', s => s.identityKind === 'cloud' && s.connId === connId);
        this._replay.delete(connId);
    }

    onLanSocketGone(socketId) {
        if (!socketId) return;
        this.deadman.cancelWhere(owner => owner.kind === 'lan' && owner.socketId === socketId, 'client-gone');
        this._spindleAutoOff('client-gone', s => s.identityKind === 'lan' && s.socketId === socketId);
        const lastJog = this._lanJogs.get(socketId);
        this._lanJogs.delete(socketId);
        if (lastJog !== undefined && this.clock.mono() - lastJog <= LAN_JOG_DISCONNECT_MS) {
            const type = this._controllerType();
            if (MachineAdapter.getCapabilities(type).jogCancel) {
                this._runSteps({ kind: 'lan', socketId }, MachineAdapter.plan(type, 'jog.cancel', {}));
            }
        }
    }

    onLocalCommand(event, args) {
        let cmd = null;
        let cmdArgs = [];
        let motion = false;
        const list = Array.isArray(args) ? args : [];
        if (event === 'command') {
            cmd = typeof list[1] === 'string' ? list[1] : null;
            cmdArgs = list.slice(2);
        } else if (typeof event === 'string' && event.startsWith('http:')) {
            const route = event.slice(5);
            const body = Array.isArray(args) ? args[0] : args;
            if (/\/command$/.test(route)) {
                cmd = body && typeof (body.command || body.cmd) === 'string' ? (body.command || body.cmd) : null;
                cmdArgs = body && Array.isArray(body.args) ? body.args : [];
            } else if (/\/job\/resume$/.test(route)) {
                // A checkpoint resume replaces the controller program.
                cmd = 'gcode:resume';
                this.loadSeq += 1;
                this._noteResumeTap();
            } else if (/\/macros\/[^/]+\/run$/.test(route) || /\/probing\/(run|finalize-corner)$/.test(route)
                || /\/connect$/.test(route) || /\/disconnect$/.test(route)) {
                motion = true;
                if (/\/probing\//.test(route)) this.wcsSeq += 1;
            }
        } else if (typeof event === 'string') {
            if (LOCAL_MOTION_EVENTS.includes(event)) motion = true;
            if (event === 'file:load' || event === 'file:unload' || event === 'job:resume:confirm') this.loadSeq += 1;
            if (event === 'job:resume:confirm') this._noteResumeTap();
            if (event === 'gamepad:button') this._demoteRemotePause();
            if ((event === 'command:raw' || event === 'write' || event === 'writeln')) {
                const data = event === 'command:raw' ? list[0] : list[1];
                if (typeof data === 'string') this._noteLocalRaw(data);
            }
        }

        if (cmd && this._noteLocalCmd(cmd, cmdArgs)) motion = true;
        if (motion) this._noteLocalMotion();
        this._checkLocks();
    }

    /**
     * Operator-side engine command bookkeeping shared by the taps and the
     * controller observer. Returns true when the command moves the machine.
     */
    _noteLocalCmd(cmd, cmdArgs) {
        const a = Array.isArray(cmdArgs) ? cmdArgs : [];
        if (cmd === 'gcode:pause' || cmd === 'feedhold') {
            this.pause = { origin: 'local', channel: null, at: this.clock.wall(), atMono: this.clock.mono() };
            this._pendingRemotePause = null;
        }
        if (cmd === 'gcode:resume' || cmd === 'cyclestart' || cmd === 'gcode:stop') {
            if (!this.telemetry.toolchangePending || cmd === 'gcode:stop') this.pause = null;
            this._pendingRemotePause = null;
        }
        if (WCS_CHANGE_CMDS.includes(cmd)) this.wcsSeq += 1;
        if ((cmd === 'gcode' || cmd === 'macro:run') && typeof a[0] === 'string' && WCS_GCODE_RE.test(a[0])) this.wcsSeq += 1;
        if (cmd === 'gcode:load' || cmd === 'gcode:unload') this.loadSeq += 1;
        return isLocalMotionCmd(cmd);
    }

    /** Raw console text (Grbl-family realtime bytes and lines). */
    _noteLocalRaw(data) {
        const s = String(data);
        if (!s) return false;
        if (s.includes('!')) {
            const j = this._jobState();
            if (j.active) {
                this.pause = { origin: 'local', channel: null, at: this.clock.wall(), atMono: this.clock.mono() };
                this._pendingRemotePause = null;
            }
        }
        if (s.includes('~') || s.includes('\x18')) {
            if (!this.telemetry.toolchangePending || s.includes('\x18')) this.pause = null;
            this._pendingRemotePause = null;
        }
        if (WCS_GCODE_RE.test(s)) this.wcsSeq += 1;
        return RAW_MOTION_RE.test(s);
    }

    /** An operator input we cannot decode (gamepad button): never leave a remote origin. */
    _demoteRemotePause() {
        if (this.pause && this.pause.origin === 'remote') {
            this.pause = { origin: 'local', channel: null, at: this.clock.wall(), atMono: this.clock.mono() };
        }
        this._pendingRemotePause = null;
    }

    _noteLocalMotion() {
        this.cancelAllJogs('operator-activity');
        const now = this.clock.mono();
        this._localActivityUntil = Math.max(this._localActivityUntil, now + LOCAL_ACTIVITY_MS);
        this._motionDispatchedAt = now;
    }

    /**
     * TelemetryBuilder 'controller-call': a command/write that actually
     * reached the bound controller, from any caller. Everything not
     * dispatched by the gate itself and not a LAN command the gate just
     * checked is operator-side activity.
     */
    _onControllerCall(method, args) {
        if (this._disposed) return;
        const list = Array.isArray(args) ? args : [];
        try {
            if (method === 'command') {
                const cmd = list[0];
                if (typeof cmd !== 'string') return;
                if (cmd === 'gcode:load') {
                    this._program = { name: String(isAbsent(list[1]) ? '' : list[1]), size: typeof list[2] === 'string' ? list[2].length : 0 };
                    const now = this.clock.mono();
                    if (this._selfDispatch === 0 && now <= this._resumeArmUntil) {
                        this._resumeProgram = true;
                    } else {
                        this._resumeProgram = false;
                    }
                    this._resumeArmUntil = -Infinity;
                } else if (cmd === 'gcode:unload') {
                    this._program = { unloaded: true };
                    this._resumeProgram = false;
                    this._resumeArmUntil = -Infinity;
                }
                if (this._selfDispatch > 0 || this._consumeLanPass(cmd)) return;
                const motion = this._noteLocalCmd(cmd, list.slice(1));
                if (motion) this._noteLocalMotion();
                this._checkLocks();
            } else if (method === 'write' || method === 'writeln') {
                if (this._selfDispatch > 0) return;
                const d = list[0];
                const data = typeof d === 'string' ? d : (Buffer.isBuffer(d) ? d.toString('latin1') : '');
                if (this._noteLocalRaw(data)) {
                    this._noteLocalMotion();
                    this._checkLocks();
                }
            }
        } catch (err) {
            this.logger.warn(`[gate] controller observer failed: ${err && err.message}`);
        }
    }

    _onHostMotion(phase) {
        if (this._disposed) return;
        if (phase === 'start') {
            this._hostMotionActive += 1;
            this._noteLocalMotion();
        } else if (phase === 'end') {
            this._hostMotionActive = Math.max(0, this._hostMotionActive - 1);
            // The lock runs for the usual window after the LAST move ends, so
            // the Idle gaps inside a probing chain stay covered.
            const now = this.clock.mono();
            this._localActivityUntil = Math.max(this._localActivityUntil, now + LOCAL_ACTIVITY_MS);
            this._motionDispatchedAt = now;
        }
        this._checkLocks();
    }

    _noteLanPass(engineCmd) {
        const now = this.clock.mono();
        this._lanPasses = this._lanPasses.filter(p => p.until > now);
        const cmd = engineCmd === 'file:load' ? 'gcode:load' : engineCmd === 'file:unload' ? 'gcode:unload' : engineCmd;
        this._lanPasses.push({ cmd, until: now + LAN_PASS_MS });
        if (this._lanPasses.length > 32) this._lanPasses.shift();
    }

    _consumeLanPass(cmd) {
        const now = this.clock.mono();
        this._lanPasses = this._lanPasses.filter(p => p.until > now);
        const i = this._lanPasses.findIndex(p => p.cmd === cmd);
        if (i < 0) return false;
        this._lanPasses.splice(i, 1);
        return true;
    }

    /**
     * A checkpoint resume is about to load its program into the controller.
     * Fail closed: the flag is set now, so even a resume whose load we never
     * observe blocks remote start until a plain load or unload.
     */
    _noteResumeTap() {
        this._resumeProgram = true;
        this._resumeArmUntil = this.clock.mono() + LAN_PASS_MS;
    }

    /** True when the controller holds a checkpoint-resume program, not a plain file. */
    _isResumeProgram(loaded) {
        return this._resumeProgram === true || !!(loaded && loaded.resume);
    }

    /** True when the controller's program is known not to be engine.loadedFile. */
    _programMismatch(loaded) {
        const p = this._program;
        if (!p) return false;
        if (p.unloaded) return true;
        return !loaded || p.name !== loaded.name || p.size !== loaded.size;
    }

    // ─── cloud path ──────────────────────────────────────────────────

    execute(identity, type, args, ctx = {}) {
        const res = this._executeInner(identity, type, args, ctx || {});
        const row = typeof type === 'string' && Object.hasOwn(COMMAND_TABLE, type) ? COMMAND_TABLE[type] : null;
        const isKeepalive = type === 'jog.cont.keepalive';
        if (!(isKeepalive && res.status === 'accepted')) {
            const fields = {
                event: 'cmd',
                type: row ? type : str(type, 40),
                args: row ? sanitize(args) : null,
                status: res.status,
                code: res.code,
                message: res.message,
            };
            if (res.duplicate) fields.duplicate = true;
            this._audit(identity, fields);
        }
        if (row && row.cls !== 'stop' && !isKeepalive && !res.duplicate && identity && identity.kind === 'cloud'
            && typeof ctx.idem === 'string' && ctx.idem.length > 0 && ctx.idem.length <= 40) {
            this._idemStore(identity.userId, ctx.idem, res);
        }
        return res;
    }

    _executeInner(identity, type, rawArgs, ctx) {
        try {
            if (typeof type !== 'string' || !Object.hasOwn(COMMAND_TABLE, type)) return result('rejected', 'UNKNOWN_COMMAND');
            const row = COMMAND_TABLE[type];
            if (!identity || identity.kind !== 'cloud') return result('rejected', 'BAD_ARGS', 'identity');
            if (ctx.cls !== row.cls) return result('rejected', 'BAD_ARGS', 'cls');
            const controllerType = this._controllerType();
            const limits = MachineAdapter.getLimits(controllerType);
            const args = validateArgs(type, rawArgs, limits);
            if (!args) return result('rejected', 'BAD_ARGS');
            const isKeepalive = type === 'jog.cont.keepalive';
            this._noteCloudUser(identity);

            if (row.cls !== 'stop' && !isKeepalive) {
                const cached = this._idemLookup(identity.userId, ctx.idem);
                if (cached) return { ...cached, duplicate: true };
            }

            const seq = ctx.seq;
            if (!Number.isInteger(seq) || seq < 1) return result('rejected', 'BAD_ARGS', 'seq');
            const connKey = typeof identity.connId === 'string' ? identity.connId : '';
            const last = this._replay.get(connKey);
            if (last && seq <= last.seq) return result('rejected', 'REPLAY');
            this._replay.set(connKey, { seq, at: this.clock.mono() });

            const expired = this._checkFreshness(row, ctx);
            if (expired) return expired;
            if (this.isLanOnly()) return result('rejected', 'LOCKED', 'lan-only');

            return this._evaluate('cloud', identity, type, row, args, ctx, controllerType, limits);
        } catch (err) {
            this.logger.error(`[gate] execute ${String(type).slice(0, 40)} failed: ${err && err.message}`);
            return result('failed', 'INTERNAL', 'internal error');
        }
    }

    _checkFreshness(row, ctx) {
        const offset = ctx.relayOffsetMs;
        if (offset === null || offset === undefined || !Number.isFinite(Number(offset))) {
            // Without an offset the TTL cannot be checked. Only stop is exempt:
            // a stale resume or feed change must not slip through the warm-up.
            return row.cls === 'stop' ? null : result('rejected', 'LATENCY_TOO_HIGH', 'clock offset unknown');
        }
        const via = ctx.via || {};
        const relayTs = Number(via.relayTs);
        if (!Number.isFinite(relayTs)) return result('rejected', 'BAD_ARGS', 'relayTs');
        const cap = TTL_MAX[row.cls];
        let ttl = Number(ctx.ttlMs);
        if (!Number.isFinite(ttl) || ttl < 1) ttl = cap;
        ttl = Math.min(ttl, cap);
        const clientRtt = Number(via.clientRttMs);
        const allowance = Math.min((Number.isFinite(clientRtt) ? clientRtt : 0) / 2, 150);
        const ageMs = (this.clock.wall() + Number(offset)) - relayTs;
        if (ageMs > ttl + allowance) return result('rejected', 'EXPIRED');
        return null;
    }

    /**
     * Checks 6-14 shared by cloud (dispatches) and LAN (records only).
     */
    _evaluate(profile, identity, type, row, args, ctx, controllerType, limits) {
        const isKeepalive = type === 'jog.cont.keepalive';
        const now = this.clock.mono();

        if (row.cls !== 'stop' && !isKeepalive) {
            if (row.cls === 'motion') {
                while (this._motionTimes.length && now - this._motionTimes[0] >= 1000) this._motionTimes.shift();
                if (this._motionTimes.length >= MOTION_PER_SEC) return result('rejected', 'RATE_LIMITED');
            }
            if (type === 'jog.step' && now - this._lastStepAt < STEP_SPACING_MS) return result('rejected', 'RATE_LIMITED');
        }

        if (row.cls !== 'stop') {
            const locks = this.getLocks(identity.kind);
            if (locks.length) return result('rejected', 'LOCKED', locks.join(','));
        }

        if (row.tier !== 'any' && TIER_RANK[this.effectiveTier(identity)] < TIER_RANK[row.tier]) {
            return result('rejected', 'TIER_REQUIRED', row.tier);
        }
        // The per-device bucket is checked at step 6 but only charged here, so
        // a locked-out or Monitor-tier identity cannot drain the tokens of the
        // one identity that actually holds Motion.
        if (row.cls === 'motion' && !isKeepalive) this._motionTimes.push(now);

        const caps = MachineAdapter.getCapabilities(controllerType);
        if (row.capability) {
            const cap = caps[row.capability];
            if (!cap || cap === 'none') {
                const unsupportedJog = MachineAdapter.controllerKey(controllerType) === 'RTS'
                    && (row.capability === 'jogStep' || row.capability === 'jogContinuous');
                return result('rejected', 'NOT_SUPPORTED', unsupportedJog ? 'UNSUPPORTED_ON_CONTROLLER' : row.capability);
            }
        }

        if (row.cls === 'motion' && !isKeepalive) {
            if (profile === 'cloud' && (!ctx.linkFresh || !(Number(ctx.effectiveRttMs) <= limits.maxRttMs))) {
                return result('rejected', 'LATENCY_TOO_HIGH');
            }
            if (!(this.telemetry.telemetryAgeMs() <= STALE_MOTION_MS)) return result('rejected', 'STALE_TELEMETRY');
        }

        const handler = this[`_do_${type.replace(/\./g, '_')}`];
        return handler.call(this, profile, identity, args, ctx, controllerType, limits);
    }

    _jobState() {
        return this.telemetry.jobInfo();
    }

    _latchedState() {
        const s = this.telemetry.machineState();
        if (this._motionDispatchedAt !== null) {
            if (this._idleSeenAt !== null && this._idleSeenAt >= this._motionDispatchedAt + LATCH_IDLE_AFTER_MS) {
                this._motionDispatchedAt = null;
            } else if (s === 'idle') {
                return 'jogging';
            }
        }
        return s;
    }

    /** Every gate-originated engine call goes through here (see _selfDispatch). */
    _runSteps(identity, steps) {
        this._selfDispatch += 1;
        try {
            return MachineAdapter.run(this.getEngine(), identity, steps);
        } finally {
            this._selfDispatch -= 1;
        }
    }

    _dispatch(identity, steps) {
        const r = this._runSteps(identity, steps);
        return r.ok ? null : result('failed', 'ENGINE_ERROR', r.error);
    }

    /**
     * The held jog lease is checked before the idle state: the generator's
     * own steps make S non-idle, and JOG_ACTIVE is the answer the user needs.
     */
    _idleMotionPreconditions({ fileOrder = false } = {}) {
        const j = this._jobState();
        const jobBusy = j.active || j.paused;
        if (fileOrder && jobBusy) return result('rejected', 'JOB_ACTIVE');
        if (this.deadman.isActive()) return result('rejected', 'JOG_ACTIVE');
        if (this._latchedState() !== 'idle') return result('rejected', 'NOT_IDLE');
        if (jobBusy) return result('rejected', 'JOB_ACTIVE');
        return null;
    }

    _libraryEntry(libraryId) {
        if (!this.libraryService) return null;
        try {
            return this.libraryService.list().find(m => m && m.id === libraryId) || null;
        } catch (_) {
            return null;
        }
    }

    _isUnreviewedCloud(meta) {
        return !!(meta && meta.provenance && meta.provenance.origin === 'cloud' && !meta.provenance.reviewed);
    }

    _loadedIsUnreviewed() {
        const engine = this.getEngine();
        const loaded = engine && engine.loadedFile;
        if (!loaded || !this.libraryService) return false;
        if (this._remoteLoaded && this._remoteLoaded.loadSeq === this.loadSeq) {
            const meta = this._libraryEntry(this._remoteLoaded.libraryId);
            if (meta) return this._isUnreviewedCloud(meta);
        }
        try {
            return this.libraryService.list().some(m => this._isUnreviewedCloud(m) && m.fileName === loaded.name);
        } catch (_) {
            return false;
        }
    }

    _readBody(meta) {
        let body;
        try {
            body = this.libraryService.getBody(meta.id);
        } catch (_) {
            return { error: result('rejected', 'NO_FILE') };
        }
        if (typeof body !== 'string') return { error: result('rejected', 'NO_FILE') };
        if (Buffer.byteLength(body, 'utf-8') > MAX_BODY_BYTES) return { error: result('rejected', 'BAD_ARGS', 'file too large') };
        return { body };
    }

    // ─── row handlers (checks 11-13) ─────────────────────────────────

    _do_job_stop(profile, identity) {
        this.cancelAllJogs('remote-stop');
        const j = this._jobState();
        const snap = {
            hasController: !!(this.getEngine() && this.getEngine().controller),
            jobActive: j.active,
            jobPaused: j.paused,
            state: this._latchedState(),
            spindleRpm: this.telemetry.lastStatus ? this.telemetry.lastStatus.spindle : 0,
            remoteSpindleOn: !!this.remoteSpindleOn,
        };
        const type = this._controllerType();
        const planned = MachineAdapter.planStop(type, snap);
        this.pause = null;
        this._pendingRemotePause = null;
        if (profile === 'lan') return result('accepted', 'OK', planned.message);
        if (planned.steps.length) {
            const err = this._dispatch(identity, planned.steps);
            if (err) return err;
        }
        if (planned.steps.some(s => s.fn === 'cmd' && s.cmd === 'gcode' && s.args[0] === 'M5')) this.remoteSpindleOn = null;
        if (planned.acted) this._startStopVerification(identity);
        return result('accepted', 'OK', planned.message);
    }

    _do_jog_cont_stop(profile, identity, args) {
        const stopped = this.deadman.stopOwned(identity, args.jogId);
        return result('accepted', 'OK', stopped ? null : 'no-jog');
    }

    _do_tier_dropMotion(profile, identity) {
        this.revokeMotion('remote-drop', identity);
        return result('accepted', 'OK');
    }

    _do_spindle_off(profile, identity) {
        if (this._jobState().active) return result('rejected', 'JOB_ACTIVE', 'use job.stop');
        if (profile === 'lan') return result('accepted', 'OK');
        const err = this._dispatch(identity, MachineAdapter.plan(this._controllerType(), 'spindle.off', {}));
        if (err) return err;
        this.remoteSpindleOn = null;
        return result('accepted', 'OK');
    }

    _do_job_pause(profile, identity) {
        const j = this._jobState();
        if (!j.active) return result('rejected', 'NO_JOB');
        if (j.paused) return result('rejected', 'NOT_RUNNING');
        this._pendingRemotePause = { channel: identity.kind, until: this.clock.mono() + REMOTE_PAUSE_ATTRIBUTION_MS };
        if (profile === 'lan') return result('accepted', 'OK');
        const err = this._dispatch(identity, MachineAdapter.plan(this._controllerType(), 'job.pause', {}));
        if (err) {
            this._pendingRemotePause = null;
            return err;
        }
        // Only a pause actually observed within the window is credited to us
        // (_onPauseObserved). Claiming it here would leave a stale 'remote'
        // origin if the hold never lands, and a later M0/firmware hold would
        // then be resumable remotely.
        return result('accepted', 'OK');
    }

    _do_job_resume(profile, identity) {
        const j = this._jobState();
        if (!j.paused) return result('rejected', 'NOT_PAUSED');
        // The job flag can stay 'paused' after a resume the host never saw
        // (Grbl '~'); a machine that is visibly moving is not held by anyone.
        if (RUNNING_RAW.includes(this.telemetry.rawState() || '')) return result('rejected', 'NOT_PAUSED', 'machine-running');
        if (!this.telemetry.boardLinkOk()) return result('rejected', 'LOCKED', 'board-link-down');
        const p = this.pause;
        if (!p || p.origin !== 'remote' || p.channel !== identity.kind) {
            return result('rejected', 'PAUSE_NOT_REMOTE', p ? p.origin : 'unknown');
        }
        if ((this.telemetry.rawState() || '').startsWith('Door') || this.telemetry.toolchangePending) {
            return result('rejected', 'PAUSE_NOT_REMOTE', this.telemetry.toolchangePending ? 'toolchange' : 'door');
        }
        if (profile === 'lan') return result('accepted', 'OK');
        const err = this._dispatch(identity, MachineAdapter.plan(this._controllerType(), 'job.resume', {}));
        if (err) return err;
        this.pause = null;
        return result('accepted', 'OK');
    }

    _do_feed_override(profile, identity, args) {
        if (profile === 'lan') return result('accepted', 'OK');
        const err = this._dispatch(identity, MachineAdapter.plan(this._controllerType(), 'feed.override', args));
        return err || result('accepted', 'OK');
    }

    _do_job_load(profile, identity, args) {
        const pre = this._idleMotionPreconditions({ fileOrder: true });
        if (pre) return pre;
        const meta = this._libraryEntry(args.libraryId);
        if (!meta) return result('rejected', 'NO_FILE');
        const read = this._readBody(meta);
        if (read.error) return read.error;
        if (this._isUnreviewedCloud(meta)) return result('rejected', 'REVIEW_REQUIRED');
        const steps = MachineAdapter.plan(this._controllerType(), 'job.load', {}, { fileName: meta.fileName, content: read.body });
        const err = this._dispatch(identity, steps);
        if (err) return err;
        this.loadSeq += 1;
        this._remoteLoaded = { libraryId: meta.id, loadSeq: this.loadSeq };
        this._notify();
        return result('accepted', 'OK');
    }

    _do_job_start(profile, identity, args) {
        const pre = this._idleMotionPreconditions({ fileOrder: true });
        if (pre) return pre;
        const engine = this.getEngine();
        let content;
        let meta = null;
        if (profile === 'cloud') {
            const expect = args.expect;
            if (args.libraryId) {
                meta = this._libraryEntry(args.libraryId);
                if (!meta) return result('rejected', 'NO_FILE');
                if (meta.fileName !== expect.name || meta.size !== expect.size || expect.loadSeq !== this.loadSeq) {
                    return result('rejected', 'FILE_CHANGED');
                }
            } else {
                const loaded = engine && engine.loadedFile;
                if (!loaded) return result('rejected', 'NO_FILE');
                if (loaded.name !== expect.name || loaded.size !== expect.size || expect.loadSeq !== this.loadSeq) {
                    return result('rejected', 'FILE_CHANGED');
                }
                // Start runs whatever the controller holds, which a checkpoint
                // resume (or a new controller) can replace underneath
                // engine.loadedFile.
                if (this._programMismatch(loaded)) return result('rejected', 'FILE_CHANGED', 'controller-program');
                // The resume program (preamble + remaining lines) carries the
                // original name; starting it is not a run from the beginning.
                if (this._isResumeProgram(loaded)) return result('rejected', 'FILE_CHANGED', 'resume-program');
            }
            if (expect.wcsSeq !== this.wcsSeq) return result('rejected', 'FILE_CHANGED');
            if (meta ? this._isUnreviewedCloud(meta) : this._loadedIsUnreviewed()) return result('rejected', 'REVIEW_REQUIRED');
            if (meta) {
                const read = this._readBody(meta);
                if (read.error) return read.error;
                content = read.body;
            }
        } else {
            if (!engine || !engine.loadedFile) return result('rejected', 'NO_FILE');
            if (this._programMismatch(engine.loadedFile)) return result('rejected', 'FILE_CHANGED', 'controller-program');
            if (this._isResumeProgram(engine.loadedFile)) return result('rejected', 'FILE_CHANGED', 'resume-program');
            if (this._loadedIsUnreviewed()) return result('rejected', 'REVIEW_REQUIRED');
            this._motionDispatchedAt = this.clock.mono();
            return result('accepted', 'OK');
        }
        const snapshot = meta ? { fileName: meta.fileName, content } : {};
        const steps = MachineAdapter.plan(this._controllerType(), 'job.start', args, snapshot);
        if (meta) {
            const loadErr = this._dispatch(identity, steps.slice(0, 1));
            if (loadErr) return loadErr;
            this.loadSeq += 1;
            this._remoteLoaded = { libraryId: meta.id, loadSeq: this.loadSeq };
        }
        const err = this._dispatch(identity, meta ? steps.slice(1) : steps);
        if (err) return err;
        this._motionDispatchedAt = this.clock.mono();
        this._notify();
        return result('accepted', 'OK');
    }

    _do_jog_step(profile, identity, args) {
        const pre = this._idleMotionPreconditions();
        if (pre) return pre;
        const now = this.clock.mono();
        if (profile === 'lan') {
            this._lastStepAt = now;
            this._motionDispatchedAt = now;
            if (identity.socketId) this._lanJogs.set(identity.socketId, now);
            return result('accepted', 'OK');
        }
        const err = this._dispatch(identity, MachineAdapter.plan(this._controllerType(), 'jog.step', args));
        if (err) return err;
        this._lastStepAt = now;
        this._motionDispatchedAt = now;
        return result('accepted', 'OK');
    }

    _do_jog_cont_start(profile, identity, args) {
        const pre = this._idleMotionPreconditions();
        if (pre) return pre;
        if (profile === 'lan') return result('rejected', 'NOT_SUPPORTED');
        const r = this.deadman.start({ jogId: args.jogId, identity, axis: args.axis, dir: args.dir, feed: args.feed });
        if (!r.ok) return result('rejected', r.code);
        return result('accepted', 'OK');
    }

    _do_jog_cont_keepalive(profile, identity, args, ctx, controllerType, limits) {
        if (!this.deadman.ownedBy(identity) || !this.deadman.lease || this.deadman.lease.jogId !== args.jogId) {
            return result('rejected', 'EXPIRED');
        }
        if (profile === 'cloud' && !(Number(ctx.effectiveRttMs) <= 2 * limits.maxRttMs)) {
            this.deadman.cancel('latency');
            return result('rejected', 'LATENCY_TOO_HIGH');
        }
        const r = this.deadman.keepalive(args.jogId, identity);
        return r.ok ? result('accepted', 'OK') : result('rejected', r.code);
    }

    _do_zero(profile, identity, args) {
        const pre = this._idleMotionPreconditions();
        if (pre) return pre;
        if (profile === 'cloud') {
            const err = this._dispatch(identity, MachineAdapter.plan(this._controllerType(), 'zero', args));
            if (err) return err;
        }
        this.wcsSeq += 1;
        this._motionDispatchedAt = this.clock.mono();
        this._notify();
        return result('accepted', 'OK');
    }

    _do_home(profile, identity, args) {
        if (this._latchedState() !== 'idle') return result('rejected', 'NOT_IDLE');
        if (this._jobState().active) return result('rejected', 'JOB_ACTIVE');
        if (profile === 'lan') return result('rejected', 'NOT_SUPPORTED');
        const err = this._dispatch(identity, MachineAdapter.plan(this._controllerType(), 'home', args));
        if (err) return err;
        this._motionDispatchedAt = this.clock.mono();
        return result('accepted', 'OK');
    }

    _do_spindle_on(profile, identity, args) {
        if (this._latchedState() !== 'idle') return result('rejected', 'NOT_IDLE');
        if (this._jobState().active) return result('rejected', 'JOB_ACTIVE');
        if (this.deadman.isActive()) return result('rejected', 'JOG_ACTIVE');
        if (profile === 'lan') return result('rejected', 'NOT_SUPPORTED');
        const err = this._dispatch(identity, MachineAdapter.plan(this._controllerType(), 'spindle.on', args));
        if (err) return err;
        this.remoteSpindleOn = { identityKind: identity.kind, connId: identity.connId || null, socketId: identity.socketId || null };
        this._motionDispatchedAt = this.clock.mono();
        return result('accepted', 'OK');
    }

    // ─── LAN path ────────────────────────────────────────────────────

    classifyLanCommand(engineCmd) {
        return classifyLanCommand(engineCmd);
    }

    checkLan(identity, engineCmd, rawArgs) {
        const cls = classifyLanCommand(engineCmd);
        const deny = (code, message = null) => ({ ok: false, code, message, tier: cls.tier, gateType: cls.gateType });
        let out;
        try {
            if (!identity || identity.kind !== 'lan') {
                out = deny('BAD_ARGS', 'identity');
            } else if (cls.tier === 'never') {
                out = deny('UNKNOWN_COMMAND');
            } else if (cls.tier === 'monitor') {
                return { ok: true, code: 'OK', message: null, tier: cls.tier, gateType: null };
            } else {
                out = this._checkLanInner(identity, engineCmd, Array.isArray(rawArgs) ? rawArgs : [], cls);
            }
        } catch (err) {
            this.logger.error(`[gate] checkLan ${String(engineCmd).slice(0, 40)} failed: ${err && err.message}`);
            out = deny('INTERNAL');
        }
        this._audit(identity || { kind: 'lan' }, {
            event: 'cmd',
            type: str(engineCmd, 40),
            args: cls.tier === 'never' ? null : sanitize(rawArgs),
            status: out.ok ? 'accepted' : 'rejected',
            code: out.code,
            message: out.message,
        });
        return out;
    }

    _checkLanInner(identity, engineCmd, rawArgs, cls) {
        const type = cls.gateType;
        const row = COMMAND_TABLE[type];
        const controllerType = this._controllerType();
        const limits = MachineAdapter.getLimits(controllerType);
        const wrap = (r) => ({ ok: r.status === 'accepted', code: r.code, message: r.message, tier: cls.tier, gateType: type });
        const bad = (message = null) => ({ ok: false, code: 'BAD_ARGS', message, tier: cls.tier, gateType: type });

        if (row.cls === 'stop') {
            // Stop from a LAN phone is always allowed; the engine handler
            // performs it, the gate only drops remote jogs and pause state.
            this.cancelAllJogs('remote-stop');
            if (engineCmd === 'feedhold') {
                const j = this._jobState();
                if (j.active && !j.paused) {
                    this._pendingRemotePause = { channel: 'lan', until: this.clock.mono() + REMOTE_PAUSE_ATTRIBUTION_MS };
                }
            } else if (engineCmd === 'gcode:stop') {
                this.pause = null;
                this._pendingRemotePause = null;
            }
            this._noteLanPass(engineCmd);
            return { ok: true, code: 'OK', message: null, tier: cls.tier, gateType: type, engineArgs: [] };
        }

        // The LAN filter forwards the phone's own packet to the engine, and
        // several controllers build G-code text from those arguments. So the
        // raw arguments themselves must be exactly the checked shape --
        // checking a normalised copy would let anything else through.
        const lanArgs = this._validateLanArgs(engineCmd, rawArgs, limits);
        if (!lanArgs) return bad();
        const args = lanArgs.gateArgs;
        const pass = (r) => {
            const out = wrap(r);
            out.engineArgs = lanArgs.engineArgs;
            if (out.ok) this._noteLanPass(engineCmd);
            return out;
        };

        if (type === 'job.load') {
            return pass(this._evaluateLanLoad(identity, engineCmd, row, controllerType));
        }
        return pass(this._evaluate('lan', identity, type, row, args, {}, controllerType, limits));
    }

    /**
     * Strict LAN argument check (§7.4 / §9.5). Returns {gateArgs, engineArgs}
     * or null for BAD_ARGS. engineArgs is the canonical packet the engine may
     * be given in place of the phone's (policy should prefer it). Trailing
     * null/undefined arguments are what socket.io makes of an omitted
     * optional parameter and are ignored; anything else extra is refused.
     */
    _validateLanArgs(engineCmd, rawArgs, limits) {
        const list = Array.isArray(rawArgs) ? rawArgs.slice() : [];
        while (list.length && isAbsent(list[list.length - 1])) list.pop();
        const cls = classifyLanCommand(engineCmd);
        switch (cls.gateType) {
            case 'jog.step': {
                if (list.length !== 1) return null;
                const gateArgs = this._mapLanJog(list[0], limits);
                if (!gateArgs) return null;
                // feedRate is forwarded only when the phone sent one, so an
                // omitted feed keeps the controller's own (never faster)
                // default instead of the 1000 mm/min the check assumed.
                const engineJog = { [gateArgs.axis]: gateArgs.distanceMm };
                if (!isAbsent(list[0].feedRate)) engineJog.feedRate = gateArgs.feed;
                return { gateArgs, engineArgs: [engineJog] };
            }
            case 'zero': {
                if (engineCmd === 'wcs:zeroAll') {
                    if (list.length) return null;
                    return { gateArgs: { axes: AXES.slice() }, engineArgs: [] };
                }
                if (list.length > 1) return null;
                const p = list.length ? list[0] : {};
                if (!isPlainObject(p) || !onlyKeys(p, ['axes', 'wcs'])) return null;
                let axes = AXES.slice();
                if (!isAbsent(p.axes)) {
                    if (!Array.isArray(p.axes) || p.axes.length === 0 || p.axes.length > 3) return null;
                    if (!p.axes.every(a => typeof a === 'string' && AXES.includes(a.toLowerCase()))) return null;
                    axes = p.axes.map(a => a.toLowerCase());
                    if (new Set(axes).size !== axes.length) return null;
                }
                const engineParams = { axes };
                if (!isAbsent(p.wcs)) {
                    if (typeof p.wcs !== 'string' || !LAN_ZERO_WCS_RE.test(p.wcs)) return null;
                    engineParams.wcs = p.wcs;
                }
                return { gateArgs: { axes: axes.slice() }, engineArgs: [engineParams] };
            }
            case 'job.start': {
                if (engineCmd === 'gcode:startFromLine') {
                    if (list.length > 1) return null;
                    const line = list.length ? list[0] : 0;
                    if (!isInt(line, 0, Number.MAX_SAFE_INTEGER)) return null;
                    return { gateArgs: {}, engineArgs: [line] };
                }
                if (list.length) return null;
                return { gateArgs: {}, engineArgs: [] };
            }
            case 'feed.override':
                if (list.length) return null;
                return { gateArgs: { action: engineCmd.slice('feedOverride:'.length) }, engineArgs: [] };
            case 'job.pause':
            case 'job.resume':
            case 'job.load':
                if (list.length) return null;
                return { gateArgs: {}, engineArgs: [] };
            default:
                return null;
        }
    }

    _evaluateLanLoad(identity, engineCmd, row, controllerType) {
        const locks = this.getLocks('lan');
        if (locks.length) return result('rejected', 'LOCKED', locks.join(','));
        if (TIER_RANK[this.effectiveTier(identity)] < TIER_RANK.motion) return result('rejected', 'TIER_REQUIRED', 'motion');
        if (!MachineAdapter.getCapabilities(controllerType).load) return result('rejected', 'NOT_SUPPORTED', 'load');
        const j = this._jobState();
        if (engineCmd === 'file:load') {
            if (j.active || j.paused) return result('rejected', 'JOB_ACTIVE');
            if (this.deadman.isActive()) return result('rejected', 'JOG_ACTIVE');
            if (this._latchedState() !== 'idle') return result('rejected', 'NOT_IDLE');
        } else if (j.active || j.paused) {
            return result('rejected', 'JOB_ACTIVE');
        }
        this.loadSeq += 1;
        this._remoteLoaded = null;
        this._notify();
        return result('accepted', 'OK');
    }

    /** LAN `jog` params -> cloud jog.step args, or null for BAD_ARGS (§9.5). */
    _mapLanJog(p, limits) {
        if (!isPlainObject(p)) return null;
        let axis = null;
        let distance = 0;
        for (const key of Object.keys(p)) {
            const v = p[key];
            if (AXES.includes(key)) {
                if (v === undefined || v === null) continue;
                if (typeof v !== 'number' || !Number.isFinite(v)) return null;
                if (v === 0) continue;
                if (axis) return null;
                axis = key;
                distance = v;
            } else if (key === 'feedRate') {
                if (v === undefined || v === null) continue;
                if (!Number.isInteger(v)) return null;
            } else if (key === 'a') {
                if (v !== undefined && v !== null && v !== 0) return null;
            } else if (key === 'units') {
                if (v !== undefined && v !== null && v !== 'G21') return null;
            } else if (key === 'mode') {
                if (v !== undefined && v !== null && v !== 'G91') return null;
            } else {
                // Unknown keys are refused outright: controllers splice
                // parameters into G-code text.
                return null;
            }
        }
        if (!axis) return null;
        const feed = p.feedRate === undefined || p.feedRate === null ? 1000 : p.feedRate;
        return validateArgs('jog.step', { axis, distanceMm: distance, feed }, limits);
    }

    // ─── bookkeeping helpers ─────────────────────────────────────────

    _onJogCancelled(info) {
        const owner = info.identity || {};
        this._audit(owner, {
            event: 'jog.cancel',
            args: { jogId: info.jogId, reason: info.reason, commandedMm: info.commandedMm, progressMm: info.progressMm },
        });
    }

    _spindleAutoOff(reason, predicate) {
        const s = this.remoteSpindleOn;
        if (!s || !predicate(s)) return;
        const j = this._jobState();
        if (j.active) return;
        this.remoteSpindleOn = null;
        const type = this._controllerType();
        if (MachineAdapter.getCapabilities(type).spindle) {
            this._runSteps({ kind: s.identityKind, connId: s.connId, socketId: s.socketId },
                MachineAdapter.plan(type, 'spindle.off', {}));
        }
        this._audit({ kind: 'system' }, { event: 'spindle.auto-off', args: { reason: str(reason, 60) } });
    }

    _startStopVerification(identity) {
        if (this._stopTimer) this.clearTimeoutFn(this._stopTimer);
        this._stopTimer = this.setTimeoutFn(() => {
            this._stopTimer = null;
            const raw = this.telemetry.rawState();
            const pos = this.telemetry.lastTwoPositions();
            let moved = false;
            if (pos.length === 2) {
                moved = AXES.some(a => Math.abs(pos[1][a] - pos[0][a]) > 0.05);
            }
            if (raw === 'Run' || raw === 'Jog' || raw === 'Home' || moved) {
                this._stopUnconfirmedAt = this.clock.wall();
                this._stopUnconfirmedUntil = this.clock.mono() + STOP_UNCONFIRMED_SHOW_MS;
                this._audit(identity, { event: 'stop.unconfirmed', args: { rawState: str(raw, 32), moved } });
                this._notify();
            }
        }, STOP_VERIFY_MS);
        if (this._stopTimer && typeof this._stopTimer.unref === 'function') this._stopTimer.unref();
    }

    _noteCloudUser(identity) {
        if (typeof identity.userId !== 'string' || !USER_ID_RE.test(identity.userId)) return;
        this._recentUsers.set(identity.userId, { userLabel: str(identity.userLabel, 60), lastSeenAt: this.clock.wall() });
        if (this._recentUsers.size > 200) this._recentUsers.delete(this._recentUsers.keys().next().value);
    }

    _idemLookup(userId, idem) {
        if (typeof idem !== 'string' || !idem) return null;
        const bucket = this._idem.get(userId || '');
        if (!bucket) return null;
        const hit = bucket.get(idem);
        if (!hit) return null;
        if (this.clock.mono() - hit.at > IDEM_TTL_MS) {
            bucket.delete(idem);
            return null;
        }
        return { ...hit.res };
    }

    _idemStore(userId, idem, res) {
        const key = userId || '';
        let bucket = this._idem.get(key);
        if (!bucket) {
            bucket = new Map();
            this._idem.set(key, bucket);
        }
        bucket.delete(idem);
        bucket.set(idem, { res: { status: res.status, code: res.code, message: res.message, duplicate: false }, at: this.clock.mono() });
        while (bucket.size > IDEM_MAX) bucket.delete(bucket.keys().next().value);
    }

    _watchdogTick() {
        if (this._disposed) return;
        const now = this.clock.mono();
        if (this.motionGrant && now >= this.motionGrant.untilMono) this._expireIfDue();
        for (const [connId, entry] of this._replay) {
            if (now - entry.at > REPLAY_IDLE_MS) this._replay.delete(connId);
        }
        for (const [userId, bucket] of this._idem) {
            for (const [idem, hit] of bucket) {
                if (now - hit.at > IDEM_TTL_MS) bucket.delete(idem);
            }
            if (!bucket.size) this._idem.delete(userId);
        }
        if (this._stopUnconfirmedAt !== null && now >= this._stopUnconfirmedUntil) {
            this._stopUnconfirmedAt = null;
            this._stopUnconfirmedUntil = null;
            this._notify();
        }
        this._checkLocks();
    }

    _notify() {
        if (this._disposed) return;
        try {
            this._onChange(this.getState('operator'));
        } catch (err) {
            this.logger.warn(`[gate] onChange observer failed: ${err && err.message}`);
        }
        this.emit('change');
    }

    _audit(identity, fields) {
        const id = identity || {};
        const entry = {
            ts: this.clock.wall(),
            kind: str(id.kind, 16),
            userId: str(id.userId, 40),
            userLabel: str(id.userLabel, 60),
            connId: str(id.connId, 40),
            sessionRef: str(id.sessionRef, 40),
        };
        if (id.kind === 'lan') {
            entry.sessionId = id.sessionId ? str(String(id.sessionId), 12) : null;
            entry.socketId = str(id.socketId, 40);
        }
        entry.event = fields.event;
        entry.type = fields.type === undefined ? null : fields.type;
        entry.args = fields.args === undefined ? null : fields.args;
        entry.status = fields.status === undefined ? null : fields.status;
        entry.code = fields.code === undefined ? null : fields.code;
        entry.message = fields.message === undefined || fields.message === null ? null : str(String(fields.message), 200);
        if (fields.duplicate === true) entry.duplicate = true;
        if (this.auditFile) {
            try {
                try {
                    if (fs.statSync(this.auditFile).size > AUDIT_MAX_BYTES) fs.renameSync(this.auditFile, `${this.auditFile}.1`);
                } catch (_) { /* no file yet */ }
                fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
                fs.appendFileSync(this.auditFile, JSON.stringify(entry) + '\n');
            } catch (err) {
                this.logger.warn(`[gate] audit write failed: ${err && err.message}`);
            }
        }
        try { this.logger.info('[remote-audit]', entry); } catch (_) { /* logger */ }
        try { this._onAudit(entry); } catch (_) { /* observer */ }
        this.emit('audit', entry);
        return entry;
    }

    /** Public audit hook for FileIngest / CloudLink (file.*, link.* events). */
    audit(identity, fields) {
        return this._audit(identity, fields);
    }

    dispose() {
        this.deadman.dispose();
        this.telemetry.detach();
        if (this._watchdog) this.clearIntervalFn(this._watchdog);
        this._watchdog = null;
        if (this._grantTimer) this.clearTimeoutFn(this._grantTimer);
        this._grantTimer = null;
        if (this._stopTimer) this.clearTimeoutFn(this._stopTimer);
        this._stopTimer = null;
        if (this.hostLoadMonitor && typeof this.hostLoadMonitor.removeListener === 'function') {
            this.hostLoadMonitor.removeListener('change', this._onHostLoad);
        }
        if (this._ownsMonitor && this.hostLoadMonitor) this.hostLoadMonitor.stop();
        this._disposed = true;
    }
}

module.exports = {
    RemoteCommandGate,
    COMMAND_TABLE,
    TIERS,
    LAN_CLASSIFICATION,
    classifyLanCommand,
    validateArgs,
    grantMatches,
};
