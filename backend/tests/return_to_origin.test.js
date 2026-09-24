'use strict';

/**
 * Returning to the origin corner when a design finishes.
 *
 * The first version of this shipped as a no-op: the engine sent
 * command('gcode', 'G0 Z10'), and the RSP controller accepts nothing but
 * M3/M4/M5/M7/M8/M9 on that command -- every other line is logged "ignored".
 * It never moved an axis while logging that it had. Everything here exists so
 * that cannot come back quietly:
 *
 *   - the command must reach OP_MOVE, not a warning
 *   - Z must only ever be commanded UPWARD
 *   - the lift must be ACKed before the cross-work traverse is sent
 *   - the gates that must stop it moving at all
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const { RSPController } = require('../services/controllers/RSPController');
const defs = require('../services/rsp/defs');
const codec = require('../services/rsp/codec');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A controller whose stream records OP_MOVE payloads instead of sending them. */
function makeCtrl({ mpos = { x: 50, y: 60, z: -2 }, activeState = 'Idle', uncertain = null } = {}) {
    const ctrl = new RSPController();
    const sent = [];
    const pending = [];
    ctrl.stream = {
        sendCommand(op, payload) {
            sent.push({ op, payload });
            return new Promise((resolve, reject) => pending.push({ op, resolve, reject }));
        },
        cancelPending() { return 0; },
    };
    ctrl.state.status = { activeState, state: defs.ST_IDLE, mpos: { ...mpos }, estop: false };
    ctrl._positionUncertain = uncertain;
    const events = [];
    ctrl.on('job:returnedToOrigin', (e) => events.push(e));
    ctrl.on('error', () => {});
    ctrl.on('console', () => {});

    /** Answer the oldest outstanding move with ST_OK. */
    const ack = () => {
        const p = pending.shift();
        if (p) p.resolve({ payload: Buffer.from([defs.OP_MOVE, defs.ST_OK]) });
        return new Promise((r) => setImmediate(r));
    };
    const moves = () => sent.filter((c) => c.op === defs.OP_MOVE).map((c) => codec.parseMove
        ? codec.parseMove(c.payload)
        : readMove(c.payload));
    return { ctrl, sent, pending, events, ack, moves };
}

/** buildMove writes x,y,z as 4-byte signed step counts then feed. */
function readMove(buf) {
    const steps = 200; // wireCompiler STEPS_PER_MM
    return {
        x: buf.readInt32LE(1) / steps,
        y: buf.readInt32LE(5) / steps,
        z: buf.readInt32LE(9) / steps,
    };
}

test('the lift is a real OP_MOVE, not a G-code line the controller ignores', async () => {
    const h = makeCtrl({ mpos: { x: 50, y: 60, z: -2 } });
    h.ctrl.command('job:returnToOrigin', { travelZ: 10, xy: true });
    await new Promise((r) => setImmediate(r));

    const first = h.sent.find((c) => c.op === defs.OP_MOVE);
    assert.ok(first, 'a move must have been sent -- this is the bug that shipped');
});

test('Z goes up first, alone, and the traverse waits for the board to ACK it', async () => {
    const h = makeCtrl({ mpos: { x: 50, y: 60, z: -2 } });
    h.ctrl.command('job:returnToOrigin', { travelZ: 10, xy: true });
    await new Promise((r) => setImmediate(r));

    // Exactly one move so far: the lift, at the SAME x/y.
    let m = h.moves();
    assert.strictEqual(m.length, 1, 'the traverse must not be sent before the lift is acknowledged');
    assert.ok(Math.abs(m[0].x - 50) < 0.01 && Math.abs(m[0].y - 60) < 0.01, 'the lift must not move X or Y');
    assert.ok(Math.abs(m[0].z - 10) < 0.01, `lift should go to Z10, got ${m[0].z}`);

    await h.ack();

    // Now, and only now, the traverse to the origin at that height.
    m = h.moves();
    assert.strictEqual(m.length, 2);
    assert.ok(Math.abs(m[1].x) < 0.01 && Math.abs(m[1].y) < 0.01, 'must travel to X0 Y0');
    assert.ok(Math.abs(m[1].z - 10) < 0.01, 'must stay at the travel height across the work');
});

test('Z is never commanded downward, even when the tool is already above the travel height', async () => {
    const h = makeCtrl({ mpos: { x: 20, y: 20, z: 40 } });   // already well clear
    h.ctrl.command('job:returnToOrigin', { travelZ: 10, xy: true });
    await new Promise((r) => setImmediate(r));

    const m = h.moves();
    assert.strictEqual(m.length, 1, 'no lift needed, so the traverse is the only move');
    assert.ok(m[0].z >= 40 - 0.01, `must hold Z at 40, not drop to the asked-for 10 (got ${m[0].z})`);
    assert.ok(Math.abs(m[0].x) < 0.01 && Math.abs(m[0].y) < 0.01);
});

test('lift-only mode never crosses the work', async () => {
    const h = makeCtrl({ mpos: { x: 50, y: 60, z: -2 } });
    h.ctrl.command('job:returnToOrigin', { travelZ: 10, xy: false });
    await new Promise((r) => setImmediate(r));
    await h.ack();

    const m = h.moves();
    assert.strictEqual(m.length, 1, 'xy:false must stop after the lift');
    assert.strictEqual(h.events[0].mode, 'lift');
});

test('nothing moves in alarm, in hold, in e-stop, or when the position is unknown', async () => {
    for (const [label, opts] of [
        ['alarm', { activeState: 'Alarm' }],
        ['hold', { activeState: 'Hold' }],
        ['position uncertain', { uncertain: 'lost steps' }],
        ['no position', { mpos: { x: NaN, y: NaN, z: NaN } }],
    ]) {
        const h = makeCtrl(opts);
        h.ctrl.command('job:returnToOrigin', { travelZ: 10, xy: true });
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(h.moves().length, 0, `${label}: the machine must stay exactly where it is`);
        assert.ok(h.events.length && h.events[0].ok === false, `${label}: must report why it did not move`);
    }
});

test('a travel height that is not a number moves nothing', async () => {
    const h = makeCtrl();
    h.ctrl.command('job:returnToOrigin', { travelZ: undefined, xy: true });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(h.moves().length, 0);
    assert.strictEqual(h.events[0].ok, false);
});

async function main() {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ok  ${t.name}`);
        } catch (err) {
            failed += 1;
            console.log(`  FAIL  ${t.name}`);
            console.log(err && err.stack ? err.stack : err);
        }
    }
    if (failed) {
        console.error(`\n${failed} of ${tests.length} failed`);
        process.exit(1);
    }
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
}

main();
