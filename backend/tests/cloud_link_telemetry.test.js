'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeEngine, createFakeClock, silentLogger } = require('./helpers/fakeEngine');
const { TelemetryBuilder, ReportThrottle, normalizeStatus, mapRawState, STATE_REPORT_MAX_BYTES } = require('../services/cloudLink/TelemetryBuilder');
const { RemoteCommandGate, createAtomicJsonStore } = require('../services/cloudLink');
const { HostLoadMonitor } = require('../services/cloudLink/HostLoadMonitor');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-telemetry-'));

function makeBuilder(type = 'RSP', extras = {}) {
    const clock = createFakeClock();
    const engine = new FakeEngine({ controllerType: type });
    const tb = new TelemetryBuilder({
        clock,
        isLanOnly: () => false,
        getRttMs: () => 64,
        getExtras: () => ({ loadSeq: 0, wcsSeq: 0, pause: null, ...extras }),
        setIntervalFn: clock.setInterval,
        clearIntervalFn: clock.clearInterval,
    });
    tb.attachEngine(engine);
    return { tb, engine, clock };
}

test('RSP status payload normalisation accepts both shapes', () => {
    const plain = { activeState: 'Run', mpos: { x: 1, y: 2, z: 3 } };
    assert.strictEqual(normalizeStatus(plain), plain);
    assert.strictEqual(normalizeStatus({ status: plain, parserstate: {} }), plain);
    const { tb, engine } = makeBuilder('RSP');
    engine.controller.emit('status', { status: { activeState: 'Jog', mpos: { x: 1.23456, y: 0, z: -2.5 } }, parserstate: {} });
    let snap = tb.snapshot();
    assert.strictEqual(snap.machine.rawState, 'Jog');
    assert.strictEqual(snap.machine.state, 'jogging');
    assert.deepStrictEqual(snap.machine.pos, { x: 1.235, y: 0, z: -2.5 });
    engine.controller.emit('status', { activeState: 'Idle', mpos: { x: 0, y: 0, z: 0 }, feedrate: 1500.4, spindle: 18000, feedOverridePct: 120 });
    snap = tb.snapshot();
    assert.strictEqual(snap.machine.state, 'idle');
    assert.strictEqual(snap.machine.feedrate, 1500);
    assert.strictEqual(snap.machine.feedOverridePct, 120);
    tb.detach();
});

test('state mapping table', () => {
    const table = {
        Idle: 'idle', Jog: 'jogging', Home: 'homing', Homing: 'homing', Run: 'running', Stream: 'running',
        Hold: 'paused', 'Hold:0': 'paused', Door: 'paused', 'Door:1': 'paused', Stop: 'stopping',
        Alarm: 'alarm', EStop: 'alarm', Fault: 'alarm', Boot: 'boot',
    };
    for (const [raw, state] of Object.entries(table)) assert.strictEqual(mapRawState(raw, true, false), state, raw);
    assert.strictEqual(mapRawState('Run', false, true), 'disconnected');
    assert.strictEqual(mapRawState('Weird', true, false), 'idle');
    assert.strictEqual(mapRawState('Weird', true, true), 'running');
    const { tb, engine } = makeBuilder('Grbl');
    engine.connected = false;
    engine.setStatus({ activeState: 'Run' });
    assert.strictEqual(tb.snapshot().machine.state, 'disconnected');
    tb.detach();
});

test('alarm latch: set by rawState, estop flag, RSP numeric state and alarm event; cleared only by later Idle', () => {
    const triggers = [
        e => e.setStatus({ activeState: 'Alarm' }),
        e => e.setStatus({ activeState: 'Idle', estop: true }),
        e => e.setStatus({ activeState: 'State9', state: 9 }),
        e => e.emitAlarm({ type: 'comm_lost', code: 3, message: 'link' }),
    ];
    for (const trigger of triggers) {
        const { tb, engine, clock } = makeBuilder('RSP');
        const events = [];
        tb.on('alarm-latched', a => events.push(['latched', a]));
        tb.on('alarm-cleared', () => events.push(['cleared']));
        trigger(engine);
        assert.ok(tb.alarm, 'latched');
        assert.ok(tb.snapshot().alarm && Number.isFinite(tb.snapshot().alarm.since));
        engine.setStatus({ activeState: 'Hold', estop: false, state: 6 });
        assert.ok(tb.alarm, 'a non-Idle state does not clear it');
        clock.advance(5);
        engine.setStatus({ activeState: 'Idle', estop: false, state: 1 });
        assert.strictEqual(tb.alarm, null);
        assert.deepStrictEqual(events.map(e => e[0]), ['latched', 'cleared']);
        tb.detach();
    }
    const { tb, engine } = makeBuilder('RSP');
    engine.emitAlarm({ type: 'estop', code: null, message: 'E-Stop Triggered' });
    assert.deepStrictEqual({ ...tb.alarm, since: 0 }, { type: 'estop', code: null, message: 'E-Stop Triggered', since: 0 });
    tb.detach();
});

test('job fields from RSP getSenderStatus; GRBL from sender:status; GRBL ov.feed', () => {
    let { tb, engine } = makeBuilder('RSP');
    engine.loadedFile = { name: 'sign_v2.nc', total: 12488, size: 402113 };
    engine.controller.job.active = true;
    engine.controller.sender = { executed: 5120, total: 12488, progress: 41, failReason: null, stalled: false };
    engine.controller.emit('sender:start', {});
    engine.setStatus({ activeState: 'Run' });
    let snap = tb.snapshot();
    assert.deepStrictEqual(
        { ...snap.job, startedAt: typeof snap.job.startedAt },
        { active: true, paused: false, stalled: false, name: 'sign_v2.nc', progressPct: 41, executed: 5120, total: 12488, startedAt: 'number', failReason: null },
    );
    assert.deepStrictEqual(snap.file, { name: 'sign_v2.nc', total: 12488, size: 402113, loadSeq: 0 });
    engine._jobPaused = true;
    assert.strictEqual(tb.snapshot().job.paused, true);
    tb.detach();

    ({ tb, engine } = makeBuilder('Grbl'));
    engine.controller.workflow = 'running';
    engine.controller.emit('sender:status', { received: 10, sent: 12, total: 100, progress: 10 });
    engine.setStatus({ activeState: 'Run', ov: { feed: 150, rapid: 100, spindle: 100 } });
    snap = tb.snapshot();
    assert.strictEqual(snap.job.executed, 10);
    assert.strictEqual(snap.job.progressPct, 10);
    assert.strictEqual(snap.machine.feedOverridePct, 150);
    assert.strictEqual(snap.machine.boardLinkOk, true);
    engine.controller.workflow = 'idle';
    assert.strictEqual(tb.snapshot().job, null);
    tb.detach();
});

test('rebinding a controller moves the listeners to the new controller', () => {
    const { tb, engine } = makeBuilder('Grbl');
    const old = engine.controller;
    const bound = [];
    tb.on('controller-bound', (ctrl, isNew) => bound.push(isNew));
    engine.bindNewController('Grbl');
    assert.deepStrictEqual(bound, [true]);
    assert.strictEqual(old.listenerCount('status'), 0);
    engine.setStatus({ activeState: 'Jog' });
    assert.strictEqual(tb.rawState(), 'Jog');
    tb.detach();
    assert.strictEqual(engine.controller.listenerCount('status'), 0);
});

function makeThrottle({ clock, state, tier, fast = false }) {
    const sent = [];
    const socket = { bufferedAmount: 0 };
    const throttle = new ReportThrottle({
        clock,
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
        getState: () => JSON.parse(JSON.stringify(state())),
        getTier: () => tier(),
        isFast: () => fast,
        canSend: () => socket.bufferedAmount <= 256 * 1024,
        send: (t, body) => { sent.push({ t, body, at: clock.mono() }); return true; },
    });
    return { throttle, sent, socket };
}

test('throttle: 1 Hz idle, 5 Hz running, immediate on change with 100 ms coalescing, seq increments', () => {
    const { tb, engine, clock } = makeBuilder('Grbl');
    engine.setStatus({ activeState: 'Idle' });
    const { throttle, sent } = makeThrottle({ clock, state: () => tb.snapshot(), tier: () => ({ tier: 'monitor' }) });
    throttle.start();
    const states = () => sent.filter(s => s.t === 'report.state');
    assert.strictEqual(states().length, 1);
    assert.strictEqual(sent.filter(s => s.t === 'report.tier').length, 1);
    clock.advance(3150);
    assert.strictEqual(states().length, 4, '1 Hz while idle');

    engine.setStatus({ activeState: 'Run' });
    throttle.poke();
    const n = states().length;
    assert.strictEqual(n, 5, 'state change sent immediately');
    engine.setStatus({ activeState: 'Hold' });
    throttle.poke();
    assert.strictEqual(states().length, 5, 'coalesced: < 100 ms since the last report');
    clock.advance(100);
    assert.strictEqual(states().length, 6, 'coalesced change sent at 100 ms');
    engine.setStatus({ activeState: 'Run' });
    clock.advance(100);
    const before = states().length;
    clock.advance(1000);
    const perSecond = states().length - before;
    assert.ok(perSecond >= 4 && perSecond <= 5, `5 Hz while running (${perSecond})`);
    const seqs = states().map(s => s.body.seq);
    assert.deepStrictEqual(seqs, seqs.map((_, i) => i + 1));
    for (const s of states()) assert.ok(Buffer.byteLength(JSON.stringify(s.body)) < STATE_REPORT_MAX_BYTES);
    throttle.stop();
    tb.detach();
});

test('throttle: tier change skipped at bufferedAmount > 256 KiB is sent within 100 ms of draining', () => {
    const clock = createFakeClock();
    let tierBody = { tier: 'monitor' };
    const { throttle, sent, socket } = makeThrottle({ clock, state: () => ({ machine: { state: 'idle' }, connected: true }), tier: () => tierBody });
    throttle.start();
    socket.bufferedAmount = 300 * 1024;
    tierBody = { tier: 'motion' };
    throttle.markTierDirty();
    clock.advance(500);
    assert.ok(!sent.some(s => s.t === 'report.tier' && s.body.tier === 'motion'));
    assert.strictEqual(throttle.tierDirty, true);
    socket.bufferedAmount = 0;
    const drainedAt = clock.mono();
    clock.advance(100);
    const hit = sent.find(s => s.t === 'report.tier' && s.body.tier === 'motion');
    assert.ok(hit && hit.at - drainedAt <= 100);
    assert.strictEqual(throttle.tierDirty, false);
    clock.advance(30000);
    assert.ok(sent.filter(s => s.t === 'report.tier').length >= 3, 'tier refreshed every 30 s');
    throttle.stop();
});

test('report.state carries pause.origin, file.loadSeq and wcsSeq from the gate', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'g-'));
    const clock = createFakeClock();
    const engine = new FakeEngine({ controllerType: 'Grbl' });
    const gate = new RemoteCommandGate({
        store: createAtomicJsonStore(path.join(dir, 'cloud-link.json'), {}),
        logger: silentLogger(),
        getEngine: () => engine,
        auditFile: path.join(dir, 'audit.jsonl'),
        clock,
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
        setIntervalFn: clock.setInterval,
        clearIntervalFn: clock.clearInterval,
        hostLoadMonitor: new HostLoadMonitor({ clock }),
    });
    gate.attachEngine(engine);
    engine.loadedFile = { name: 'a.nc', total: 3, size: 20 };
    engine.startJob();
    gate.onLocalCommand('command', ['COM1', 'wcs:zero', {}]);
    gate.onLocalCommand('file:load', [{}]);
    gate.onLocalCommand('command', ['COM1', 'gcode:pause']);
    engine.pauseJob();
    const snap = gate.getTelemetry();
    assert.strictEqual(snap.pause.origin, 'local');
    assert.ok(Number.isFinite(snap.pause.since));
    assert.strictEqual(snap.file.loadSeq, 1);
    assert.strictEqual(snap.wcsSeq, 1);
    assert.deepStrictEqual(snap.link, { cloudRttMs: null, lanOnly: false });
    gate.dispose();
});

async function main() {
    console.log('=== CloudLink Telemetry Tests ===');
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
