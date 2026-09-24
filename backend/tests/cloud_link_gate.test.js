'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeEngine, createFakeClock, silentLogger } = require('./helpers/fakeEngine');
const { RemoteCommandGate, COMMAND_TABLE, TIERS, createAtomicJsonStore } = require('../services/cloudLink');
const { classifyLanCommand } = require('../services/cloudLink/RemoteCommandGate');
const MachineAdapter = require('../services/cloudLink/MachineAdapter');
const { HostLoadMonitor } = require('../services/cloudLink/HostLoadMonitor');
const { LatencyTracker } = require('../services/cloudLink/LatencyTracker');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-gate-'));
const OP = Object.freeze({ kind: 'operator' });
const USER_A = 'u_aaaaaaaaaaaa';
const USER_B = 'u_bbbbbbbbbbbb';

function cloudId(userId = USER_A, connId = 'k_conn00000001') {
    return { kind: 'cloud', userId, userLabel: 'Sam', role: 'operator', connId, sessionRef: 's3a9f1' };
}

function lanId(socketId = 'sock-1') {
    return { kind: 'lan', sessionId: 'sess1', ip: '192.168.1.20', via: 'pin', socketId };
}

function fakeLibrary(entries = []) {
    const items = entries.map(e => ({ ...e }));
    return {
        items,
        list: () => items.map(e => ({ ...e, provenance: e.provenance || null })),
        get: (id) => items.find(e => e.id === id) || null,
        getBody: (id) => {
            const e = items.find(x => x.id === id);
            if (!e) throw new Error('not found');
            return e.body;
        },
    };
}

function makeGate({ type = 'RSP', library = fakeLibrary(), store = null, dir = null } = {}) {
    const d = dir || fs.mkdtempSync(path.join(tmpRoot, 'g-'));
    const s = store || createAtomicJsonStore(path.join(d, 'cloud-link.json'), {});
    const clock = createFakeClock();
    const engine = new FakeEngine({ controllerType: type });
    const monitor = new HostLoadMonitor({ clock, setIntervalFn: clock.setInterval, clearIntervalFn: clock.clearInterval });
    const audits = [];
    const expired = [];
    const activity = [];
    const lan = { only: false };
    const logger = silentLogger();
    const gate = new RemoteCommandGate({
        store: s,
        logger,
        getEngine: () => engine,
        libraryService: library,
        auditFile: path.join(d, 'remote-audit.jsonl'),
        isLanOnly: () => lan.only,
        onAudit: e => audits.push(e),
        onMotionExpired: e => expired.push(e),
        onJogActivity: j => activity.push(j),
        clock,
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
        setIntervalFn: clock.setInterval,
        clearIntervalFn: clock.clearInterval,
        hostLoadMonitor: monitor,
    });
    gate.attachEngine(engine);
    engine.setStatus({ activeState: 'Idle' });
    const h = { gate, engine, clock, store: s, audits, expired, activity, lan, dir: d, library, monitor, logger, seqs: new Map() };
    h.exec = (identity, type, args = {}, over = {}) => {
        const row = Object.hasOwn(COMMAND_TABLE, type) ? COMMAND_TABLE[type] : null;
        const connId = identity.connId || 'x';
        const seq = over.seq !== undefined ? over.seq : (h.seqs.get(connId) || 0) + 1;
        if (over.seq === undefined) h.seqs.set(connId, seq);
        const via = {
            userId: identity.userId, userLabel: identity.userLabel, role: identity.role, connId,
            sessionRef: identity.sessionRef, relayTs: clock.wall(), clientRttMs: 40, clientSeq: seq, ...(over.via || {}),
        };
        const ctx = {
            via,
            ttlMs: over.ttlMs !== undefined ? over.ttlMs : 500,
            relayOffsetMs: over.relayOffsetMs !== undefined ? over.relayOffsetMs : 0,
            effectiveRttMs: over.effectiveRttMs !== undefined ? over.effectiveRttMs : 100,
            linkFresh: over.linkFresh !== undefined ? over.linkFresh : true,
            cls: over.cls !== undefined ? over.cls : (row ? row.cls : 'motion'),
            idem: over.idem !== undefined ? over.idem : `c_${connId}_${seq}`,
            seq,
        };
        return gate.execute(identity, type, args, ctx);
    };
    h.settle = () => {
        clock.advance(260);
        engine.setStatus({ activeState: 'Idle' });
    };
    h.grantCloud = (userId = null, minutes = 5) => gate.grantMotion(minutes, OP, { channel: 'cloud', userId });
    h.dispose = () => gate.dispose();
    return h;
}

function cmdsOf(h) {
    return h.engine.calls.map(c => [c.cmd, ...c.args]);
}

// ─── rows: allowed paths ──────────────────────────────────────────────

test('job.stop with nothing to stop is accepted (RSP purges jog retransmits only)', () => {
    const h = makeGate();
    const r = h.exec(cloudId(), 'job.stop');
    assert.strictEqual(r.status, 'accepted');
    assert.strictEqual(r.message, 'nothing-to-stop');
    assert.deepStrictEqual(cmdsOf(h), []);
    assert.strictEqual(h.engine.controller.cancelPendingJogsCalls, 1);
    h.dispose();
});

test('jog.cont.stop without a jog -> accepted no-jog; tier.dropMotion drops the grant', () => {
    const h = makeGate();
    assert.deepStrictEqual(h.exec(cloudId(), 'jog.cont.stop', {}), { status: 'accepted', code: 'OK', message: 'no-jog', duplicate: false });
    h.grantCloud();
    assert.strictEqual(h.gate.getState('cloud').tier, 'motion');
    assert.strictEqual(h.exec(cloudId(), 'tier.dropMotion').status, 'accepted');
    assert.strictEqual(h.gate.getState('cloud').tier, 'monitor');
    h.dispose();
});

test('job.pause / job.resume / feed.override dispatch exact engine commands', () => {
    const h = makeGate();
    h.gate.setJobControl('cloud', true, OP);
    h.engine.startJob();
    let r = h.exec(cloudId(), 'job.pause');
    assert.strictEqual(r.status, 'accepted', JSON.stringify(r));
    h.engine.pauseJob();
    assert.strictEqual(h.gate.getTelemetry().pause.origin, 'remote');
    r = h.exec(cloudId(), 'job.resume');
    assert.strictEqual(r.status, 'accepted', JSON.stringify(r));
    r = h.exec(cloudId(), 'feed.override', { action: 'coarsePlus' });
    assert.strictEqual(r.status, 'accepted');
    assert.deepStrictEqual(cmdsOf(h), [['gcode:pause'], ['gcode:resume'], ['feedOverride:coarsePlus']]);
    h.dispose();
});

test('job.load and job.start (RSP: load + startFromLine 0; Grbl: gcode:start)', () => {
    const lib = fakeLibrary([{ id: 'l-1789500000000-abc123', name: 'sign', fileName: 'sign.nc', size: 11, body: 'G0 X1\nG1 Y2' }]);
    const h = makeGate({ library: lib });
    h.grantCloud();
    let r = h.exec(cloudId(), 'job.load', { libraryId: 'l-1789500000000-abc123' });
    assert.strictEqual(r.status, 'accepted', JSON.stringify(r));
    assert.deepStrictEqual(h.engine.fileLoads.map(f => [f.name, f.content]), [['sign.nc', 'G0 X1\nG1 Y2']]);
    assert.strictEqual(h.gate.getTelemetry().file.loadSeq, 1);
    h.settle();
    r = h.exec(cloudId(), 'job.start', {
        libraryId: 'l-1789500000000-abc123', fromBeginning: true,
        expect: { name: 'sign.nc', size: 11, loadSeq: 1, wcsSeq: 0 },
    });
    assert.strictEqual(r.status, 'accepted', JSON.stringify(r));
    // 'gcode:startFresh' -- line 1 or a refusal, never a resume. This used to
    // be ['gcode:startFromLine', 0]; line 0 is outside every file, so the
    // controller rejected it and no remote start ever ran a job.
    assert.deepStrictEqual(cmdsOf(h), [['gcode:startFresh']]);
    assert.strictEqual(h.engine.fileLoads.length, 2);
    h.dispose();

    const g = makeGate({ type: 'Grbl' });
    g.grantCloud();
    g.engine.loadedFile = { name: 'a.nc', total: 3, size: 20 };
    r = g.exec(cloudId(), 'job.start', { fromBeginning: true, expect: { name: 'a.nc', size: 20, loadSeq: 0, wcsSeq: 0 } });
    assert.strictEqual(r.status, 'accepted', JSON.stringify(r));
    assert.deepStrictEqual(cmdsOf(g), [['gcode:start']]);
    g.dispose();
});

test('jog.step, zero, spindle.on/off dispatch exact args (Grbl)', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    assert.strictEqual(h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: -1, feed: 1200 }).status, 'accepted');
    h.settle();
    assert.strictEqual(h.exec(cloudId(), 'zero', { axes: ['x', 'y'] }).status, 'accepted');
    h.settle();
    assert.strictEqual(h.exec(cloudId(), 'spindle.on', { rpm: 12000 }).status, 'accepted');
    h.settle();
    assert.strictEqual(h.exec(cloudId(), 'spindle.off').status, 'accepted');
    assert.deepStrictEqual(cmdsOf(h), [
        ['jog', { x: -1, feedRate: 1200 }],
        ['wcs:zero', { axes: ['x', 'y'] }],
        ['gcode', 'M3 S12000'],
        ['gcode', 'M5'],
    ]);
    assert.strictEqual(h.gate.getTelemetry().wcsSeq, 1);
    h.dispose();
});

test('jog.cont.start issues bounded jog steps; keepalive accepted and not audited', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    const r = h.exec(cloudId(), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'y', dir: -1, feed: 600 });
    assert.strictEqual(r.status, 'accepted', JSON.stringify(r));
    assert.deepStrictEqual(cmdsOf(h)[0], ['jog', { y: -2, feedRate: 600 }]);
    const before = h.audits.length;
    assert.strictEqual(h.exec(cloudId(), 'jog.cont.keepalive', { jogId: 'j_abcdef' }).status, 'accepted');
    assert.strictEqual(h.audits.length, before);
    assert.strictEqual(h.gate.getState('cloud').activeJog.jogId, 'j_abcdef');
    h.dispose();
});

test('home is NOT_SUPPORTED on every controller; spindle on RSP NOT_SUPPORTED', () => {
    for (const type of ['RSP', 'Grbl', 'GrblHAL', 'FluidNC', 'RTS', 'Generic']) {
        const h = makeGate({ type });
        h.grantCloud();
        assert.strictEqual(h.exec(cloudId(), 'home', { axis: 'all' }).code, 'NOT_SUPPORTED', type);
        h.dispose();
    }
    const h = makeGate({ type: 'RSP' });
    h.grantCloud();
    assert.strictEqual(h.exec(cloudId(), 'spindle.on', { rpm: 1000 }).code, 'NOT_SUPPORTED');
    assert.strictEqual(h.exec(cloudId(), 'spindle.off').code, 'NOT_SUPPORTED');
    h.dispose();
});

// ─── preconditions ────────────────────────────────────────────────────

test('job preconditions: NO_JOB, NOT_RUNNING, NOT_PAUSED', () => {
    const h = makeGate();
    h.gate.setJobControl('cloud', true, OP);
    assert.strictEqual(h.exec(cloudId(), 'job.pause').code, 'NO_JOB');
    assert.strictEqual(h.exec(cloudId(), 'job.resume').code, 'NOT_PAUSED');
    h.engine.startJob();
    h.engine.pauseJob();
    assert.strictEqual(h.exec(cloudId(), 'job.pause').code, 'NOT_RUNNING');
    h.dispose();
});

test('motion preconditions: NOT_IDLE, JOB_ACTIVE, NO_FILE, JOG_ACTIVE, spindle JOB_ACTIVE', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    h.engine.setStatus({ activeState: 'Run' });
    assert.strictEqual(h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }).code, 'NOT_IDLE');
    h.engine.setStatus({ activeState: 'Idle' });
    h.engine.controller.job.active = true;
    assert.strictEqual(h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }).code, 'JOB_ACTIVE');
    assert.strictEqual(h.exec(cloudId(), 'job.load', { libraryId: 'l-1789500000000-zzz' }).code, 'JOB_ACTIVE');
    assert.strictEqual(h.exec(cloudId(), 'spindle.on', { rpm: 100 }).code, 'JOB_ACTIVE');
    assert.strictEqual(h.exec(cloudId(), 'spindle.off').code, 'JOB_ACTIVE');
    h.engine.controller.job.active = false;
    assert.strictEqual(h.exec(cloudId(), 'job.load', { libraryId: 'l-1789500000000-zzz' }).code, 'NO_FILE');
    assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: { name: 'a', size: 1, loadSeq: 0, wcsSeq: 0 } }).code, 'NO_FILE');
    assert.strictEqual(h.exec(cloudId(), 'jog.cont.keepalive', { jogId: 'j_nothere' }).code, 'EXPIRED');
    h.exec(cloudId(), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 300 });
    assert.strictEqual(h.exec(cloudId(USER_A, 'k_conn00000002'), 'jog.cont.start', { jogId: 'j_second', axis: 'x', dir: 1, feed: 300 }).code, 'JOG_ACTIVE');
    assert.strictEqual(h.exec(cloudId(), 'job.load', { libraryId: 'l-1789500000000-zzz' }).code, 'JOG_ACTIVE');
    h.dispose();
});

test('args are strict: unknown keys, wrong types and out-of-range -> BAD_ARGS', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    const bad = [
        ['job.stop', { force: true }],
        ['jog.step', { axis: 'x', distanceMm: 11, feed: 100 }],
        ['jog.step', { axis: 'x', distanceMm: 0.0001, feed: 100 }],
        ['jog.step', { axis: 'x', distanceMm: 1, feed: 3001 }],
        ['jog.step', { axis: 'a', distanceMm: 1, feed: 100 }],
        ['jog.step', { axis: 'x', distanceMm: '1', feed: 100 }],
        ['jog.step', { axis: 'x', distanceMm: 1, feed: 100, y: 1 }],
        ['jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 2, feed: 100 }],
        ['jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 1501 }],
        ['zero', { axes: [] }],
        ['zero', { axes: ['x', 'x'] }],
        ['spindle.on', { rpm: 24001 }],
        ['feed.override', { action: 'max' }],
        ['job.load', { libraryId: '../../etc' }],
        ['job.start', { fromBeginning: false, expect: { name: 'a', size: 1, loadSeq: 0, wcsSeq: 0 } }],
        ['job.start', { fromBeginning: true, expect: { name: 'a', size: 1, loadSeq: 0 } }],
    ];
    for (const [type, args] of bad) {
        assert.strictEqual(h.exec(cloudId(), type, args).code, 'BAD_ARGS', `${type} ${JSON.stringify(args)}`);
    }
    assert.deepStrictEqual(h.engine.calls, []);
    h.dispose();
});

// ─── tier state machine ───────────────────────────────────────────────

test('grant, replace, expiry by fake clock, and restart -> monitor', () => {
    const h = makeGate();
    assert.throws(() => h.gate.grantMotion(5, cloudId(), { channel: 'cloud' }), /operator_only/);
    assert.throws(() => h.gate.grantMotion(7, OP, { channel: 'cloud' }), /bad_duration/);
    assert.throws(() => h.gate.grantMotion(5, OP, { channel: 'cloud', userId: 'bob' }), /bad_scope/);
    assert.throws(() => h.gate.grantMotion(5, OP, { channel: 'moon' }), /bad_scope/);
    h.gate.grantMotion(5, OP, { channel: 'cloud' });
    let st = h.gate.getState('cloud');
    assert.strictEqual(st.tier, 'motion');
    assert.strictEqual(st.motionRemainingMs, 300000);
    h.gate.grantMotion(15, OP, { channel: 'cloud', userId: USER_A });
    st = h.gate.getState('operator');
    assert.strictEqual(st.motionRemainingMs, 900000);
    assert.deepStrictEqual({ channel: st.scope.motion.channel, userId: st.scope.motion.userId }, { channel: 'cloud', userId: USER_A });
    h.clock.advance(900000);
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.gate.getState('cloud').tier, 'monitor');
    assert.strictEqual(h.expired.length, 1);
    assert.strictEqual(h.expired[0].channel, 'cloud');
    assert.ok(h.audits.some(a => a.event === 'tier.motion.expire'));

    h.gate.setJobControl('cloud', true, OP);
    h.gate.grantMotion(5, OP, { channel: 'cloud' });
    const store = h.store;
    const dir = h.dir;
    h.dispose();
    const again = makeGate({ store, dir });
    const s2 = again.gate.getState('cloud');
    assert.strictEqual(s2.tier, 'job', 'job control persists (D3), motion never does');
    assert.strictEqual(s2.motionRemainingMs, null);
    again.dispose();
});

test('replacing a grant with a scope that no longer matches cancels the jog (tier)', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud(USER_A);
    h.exec(cloudId(USER_A), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 300 });
    assert.ok(h.gate.isJogActive());
    h.gate.grantMotion(5, OP, { channel: 'cloud', userId: USER_B });
    assert.ok(!h.gate.isJogActive());
    assert.strictEqual(h.audits.filter(a => a.event === 'jog.cancel').pop().args.reason, 'tier');
    h.dispose();
});

test('revoke by alarm, by disconnect lock, by controller rebind and by job-control off', () => {
    let h = makeGate();
    h.grantCloud();
    h.engine.emitAlarm();
    assert.strictEqual(h.gate.getState('cloud').tier, 'monitor');
    assert.throws(() => h.grantCloud(), /locked/);
    h.clock.advance(10);
    h.engine.setStatus({ activeState: 'Idle' });
    h.grantCloud();
    assert.strictEqual(h.gate.getState('cloud').tier, 'motion');
    h.dispose();

    h = makeGate();
    h.grantCloud();
    h.engine.connected = false;
    h.clock.advance(1000);
    assert.strictEqual(h.gate.getState('cloud').tier, 'monitor');
    assert.ok(h.gate.getState('cloud').locks.includes('disconnected'));
    h.dispose();

    h = makeGate();
    h.grantCloud();
    h.engine.bindNewController('RSP');
    assert.strictEqual(h.gate.getState('cloud').tier, 'monitor');
    assert.ok(h.audits.some(a => a.event === 'tier.motion.revoke' && a.args.reason === 'controller-changed'));
    h.dispose();

    h = makeGate();
    h.gate.setJobControl('cloud', true, OP);
    h.grantCloud();
    h.gate.setJobControl('lan', false, OP);
    assert.strictEqual(h.gate.getState('cloud').tier, 'motion', 'other channel untouched');
    h.gate.setJobControl('cloud', false, OP);
    assert.strictEqual(h.gate.getState('cloud').tier, 'monitor');
    assert.throws(() => h.gate.setJobControl('cloud', true, cloudId()), /operator_only/);
    h.dispose();
});

test('locks allow only stop-class commands', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.engine.startJob();
    h.engine.emitAlarm();
    assert.strictEqual(h.exec(cloudId(), 'job.pause').code, 'LOCKED');
    assert.strictEqual(h.exec(cloudId(), 'job.pause').message, 'alarm');
    assert.strictEqual(h.exec(cloudId(), 'feed.override', { action: 'reset' }).code, 'LOCKED');
    assert.strictEqual(h.exec(cloudId(), 'job.stop').status, 'accepted');
    assert.strictEqual(h.exec(cloudId(), 'tier.dropMotion').status, 'accepted');
    assert.strictEqual(h.exec(cloudId(), 'jog.cont.stop', {}).status, 'accepted');
    h.dispose();
});

// ─── job.stop per controller ──────────────────────────────────────────

test('job.stop branches per controller type (§9.2.4)', () => {
    const cases = [
        { type: 'RSP', setup: h => h.engine.startJob(), expect: [['feedhold'], ['gcode:stop']], message: 'job-stopped' },
        { type: 'RSP', setup: h => { h.engine.startJob(); h.engine.pauseJob(); }, expect: [['gcode:stop']], message: 'job-stopped' },
        { type: 'Grbl', setup: h => h.engine.startJob(), expect: [['gcode:stop']], message: 'job-stopped' },
        { type: 'RTS', setup: h => h.engine.startJob(), expect: [['gcode:stop']], message: 'job-stopped' },
        { type: 'Generic', setup: h => h.engine.startJob(), expect: [['feedhold']], message: 'job-stopped' },
        { type: 'Grbl', setup: h => h.engine.setStatus({ activeState: 'Jog' }), expect: [['jogcancel']], message: 'motion-halted' },
        { type: 'GrblHAL', setup: h => h.engine.setStatus({ activeState: 'Home' }), expect: [['feedhold']], message: 'motion-halted' },
        { type: 'RSP', setup: h => h.engine.setStatus({ activeState: 'Jog' }), expect: [], message: 'rsp-cannot-cancel: use the machine E-stop' },
        { type: 'Generic', setup: h => h.engine.setStatus({ activeState: 'Run' }), expect: [['feedhold']], message: 'motion-halted' },
    ];
    for (const c of cases) {
        const h = makeGate({ type: c.type });
        c.setup(h);
        const r = h.exec(cloudId(), 'job.stop');
        assert.strictEqual(r.status, 'accepted', c.type);
        assert.strictEqual(r.message, c.message, `${c.type} message`);
        assert.deepStrictEqual(cmdsOf(h), c.expect, `${c.type} ${c.message}`);
        if (c.type === 'RSP') assert.ok(h.engine.controller.cancelPendingJogsCalls >= 1);
        h.dispose();
    }
    const h = makeGate();
    h.engine.controller = null;
    assert.strictEqual(h.exec(cloudId(), 'job.stop').message, 'no-controller');
    h.dispose();
});

test('job.stop is never rate limited, de-duplicated, tier- or offset-gated', () => {
    const h = makeGate({ type: 'Grbl' });
    for (let i = 0; i < 5; i++) {
        const r = h.exec(cloudId(), 'job.stop', {}, { idem: 'c_same', relayOffsetMs: null });
        assert.strictEqual(r.status, 'accepted');
        assert.strictEqual(r.duplicate, false);
    }
    h.grantCloud();
    for (let i = 0; i < 25; i++) h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 });
    assert.strictEqual(h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }).code, 'RATE_LIMITED');
    assert.strictEqual(h.exec(cloudId(), 'job.stop').status, 'accepted');
    h.dispose();
});

// ─── invariant fuzz (§5.9) ────────────────────────────────────────────

test('fuzz: only frozen engine commands are ever dispatched; unknown types dispatch nothing', () => {
    const lib = fakeLibrary([{ id: 'l-1789500000000-abc123', name: 'a', fileName: 'a.nc', size: 5, body: 'G0 X1' }]);
    const h = makeGate({ type: 'Grbl', library: lib });
    const observed = [];
    h.engine._handleCommand = function (socket, port, cmd, ...args) { observed.push([cmd, ...args]); };
    h.gate.setJobControl('cloud', true, OP);
    h.grantCloud();
    const weird = [
        'gcode', 'command:raw', 'write', 'writeln', 'config:set', 'config:get', 'config:getAll', 'firmware:flash',
        'macro:run', 'macro:save', 'unlock', 'reset', 'estop', 'estop:clear', 'limit:clear', 'motor:reset',
        'safety:remoteDiagToggle', 'open', 'close', 'probe', 'probe:z', 'remote:pin', 'settings', '__proto__',
        'constructor', 'toString', 'hasOwnProperty', 'homing', 'homing:x', 'homing:X', 'jog', 'jog:safe',
        'jogcancel', 'feedhold', 'cyclestart', 'gcode:start', 'gcode:stop', 'gcode:load', 'gcode:unload',
        'wcs:zero', 'wcs:zeroAll', 'file:load', 'file:unload', 'job.delete', 'library.delete', 'cloud.admin',
        'tier.grantMotion', 'tier.setJobControl', 'spindle', 'coolant:flood', 'toolchange:confirm', 'debug:enable',
        'trigger:set', 'rtc.offer', 'e2e.hello', 'job', 'job.', '.stop', 'JOB.STOP', 'job.stop ', '', 'x'.repeat(500),
        'feedOverride:coarsePlus', 'access.code', 'pin.set',
    ];
    assert.ok(weird.length >= 60);
    for (const type of weird) {
        for (const cls of ['stop', 'job', 'motion', 'monitor']) {
            const r = h.exec(cloudId(), type, { cmd: 'M3 S1000', gcode: '$X' }, { cls });
            assert.strictEqual(r.code, 'UNKNOWN_COMMAND', type);
        }
    }
    assert.deepStrictEqual(observed, []);
    for (const t of [42, null, undefined, {}, ['job.stop']]) {
        assert.strictEqual(h.gate.execute(cloudId(), t, {}, { cls: 'stop' }).code, 'UNKNOWN_COMMAND');
    }

    const pollution = [
        JSON.parse('{"__proto__":{"polluted":1}}'),
        JSON.parse('{"constructor":{"prototype":{"polluted":1}}}'),
        { axis: 'x', distanceMm: 1, feed: 100, __proto__: { polluted: 1 } },
        JSON.parse('{"axis":"x","distanceMm":1,"feed":100,"__proto__":{"isAdmin":true}}'),
        JSON.parse('{"axes":["x"],"__proto__":{"axes":["x","y","z"]}}'),
        [], 'string', 7, null, Object.create({ axis: 'x', distanceMm: 1, feed: 100 }),
    ];
    for (const type of Object.keys(COMMAND_TABLE)) {
        for (const args of pollution) {
            h.settle();
            h.exec(cloudId(), type, args);
        }
    }
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(({}).isAdmin, undefined);
    for (const [cmd, ...args] of observed) {
        assert.ok(MachineAdapter.ALLOWED_CMDS.includes(cmd), `unexpected ${cmd}`);
        assert.ok(cmd !== 'homing:x' && cmd !== 'homing:y' && cmd !== 'homing:z');
        if (cmd === 'gcode') assert.ok(/^M3 S\d{1,5}$/.test(args[0]) || /^M5$/.test(args[0]), args[0]);
    }
    assert.throws(() => MachineAdapter.plan('Grbl', 'gcode', { line: '$X' }), /NOT_SUPPORTED/);
    assert.strictEqual(MachineAdapter.run(h.engine, cloudId(), [{ fn: 'cmd', cmd: 'unlock', args: [] }]).ok, false);
    assert.strictEqual(MachineAdapter.run(h.engine, cloudId(), [{ fn: 'cmd', cmd: 'gcode', args: ['G0 X100'] }]).ok, false);
    h.dispose();
});

test('identity kind and cls checks: operator/lan -> BAD_ARGS, cls mismatch -> BAD_ARGS', () => {
    const h = makeGate();
    assert.strictEqual(h.gate.execute(OP, 'job.stop', {}, { cls: 'stop' }).code, 'BAD_ARGS');
    assert.strictEqual(h.gate.execute(lanId(), 'job.stop', {}, { cls: 'stop' }).code, 'BAD_ARGS');
    assert.strictEqual(h.gate.execute({ kind: 'local' }, 'job.stop', {}, { cls: 'stop' }).code, 'BAD_ARGS');
    assert.strictEqual(h.gate.checkLan(OP, 'gcode:stop', []).code, 'BAD_ARGS');
    assert.strictEqual(h.gate.checkLan(cloudId(), 'gcode:stop', []).code, 'BAD_ARGS');
    assert.strictEqual(h.exec(cloudId(), 'job.stop', {}, { cls: 'monitor' }).code, 'BAD_ARGS');
    assert.strictEqual(h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }, { cls: 'job' }).code, 'BAD_ARGS');
    assert.deepStrictEqual(h.engine.calls, []);
    h.dispose();
});

test('replay, TTL with offset, idem duplicate carries no second dispatch', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.engine.startJob();
    const id = cloudId();
    assert.strictEqual(h.exec(id, 'feed.override', { action: 'reset' }, { seq: 5 }).status, 'accepted');
    assert.strictEqual(h.exec(id, 'feed.override', { action: 'reset' }, { seq: 5, idem: 'c_other1' }).code, 'REPLAY');
    assert.strictEqual(h.exec(id, 'feed.override', { action: 'reset' }, { seq: 4, idem: 'c_other2' }).code, 'REPLAY');
    // relay clock 2 s ahead of machine wall: relayTs is "now" on the relay
    const relayNow = h.clock.wall() + 2000;
    assert.strictEqual(h.exec(id, 'feed.override', { action: 'reset' }, { seq: 6, idem: 'c_t1', relayOffsetMs: 2000, via: { relayTs: relayNow } }).status, 'accepted');
    assert.strictEqual(h.exec(id, 'feed.override', { action: 'reset' }, { seq: 7, idem: 'c_t2', relayOffsetMs: 0, via: { relayTs: relayNow - 8000 } }).code, 'EXPIRED');
    // job TTL max is 5000 even if a larger ttl is claimed
    assert.strictEqual(h.exec(id, 'feed.override', { action: 'reset' }, { seq: 8, idem: 'c_t3', ttlMs: 60000, via: { relayTs: h.clock.wall() - 5300 } }).code, 'EXPIRED');

    const calls = h.engine.calls.length;
    const first = h.exec(id, 'feed.override', { action: 'finePlus' }, { seq: 9, idem: 'c_dup' });
    const dup = h.exec(id, 'feed.override', { action: 'finePlus' }, { seq: 10, idem: 'c_dup' });
    assert.strictEqual(first.duplicate, false);
    assert.strictEqual(dup.duplicate, true);
    assert.strictEqual(dup.status, first.status);
    assert.strictEqual(h.engine.calls.length, calls + 1);
    h.dispose();
});

test('keepalives are never de-duplicated or rate limited', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    h.exec(cloudId(), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 300 });
    for (let i = 0; i < 60; i++) {
        const r = h.exec(cloudId(), 'jog.cont.keepalive', { jogId: 'j_abcdef' }, { idem: 'c_same' });
        assert.strictEqual(r.status, 'accepted', `${i} ${r.code}`);
        assert.strictEqual(r.duplicate, false);
    }
    h.dispose();
});

test('latency guard: 301 ms, unknown offset, null client RTT, stale telemetry', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    const step = { axis: 'x', distanceMm: 1, feed: 100 };
    assert.strictEqual(h.exec(cloudId(), 'jog.step', step, { effectiveRttMs: 301 }).code, 'LATENCY_TOO_HIGH');
    assert.strictEqual(h.exec(cloudId(), 'jog.step', step, { relayOffsetMs: null }).code, 'LATENCY_TOO_HIGH');
    assert.strictEqual(h.exec(cloudId(), 'job.stop', {}, { relayOffsetMs: null }).status, 'accepted');
    const lt = new LatencyTracker({ clock: h.clock });
    assert.strictEqual(lt.effectiveRtt({ clientRttMs: null }), Infinity);
    assert.strictEqual(h.exec(cloudId(), 'jog.step', step, { effectiveRttMs: lt.effectiveRtt({ clientRttMs: null }) }).code, 'LATENCY_TOO_HIGH');
    assert.strictEqual(h.exec(cloudId(), 'jog.step', step, { linkFresh: false }).code, 'LATENCY_TOO_HIGH');
    h.clock.advance(1600);
    assert.strictEqual(h.exec(cloudId(), 'jog.step', step).code, 'STALE_TELEMETRY');
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.exec(cloudId(), 'jog.step', step).status, 'accepted');
    h.dispose();
});

// ─── scopes ───────────────────────────────────────────────────────────

test('scopes: LAN-scoped motion, user-scoped cloud motion, per-channel job control', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.grantMotion(5, OP, { channel: 'lan' });
    assert.strictEqual(h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }).code, 'TIER_REQUIRED');
    assert.strictEqual(h.gate.checkLan(lanId(), 'jog', [{ x: 5, feedRate: 500 }]).ok, true);
    assert.strictEqual(h.gate.getState('lan').tier, 'motion');
    assert.strictEqual(h.gate.getState('cloud').tier, 'monitor');

    h.gate.grantMotion(5, OP, { channel: 'cloud', userId: USER_A });
    h.settle();
    assert.strictEqual(h.exec(cloudId(USER_B, 'k_connbbbbbbbb'), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }).code, 'TIER_REQUIRED');
    assert.strictEqual(h.exec(cloudId(USER_A), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }).status, 'accepted');
    assert.strictEqual(h.gate.getState('lan').scope.motion.userId, null, 'LAN view never sees relay user ids');
    assert.strictEqual(h.gate.getState('cloud').scope.motion.userId, USER_A);
    h.gate.revokeMotion('test', OP);

    h.gate.setJobControl('lan', true, OP);
    h.engine.startJob();
    assert.strictEqual(h.exec(cloudId(), 'job.pause').code, 'TIER_REQUIRED');
    assert.strictEqual(h.gate.checkLan(lanId(), 'gcode:pause', []).ok, true);
    assert.strictEqual(h.gate.getState('lan').jobControlEnabled, true);
    assert.strictEqual(h.gate.getState('cloud').jobControlEnabled, false);
    h.dispose();
});

// ─── pause provenance ─────────────────────────────────────────────────

test('pause provenance: remote ok; local, toolchange, door, program and LAN pauses refuse cloud resume', () => {
    const setup = (type = 'Grbl') => {
        const h = makeGate({ type });
        h.gate.setJobControl('cloud', true, OP);
        h.gate.setJobControl('lan', true, OP);
        h.engine.startJob();
        return h;
    };
    let h = setup();
    h.gate.onLocalCommand('command', ['/dev/ttyUSB0', 'gcode:pause']);
    h.engine.pauseJob();
    let r = h.exec(cloudId(), 'job.resume');
    assert.deepStrictEqual([r.code, r.message], ['PAUSE_NOT_REMOTE', 'local']);
    h.dispose();

    h = setup();
    h.exec(cloudId(), 'job.pause');
    h.engine.controller.emit('toolchange:start', { tool: 2 });
    h.engine.pauseJob();
    r = h.exec(cloudId(), 'job.resume');
    assert.strictEqual(r.code, 'PAUSE_NOT_REMOTE');
    assert.strictEqual(h.gate.getTelemetry().pause.origin, 'toolchange');
    h.dispose();

    h = setup();
    h.exec(cloudId(), 'job.pause');
    h.engine.pauseJob();
    h.engine.setStatus({ activeState: 'Door:1' });
    r = h.exec(cloudId(), 'job.resume');
    assert.strictEqual(r.code, 'PAUSE_NOT_REMOTE');
    h.dispose();

    h = setup();
    h.clock.advance(100);
    h.engine.pauseJob();
    r = h.exec(cloudId(), 'job.resume');
    assert.deepStrictEqual([r.code, r.message], ['PAUSE_NOT_REMOTE', 'program']);
    h.dispose();

    h = setup();
    assert.strictEqual(h.gate.checkLan(lanId(), 'gcode:pause', []).ok, true);
    h.engine.pauseJob();
    assert.strictEqual(h.gate.getTelemetry().pause.origin, 'remote');
    assert.strictEqual(h.exec(cloudId(), 'job.resume').code, 'PAUSE_NOT_REMOTE');
    assert.strictEqual(h.gate.checkLan(lanId(), 'cyclestart', []).ok, true);
    h.dispose();
});

test('pause provenance: a remote pause that never lands is not inherited by a later program hold', () => {
    for (const type of ['Grbl', 'RSP']) {
        const h = makeGate({ type });
        h.gate.setJobControl('cloud', true, OP);
        h.engine.startJob();
        assert.strictEqual(h.exec(cloudId(), 'job.pause').status, 'accepted');
        assert.strictEqual(h.gate.getTelemetry().pause, null, 'not credited before a pause is observed');
        h.clock.advance(3000);
        h.engine.setStatus({ activeState: 'Run' });
        h.engine.pauseJob();
        h.engine.setStatus({ activeState: 'Hold' });
        const r = h.exec(cloudId(), 'job.resume');
        assert.deepStrictEqual([r.code, r.message], ['PAUSE_NOT_REMOTE', 'program'], type);
        h.dispose();
    }

    // an observed remote pause whose resume was never seen does not carry over to the next hold
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.engine.startJob();
    h.exec(cloudId(), 'job.pause');
    h.engine.pauseJob();
    assert.strictEqual(h.gate.getTelemetry().pause.origin, 'remote');
    // resumed from a path the gate never observed
    h.engine._jobPaused = false;
    h.engine.controller.workflow = 'running';
    h.engine.setStatus({ activeState: 'Run' });
    h.clock.advance(5000);
    h.engine.setStatus({ activeState: 'Run' });
    h.engine.pauseJob();
    const r = h.exec(cloudId(), 'job.resume');
    assert.deepStrictEqual([r.code, r.message], ['PAUSE_NOT_REMOTE', 'program']);
    h.dispose();
});

// ─── spindle safety ───────────────────────────────────────────────────

test('remote spindle is switched off on link down, client gone, expiry and revoke', () => {
    const scenarios = [
        ['link down', h => h.gate.onLinkDown('cloud')],
        ['client gone', h => h.gate.onClientGone('k_conn00000001')],
        ['expiry', h => { h.clock.advance(5 * 60000); }],
        ['revoke', h => h.gate.revokeMotion('operator', OP)],
    ];
    for (const [name, trigger] of scenarios) {
        const h = makeGate({ type: 'Grbl' });
        h.grantCloud();
        assert.strictEqual(h.exec(cloudId(), 'spindle.on', { rpm: 8000 }).status, 'accepted');
        trigger(h);
        assert.deepStrictEqual(cmdsOf(h).pop(), ['gcode', 'M5'], name);
        assert.ok(h.audits.some(a => a.event === 'spindle.auto-off'), name);
        h.dispose();
    }
    const h = makeGate({ type: 'Grbl' });
    h.engine.emitAlarm();
    assert.strictEqual(h.exec(cloudId(), 'spindle.off').status, 'accepted', 'spindle.off while locked at Monitor');
    h.engine.setStatus({ activeState: 'Idle', spindle: 12000 });
    h.engine.calls.length = 0;
    const r = h.exec(cloudId(), 'job.stop');
    assert.strictEqual(r.message, 'spindle-off');
    assert.deepStrictEqual(cmdsOf(h), [['gcode', 'M5']]);
    h.dispose();
});

// ─── local activity and latch ─────────────────────────────────────────

test('operator activity cancels remote jog, locks remote motion 5 s; motion-pending latch', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    h.exec(cloudId(), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 300 });
    h.gate.onLocalCommand('command', ['COM3', 'jog', { x: 1 }]);
    assert.ok(!h.gate.isJogActive());
    assert.strictEqual(h.audits.filter(a => a.event === 'jog.cancel').pop().args.reason, 'operator-activity');
    const r = h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 });
    assert.deepStrictEqual([r.code, r.message], ['LOCKED', 'local-activity']);
    h.clock.advance(5001);
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 }).status, 'accepted');
    h.clock.advance(200);
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.exec(cloudId(), 'zero', { axes: ['z'] }).code, 'NOT_IDLE', 'Idle only 200 ms after dispatch');
    h.clock.advance(60);
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.exec(cloudId(), 'zero', { axes: ['z'] }).status, 'accepted');
    h.dispose();
});

// ─── file identity ────────────────────────────────────────────────────

test('job.start FILE_CHANGED for stale expect; REVIEW_REQUIRED for unreviewed cloud uploads', () => {
    const lib = fakeLibrary([
        { id: 'l-1789500000000-aaa111', name: 'a', fileName: 'a.nc', size: 5, body: 'G0 X1' },
        { id: 'l-1789500000000-bbb222', name: 'b', fileName: 'b.nc', size: 5, body: 'G0 X2', provenance: { origin: 'cloud', reviewed: false } },
    ]);
    const h = makeGate({ library: lib });
    h.grantCloud();
    h.engine.loadedFile = { name: 'a.nc', total: 1, size: 5 };
    const base = { name: 'a.nc', size: 5, loadSeq: 0, wcsSeq: 0 };
    for (const change of [{ name: 'b.nc' }, { size: 6 }, { loadSeq: 3 }, { wcsSeq: 1 }]) {
        const r = h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: { ...base, ...change } });
        assert.strictEqual(r.code, 'FILE_CHANGED', JSON.stringify(change));
    }
    assert.strictEqual(h.exec(cloudId(), 'job.start', { libraryId: 'l-1789500000000-aaa111', fromBeginning: true, expect: { ...base, loadSeq: 1 } }).code, 'FILE_CHANGED');
    assert.strictEqual(h.exec(cloudId(), 'job.load', { libraryId: 'l-1789500000000-bbb222' }).code, 'REVIEW_REQUIRED');
    assert.strictEqual(h.exec(cloudId(), 'job.start', { libraryId: 'l-1789500000000-bbb222', fromBeginning: true, expect: { name: 'b.nc', size: 5, loadSeq: 0, wcsSeq: 0 } }).code, 'REVIEW_REQUIRED');
    h.engine.loadedFile = { name: 'b.nc', total: 1, size: 5 };
    assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: { name: 'b.nc', size: 5, loadSeq: 0, wcsSeq: 0 } }).code, 'REVIEW_REQUIRED');
    assert.strictEqual(h.gate.checkLan(lanId(), 'gcode:start', []).code, 'TIER_REQUIRED');
    h.gate.grantMotion(5, OP, { channel: 'lan' });
    assert.strictEqual(h.gate.checkLan(lanId(), 'gcode:start', []).code, 'REVIEW_REQUIRED');
    assert.deepStrictEqual(h.engine.calls, []);
    assert.deepStrictEqual(h.engine.fileLoads, []);
    h.dispose();
});

// ─── host busy, stop verification ─────────────────────────────────────

test('host busy: 300 ms loop lag cancels jogs (host-busy) and locks motion', () => {
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    h.exec(cloudId(), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 300 });
    h.monitor.sample(300);
    assert.ok(!h.gate.isJogActive());
    assert.strictEqual(h.audits.filter(a => a.event === 'jog.cancel').pop().args.reason, 'host-busy');
    const r = h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 });
    assert.deepStrictEqual([r.code, r.message], ['LOCKED', 'host-busy']);
    assert.strictEqual(h.exec(cloudId(), 'job.stop').status, 'accepted');
    for (let i = 0; i < 21; i++) { h.clock.advance(100); h.monitor.sample(10); }
    assert.ok(!h.gate.getLocks('cloud').includes('host-busy'));
    h.dispose();
});

test('stop verification: telemetry still Run 2 s after job.stop -> stop.unconfirmed', () => {
    const h = makeGate({ type: 'Grbl' });
    h.engine.startJob();
    assert.strictEqual(h.exec(cloudId(), 'job.stop').message, 'job-stopped');
    h.clock.advance(1000);
    h.engine.setStatus({ activeState: 'Run', mpos: { x: 1, y: 0, z: 0 } });
    h.clock.advance(1001);
    assert.ok(h.audits.some(a => a.event === 'stop.unconfirmed'));
    assert.ok(Number.isFinite(h.gate.getState('cloud').stopUnconfirmedAt));
    h.clock.advance(61000);
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.gate.getState('cloud').stopUnconfirmedAt, undefined);
    h.dispose();
});

// ─── controller specifics ─────────────────────────────────────────────

test('RSP: running job stop sends feedhold then gcode:stop; jog cancel purges pending jogs', () => {
    const h = makeGate({ type: 'RSP' });
    h.grantCloud();
    h.exec(cloudId(), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 300 });
    const purgesBefore = h.engine.controller.cancelPendingJogsCalls;
    h.gate.onLinkDown('cloud');
    assert.ok(h.engine.controller.cancelPendingJogsCalls > purgesBefore);
    assert.ok(!cmdsOf(h).some(c => c[0] === 'jogcancel' || c[0] === 'feedhold'));
    h.dispose();
});

test('RTS (D2): continuous jog and step jog unsupported, 2 mm step BAD_ARGS, home NOT_SUPPORTED', () => {
    const h = makeGate({ type: 'RTS' });
    h.grantCloud();
    assert.strictEqual(h.exec(cloudId(), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 300 }).code, 'NOT_SUPPORTED');
    assert.strictEqual(h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 2, feed: 100 }).code, 'BAD_ARGS');
    const r = h.exec(cloudId(), 'jog.step', { axis: 'x', distanceMm: 0.5, feed: 100 });
    assert.deepStrictEqual([r.code, r.message], ['NOT_SUPPORTED', 'UNSUPPORTED_ON_CONTROLLER']);
    assert.strictEqual(h.exec(cloudId(), 'home', { axis: 'x' }).code, 'NOT_SUPPORTED');
    h.gate.grantMotion(5, OP, { channel: 'lan' });
    assert.strictEqual(h.gate.checkLan(lanId(), 'jog', [{ x: 0.5 }]).code, 'NOT_SUPPORTED');
    assert.strictEqual(h.gate.getState('cloud').capabilities.jogStep, false);
    assert.deepStrictEqual(h.engine.calls, []);
    h.dispose();
});

test('engine errors: synchronous controller error or serialport:error -> failed ENGINE_ERROR', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.engine.startJob();
    h.engine.controllerErrorFor = (cmd) => (cmd === 'gcode:pause' ? 'Unknown command: gcode:pause' : null);
    let r = h.exec(cloudId(), 'job.pause');
    assert.deepStrictEqual([r.status, r.code, r.message], ['failed', 'ENGINE_ERROR', 'Unknown command: gcode:pause']);
    h.engine.controllerErrorFor = null;
    h.engine.serialErrorFor = 'No active controller';
    r = h.exec(cloudId(), 'feed.override', { action: 'reset' });
    assert.deepStrictEqual([r.status, r.code, r.message], ['failed', 'ENGINE_ERROR', 'No active controller']);
    h.dispose();
});

// ─── LAN ──────────────────────────────────────────────────────────────

test('classifyLanCommand table (§7.4)', () => {
    const expect = {
        'gcode:stop': ['stop', 'job.stop'], feedhold: ['stop', 'job.stop'], jogcancel: ['stop', 'jog.cont.stop'],
        'gcode:pause': ['job', 'job.pause'], 'gcode:resume': ['job', 'job.resume'], cyclestart: ['job', 'job.resume'],
        'feedOverride:reset': ['job', 'feed.override'], 'feedOverride:fineMinus': ['job', 'feed.override'],
        jog: ['motion', 'jog.step'], 'gcode:start': ['motion', 'job.start'], 'gcode:startFromLine': ['motion', 'job.start'],
        'wcs:zero': ['motion', 'zero'], 'wcs:zeroAll': ['motion', 'zero'], 'file:load': ['motion', 'job.load'],
        'file:unload': ['motion', 'job.load'], statusreport: ['monitor', null], 'safety:remoteDiagStatus': ['monitor', null],
    };
    for (const [cmd, [tier, gateType]] of Object.entries(expect)) {
        assert.deepStrictEqual(classifyLanCommand(cmd), { tier, gateType }, cmd);
    }
    const never = ['gcode', 'gcode:load', 'gcode:unload', 'jog:safe', 'homing', 'homing:x', 'homing:X', 'home', 'macro:run',
        'unlock', 'reset', 'estop', 'estop:clear', 'limit:clear', 'motor:reset', 'motor:resetAll', 'probe', 'trigger:set',
        'debug:enable', 'safety:remoteDiagToggle', 'spindleOverride:plus', 'coolant:flood', 'toolchange:confirm',
        'command:raw', 'feedOverride:max', '__proto__', 'constructor', undefined, 5];
    const h = makeGate();
    for (const cmd of never) {
        assert.strictEqual(classifyLanCommand(cmd).tier, 'never', String(cmd));
        assert.strictEqual(h.gate.checkLan(lanId(), cmd, []).code, 'UNKNOWN_COMMAND', String(cmd));
    }
    assert.deepStrictEqual(h.gate.classifyLanCommand('jog'), { tier: 'motion', gateType: 'jog.step' });
    assert.strictEqual(TIERS.length, 3);
    h.dispose();
});

test('LAN jog caps: 100 mm and diagonal -> BAD_ARGS on every controller; 150 ms spacing', () => {
    for (const type of ['RSP', 'Grbl', 'GrblHAL', 'FluidNC', 'RTS', 'Generic']) {
        const h = makeGate({ type });
        h.gate.grantMotion(5, OP, { channel: 'lan' });
        assert.strictEqual(h.gate.checkLan(lanId(), 'jog', [{ x: 100, feedRate: 500 }]).code, 'BAD_ARGS', type);
        assert.strictEqual(h.gate.checkLan(lanId(), 'jog', [{ x: 1, y: 1, feedRate: 500 }]).code, 'BAD_ARGS', type);
        assert.strictEqual(h.gate.checkLan(lanId(), 'jog', [{ x: 1, mode: 'G90' }]).code, 'BAD_ARGS', type);
        h.dispose();
    }
    const h = makeGate({ type: 'Grbl' });
    h.gate.grantMotion(5, OP, { channel: 'lan' });
    assert.strictEqual(h.gate.checkLan(lanId(), 'jog', [{ x: 1, feedRate: 500, units: 'G21', mode: 'G91' }]).ok, true);
    h.clock.advance(100);
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.gate.checkLan(lanId(), 'jog', [{ x: 1, feedRate: 500 }]).code, 'RATE_LIMITED');
    assert.strictEqual(h.gate.checkLan(lanId(), 'gcode:stop', []).ok, true, 'stop always allowed');
    assert.strictEqual(h.gate.checkLan(lanId(), 'statusreport', []).ok, true);
    // LAN socket disconnect shortly after a jog sends jogcancel on controllers that have it
    h.gate.onLanSocketGone('sock-1');
    assert.deepStrictEqual(cmdsOf(h), [['jogcancel']]);
    h.dispose();
});

test('LAN wcs:zero, file:load and file:unload record seqs', () => {
    const h = makeGate({ type: 'Grbl' });
    assert.strictEqual(h.gate.checkLan(lanId(), 'wcs:zero', [{}]).code, 'TIER_REQUIRED');
    h.gate.grantMotion(5, OP, { channel: 'lan' });
    assert.strictEqual(h.gate.checkLan(lanId(), 'wcs:zero', []).ok, true);
    assert.strictEqual(h.gate.getTelemetry().wcsSeq, 1);
    h.settle();
    assert.strictEqual(h.gate.checkLan(lanId(), 'file:load', []).ok, true);
    assert.strictEqual(h.gate.checkLan(lanId(), 'file:unload', []).ok, true);
    assert.strictEqual(h.gate.getTelemetry().loadSeq, 2);
    h.engine.startJob();
    assert.strictEqual(h.gate.checkLan(lanId(), 'file:load', []).code, 'JOB_ACTIVE');
    h.dispose();
});

test('LAN args are checked as sent: G-code injection through wcs:zero/jog/startFromLine is BAD_ARGS', () => {
    const policy = require('../services/remoteAccess/policy');
    for (const type of ['Grbl', 'RTS', 'RSP']) {
        const h = makeGate({ type });
        h.gate.grantMotion(5, OP, { channel: 'lan' });
        const evil = [
            ['wcs:zero', [{ axes: ['X0\nG0 X-400 Y-400 F6000 ;'] }]],
            ['wcs:zero', [{ axes: ['x', 'y', 'q'] }]],
            ['wcs:zero', [{ axes: ['x', 'x'] }]],
            ['wcs:zero', [{ axes: 'x' }]],
            ['wcs:zero', [{ axes: ['x'], wcs: 'G54\nG0 X-400' }]],
            ['wcs:zero', [{ axes: ['x'], wcs: 'G53' }]],
            ['wcs:zero', [{ x: 0 }]],
            ['wcs:zero', [{ axes: ['x'] }, 'G0 X-400']],
            ['wcs:zero', ['X0\nG0 X-400']],
            ['wcs:zeroAll', [{ axes: ['X0\nG0 X-400'] }]],
            ['jog', [{ x: 1, feedRate: 500, comment: '\nG0 X-400' }]],
            ['jog', [{ x: 1, feedRate: 500, units: 'G21\nG0 X-400' }]],
            ['jog', [{ x: 1, feedRate: 500 }, { y: 400 }]],
            ['gcode:startFromLine', ['0\nG0 X-400']],
            ['gcode:startFromLine', [-1]],
            ['gcode:start', ['G0 X-400']],
        ];
        for (const [cmd, args] of evil) {
            h.settle();
            assert.strictEqual(h.gate.checkLan(lanId(), cmd, args).code, 'BAD_ARGS', `${type} ${cmd} ${JSON.stringify(args)}`);
        }
        // The real LAN socket filter drops the injected packet.
        const denied = [];
        const socket = { id: 'sock-1', data: { identity: lanId() }, handshake: { address: '192.168.1.20' }, emit: (e, p) => denied.push(p) };
        const filter = policy.createLanPacketFilter({ gate: h.gate, socket });
        let passed = false;
        h.settle();
        filter(['command', '/dev/ttyUSB0', 'wcs:zero', { axes: ['X0\nG0 X-400 Y-400 F6000 ;'] }], () => { passed = true; });
        assert.strictEqual(passed, false, `${type} filter must not forward`);
        assert.strictEqual(denied[0].code, 'BAD_ARGS');

        // Legitimate kiosk shapes still pass, with canonical engine args.
        h.settle();
        let r = h.gate.checkLan(lanId(), 'wcs:zero', [{ axes: ['X'] }]);
        assert.strictEqual(r.ok, true, `${type} ${JSON.stringify(r)}`);
        assert.deepStrictEqual(r.engineArgs, [{ axes: ['x'] }]);
        h.settle();
        r = h.gate.checkLan(lanId(), 'wcs:zero', [undefined]);
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.engineArgs, [{ axes: ['x', 'y', 'z'] }]);
        h.settle();
        assert.strictEqual(h.gate.checkLan(lanId(), 'wcs:zero', [{ axes: ['y'], wcs: 'G55' }]).ok, true);
        h.settle();
        assert.strictEqual(h.gate.checkLan(lanId(), 'wcs:zeroAll', []).ok, true);
        h.dispose();
    }
    const h = makeGate({ type: 'Grbl' });
    h.gate.grantMotion(5, OP, { channel: 'lan' });
    const r = h.gate.checkLan(lanId(), 'jog', [{ x: 1, y: undefined, feedRate: 500 }]);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.engineArgs, [{ x: 1, feedRate: 500 }]);
    h.dispose();
});

test('RTSController wcs:zero never splices free text into G-code', () => {
    const { RTSController } = require('../services/controllers/RTSController');
    const sent = [];
    const stub = {
        _sendGcode: (l) => sent.push(l), _wco: { x: 0, y: 0, z: 0 }, _mpos: { x: 1, y: 2, z: 3 },
        _updateStateObject() {}, emit() {}, state: { status: {} },
    };
    RTSController.prototype._zeroWCS.call(stub, { axes: ['X0\nG0 X-400 Y-400 F6000 ;'] });
    RTSController.prototype._zeroWCS.call(stub, { axes: ['x', 'Y'], wcs: 'G55\nG0 X-400' });
    RTSController.prototype._zeroWCS.call(stub, { axes: ['z'], wcs: 'G56' });
    assert.deepStrictEqual(sent, ['G10 L20 P1 X0 Y0', 'G10 L20 P3 Z0']);
    assert.ok(sent.every(l => !l.includes('\n')));
});

test('pause provenance: a resume the host never saw clears the remote origin; a later hold is not remotely resumable', () => {
    for (const type of ['Grbl', 'RSP']) {
        const h = makeGate({ type });
        h.gate.setJobControl('cloud', true, OP);
        h.engine.startJob();
        assert.strictEqual(h.exec(cloudId(), 'job.pause').status, 'accepted');
        h.engine.pauseJob();
        const tick = (ms, st) => { for (let t = 0; t < ms; t += 100) { h.clock.advance(100); h.engine.setStatus(st); } };
        tick(1000, { activeState: 'Hold' });
        assert.strictEqual(h.gate.getTelemetry().pause.origin, 'remote');
        // Pendant cycle start / gamepad '~': no event, job flags stay paused.
        tick(3000, { activeState: 'Run' });
        assert.strictEqual(h.gate.telemetry.jobInfo().paused, true, `${type} flag still paused`);
        let r = h.exec(cloudId(), 'job.resume');
        assert.strictEqual(r.code, 'NOT_PAUSED', `${type} running machine is not held: ${JSON.stringify(r)}`);
        // Operator holds at the machine (no event either).
        tick(2000, { activeState: 'Hold' });
        assert.notStrictEqual(h.gate.getTelemetry().pause && h.gate.getTelemetry().pause.origin, 'remote', type);
        const before = h.engine.calls.length;
        r = h.exec(cloudId(), 'job.resume');
        assert.strictEqual(r.code, 'PAUSE_NOT_REMOTE', `${type} ${JSON.stringify(r)}`);
        assert.strictEqual(h.engine.calls.length, before, 'nothing dispatched');
        h.dispose();
    }

    // Raw console '~' / '!' reaching the controller (gamepad) re-attribute too.
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.engine.startJob();
    h.engine.controller.write = () => {};
    h.gate.telemetry.bindController(h.engine.controller);
    h.exec(cloudId(), 'job.pause');
    h.engine.pauseJob();
    assert.strictEqual(h.gate.getTelemetry().pause.origin, 'remote');
    h.engine.controller.write('!\n');
    assert.strictEqual(h.gate.getTelemetry().pause.origin, 'local');
    assert.strictEqual(h.exec(cloudId(), 'job.resume').code, 'PAUSE_NOT_REMOTE');
    // gamepad:button through the operator tap demotes a remote origin.
    const g = makeGate({ type: 'Grbl' });
    g.gate.setJobControl('cloud', true, OP);
    g.engine.startJob();
    g.exec(cloudId(), 'job.pause');
    g.engine.pauseJob();
    g.gate.onLocalCommand('gamepad:button', [{ index: 3, pressed: true }]);
    assert.strictEqual(g.gate.getTelemetry().pause.origin, 'local');
    g.clock.advance(6000);
    g.engine.setStatus({ activeState: 'Hold' });
    assert.strictEqual(g.exec(cloudId(), 'job.resume').code, 'PAUSE_NOT_REMOTE');
    h.dispose();
    g.dispose();
});

test('local activity: host-sequenced probing moves hold the lock for their whole duration; direct controller motion locks too', () => {
    const h = makeGate({ type: 'RSP' });
    h.grantCloud();
    const step = { axis: 'z', distanceMm: -10, feed: 3000 };
    const idleOn = (x, ms) => { for (let t = 0; t < ms; t += 100) { x.clock.advance(100); x.engine.setStatus({ activeState: 'Idle' }); } };
    const idle = (ms) => idleOn(h, ms);
    // A 20 s probe chain: moves with Idle gaps between them.
    for (let i = 0; i < 8; i++) {
        h.engine.controller.emit('hostmotion', { phase: 'start', op: i % 2 ? 'move' : 'probe' });
        idle(1500);
        assert.deepStrictEqual(h.gate.getLocks('cloud'), ['local-activity'], `move ${i}`);
        h.engine.controller.emit('hostmotion', { phase: 'end', op: 'move' });
        idle(1000);
        assert.strictEqual(h.exec(cloudId(), 'jog.step', step).code, 'LOCKED', `gap after move ${i}`);
        assert.strictEqual(h.exec(cloudId(), 'zero', { axes: ['x', 'y', 'z'] }).code, 'LOCKED');
    }
    idle(4200);
    assert.deepStrictEqual(h.gate.getLocks('cloud'), [], 'released 5 s after the last move');
    assert.strictEqual(h.exec(cloudId(), 'jog.step', step).status, 'accepted');
    h.dispose();

    // isLocalBusy (index.js: probingService.activeRun) holds the lock for a
    // whole routine even with no controller signal at all.
    {
        const busy = { on: false };
        const b = makeGate({ type: 'Grbl' });
        b.gate.isLocalBusy = () => busy.on;
        b.grantCloud();
        b.gate.onLocalCommand('http:/api/probing/run', [{ strategy: 'corner' }]);
        busy.on = true;
        idleOn(b, 7000);
        assert.deepStrictEqual(b.gate.getLocks('cloud'), ['local-activity']);
        assert.strictEqual(b.exec(cloudId(), 'jog.step', step).code, 'LOCKED');
        idleOn(b, 13000);
        assert.strictEqual(b.exec(cloudId(), 'zero', { axes: ['x'] }).code, 'LOCKED');
        busy.on = false;
        idleOn(b, 3000);
        assert.deepStrictEqual(b.gate.getLocks('cloud'), ['local-activity'], 'window after the routine ends');
        idleOn(b, 2500);
        assert.deepStrictEqual(b.gate.getLocks('cloud'), []);
        b.dispose();
    }

    // Commands that reach the controller without the gate or a tap
    // (ProbingService zero, Telegram jog, 'probe') are operator activity.
    for (const [cmd, args] of [['wcs:zero', [{ z: 0 }]], ['probe', [{ axis: 2 }]], ['jog', [{ x: 1 }]], ['move', [{}]], ['homing', []]]) {
        const g = makeGate({ type: 'RSP' });
        g.grantCloud();
        g.engine.controller.command(cmd, ...args);
        assert.deepStrictEqual(g.gate.getLocks('cloud'), ['local-activity'], cmd);
        g.dispose();
    }
    // The gate's own dispatches never lock the remote user out.
    const g = makeGate({ type: 'RSP' });
    g.grantCloud();
    assert.strictEqual(g.exec(cloudId(), 'jog.step', step).status, 'accepted');
    g.settle();
    assert.deepStrictEqual(g.gate.getLocks('cloud'), []);
    assert.strictEqual(g.exec(cloudId(), 'zero', { axes: ['x'] }).status, 'accepted');
    g.settle();
    assert.deepStrictEqual(g.gate.getLocks('cloud'), []);
    g.dispose();
    // LAN commands the gate let through are not operator activity either.
    const l = makeGate({ type: 'Grbl' });
    l.gate.grantMotion(5, OP, { channel: 'lan' });
    const lr = l.gate.checkLan(lanId(), 'jog', [{ x: 1, feedRate: 500 }]);
    assert.strictEqual(lr.ok, true);
    l.engine.controller.command('jog', ...lr.engineArgs);
    assert.deepStrictEqual(l.gate.getLocks('lan'), []);
    l.dispose();
});

test('RSPController brackets awaited OP_MOVE/OP_PROBE with hostmotion start/end', async () => {
    const { RSPController } = require('../services/controllers/RSPController');
    const defs = require('../services/rsp/defs');
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    const events = [];
    ctrl.on('hostmotion', e => events.push(`${e.op}:${e.phase}`));
    let replyOk = true;
    ctrl.stream = {
        sendCommand: () => Promise.resolve({ payload: Buffer.from([0, replyOk ? defs.ST_OK : 0x7f]) }),
    };
    await ctrl._moveAbsolute(1, 2, 3, 1000);
    replyOk = false;
    await ctrl._moveAbsolute(1, 2, 3, 1000).catch(() => {});
    assert.deepStrictEqual(events, ['move:start', 'move:end', 'move:start', 'move:end']);
    ctrl.stream = null;
});

test('file identity: a program loaded into the controller underneath engine.loadedFile refuses job.start', () => {
    for (const type of ['RSP', 'Grbl']) {
        const h = makeGate({ type });
        h.grantCloud();
        h.gate.setJobControl('lan', true, OP);
        // Operator loads A.nc through the engine (controller sees the same program).
        h.engine._handleFileLoad = function (socket, data) {
            this.controller.command('gcode:load', data.name, data.content);
            this.loadedFile = { name: data.name, total: 1, size: data.content.length };
        };
        h.gate.onLocalCommand('file:load', [{ name: 'A.nc' }]);
        h.engine._handleFileLoad(null, { name: 'A.nc', content: 'G0 X1\nG0 X2\n' });
        h.settle();
        const st = h.gate.getTelemetry();
        const expect = { name: st.file.name, size: st.file.size, loadSeq: st.loadSeq, wcsSeq: st.wcsSeq };
        assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect }).status, 'accepted', `${type} baseline`);
        h.settle();
        // JobResumeService: checkpoint program straight into the controller.
        h.engine.controller.command('gcode:load', 'B.nc', 'G0 Z5\nM3 S18000\nG1 Z-1\nG1 X100\n');
        h.settle();
        const st2 = h.gate.getTelemetry();
        assert.ok(st2.loadSeq > expect.loadSeq, `${type} loadSeq moves`);
        const before = h.engine.calls.length;
        assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect }).code, 'FILE_CHANGED', `${type} old expect`);
        const fresh = { name: st2.file.name, size: st2.file.size, loadSeq: st2.loadSeq, wcsSeq: st2.wcsSeq };
        const r = h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: fresh });
        assert.deepStrictEqual([r.code, r.message], ['FILE_CHANGED', 'controller-program'], `${type} fresh expect still refused`);
        assert.strictEqual(h.engine.calls.length, before, 'nothing started');
        h.gate.grantMotion(5, OP, { channel: 'lan' });
        assert.strictEqual(h.gate.checkLan(lanId(), 'gcode:start', []).code, 'FILE_CHANGED', `${type} LAN start`);
        // Reloading through the engine realigns them.
        h.engine._handleFileLoad(null, { name: 'A.nc', content: 'G0 X1\nG0 X2\n' });
        h.settle();
        h.grantCloud();
        const st3 = h.gate.getTelemetry();
        assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: { name: 'A.nc', size: st3.file.size, loadSeq: st3.loadSeq, wcsSeq: st3.wcsSeq } }).status, 'accepted');
        h.dispose();
    }
    // Checkpoint resume taps also move loadSeq.
    const h = makeGate();
    h.gate.onLocalCommand('http:/api/job/resume', [{}]);
    h.gate.onLocalCommand('job:resume:confirm', [{}]);
    assert.strictEqual(h.gate.getTelemetry().loadSeq, 2);
    h.dispose();
});

test('wcsSeq follows every zero that reaches the controller (probing, zero:* aliases, G10/G92 MDI), once per gate/LAN zero', () => {
    const h = makeGate({ type: 'RSP' });
    const seq = () => h.gate.getTelemetry().wcsSeq;
    let last = seq();
    const cases = [
        ['wcs:zero', { z: 0 }], ['wcs:zeroAll'], ['zero:x'], ['zero:all'], ['zero', { axes: ['X'] }], ['wcs:set', 'G55'],
        ['gcode', 'G10 L20 P1 X0'], ['gcode', 'G92 X0 Y0'], ['gcode', 'g55'], ['macro:run', 'G0 Z5\nG10 L20 P1 Z0'],
    ];
    for (const [cmd, ...args] of cases) {
        h.engine.controller.command(cmd, ...args);
        assert.strictEqual(seq(), last + 1, `${cmd} ${JSON.stringify(args)}`);
        last = seq();
    }
    h.engine.controller.command('gcode', 'G0 X10 Y10');
    h.engine.controller.command('gcode', 'M3 S12000');
    assert.strictEqual(seq(), last, 'ordinary moves do not change the zero');
    h.clock.advance(6000);
    h.engine.setStatus({ activeState: 'Idle' });
    // Remote zero via the gate: exactly one increment.
    h.grantCloud();
    assert.strictEqual(h.exec(cloudId(), 'zero', { axes: ['x'] }).status, 'accepted');
    assert.strictEqual(seq(), last + 1);
    last = seq();
    h.settle();
    // LAN zero: checked, then the engine forwards it -> one increment.
    h.gate.grantMotion(5, OP, { channel: 'lan' });
    const r = h.gate.checkLan(lanId(), 'wcs:zero', [{ axes: ['y'] }]);
    assert.strictEqual(r.ok, true);
    h.engine.controller.command('wcs:zero', ...r.engineArgs);
    assert.strictEqual(seq(), last + 1);
    // A probe-driven zero after the phone captured its expect refuses start.
    h.engine.loadedFile = { name: 'a.nc', size: 5, total: 1 };
    h.settle();
    h.grantCloud();
    const st = h.gate.getTelemetry();
    const expect = { name: 'a.nc', size: 5, loadSeq: st.loadSeq, wcsSeq: st.wcsSeq };
    h.engine.controller.command('wcs:zeroAll');
    h.clock.advance(6000);
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect }).code, 'FILE_CHANGED');
    h.dispose();
});

// ─── clocks, reasons, audit ───────────────────────────────────────────

test('monotonic clock: wall steps of +/-10 s change no grant or TTL-free timer outcome', () => {
    const h = makeGate();
    h.grantCloud();
    h.clock.stepWall(-10000);
    h.clock.advance(4 * 60000);
    h.engine.setStatus({ activeState: 'Idle' });
    assert.strictEqual(h.gate.getState('cloud').tier, 'motion');
    h.clock.stepWall(+20000);
    assert.strictEqual(h.gate.getState('cloud').motionRemainingMs, 60000);
    h.clock.advance(60000);
    assert.strictEqual(h.gate.getState('cloud').tier, 'monitor');
    h.dispose();
});

test('exact cancel reason strings from gate hooks', () => {
    const reasons = [];
    const run = (type, trigger) => {
        const h = makeGate({ type });
        h.grantCloud();
        h.exec(cloudId(), 'jog.cont.start', { jogId: 'j_abcdef', axis: 'x', dir: 1, feed: 300 });
        assert.ok(h.gate.isJogActive(), 'jog started');
        trigger(h);
        const cancel = h.audits.filter(a => a.event === 'jog.cancel').pop();
        reasons.push(cancel && cancel.args.reason);
        h.dispose();
    };
    run('Grbl', h => h.exec(cloudId(), 'jog.cont.stop', { jogId: 'j_abcdef' }));
    run('Grbl', h => h.exec(cloudId(USER_B, 'k_other0000001'), 'job.stop'));
    run('Grbl', h => h.gate.onLinkDown('cloud'));
    run('Grbl', h => h.gate.onClientGone('k_conn00000001'));
    run('Grbl', h => h.gate.onRttSample(700));
    run('Grbl', h => h.gate.onLinkDown('cloud', 'lan-only'));
    run('Grbl', h => h.gate.onLinkDown('cloud', 'shutdown'));
    run('Grbl', h => h.engine.bindNewController('Grbl'));
    run('Grbl', h => { h.engine.connected = false; h.gate.getState('cloud'); });
    run('Grbl', h => h.engine.emitAlarm());
    run('Grbl', h => { h.gate.grantMotion(5, OP, { channel: 'cloud' }); h.gate.revokeMotion('remote-drop', cloudId()); });
    assert.deepStrictEqual(reasons, [
        'owner-stop', 'remote-stop', 'link-down', 'client-gone', 'latency', 'lan-only', 'shutdown',
        'controller-changed', 'controller disconnected', 'alarm', 'remote-drop',
    ]);
});

test('unknown clock offset refuses job class too; only stop is exempt', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.engine.startJob();
    for (const [type, args] of [['job.pause', {}], ['feed.override', { action: 'reset' }], ['job.resume', {}]]) {
        const r = h.exec(cloudId(), type, args, { relayOffsetMs: null });
        assert.deepStrictEqual([r.status, r.code, r.message], ['rejected', 'LATENCY_TOO_HIGH', 'clock offset unknown'], type);
    }
    assert.strictEqual(h.exec(cloudId(), 'job.stop', {}, { relayOffsetMs: null }).status, 'accepted');
    assert.strictEqual(h.exec(cloudId(), 'tier.dropMotion', {}, { relayOffsetMs: undefined }).status, 'accepted');
    assert.ok(!cmdsOf(h).some(c => c[0] === 'gcode:pause' || c[0].startsWith('feedOverride')));
    h.dispose();
});

test('idem duplicates are audited with duplicate:true', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.engine.startJob();
    h.exec(cloudId(), 'feed.override', { action: 'reset' }, { idem: 'c_dupaudit' });
    const dup = h.exec(cloudId(), 'feed.override', { action: 'reset' }, { idem: 'c_dupaudit' });
    assert.strictEqual(dup.duplicate, true);
    const lines = fs.readFileSync(path.join(h.dir, 'remote-audit.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
        .filter(l => l.event === 'cmd' && l.type === 'feed.override');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].duplicate, undefined);
    assert.deepStrictEqual([lines[1].duplicate, lines[1].status, lines[1].code], [true, 'accepted', 'OK']);
    h.dispose();
});

test('motion bucket: unauthorised LAN/cloud spam cannot rate-limit the Motion holder', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.grantMotion(5, OP, { channel: 'cloud', userId: USER_A });
    for (let i = 0; i < 40; i++) {
        assert.strictEqual(h.gate.checkLan(lanId(), 'jog', [{ x: 1, feedRate: 100 }]).code, 'TIER_REQUIRED');
        assert.strictEqual(h.exec(cloudId(USER_B, 'k_connbbbbbbbb'), 'zero', { axes: ['x'] }).code, 'TIER_REQUIRED');
    }
    const r = h.exec(cloudId(USER_A), 'jog.step', { axis: 'x', distanceMm: 1, feed: 100 });
    assert.strictEqual(r.status, 'accepted', JSON.stringify(r));
    // the holder's own motion commands are still capped at 20/s
    let limited = 0;
    for (let i = 0; i < 25; i++) {
        if (h.exec(cloudId(USER_A), 'zero', { axes: ['y'] }).code === 'RATE_LIMITED') limited += 1;
    }
    assert.ok(limited > 0, 'bucket still enforced for authorised motion');
    h.dispose();
});

test('audit lines go to jsonl, logger and onAudit with no secrets', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.exec(cloudId(), 'job.pause');
    h.exec(cloudId(), 'command:raw', { data: 'odc_secret' });
    const lines = fs.readFileSync(path.join(h.dir, 'remote-audit.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.length >= 3);
    const cmd = lines.find(l => l.event === 'cmd' && l.type === 'job.pause');
    assert.deepStrictEqual(
        { kind: cmd.kind, userId: cmd.userId, userLabel: cmd.userLabel, connId: cmd.connId, sessionRef: cmd.sessionRef, status: cmd.status, code: cmd.code },
        { kind: 'cloud', userId: USER_A, userLabel: 'Sam', connId: 'k_conn00000001', sessionRef: 's3a9f1', status: 'rejected', code: 'NO_JOB' },
    );
    const raw = fs.readFileSync(path.join(h.dir, 'remote-audit.jsonl'), 'utf-8');
    assert.ok(!/odc_|ors_|ops_/.test(raw), 'unknown-type args are never recorded');
    assert.ok(h.logger.lines.some(l => l.text.includes('[remote-audit]')));
    assert.strictEqual(h.audits.length, lines.length);
    h.dispose();
});

// ─── RSPController §9.6 (fake stream) ─────────────────────────────────

// REMOVED: 'RSPController: paused-job stop with a dropped ABORT sends no RESUME; ACK then RESUME'
// That case asserted _resumeAfterAbortAck(), which sent OP_RESUME once a durable
// OP_JOB_ABORT was ACKed. This controller stops differently now: job.abort() sends
// a forced OP_JOB_ABORT that takes the firmware out of HOLD to IDLE by itself, so
// there is no blind OP_RESUME to withhold. See RSPController gcode:stop.

test('RSPController: a board still running after the host job ended is never reported Idle', () => {
    const { RSPController } = require('../services/controllers/RSPController');
    const defs = require('../services/rsp/defs');
    const ctrl = new RSPController();
    const sent = [];
    ctrl.stream = { sendCommand(op) { sent.push(op); return Promise.resolve(); }, cancelPending() { return 0; } };
    ctrl.job = { active: false, noteProgress() {} };
    const statuses = [];
    ctrl.on('status', st => statuses.push({ activeState: st.activeState, state: st.state }));
    ctrl.on('error', () => {});
    ctrl._onTelemetry({ x: 0, y: 0, z: 0, state: defs.ST_RUNNING, state_name: 'Run', job_active: true, job_id: 7 });
    ctrl._onTelemetry({ x: 0, y: 0, z: 0, state: defs.ST_HOLD, state_name: 'Hold', job_active: true, job_id: 7 });
    assert.deepStrictEqual(statuses, [{ activeState: 'Run', state: defs.ST_RUNNING }, { activeState: 'Hold', state: defs.ST_HOLD }]);
    assert.ok(!sent.includes(defs.OP_RESUME));
});

test('RSPController.cancelPendingJogs removes only OP_JOG/OP_MOVE pendings', () => {
    const { RSPController } = require('../services/controllers/RSPController');
    const { ReliableStream } = require('../services/rsp/stream');
    const defs = require('../services/rsp/defs');
    const stream = new ReliableStream({ send() {}, on() {} }, { logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const ops = [defs.OP_JOG, defs.OP_MOVE, defs.OP_JOB_ABORT, defs.OP_JOG, defs.OP_RESUME, defs.OP_FEED_HOLD];
    ops.forEach((op, i) => stream._sent.set(i, { seq: i, payload: Buffer.from([op, 1, 2]) }));
    const ctrl = new RSPController();
    ctrl.stream = stream;
    assert.strictEqual(ctrl.cancelPendingJogs(), 3);
    assert.deepStrictEqual([...stream._sent.values()].map(p => p.payload[0]), [defs.OP_JOB_ABORT, defs.OP_RESUME, defs.OP_FEED_HOLD]);
    ctrl.stream = null;
    assert.strictEqual(ctrl.cancelPendingJogs(), 0);
});

test('LAN filters forward the gate canonical arguments, not the phone packet; stops keep their own', () => {
    const policy = require('../services/remoteAccess/policy');
    const h = makeGate({ type: 'Grbl' });
    h.gate.grantMotion(5, OP, { channel: 'lan' });
    const socket = { id: 'sock-1', data: { identity: lanId() }, handshake: { address: '192.168.1.20' }, emit() {} };
    const filter = policy.createLanPacketFilter({ gate: h.gate, socket });
    const ack = () => {};
    h.settle();
    const packet = ['command', '/dev/ttyUSB0', 'wcs:zero', { axes: ['X', 'Y'] }, undefined, ack];
    let passed = false;
    filter(packet, () => { passed = true; });
    assert.strictEqual(passed, true);
    assert.deepStrictEqual(packet.slice(0, 4), ['command', '/dev/ttyUSB0', 'wcs:zero', { axes: ['x', 'y'] }]);
    assert.strictEqual(packet.length, 5, 'trailing undefined dropped');
    assert.strictEqual(packet[4], ack, 'ack callback kept last');

    h.settle();
    const jog = ['command', '/dev/ttyUSB0', 'jog', { x: 2, y: null, feedRate: 500, units: 'G21', mode: 'G91' }];
    filter(jog, () => {});
    assert.deepStrictEqual(jog.slice(3), [{ x: 2, feedRate: 500 }]);

    h.settle();
    const stop = ['command', '/dev/ttyUSB0', 'gcode:stop', { force: true }];
    filter(stop, () => {});
    assert.deepStrictEqual(stop.slice(3), [{ force: true }], 'stop packet untouched');

    const http = policy.createLanHttpFilter({ gate: h.gate, libraryService: h.library });
    h.settle();
    const req = {
        path: '/api/command', method: 'POST', ip: '192.168.1.20', remoteIdentity: lanId(),
        body: { command: 'wcs:zero', args: [{ axes: ['Z'] }, null] },
    };
    const res = { status() { return { json: (b) => { throw new Error(`denied ${JSON.stringify(b)}`); } }; } };
    let nexted = false;
    http(req, res, () => { nexted = true; });
    assert.strictEqual(nexted, true);
    assert.deepStrictEqual(req.body.args, [{ axes: ['z'] }]);
    h.dispose();
});

test('LAN packet filter: a stale (revoked) identity is denied SESSION_REVOKED and the socket is closed', () => {
    const policy = require('../services/remoteAccess/policy');
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('lan', true, OP);
    const denied = [];
    let disconnects = 0;
    const socket = {
        id: 'sock-1', data: { identity: lanId() }, handshake: { address: '192.168.1.20' },
        emit: (e, p) => denied.push([e, p]),
        disconnect: (close) => { assert.strictEqual(close, true); disconnects += 1; },
    };
    let current = true;
    const filter = policy.createLanPacketFilter({ gate: h.gate, socket, isIdentityCurrent: () => current });
    h.settle();
    let passed = 0;
    filter(['command', '/dev/ttyUSB0', 'feedhold'], () => { passed += 1; });
    assert.strictEqual(passed, 1, 'current identity passes');
    current = false;
    for (const packet of [['command', '/dev/ttyUSB0', 'feedhold'], ['command', '/dev/ttyUSB0', 'gcode:start'], ['open', '/dev/ttyUSB0']]) {
        filter(packet, () => { passed += 1; });
    }
    assert.strictEqual(passed, 1, 'nothing passes once stale');
    assert.strictEqual(disconnects, 3);
    assert.ok(denied.length === 3 && denied.every(([e, p]) => e === 'remote:denied' && p.code === 'SESSION_REVOKED'));
    // A throwing check fails closed.
    const f2 = policy.createLanPacketFilter({ gate: h.gate, socket, isIdentityCurrent: () => { throw new Error('boom'); } });
    f2(['command', '/dev/ttyUSB0', 'feedhold'], () => { passed += 1; });
    assert.strictEqual(passed, 1);
    assert.strictEqual(denied[denied.length - 1][1].code, 'SESSION_REVOKED');
    h.dispose();
});

test('published pause carries the channel of a remote pause and a pending tool change', () => {
    const h = makeGate({ type: 'Grbl' });
    h.gate.setJobControl('cloud', true, OP);
    h.gate.setJobControl('lan', true, OP);
    h.engine.startJob();
    h.settle();
    assert.strictEqual(h.gate.checkLan(lanId(), 'feedhold', []).ok, true);
    h.engine.pauseJob();
    h.engine.setStatus({ activeState: 'Hold' });
    let pause = h.gate.getTelemetry().pause;
    assert.strictEqual(pause.origin, 'remote');
    assert.strictEqual(pause.channel, 'lan');
    assert.strictEqual(h.gate.getState('operator').pause.channel, 'lan');
    h.dispose();

    const c = makeGate({ type: 'Grbl' });
    c.gate.setJobControl('cloud', true, OP);
    c.engine.startJob();
    assert.strictEqual(c.exec(cloudId(), 'job.pause').status, 'accepted');
    c.engine.pauseJob();
    c.engine.setStatus({ activeState: 'Hold' });
    pause = c.gate.getTelemetry().pause;
    assert.deepStrictEqual([pause.origin, pause.channel, pause.toolchangePending], ['remote', 'cloud', undefined]);
    c.gate.telemetry.toolchangePending = true;
    assert.strictEqual(c.gate.getTelemetry().pause.toolchangePending, true);
    c.dispose();
});

test('GrblController: non-string command never dispatches; wcs:zero and jog never splice free text', () => {
    const { GrblController } = require('../services/GRBLController');
    const out = [];
    const errors = [];
    const stub = Object.create(GrblController.prototype);
    stub.writeln = (s) => out.push(s);
    stub.emit = (e, p) => { if (e === 'error') errors.push(p.message); };
    stub.command(['wcs:zero'], { axes: ['x'] });
    stub.command({ toString: () => 'wcs:zeroAll' });
    stub.command('toString');
    assert.deepStrictEqual(out, [], 'coerced / inherited names dispatch nothing');
    stub.command('wcs:zero', { axes: ['X0\nG0 X-400 Y-400 F6000 ;'] });
    stub.command('wcs:zero', { axes: 'x' });
    stub.command('wcs:zero', { axes: ['x', 'Y', 'y'], wcs: 'G55\nG0 X-400' });
    stub.command('wcs:zero', { axes: ['x', 'q'] });
    stub.command('wcs:zero', { axes: ['x', 'Y', 'y'], wcs: 'G55' });
    stub.command('wcs:zero', { axes: ['z'], wcs: 'G56' });
    stub.command('jog', { x: '1\nG0 X-400', feedRate: 500 });
    stub.command('jog', { x: 1, feedRate: '500\nM3' });
    stub.command('jog', { x: 1, feedRate: 500, units: 'G21\nM3' });
    stub.command('jog', { x: 1, feedRate: 500, mode: 'G53' });
    stub.command('jog', { x: -1.5, y: 0, z: null, feedRate: 800 });
    assert.deepStrictEqual(out, ['G10 L20 P2 X0 Y0', 'G10 L20 P3 Z0', '$J=G91 G21 X-1.5 F800']);
    assert.ok(out.every(l => !l.includes('\n')));
    // 3 refused command names + 4 refused zeros + 4 refused jogs.
    assert.strictEqual(errors.length, 11, errors.join(' | '));

    const { RTSController } = require('../services/controllers/RTSController');
    const rts = Object.create(RTSController.prototype);
    let called = 0;
    Object.defineProperty(rts, '_commands', { value: { gcode: () => { called += 1; } } });
    rts.command(['gcode'], 'G0 X-400');
    rts.command('toString');
    assert.strictEqual(called, 0);
    rts.command('gcode', 'G0 X1');
    assert.strictEqual(called, 1);
});

test('job resume: the engine records the program it loads into the controller, so the gate sees no mismatch', () => {
    const { JobResumeService } = require('../services/jobresume/JobResumeService');
    const CNCEngine = require('../services/CNCEngine');
    const EngineClass = CNCEngine.CNCEngine || CNCEngine;
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    const emitted = [];
    h.engine.io = { emit: (e, p) => emitted.push([e, p]) };
    h.engine.noteProgramLoaded = EngineClass.prototype.noteProgramLoaded;
    const cp = {
        filename: 'part.nc', gcodeText: 'G0 X1\nG0 X2\nG0 X3\n', gcodeHash: 'h', lastExecutedLine: 1, totalLines: 3, modalState: {},
    };
    const svc = new JobResumeService({
        dataDir: fs.mkdtempSync(path.join(tmpRoot, 'jr-')), io: { on() {}, emit() {} }, logger: silentLogger(),
        getController: () => h.engine.controller,
        onProgramLoaded: ({ name, content }) => h.engine.noteProgramLoaded(name, content),
    });
    svc.store = { load: () => cp, save() {}, clear() {} };
    const r = svc.resumeFromCheckpoint({ skipPreamble: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(h.engine.loadedFile.name, 'part.nc');
    assert.strictEqual(h.engine.loadedFile.size, cp.gcodeText.length);
    assert.ok(emitted.some(([e, p]) => e === 'file:load' && p.name === 'part.nc'));
    assert.strictEqual(h.gate._programMismatch(h.engine.loadedFile), false);
    h.dispose();
});

test('job resume: the checkpoint-resume program is never started remotely "from the beginning" (cloud or LAN) until a plain load', () => {
    const { JobResumeService } = require('../services/jobresume/JobResumeService');
    const CNCEngine = require('../services/CNCEngine');
    const EngineClass = CNCEngine.CNCEngine || CNCEngine;
    for (const tap of ['http:/api/job/resume', 'job:resume:confirm']) {
        const h = makeGate({ type: 'Grbl' });
        h.grantCloud();
        h.gate.setJobControl('lan', true, OP);
        h.engine.io = { emit() {} };
        h.engine.noteProgramLoaded = EngineClass.prototype.noteProgramLoaded;
        h.engine._handleFileLoad = function (socket, data) {
            this.controller.command('gcode:load', data.name, data.content);
            this.loadedFile = { name: data.name, total: 1, size: data.content.length };
        };
        const original = Array.from({ length: 50 }, (_, i) => `G1 X${i + 1} Z-3 F800`).join('\n');
        h.gate.onLocalCommand('file:load', [{ name: 'part.nc' }]);
        h.engine._handleFileLoad(null, { name: 'part.nc', content: original });
        h.settle();
        const cp = {
            filename: 'part.nc', gcodeText: original, gcodeHash: 'h', lastExecutedLine: 25, totalLines: 50,
            modalState: { spindleSpeed: 12000, feedRate: 800 }, position: { x: 25, y: 0, z: -3 },
        };
        const svc = new JobResumeService({
            dataDir: fs.mkdtempSync(path.join(tmpRoot, 'jr-')), io: { on() {}, emit() {} }, logger: silentLogger(),
            getController: () => h.engine.controller,
            getConfig: () => ({ get: (_k, d) => d }),
            onProgramLoaded: ({ name, content }) => h.engine.noteProgramLoaded(name, content),
        });
        svc.store = { load: () => cp, save() {}, clear() {} };
        // Kiosk resume: the tap runs before the handler (socket.use / noteLocalCommand).
        h.gate.onLocalCommand(tap, [{}]);
        const r = svc.resumeFromCheckpoint({});
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.ok(r.preamble.length > 0, 'resume program has a preamble');
        // The resumed job ends; the controller still holds the partial program under 'part.nc'.
        h.clock.advance(6000);
        h.settle();
        h.grantCloud();
        const st = h.gate.getTelemetry();
        assert.strictEqual(st.file.name, 'part.nc');
        assert.strictEqual(h.gate._programMismatch(h.engine.loadedFile), false, 'names and sizes agree');
        const expect = { name: st.file.name, size: st.file.size, loadSeq: st.loadSeq, wcsSeq: st.wcsSeq };
        const before = h.engine.calls.length;
        const res = h.exec(cloudId(), 'job.start', { fromBeginning: true, expect });
        assert.deepStrictEqual([res.status, res.code, res.message], ['rejected', 'FILE_CHANGED', 'resume-program'], `${tap} cloud`);
        h.gate.grantMotion(5, OP, { channel: 'lan' });
        const lanRes = h.gate.checkLan(lanId(), 'gcode:start', []);
        assert.deepStrictEqual([lanRes.code, lanRes.message], ['FILE_CHANGED', 'resume-program'], `${tap} LAN start`);
        assert.strictEqual(h.gate.checkLan(lanId(), 'gcode:startFromLine', [0]).code, 'FILE_CHANGED', `${tap} LAN startFromLine`);
        assert.strictEqual(h.engine.calls.length, before, 'nothing started');
        // A plain load (well after the resume) makes the file startable again.
        h.clock.advance(5000);
        h.gate.onLocalCommand('file:load', [{ name: 'part.nc' }]);
        h.engine._handleFileLoad(null, { name: 'part.nc', content: original });
        h.settle();
        h.grantCloud();
        const st2 = h.gate.getTelemetry();
        const ok = h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: { name: 'part.nc', size: original.length, loadSeq: st2.loadSeq, wcsSeq: st2.wcsSeq } });
        assert.strictEqual(ok.status, 'accepted', `${tap} plain reload: ${JSON.stringify(ok)}`);
        h.dispose();
    }
    // Fail closed: a resume tap whose load is never observed still blocks start;
    // an unload clears it; an engine-marked resume program is refused too.
    const h = makeGate({ type: 'Grbl' });
    h.grantCloud();
    h.engine._handleFileLoad = function (socket, data) {
        this.controller.command('gcode:load', data.name, data.content);
        this.loadedFile = { name: data.name, total: 1, size: data.content.length };
    };
    h.engine._handleFileLoad(null, { name: 'A.nc', content: 'G0 X1\n' });
    h.settle();
    h.gate.onLocalCommand('http:/api/job/resume', [{}]);
    h.clock.advance(6000);
    h.settle();
    h.grantCloud();
    const fresh =() => { const t = h.gate.getTelemetry(); return { name: t.file.name, size: t.file.size, loadSeq: t.loadSeq, wcsSeq: t.wcsSeq }; };
    assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: fresh() }).message, 'resume-program');
    h.engine.controller.command('gcode:unload');
    h.engine._handleFileLoad(null, { name: 'A.nc', content: 'G0 X1\n' });
    h.settle();
    h.grantCloud();
    assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: fresh() }).status, 'accepted');
    h.settle();
    h.engine.loadedFile = { ...h.engine.loadedFile, resume: true };
    h.grantCloud();
    assert.strictEqual(h.exec(cloudId(), 'job.start', { fromBeginning: true, expect: fresh() }).message, 'resume-program');
    h.dispose();
});

async function main() {
    console.log('=== CloudLink Gate Tests ===');
    const guard = setTimeout(() => { console.log('✗ timeout after 30 s'); process.exit(1); }, 30000);
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✓ ${t.name}`);
        } catch (err) {
            failed += 1;
            console.log(`✗ ${t.name}`);
            console.log(err && err.stack ? err.stack : err);
        }
    }
    clearTimeout(guard);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* tmp */ }
    console.log(failed ? `${failed} of ${tests.length} failed` : `All ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

main();

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
