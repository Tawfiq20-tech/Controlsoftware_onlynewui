'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeEngine, createFakeClock, silentLogger } = require('./helpers/fakeEngine');
const { JogDeadman } = require('../services/cloudLink/JogDeadman');
const { RemoteCommandGate, createAtomicJsonStore } = require('../services/cloudLink');
const { HostLoadMonitor } = require('../services/cloudLink/HostLoadMonitor');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-deadman-'));
const OWNER = Object.freeze({ kind: 'cloud', userId: 'u_aaaaaaaaaaaa', userLabel: 'Sam', connId: 'k_owner0000001' });
const OTHER = Object.freeze({ kind: 'cloud', userId: 'u_bbbbbbbbbbbb', userLabel: 'Kim', connId: 'k_other0000001' });

/** A JogDeadman wired to a simulated machine that travels at the commanded feed. */
function makeJog({ type = 'Grbl', simulate = true } = {}) {
    const clock = createFakeClock();
    const sim = { pos: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, statusAt: clock.mono(), feed: 0 };
    const h = { clock, sim, locks: [], tier: 'motion', jobActive: false, dispatched: [], cancels: [], activity: [] };
    h.jog = new JogDeadman({
        clock,
        setIntervalFn: clock.setInterval,
        clearIntervalFn: clock.clearInterval,
        getControllerType: () => type,
        getPosition: () => ({ ...sim.pos }),
        getTelemetryAgeMs: () => clock.mono() - sim.statusAt,
        getLocks: () => h.locks,
        getOwnerTier: () => h.tier,
        isJobActive: () => h.jobActive,
        onCancel: info => h.cancels.push(info),
        onActivity: a => h.activity.push(a),
        dispatch: (steps) => {
            for (const s of steps) {
                h.dispatched.push(s);
                if (s.fn === 'cmd' && s.cmd === 'jog') {
                    const p = s.args[0];
                    for (const axis of ['x', 'y', 'z']) if (p[axis] !== undefined) sim.target[axis] += p[axis];
                    sim.feed = p.feedRate;
                }
            }
            return { ok: true };
        },
    });
    // Advance in 10 ms slices: the machine moves toward its target and
    // reports telemetry each slice (unless simulate is false).
    h.run = (ms, { keepaliveEvery = 100, jogId = 'j_abcdef', owner = OWNER, onSlice } = {}) => {
        let sinceKeepalive = 0;
        for (let t = 0; t < ms; t += 10) {
            clock.advance(10);
            if (simulate) {
                const perSlice = (sim.feed / 60) * 0.01;
                for (const axis of ['x', 'y', 'z']) {
                    const d = sim.target[axis] - sim.pos[axis];
                    sim.pos[axis] += Math.sign(d) * Math.min(Math.abs(d), perSlice);
                }
                sim.statusAt = clock.mono();
            }
            sinceKeepalive += 10;
            if (keepaliveEvery && sinceKeepalive >= keepaliveEvery) {
                sinceKeepalive = 0;
                h.jog.keepalive(jogId, owner);
            }
            if (onSlice) onSlice();
        }
    };
    h.jogSteps = () => h.dispatched.filter(s => s.fn === 'cmd' && s.cmd === 'jog');
    return h;
}

function makeGate({ type = 'Grbl', engine = null } = {}) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'g-'));
    const clock = createFakeClock();
    const eng = engine || new FakeEngine({ controllerType: type });
    const audits = [];
    const gate = new RemoteCommandGate({
        store: createAtomicJsonStore(path.join(dir, 'cloud-link.json'), {}),
        logger: silentLogger(),
        getEngine: () => eng,
        auditFile: path.join(dir, 'remote-audit.jsonl'),
        onAudit: e => audits.push(e),
        clock,
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
        setIntervalFn: clock.setInterval,
        clearIntervalFn: clock.clearInterval,
        hostLoadMonitor: new HostLoadMonitor({ clock, setIntervalFn: clock.setInterval, clearIntervalFn: clock.clearInterval }),
    });
    gate.attachEngine(eng);
    eng.setStatus({ activeState: 'Idle' });
    gate.grantMotion(5, { kind: 'operator' }, { channel: 'cloud' });
    let seq = 0;
    const start = (identity = OWNER, jogId = 'j_abcdef') => gate.execute(identity, 'jog.cont.start',
        { jogId, axis: 'x', dir: 1, feed: 300 },
        { via: { relayTs: clock.wall(), clientRttMs: 20, clientSeq: ++seq, connId: identity.connId }, ttlMs: 500, relayOffsetMs: 0,
            effectiveRttMs: 50, linkFresh: true, cls: 'motion', idem: `c_${seq}`, seq });
    const cancelReasons = () => audits.filter(a => a.event === 'jog.cancel').map(a => a.args.reason);
    return { gate, engine: eng, clock, audits, start, cancelReasons };
}

// ─── ledger ───────────────────────────────────────────────────────────

test('keepalives keep steps flowing at the ledger rate with outstanding travel <= 2 x step', () => {
    for (const [type, feed, stepMm] of [['Grbl', 600, 2], ['RSP', 600, 1], ['Grbl', 120, 0.4]]) {
        const h = makeJog({ type });
        assert.deepStrictEqual(h.jog.start({ jogId: 'j_abcdef', identity: OWNER, axis: 'x', dir: 1, feed }), { ok: true, code: 'OK' });
        assert.strictEqual(h.jog.lease.stepMm, stepMm);
        let worst = 0;
        h.run(3000, {
            onSlice: () => {
                if (!h.jog.lease) return;
                worst = Math.max(worst, h.jog.lease.commandedMm - Math.abs(h.sim.pos.x));
            },
        });
        assert.ok(h.jog.isActive(), `${type} still jogging`);
        const travelled = h.sim.pos.x;
        const expected = (feed / 60) * 3;
        assert.ok(Math.abs(travelled - expected) <= 2 * stepMm + 0.01, `${type} travelled ${travelled} ~ ${expected}`);
        assert.ok(worst <= 2 * stepMm + 1e-9, `${type} outstanding ${worst} <= ${2 * stepMm}`);
        const steps = h.jogSteps();
        assert.ok(steps.every(s => Math.abs(s.args[0].x) === stepMm && s.args[0].feedRate === feed));
    }
});

test('telemetry stall stops issuing steps (ledger never runs ahead)', () => {
    const h = makeJog({ simulate: false });
    h.jog.start({ jogId: 'j_abcdef', identity: OWNER, axis: 'x', dir: 1, feed: 600 });
    // Telemetry is fresh but the machine never moves.
    for (let i = 0; i < 40; i++) { h.clock.advance(10); h.sim.statusAt = h.clock.mono(); if (i % 10 === 0) h.jog.keepalive('j_abcdef', OWNER); }
    assert.strictEqual(h.jogSteps().length, 1, 'only the first step while no progress is observed');
});

// ─── cancel triggers ──────────────────────────────────────────────────

test('no keepalive for 400 ms -> deadman cancel within 450 ms; stats increment', () => {
    const h = makeJog();
    h.jog.start({ jogId: 'j_abcdef', identity: OWNER, axis: 'x', dir: 1, feed: 300 });
    h.run(1000, { keepaliveEvery: 100 });
    const lastKeepalive = h.clock.mono();
    let cancelledAt = null;
    h.run(600, { keepaliveEvery: 0, onSlice: () => { if (cancelledAt === null && !h.jog.isActive()) cancelledAt = h.clock.mono(); } });
    assert.ok(cancelledAt !== null);
    assert.ok(cancelledAt - lastKeepalive > 400 && cancelledAt - lastKeepalive <= 450, `cancelled after ${cancelledAt - lastKeepalive}`);
    assert.strictEqual(h.cancels[0].reason, 'deadman');
    assert.strictEqual(h.jog.getStats().deadmanCancels, 1);
    assert.strictEqual(h.activity[h.activity.length - 1], null);
});

test('a keepalive arriving after the 400 ms window (before the next tick) cancels instead of reviving', () => {
    const h = makeJog();
    h.jog.start({ jogId: 'j_abcdef', identity: OWNER, axis: 'x', dir: 1, feed: 300 });
    h.run(500, { keepaliveEvery: 100 });
    const lastKeepalive = h.clock.mono();
    // Link stall: 420 ms without keepalives. The tick at +400 sees exactly
    // 400 ms (not expired); the next tick would run at +450.
    h.run(420, { keepaliveEvery: 0 });
    assert.strictEqual(h.clock.mono() - lastKeepalive, 420);
    assert.ok(h.jog.isActive(), 'no tick has expired it yet');
    const late = h.jog.keepalive('j_abcdef', OWNER);
    assert.deepStrictEqual(late, { ok: false, code: 'EXPIRED' });
    assert.strictEqual(h.jog.isActive(), false);
    assert.strictEqual(h.cancels[0].reason, 'deadman');
    assert.strictEqual(h.jog.getStats().deadmanCancels, 1);
    // A burst of further delayed keepalives cannot restart anything.
    assert.strictEqual(h.jog.keepalive('j_abcdef', OWNER).code, 'EXPIRED');
});

test('moving the wall clock back 10 s mid-jog does not delay the deadman', () => {
    const h = makeJog();
    h.jog.start({ jogId: 'j_abcdef', identity: OWNER, axis: 'x', dir: 1, feed: 300 });
    h.run(300);
    h.clock.stepWall(-10000);
    const t0 = h.clock.mono();
    let cancelledAt = null;
    h.run(600, { keepaliveEvery: 0, onSlice: () => { if (cancelledAt === null && !h.jog.isActive()) cancelledAt = h.clock.mono(); } });
    assert.ok(cancelledAt !== null && cancelledAt - t0 <= 450, 'deadman on mono clock');
    assert.strictEqual(h.cancels[0].reason, 'deadman');
});

test('stale telemetry, locks, tier loss, job start and max duration cancel with exact reasons', () => {
    const cases = [
        ['stale-telemetry', h => { h.sim.statusAt = h.clock.mono() - 600; h.clock.advance(50); }],
        ['lock', h => { h.locks = ['alarm']; h.clock.advance(50); }],
        ['tier', h => { h.tier = 'job'; h.clock.advance(50); }],
        ['job-active', h => { h.jobActive = true; h.clock.advance(50); }],
        ['max-duration', h => h.run(60100)],
    ];
    for (const [reason, trigger] of cases) {
        const h = makeJog();
        h.jog.start({ jogId: 'j_abcdef', identity: OWNER, axis: 'x', dir: 1, feed: 30 });
        h.run(100);
        trigger(h);
        assert.ok(!h.jog.isActive(), reason);
        assert.strictEqual(h.cancels[0].reason, reason);
    }
});

test('Grbl cancel sends jogcancel; double cancel is idempotent; lease conflict -> JOG_ACTIVE', () => {
    const h = makeJog({ type: 'Grbl' });
    h.jog.start({ jogId: 'j_abcdef', identity: OWNER, axis: 'x', dir: 1, feed: 300 });
    assert.strictEqual(h.jog.start({ jogId: 'j_second', identity: OTHER, axis: 'y', dir: 1, feed: 300 }).code, 'JOG_ACTIVE');
    assert.strictEqual(h.jog.keepalive('j_abcdef', OTHER).code, 'EXPIRED', 'only the owner keeps it alive');
    assert.strictEqual(h.jog.stopOwned(OTHER), false);
    assert.strictEqual(h.jog.cancel('owner-stop'), true);
    assert.strictEqual(h.jog.cancel('owner-stop'), false);
    assert.strictEqual(h.cancels.length, 1);
    assert.deepStrictEqual(h.dispatched.filter(s => s.fn === 'cmd' && s.cmd !== 'jog').map(s => s.cmd), ['jogcancel']);
});

test('RSP cancel: no jogcancel, no feedhold, host purge only', () => {
    const h = makeJog({ type: 'RSP' });
    h.jog.start({ jogId: 'j_abcdef', identity: OWNER, axis: 'x', dir: 1, feed: 300 });
    h.jog.cancel('link-down');
    const other = h.dispatched.filter(s => !(s.fn === 'cmd' && s.cmd === 'jog'));
    assert.deepStrictEqual(other, [{ fn: 'rspCancelPendingJogs' }]);
});

// ─── through the gate ─────────────────────────────────────────────────

test('onLinkDown(cloud) cancels synchronously; onClientGone cancels only that owner', () => {
    let g = makeGate();
    assert.strictEqual(g.start().status, 'accepted');
    g.gate.onLinkDown('cloud');
    assert.ok(!g.gate.isJogActive(), 'cancelled before any tick');
    assert.deepStrictEqual(g.cancelReasons(), ['link-down']);
    g.gate.dispose();

    g = makeGate();
    g.start(OWNER);
    g.gate.onClientGone(OTHER.connId);
    assert.ok(g.gate.isJogActive(), 'other connection gone: jog continues');
    g.gate.onClientGone(OWNER.connId);
    assert.ok(!g.gate.isJogActive());
    assert.deepStrictEqual(g.cancelReasons(), ['client-gone']);
    assert.deepStrictEqual(g.engine.commandNames().filter(c => c !== 'jog'), ['jogcancel']);
    g.gate.dispose();
});

test('alarm during jog -> cancel alarm; RTT sample 700 ms -> cancel latency', () => {
    let g = makeGate();
    g.start();
    g.engine.emitAlarm();
    assert.deepStrictEqual(g.cancelReasons(), ['alarm']);
    g.gate.dispose();

    g = makeGate();
    g.start();
    g.gate.onRttSample(250);
    assert.ok(g.gate.isJogActive());
    g.gate.onRttSample(700);
    assert.deepStrictEqual(g.cancelReasons(), ['latency']);
    g.gate.dispose();
});

test('real RSP stream: 2 unacked OP_JOG frames, link down, link recovery -> zero jog retransmits', () => {
    const { RSPController } = require('../services/controllers/RSPController');
    const { ReliableStream } = require('../services/rsp/stream');
    const { FrameParser } = require('../services/rsp/frame');
    const defs = require('../services/rsp/defs');

    const frames = [];
    const parser = new FrameParser();
    const transport = { send: (buf) => { for (const f of parser.feed(buf)) frames.push(f.payload[0]); }, on() {} };
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    const stream = new ReliableStream(transport, { logger: quiet });
    stream._setLink(true);
    const rsp = new RSPController();
    rsp.on('error', () => {});
    rsp.stream = stream;

    const engine = new FakeEngine({ controllerType: 'RSP' });
    engine.controller = rsp;
    const g = makeGate({ engine });
    assert.strictEqual(g.start().status, 'accepted', 'first step issued');
    // A second step once the first shows progress.
    g.clock.advance(50);
    engine.setStatus({ activeState: 'Jog', mpos: { x: 1, y: 0, z: 0 } });
    g.clock.advance(150);
    const jogFramesBefore = frames.filter(op => op === defs.OP_JOG).length;
    assert.strictEqual(jogFramesBefore, 2, 'two OP_JOG frames on the wire');
    assert.strictEqual([...stream._sent.values()].filter(p => p.payload[0] === defs.OP_JOG).length, 2, 'both unacked');

    g.gate.onLinkDown('cloud');
    stream._setLink(false, 'heartbeat');
    stream._setLink(true);
    stream._retransmitReady(Date.now() / 1000 + 60);
    assert.strictEqual(frames.filter(op => op === defs.OP_JOG).length, jogFramesBefore, 'no jog frame retransmitted after cancel');
    assert.ok(!frames.includes(defs.OP_FEED_HOLD), 'no feedhold on RSP jog cancel');
    stream.stop();
    g.gate.dispose();
});

async function main() {
    console.log('=== CloudLink Deadman Tests ===');
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
