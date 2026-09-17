'use strict';

/**
 * What the controller board does with jogs, diagonal jogs (OP_MOVE), probing,
 * homing, stops, the physical E-stop and a reboot -- firmware 0.2.0 (on the
 * machine) and 0.2.1 (source_0.2.1, amended 2026-09-17), through the real
 * sender stack (RSPController + ReliableStream) and the fake firmware's
 * personalities. The host-visible contract these pin is written up in the
 * Phase 2 contract "firmware-0.2.1.md"; the sender must work on both builds.
 *
 * Phase 1 findings behind each case:
 *   D2-1  a diagonal jog reported Idle with the start position while it ran,
 *         so a Resume pressed during it was planned "in place" and plunged
 *         diagonally through the work
 *   D2-3  a stop (OP_JOB_ABORT) during a jog left the board in Jog for good
 *   D2-M1 the jog STOP had no way to stop a jog in flight
 *   D2-M2 held jog keys piled up distance: the machine ran on after release
 *   D2-M3 a probe / move longer than 20 s looked like a dead link
 *   D2-4  G20 / G91 / F from one job carried into the next
 *   D2-5  the physical E-stop left the planner and job flags behind; a short
 *         press during probing / homing went unseen; a press during the
 *         driver power-up could read as a driver alarm
 *   D2-6  a reboot was invisible after a session that only probed or moved
 *         diagonally (the step counter stayed 0)
 * And from the review of the first 0.2.1 amendment: commands it held behind
 * a diagonal jog held the E-STOP behind them (every connect starts with a
 * feed hold), the move's late reply could answer a command of a new
 * connection, and a NaN move target became a NaN position.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const defs = require('../services/rsp/defs');
const codec = require('../services/rsp/codec');
const { FrameParser, FT_ACK, FT_RSP, FT_EVT, FT_HB } = require('../services/rsp/frame');
const { RSPController } = require('../services/controllers/RSPController');
const { ControllerRestartMonitor } = require('../services/ControllerRestartMonitor');
const { FakeFirmware, FakeConnection } = require('./helpers/fakeFirmware');

const flush = () => new Promise((r) => setImmediate(r));
async function advance(ms, step = 5) {
    for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); }
}
async function until(pred, maxMs, what, step = 5) {
    for (let t = 0; t <= maxMs; t += step) {
        if (pred()) return t;
        mock.timers.tick(step);
        await flush();
    }
    throw new Error(`timed out waiting for: ${what}`);
}

function rig(fwVersion, extra = {}) {
    const fw = new FakeFirmware({ fwVersion, legTimeScale: 1, ...extra });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    const log = [];
    const link = [];
    const pauses = [];
    ctrl.on('console', (m) => log.push(m));
    ctrl.on('error', () => {});
    ctrl.on('job:programPause', (p) => pauses.push(p));
    ctrl.bind(conn);
    ctrl.stream.on('link', (up) => link.push({ t: Date.now(), up }));
    ctrl.stream.on('gaveUp', (g) => link.push({ t: Date.now(), gaveUp: g.op }));
    // every frame the board sends, as the host receives it
    const frames = [];
    const parser = new FrameParser();
    conn.on('rawData', (buf) => {
        for (const f of parser.feed(buf)) {
            frames.push({ t: Date.now(), type: f.frameType, seq: f.seq, op: f.payload.length ? f.payload[0] : null, status: f.payload.length > 1 ? f.payload[1] : null });
        }
    });
    return { fw, conn, ctrl, log, link, pauses, frames, close() { ctrl.unbind(); fw.destroy(); } };
}

/** sendCommand, remembering how it settled. */
function send(r, op, payload, timeout = 60) {
    const out = { done: false, ok: null, err: null, rsp: null, seq: r.ctrl.stream._txSeq };
    r.ctrl.stream.sendCommand(op, payload, { timeout })
        .then((rsp) => { out.done = true; out.ok = true; out.rsp = rsp; })
        .catch((e) => { out.done = true; out.ok = false; out.err = e; });
    return out;
}

const onStep = (v) => Math.abs(v * 200 - Math.round(v * 200)) < 1e-3;
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

/** Job along X at Z-1, so a stop leaves the tool on a line boundary. */
function program(n) {
    const out = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    for (let i = 1; i <= n; i++) out.push(`G1 X${(i * 2).toFixed(3)} Y0.000 F600`);
    out.push('G0 Z5', 'M2');
    return out.join('\n');
}

// ---------------------------------------------------------------- D2-1
async function testDiagonalJogReportsJogging() {
    for (const v of ['0.2.0', '0.2.1']) {
        const r = rig(v);
        await advance(300);
        r.ctrl.command('jog', { x: 30, y: 30, feedRate: 1000 }); // OP_MOVE, ~2.5 s
        await advance(600);
        const st = r.ctrl.state.status;
        if (v === '0.2.0') {
            assert.strictEqual(st.state, defs.ST_IDLE, '0.2.0 reports Idle during OP_MOVE (the D2-1 hazard, modelled)');
            assert.deepStrictEqual(st.mpos, { x: 0, y: 0, z: 0 }, '0.2.0: position frozen at the start');
        } else {
            assert.strictEqual(st.state, defs.ST_JOGGING, '0.2.1 reports Jog while the diagonal jog moves');
            assert.strictEqual(st.dbgJogActive, 1, '0.2.1: the step engine is busy');
        }
        await until(() => r.fw.state === defs.ST_IDLE && near(r.fw.cur.x, 30) && near(r.fw.cur.y, 30), 10000, `${v}: diagonal jog ends`);
        assert.strictEqual(r.fw.powered, true, `${v}: drivers stay on after a diagonal jog`);
        r.close();
    }
    console.log('  ok  diagonal jog: 0.2.0 says Idle at the start position while moving, 0.2.1 says Jog');
}

async function testResumeDuringDiagonalJogNeverPlungesDiagonally() {
    const r = rig('0.2.1');
    r.ctrl.command('gcode:load', 'a.nc', program(60), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 12, 300000, '12 moves', 10);
    r.ctrl.command('gcode:pause');
    await until(() => r.fw.state === defs.ST_HOLD && !r.fw.leg, 20000, 'held, leg finished', 10);
    await advance(500);
    r.ctrl.command('gcode:stop');
    await advance(600);
    assert.ok(r.ctrl.getResumePoint().line > 1, 'resume point saved');
    r.ctrl.command('jog', { z: 6, feedRate: 1000 });
    await until(() => r.fw.state === defs.ST_JOGGING, 5000, 'Z jog started');
    await until(() => r.fw.state === defs.ST_IDLE && !r.fw.leg, 20000, 'Z jog done', 10);
    await advance(300);
    // diagonal jog 25/25 at 1000 mm/min (~2.1 s); Start pressed 400 ms in
    r.ctrl.command('jog', { x: 25, y: 25, feedRate: 1000 });
    await advance(400);
    const execBefore = r.fw.executed.length;
    const legs = [];
    r.ctrl.command('gcode:start');
    await until(() => {
        if (r.fw.leg && !r.fw.leg.jog && !legs.includes(r.fw.leg)) legs.push(r.fw.leg);
        return r.fw.executed.length >= execBefore + 4 || r.pauses.length > 0;
    }, 120000, 'resumed job moves', 5);
    if (r.pauses.length) {
        r.ctrl.command('gcode:resume');
        await until(() => {
            if (r.fw.leg && !r.fw.leg.jog && !legs.includes(r.fw.leg)) legs.push(r.fw.leg);
            return r.fw.executed.length >= execBefore + 4;
        }, 120000, 'resumed job moves after the spindle pause', 5);
    }
    assert.strictEqual(r.fw.moves.length, 1, 'the diagonal jog ran');
    assert.ok(legs.length >= 2, 'resumed legs seen');
    for (const l of legs) {
        const xy = Math.hypot(l.to.x - l.from.x, l.to.y - l.from.y);
        assert.ok(!(xy > 0.01 && l.to.z < l.from.z - 0.01),
            `no leg goes down while moving in X/Y: line ${l.line} from ${JSON.stringify(l.from)} to ${JSON.stringify(l.to)}`);
    }
    assert.ok(!r.log.some((m) => /already at X/.test(m)), 'the resume was not planned in place from the old X/Y');
    r.close();
    console.log('  ok  0.2.1: Start pressed during a diagonal jog lifts, travels and plunges straight -- no diagonal plunge');
}

// ---------------------------------------------------------------- D2-M3
async function testLongProbeAndMoveKeepTheLink() {
    const r = rig('0.2.1');
    await advance(500);
    // 30 mm at 60 mm/min: 30 s of probing, no contact
    const t0 = Date.now();
    let probe = null;
    r.ctrl.probeAxis(2, 1, 30, 60).then((p) => { probe = p; }).catch((e) => { probe = e; });
    await advance(200);
    const ack = r.frames.find((f) => f.type === FT_ACK && f.t >= t0);
    assert.ok(ack && ack.t - t0 < 100, 'OP_PROBE is ACKed as soon as it is accepted');
    await advance(1000);
    assert.strictEqual(r.ctrl.state.status.state, defs.ST_JOGGING, 'probing reports Jog');
    const statusDuring = r.fw.sentFrames;
    await advance(2000);
    assert.ok(r.fw.sentFrames > statusDuring + 10, 'EV_STATUS keeps coming while the probe blocks the firmware');
    await until(() => probe !== null, 60000, 'probe result');
    await advance(300);
    assert.ok(!(probe instanceof Error), `probe resolved: ${probe && probe.message}`);
    assert.strictEqual(probe.contact, false);
    assert.ok(near(probe.z, -30), `0.2.1 counts the Z probe the way it moved (z=${probe.z})`);
    assert.ok(r.ctrl.state.status.dbgTim2IsrCount >= 6000, 'the probe steps count towards the reboot-detection counter');

    let moved = null;
    r.ctrl._moveAbsolute(0, 25, -30, 60).then((m) => { moved = m; }).catch((e) => { moved = e; });
    await until(() => moved !== null, 60000, 'OP_MOVE result');
    assert.ok(!(moved instanceof Error), `25 s OP_MOVE resolved: ${moved && moved.message}`);
    assert.ok(!r.link.some((e) => e.up === false || e.gaveUp !== undefined), `link stayed up: ${JSON.stringify(r.link)}`);
    r.close();

    const h = rig('0.2.1', { homeMs: 25000 });
    await advance(500);
    const home = send(h, defs.OP_HOME, codec.buildHome(0x07), 40);
    await advance(300);
    assert.ok(h.frames.some((f) => f.type === FT_ACK && f.seq === home.seq), 'OP_HOME is ACKed at once');
    assert.strictEqual(h.fw.state, defs.ST_HOMING);
    await until(() => home.done, 40000, 'home result');
    assert.ok(home.ok, 'homing resolved');
    assert.ok(!h.link.some((e) => e.up === false || e.gaveUp !== undefined), `link stayed up while homing: ${JSON.stringify(h.link)}`);
    h.close();
    console.log('  ok  0.2.1: 30 s probe, 25 s OP_MOVE and 25 s homing are ACKed at once, keep telemetry flowing, never drop the link');
}

// ---------------------------------------------------------------- D2-M1 / D2-3
async function testJogCancel() {
    // 0.2.1: OP_JOB_ABORT 0xFFFF is the jog STOP
    {
        const r = rig('0.2.1');
        await advance(300);
        r.ctrl.command('jog', { x: 100, feedRate: 1000 }); // 6 s
        await advance(1000);
        assert.strictEqual(r.fw.state, defs.ST_JOGGING);
        const stop = send(r, defs.OP_JOB_ABORT, codec.buildJobAbort(0xFFFF));
        await until(() => stop.done, 1000, 'abort reply');
        assert.ok(stop.ok);
        assert.strictEqual(r.fw.state, defs.ST_IDLE, 'Idle at once');
        const x = r.fw.cur.x;
        assert.ok(x > 10 && x < 25 && onStep(x), `stopped part-way on a whole step (x=${x})`);
        assert.strictEqual(r.fw.powered, true, 'drivers still hold');
        await advance(3000);
        assert.strictEqual(r.fw.cur.x, x, 'nothing moves after the stop');
        const zero = send(r, defs.OP_ZERO, codec.buildZero(0x01));
        await until(() => zero.done, 1000, 'zero reply');
        assert.ok(zero.ok, 'zero accepted right after the stop');
        r.close();
    }
    // 0.2.1: the same stops a diagonal jog; its OP_MOVE is answered ERR_STATE
    {
        const r = rig('0.2.1');
        await advance(300);
        const mv = send(r, defs.OP_MOVE, codec.buildMove(60, 60, 0, 1000));
        await advance(1000);
        assert.strictEqual(r.fw.state, defs.ST_JOGGING);
        const stop = send(r, defs.OP_JOB_ABORT, codec.buildJobAbort(0xFFFF));
        await until(() => stop.done && mv.done, 1000, 'abort and move replies');
        assert.ok(stop.ok);
        assert.strictEqual(mv.ok, false);
        assert.strictEqual(mv.err.status, defs.ST_ERR_STATE, 'the stopped OP_MOVE is answered ST_ERR_STATE');
        assert.strictEqual(r.fw.state, defs.ST_IDLE);
        assert.ok(r.fw.cur.x > 5 && r.fw.cur.x < 60 && near(r.fw.cur.x, r.fw.cur.y, 0.006), `stopped on the diagonal (${JSON.stringify(r.fw.cur)})`);
        r.close();
    }
    // 0.2.0: the abort stops the jog but the board stays in Jog (D2-3) until a
    // jog too short to take a step (half a step = 0.0025 mm) lets it settle
    {
        const r = rig('0.2.0');
        await advance(300);
        r.ctrl.command('jog', { x: 100, feedRate: 1000 });
        await advance(1000);
        const stop = send(r, defs.OP_JOB_ABORT, codec.buildJobAbort(0xFFFF));
        await until(() => stop.done, 1000, 'abort reply');
        const x = r.fw.cur.x;
        await advance(3000);
        assert.strictEqual(r.fw.state, defs.ST_JOGGING, '0.2.0 stays in Jog after the abort');
        const zero = send(r, defs.OP_ZERO, codec.buildZero(0x01));
        await until(() => zero.done, 1000, 'zero reply');
        assert.strictEqual(zero.ok, false, '0.2.0 refuses zero while stuck in Jog');
        const up = send(r, defs.OP_JOG, codec.buildJog(0, 1, 0.001, 1000));
        await until(() => up.done && r.fw.state === defs.ST_IDLE, 1000, 'nudge +');
        const down = send(r, defs.OP_JOG, codec.buildJog(0, 0, 0.001, 1000));
        await until(() => down.done && r.fw.state === defs.ST_IDLE && !r.fw.leg, 1000, 'nudge -');
        assert.ok(near(r.fw.cur.x, x, 1e-5), `0.2.0 nudge pair returns to the stop position (${r.fw.cur.x} vs ${x})`);
        assert.strictEqual(r.fw.state, defs.ST_IDLE);
        r.close();
    }
    console.log('  ok  jog STOP: 0.2.1 JOB_ABORT(0xFFFF) -> Idle at the exact position; 0.2.0 needs a sub-step jog pair to leave Jog');
}

async function testStopAfterAlarmLostJobWhileJogging() {
    const r = rig('0.2.1');
    r.ctrl.command('gcode:load', 'job.nc', program(80), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 10 && r.fw.leg, 300000, 'mid-move');
    r.fw.injectAlarm(0);
    await advance(400);
    r.ctrl.command('unlock');
    await advance(500);
    assert.strictEqual(r.fw.state, defs.ST_IDLE);
    r.ctrl.command('jog', { z: 20, feedRate: 300 }); // 4 s
    await advance(600);
    assert.strictEqual(r.fw.state, defs.ST_JOGGING);
    r.ctrl.command('gcode:stop');
    await advance(500);
    assert.ok(r.fw.jobAborts >= 1, 'the lost job was aborted');
    assert.strictEqual(r.fw.state, defs.ST_IDLE, '0.2.1: a stop during the jog leaves the board Idle, not stuck in Jog');
    r.close();
    console.log('  ok  0.2.1: Stop pressed while jogging after an alarm-lost job leaves the machine Idle');
}

// ---------------------------------------------------------------- D2-M2
async function testJogsDoNotPileUp() {
    const results = {};
    for (const v of ['0.2.0', '0.2.1']) {
        const r = rig(v);
        await advance(300);
        const sent = [];
        for (let i = 0; i < 10; i++) {
            sent.push(send(r, defs.OP_JOG, codec.buildJog(0, 1, 10, 3000))); // 10 mm = 200 ms each
            await advance(20);
        }
        await until(() => sent.every((s) => s.done), 2000, `${v}: jog replies`);
        await until(() => r.fw.state === defs.ST_IDLE && !r.fw.leg, 20000, `${v}: jogs drain`);
        results[v] = { x: r.fw.cur.x, busy: sent.filter((s) => !s.ok && s.err && s.err.status === defs.ST_ERR_BUSY).length };
        r.close();
    }
    assert.strictEqual(results['0.2.0'].x, 100, '0.2.0 adds every press up (modelled)');
    assert.strictEqual(results['0.2.1'].x, 20, '0.2.1: the jog in flight plus one waiting');
    assert.strictEqual(results['0.2.1'].busy, 8, '0.2.1 answers the rest ST_ERR_BUSY');

    // held arrow key (keyboard continuous jog: a jog every 120 ms), 100 mm step
    const r = rig('0.2.1');
    await advance(300);
    const t0 = Date.now();
    r.ctrl.command('jog', { x: 100, feedRate: 2000 });
    const iv = setInterval(() => { if (Date.now() - t0 < 1000) r.ctrl.command('jog', { x: 100, feedRate: 3000 }); }, 120);
    await advance(1000);
    clearInterval(iv);
    const t = await until(() => r.fw.state === defs.ST_IDLE && !r.fw.leg, 30000, 'held-key jog drains', 20);
    assert.ok(r.fw.cur.x <= 200.001, `at most two steps of travel (x=${r.fw.cur.x})`);
    assert.ok(t < 5000, `stops within 5 s of release (${t} ms)`);
    r.close();
    console.log('  ok  jogs: 0.2.0 piles every press up; 0.2.1 runs the jog in flight plus one and answers BUSY to the rest');
}

// ---------------------------------------------------------------- F9: commands during OP_MOVE
async function testCommandsDuringOpMove() {
    const r = rig('0.2.1');
    await advance(300);
    const mv = send(r, defs.OP_MOVE, codec.buildMove(20, 0, 0, 600)); // 2 s
    await advance(300);
    const t1 = Date.now();
    // everything a sender might send meanwhile -- none of it may be held back
    const c = {
        status: send(r, defs.OP_GET_STATUS, Buffer.alloc(0)),
        hold: send(r, defs.OP_FEED_HOLD, Buffer.alloc(0)),
        resume: send(r, defs.OP_RESUME, Buffer.alloc(0)),
        override: send(r, defs.OP_SET_FEED_OVERRIDE, codec.buildFeedOverride(120)),
        unlock: send(r, defs.OP_UNLOCK, Buffer.alloc(0)),
        zero: send(r, defs.OP_ZERO, codec.buildZero(0x01)),
        jog: send(r, defs.OP_JOG, codec.buildJog(0, 1, 5, 1000)),
        move: send(r, defs.OP_MOVE, codec.buildMove(0, 30, 0, 600)),
        probe: send(r, defs.OP_PROBE, codec.buildProbe(2, 1, 5, 100)),
        home: send(r, defs.OP_HOME, codec.buildHome(0x07)),
        start: send(r, defs.OP_JOB_START, codec.buildJobStart(7, 10)),
        line: send(r, defs.OP_JOB_LINE, codec.buildJobLine(7, 1, 'G21 G90 G1 X50 F600')),
    };
    await advance(150);
    const cmds = Object.entries(c).filter(([k]) => k !== 'line');
    for (const [name, s] of cmds) assert.ok(s.done, `${name} is answered during the move, not held until it ends`);
    const acked = (s) => r.frames.some((f) => f.type === FT_ACK && f.seq === s.seq);
    for (const [name, s] of cmds) assert.ok(!acked(s), `${name}: a final reply, no ACK-and-wait`);
    assert.ok(r.frames.some((f) => f.seq === c.line.seq && f.t >= t1), 'the job line is answered at once too (NAK: no job)');
    const tel = new defs.Telemetry(c.status.rsp.payload.subarray(2));
    assert.strictEqual(tel.state, defs.ST_JOGGING);
    for (const k of ['hold', 'resume', 'override', 'unlock']) assert.ok(c[k].ok, `${k}: OK (nothing to hold or unlock while jogging)`);
    for (const k of ['zero', 'move', 'probe', 'home', 'start']) {
        assert.strictEqual(c[k].err && c[k].err.status, defs.ST_ERR_STATE, `${k}: refused (ST_ERR_STATE), as during any jog`);
    }
    assert.strictEqual(c.jog.err && c.jog.err.status, defs.ST_ERR_BUSY, 'OP_JOG: ST_ERR_BUSY, it cannot join the move');
    assert.ok(!mv.done && r.fw.state === defs.ST_JOGGING, 'the move is still running');
    // a stop sent after all of them acts at once
    const stop = send(r, defs.OP_JOB_ABORT, codec.buildJobAbort(0xFFFF));
    await until(() => stop.done && mv.done, 100, 'the stop and the stopped move answered at once', 1);
    assert.strictEqual(mv.err && mv.err.status, defs.ST_ERR_STATE);
    const x = r.fw.cur.x;
    assert.ok(x > 3 && x < 10 && onStep(x), `stopped part-way (x=${x})`);
    await advance(3000);
    assert.strictEqual(r.fw.state, defs.ST_IDLE);
    assert.strictEqual(r.fw.cur.x, x, 'nothing refused ran later: not zeroed, no jog, no second move');
    assert.strictEqual(r.fw.cur.y, 0);
    assert.strictEqual(r.fw.jobStarts || 0, 0, 'no job started');
    assert.strictEqual(r.fw.moves.length, 1);
    r.close();

    // the move's own reply comes when it ends; heartbeats are echoed meanwhile
    const q = rig('0.2.1');
    await advance(300);
    const t0 = Date.now();
    const mv2 = send(q, defs.OP_MOVE, codec.buildMove(20, 0, 0, 600));
    await advance(300);
    assert.ok(q.frames.some((f) => f.type === FT_ACK && f.seq === mv2.seq), 'OP_MOVE is ACKed at once');
    const hbSeen = q.frames.filter((f) => f.type === FT_HB).length;
    await advance(1500);
    assert.ok(q.frames.filter((f) => f.type === FT_HB).length > hbSeen, 'heartbeats are echoed during the move');
    await until(() => mv2.done, 3000, 'move reply');
    assert.ok(mv2.ok);
    assert.ok(q.frames.find((f) => f.type === FT_RSP && f.seq === mv2.seq).t - t0 >= 1900, 'its RSP came when it ended');
    q.close();

    // 0.2.0: nothing is answered during the move
    const o = rig('0.2.0');
    await advance(300);
    const mv3 = send(o, defs.OP_MOVE, codec.buildMove(20, 0, 0, 600));
    await advance(300);
    const st3 = send(o, defs.OP_GET_STATUS, Buffer.alloc(0));
    await advance(500);
    assert.ok(!st3.done, '0.2.0 answers nothing while OP_MOVE runs');
    await until(() => mv3.done && st3.done, 5000, '0.2.0 replies after the move');
    assert.ok(o.frames.find((f) => f.type === FT_RSP && f.seq === st3.seq).t >= o.frames.find((f) => f.type === FT_RSP && f.seq === mv3.seq).t);
    o.close();
    console.log('  ok  during a 0.2.1 OP_MOVE every command is answered at once (reads/stops act, the rest refused, jog BUSY); a stop behind them acts at once');
}

/**
 * The control software restarts or the USB cable is re-plugged while a
 * diagonal jog runs. Every connect starts with OP_FEED_HOLD; the first 0.2.1
 * amendment held it until the move ended, and the E-STOP behind it with it.
 */
async function testReconnectDuringOpMove() {
    // E-STOP right after reconnecting stops the move at once
    {
        const fw = new FakeFirmware({ fwVersion: '0.2.1', legTimeScale: 1 });
        const conn1 = new FakeConnection(fw);
        const c1 = new RSPController();
        c1.on('error', () => {});
        c1.bind(conn1);
        await advance(300);
        c1.command('jog', { x: 60, y: 60, feedRate: 600 }); // OP_MOVE, ~8.5 s
        await advance(1000);
        assert.strictEqual(fw.state, defs.ST_JOGGING);
        c1.unbind();
        conn1.isOpen = false;
        const conn2 = new FakeConnection(fw);
        const c2 = new RSPController();
        const log = [];
        c2.on('console', (m) => log.push(m));
        c2.on('error', () => {});
        c2.bind(conn2);
        await advance(300);
        assert.strictEqual(c2.firmwareVersion, '0.2.1', 'the connect-time GET_CONFIG is answered during the move');
        assert.strictEqual(c2.state.status.state, defs.ST_JOGGING, 'the new session sees the move running');
        const xBefore = fw.legProgress();
        c2.command('estop');
        await until(() => fw.state === defs.ST_ESTOP, 100, 'E-STOP acts at once after a reconnect', 1);
        assert.ok(xBefore < 0.5 && fw.cur.x > 5 && fw.cur.x < 40 && near(fw.cur.x, fw.cur.y, 0.006), `stopped part-way on the diagonal (${JSON.stringify(fw.cur)})`);
        c2.unbind();
        fw.destroy();
    }
    // the old session's move reply never answers a command of the new session
    {
        const fw = new FakeFirmware({ fwVersion: '0.2.1', legTimeScale: 1 });
        const conn1 = new FakeConnection(fw);
        const c1 = new RSPController();
        c1.on('error', () => {});
        c1.bind(conn1);
        await advance(300);
        const moveSeq = c1.stream._txSeq;
        c1.stream.sendCommand(defs.OP_MOVE, codec.buildMove(20, 0, 0, 600), { timeout: 60 }).catch(() => {}); // 2 s
        await advance(300);
        assert.ok(fw.movePending && fw.movePending.seq === moveSeq);
        c1.unbind();
        conn1.isOpen = false;
        // new session; USB drops every OP_ZERO reply until the move has ended
        const conn2 = new FakeConnection(fw);
        let dropZero = true;
        const seen = [];
        const parser = new FrameParser();
        const emit = conn2.emit.bind(conn2);
        conn2.emit = (ev, buf) => {
            if (ev === 'rawData') {
                for (const f of parser.feed(buf)) {
                    const op = f.payload.length ? f.payload[0] : null;
                    if (f.frameType === FT_RSP) seen.push({ seq: f.seq, op });
                    if (dropZero && f.frameType === FT_RSP && op === defs.OP_ZERO) return true;
                }
            }
            return emit(ev, buf);
        };
        const c2 = new RSPController();
        c2.on('error', () => {});
        c2.bind(conn2);
        await advance(200);
        const r2 = { ctrl: c2 };
        while (c2.stream._txSeq < moveSeq) {
            const p = send(r2, defs.OP_PING, Buffer.alloc(0));
            await until(() => p.done, 1000, 'ping');
        }
        const zero = send(r2, defs.OP_ZERO, codec.buildZero(0x01), 10);
        assert.strictEqual(zero.seq, moveSeq, 'the new command carries the old move\'s seq');
        await until(() => fw.state === defs.ST_IDLE && !fw.movePending, 5000, 'the old move ends');
        await advance(300);
        dropZero = false;
        await until(() => zero.done, 12000, 'zero reply');
        assert.strictEqual(zero.ok, false, `the zero is not reported done by the old move's reply${zero.ok ? ` (resolved OK by a reply echoing op 0x${zero.rsp.payload[0].toString(16)})` : ''}`);
        assert.strictEqual(zero.err.status, defs.ST_ERR_STATE, 'it gets its own answer: refused while the move ran');
        assert.ok(!seen.some((f) => f.op === defs.OP_MOVE), `no OP_MOVE reply reaches the new session (${JSON.stringify(seen.filter((f) => f.op === defs.OP_MOVE))})`);
        assert.strictEqual(fw.cur.x, 20, 'and nothing was zeroed');
        c2.unbind();
        fw.destroy();
    }
    console.log('  ok  0.2.1 reconnect during a diagonal jog: connect-time commands answered at once, E-STOP acts at once, the old move\'s reply is never delivered');
}

async function testEstopDuringOpMove() {
    const r = rig('0.2.1');
    await advance(300);
    const mv = send(r, defs.OP_MOVE, codec.buildMove(0, 40, 0, 1200)); // 2 s
    await advance(800);
    r.ctrl.command('estop');
    await until(() => mv.done, 1000, 'move reply');
    assert.strictEqual(mv.err && mv.err.status, defs.ST_ERR_ESTOP, 'the E-STOP button stops the diagonal jog at once');
    assert.strictEqual(r.fw.state, defs.ST_ESTOP);
    assert.ok(r.fw.cur.y > 10 && r.fw.cur.y < 20 && onStep(r.fw.cur.y), `exact stop position (y=${r.fw.cur.y})`);
    r.close();
    console.log('  ok  0.2.1: E-STOP during a diagonal jog stops it at once (0.2.0 finished the move first)');
}

// ---------------------------------------------------------------- D2-4
async function testModalStateDoesNotCarryIntoTheNextJob() {
    const legsOf = async (v) => {
        const r = rig(v, { legTimeScale: 0.01 });
        // raw protocol jobs under the controller: it must not stop them as orphans
        r.ctrl._abortOrphanJob = () => {};
        await advance(300);
        const run = async (id, lines) => {
            const s = send(r, defs.OP_JOB_START, codec.buildJobStart(id, lines.length));
            await until(() => s.done, 1000, 'job start');
            assert.ok(s.ok, `${v}: job ${id} started`);
            for (let i = 0; i < lines.length; i++) {
                const l = send(r, defs.OP_JOB_LINE, codec.buildJobLine(id, i + 1, lines[i]));
                await until(() => r.frames.some((f) => f.seq === l.seq && (f.type === FT_ACK || f.type === FT_RSP)), 1000, 'line ack');
            }
            const e = send(r, defs.OP_JOB_END, codec.buildJobEnd(id));
            await until(() => e.done && r.fw.state === defs.ST_IDLE, 10000, `${v}: job ${id} end`);
        };
        // job A leaves inch + incremental mode and a slow feed behind
        await run(1, ['G20 G91 G1 X0.1 F5']);
        const before = r.fw.executed.length;
        // job B restates nothing
        await run(2, ['G1 X10 Y5', 'G1 Z-1']);
        const legs = r.fw.executed.slice(before).map((e) => ({ to: e.to, feed: Math.round(e.feed) }));
        r.close();
        return legs;
    };
    const old = await legsOf('0.2.0');
    assert.ok(old[0].to.x > 200, `0.2.0 runs job B in inches, incremental (x=${old[0].to.x})`);
    assert.strictEqual(old[0].feed, 127, '0.2.0 runs job B at job A\'s feed');
    const now = await legsOf('0.2.1');
    assert.deepStrictEqual(now[0].to, { x: 10, y: 5, z: 0 }, '0.2.1: job B in mm, absolute');
    assert.deepStrictEqual(now[1].to, { x: 10, y: 5, z: -1 });
    assert.strictEqual(now[0].feed, 500, '0.2.1: job B at the default feed');
    console.log('  ok  G20/G91/F from job A: 0.2.0 carries them into job B, 0.2.1 starts every job in G21 G90 F500');
}

// ---------------------------------------------------------------- D2-5
async function testPhysicalEstop() {
    for (const v of ['0.2.0', '0.2.1']) {
        const r = rig(v, { legTimeScale: 1 });
        r.ctrl.command('gcode:load', 'job.nc', program(80), 0, {});
        await advance(50);
        r.ctrl.command('gcode:start');
        await until(() => r.fw.executedCount >= 8 && r.fw.leg && r.fw.ring.length > 0, 300000, `${v}: mid-job`);
        // look at the board before the sender reacts to the E-stop (it aborts the job itself)
        r.fw.txMuted = true;
        r.fw.injectPhysicalEstop();
        await advance(5, 1);
        assert.strictEqual(r.fw.state, defs.ST_ESTOP);
        assert.strictEqual(r.fw.powered, false);
        assert.ok(onStep(r.fw.cur.x), `${v}: the steps taken are kept`);
        if (v === '0.2.0') {
            assert.strictEqual(r.fw.jobActive, true, '0.2.0: the job stays active after a physical E-stop (modelled)');
            assert.ok(r.fw.ring.length > 0, '0.2.0: the planner keeps its moves');
        } else {
            assert.strictEqual(r.fw.jobActive, false, '0.2.1: the job is cleared like the E-STOP button does');
            assert.strictEqual(r.fw.ring.length, 0, '0.2.1: the planner is cleared');
            assert.deepStrictEqual(r.fw.planned, r.fw.cur, '0.2.1: planned = the stop position');
        }
        r.fw.txMuted = false;
        const u1 = send(r, defs.OP_UNLOCK, Buffer.alloc(0));
        await until(() => u1.done, 1000, 'unlock reply');
        assert.strictEqual(r.fw.state, defs.ST_ESTOP, `${v}: no unlock while the button is still pressed`);
        r.fw.releasePhysicalEstop();
        const u2 = send(r, defs.OP_UNLOCK, Buffer.alloc(0));
        await until(() => u2.done, 1000, 'unlock reply');
        assert.strictEqual(r.fw.state, defs.ST_IDLE, `${v}: unlock once released`);
        r.close();
    }
    console.log('  ok  physical E-stop: position kept, unlock waits for the button; 0.2.1 also clears the job and planner');
}

/**
 * A short press of the physical E-stop (or a noise edge): the interrupt cut
 * the drivers and latched E-stop, but the input already reads released when
 * the blocking probe / homing loop next looks at it.
 */
async function testShortEstopPressDuringProbeAndHome() {
    {
        const r = rig('0.2.1');
        await advance(500);
        let probe = null;
        r.ctrl.probeAxis(2, 1, 30, 60).then((p) => { probe = p; }).catch((e) => { probe = e; }); // Z down, 30 s
        await advance(2000);
        r.fw.injectPhysicalEstop();
        r.fw.releasePhysicalEstop();
        await until(() => probe !== null, 100, '0.2.1: the probe stops at once', 1);
        assert.ok(probe instanceof Error && /ESTOP/.test(probe.message), `0.2.1: the probe is answered E-stop (${probe && probe.message})`);
        assert.strictEqual(r.fw.state, defs.ST_ESTOP);
        assert.ok(r.fw.cur.z < -1.9 && r.fw.cur.z > -2.2 && onStep(r.fw.cur.z), `0.2.1: z is where the probe really stopped (${r.fw.cur.z})`);
        const u = send(r, defs.OP_UNLOCK, Buffer.alloc(0));
        await until(() => u.done, 500, 'unlock');
        assert.strictEqual(r.fw.state, defs.ST_IDLE, 'unlock works once released');
        r.close();
    }
    {
        const h = rig('0.2.1', { homeMs: 10000 });
        await advance(500);
        const home = send(h, defs.OP_HOME, codec.buildHome(0x07), 20);
        await advance(1000);
        h.fw.injectPhysicalEstop();
        h.fw.releasePhysicalEstop();
        await until(() => home.done, 100, '0.2.1: homing stops at once', 1);
        assert.strictEqual(home.err && home.err.status, defs.ST_ERR_ESTOP, '0.2.1: homing is answered E-stop');
        assert.strictEqual(h.fw.state, defs.ST_ESTOP, '0.2.1: the latched E-stop is kept, not overwritten by the end of homing');
        h.close();
    }
    {
        // 0.2.0 (modelled): the loop only reads the input, so it keeps stepping into the disabled drivers
        const o = rig('0.2.0');
        await advance(500);
        let probe = null;
        o.ctrl.probeAxis(2, 1, 30, 60).then((p) => { probe = p; }).catch((e) => { probe = e; });
        await advance(2000);
        o.fw.injectPhysicalEstop();
        o.fw.releasePhysicalEstop();
        await advance(1000);
        assert.strictEqual(probe, null, '0.2.0 keeps probing after a short E-stop press (modelled)');
        o.close();
    }
    console.log('  ok  0.2.1: a short E-stop press stops a probe or homing at once with the real position; 0.2.0 probed on');
}

/** E-stop pressed while the drivers power up (~0.5 s): an E-stop, never a driver alarm. */
async function testEstopDuringDriverPowerUp() {
    for (const v of ['0.2.0', '0.2.1']) {
        const r = rig(v, { powerOnMs: 500 });
        await advance(300);
        // drivers whose enable the E-stop cut may raise their alarm output
        r.fw.almAtEnable = 1;
        const jog = send(r, defs.OP_JOG, codec.buildJog(0, 1, 10, 1000));
        await advance(200);
        r.fw.injectPhysicalEstop();
        r.fw.releasePhysicalEstop();
        await until(() => jog.done, 1000, `${v}: jog reply`);
        await advance(300);
        const faultEvents = r.frames.filter((f) => f.type === FT_EVT && f.op === defs.EV_FAULT).length;
        if (v === '0.2.1') {
            assert.strictEqual(jog.err && jog.err.status, defs.ST_ERR_ESTOP, '0.2.1: the jog is answered E-stop');
            assert.strictEqual(r.fw.state, defs.ST_ESTOP, '0.2.1: state E-stop');
            assert.strictEqual(faultEvents, 0, '0.2.1: no driver-alarm event');
            assert.strictEqual(r.fw.faultLatched, 0, '0.2.1: no latched driver fault');
        } else {
            assert.strictEqual(jog.err && jog.err.status, defs.ST_ERR_FAULT, '0.2.0 reports a driver alarm instead (modelled)');
            assert.strictEqual(faultEvents, 1);
        }
        assert.strictEqual(r.fw.powered, false, `${v}: drivers off`);
        assert.strictEqual(r.fw.cur.x, 0, `${v}: nothing moved`);
        r.close();
    }
    console.log('  ok  E-stop during the driver power-up: 0.2.1 reports the E-stop; 0.2.0 reported a driver alarm');
}

/** OP_MOVE targets: NaN or absurd numbers are refused, real machine positions are not. */
async function testMoveTargetMustBeARealPosition() {
    const r = rig('0.2.1');
    await advance(300);
    for (const [x, y, z] of [[NaN, 10, 0], [0, 1e30, 0], [0, 0, -Infinity], [10001, 0, 0]]) {
        const m = send(r, defs.OP_MOVE, codec.buildMove(x, y, z, 600));
        await until(() => m.done, 100, 'refusal');
        assert.strictEqual(m.err && m.err.status, defs.ST_ERR_CMD, `0.2.1 refuses the target ${x}/${y}/${z}`);
        assert.ok(!r.frames.some((f) => f.type === FT_ACK && f.seq === m.seq), 'refused without an ACK');
    }
    assert.strictEqual(r.fw.state, defs.ST_IDLE);
    assert.deepStrictEqual(r.fw.cur, { x: 0, y: 0, z: 0 }, 'nothing moved, the position is still a number');
    // the far corner of the largest machine profile (1245 x 838 mm) is fine
    const far = send(r, defs.OP_MOVE, codec.buildMove(1240, 830, 0, 3000));
    await advance(100);
    assert.ok(r.frames.some((f) => f.type === FT_ACK && f.seq === far.seq) && r.fw.state === defs.ST_JOGGING, '0.2.1 accepts a far but real target');
    const stop = send(r, defs.OP_JOB_ABORT, codec.buildJobAbort(0xFFFF));
    await until(() => stop.done && far.done, 200, 'stop');
    r.close();

    // 0.2.0 (modelled): a NaN axis takes no steps and the finished move sets it to NaN
    const o = rig('0.2.0');
    await advance(300);
    const m = send(o, defs.OP_MOVE, codec.buildMove(NaN, 5, 0, 600));
    await until(() => m.done, 3000, '0.2.0 move');
    assert.ok(m.ok && Number.isNaN(o.fw.cur.x) && near(o.fw.cur.y, 5), `0.2.0 accepts it and x becomes NaN (modelled): ${JSON.stringify(o.fw.cur)}`);
    o.close();
    console.log('  ok  OP_MOVE: 0.2.1 refuses NaN / infinite / beyond-10 m targets and accepts a real far corner; 0.2.0 set x to NaN');
}

// ---------------------------------------------------------------- power-up (D2-7)
async function testDriverPowerUpAfterStop() {
    const r = rig('0.2.0', { legTimeScale: 0.3, powerOnMs: 500 });
    const prog = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    for (let i = 1; i <= 200; i++) prog.push(`G1 X${(i * 0.5).toFixed(3)} Y0.000 F1200`);
    prog.push('G0 Z5', 'M5', 'M2');
    r.ctrl.command('gcode:load', 'job.nc', prog.join('\n'), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 50, 300000, '50 moves', 10);
    r.ctrl.command('gcode:stop');
    await advance(800);
    assert.strictEqual(r.fw.powered, false, '0.2.0 powers the drivers off at Stop');
    const resumeLine = r.ctrl.getResumePoint().line;
    assert.ok(resumeLine > 1);
    r.fw.almAtEnable = 1; // Y1 driver alarm when they come on again
    r.ctrl.command('gcode:start');
    await until(() => r.fw.state === defs.ST_ALARM, 20000, 'alarm at power-up', 10);
    await advance(500);
    assert.ok(r.log.some((m) => /already active when the drivers were enabled/.test(m)), 'EV_FAULT code 2 reported');
    assert.strictEqual(r.ctrl.getResumePoint().line, resumeLine, 'the resume point did not move: nothing ran');
    r.ctrl.command('unlock');
    await advance(800);
    const pausesBefore = r.pauses.length;
    r.ctrl.command('gcode:start');
    await until(() => (!r.ctrl.job.active && r.fw.state === defs.ST_IDLE && r.fw.executedCount > 200) || r.pauses.length > pausesBefore, 600000, 'resumed job', 10);
    if (r.pauses.length > pausesBefore) {
        await advance(400);
        r.ctrl.command('gcode:resume');
        await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 600000, 'resumed job end', 10);
    }
    const xs = new Set(r.fw.executed.map((e) => Math.round(e.to.x * 1000)));
    for (let i = 1; i <= 200; i++) assert.ok(xs.has(i * 500), `X${(i * 0.5).toFixed(3)} was cut`);
    r.close();
    console.log('  ok  0.2.0 Start after Stop (drivers off, 0.5 s power-up): an alarm at power-up loses nothing, the job resumes and finishes');
}

// ---------------------------------------------------------------- D2-6
async function testRebootDetectedAfterProbeOnlySession() {
    const counts = {};
    for (const v of ['0.2.0', '0.2.1']) {
        const r = rig(v, { legTimeScale: 0.05 });
        await advance(500);
        let p = null;
        r.ctrl.probeAxis(2, 1, 5, 100).then((x) => { p = x; }).catch((e) => { p = e; });
        await until(() => p !== null, 20000, `${v}: probe`);
        await advance(300);
        counts[v] = r.ctrl.state.status.dbgTim2IsrCount;
        if (v === '0.2.1') {
            const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fwreboot-')), 'last_seen.json');
            const m = new ControllerRestartMonitor(file);
            m.onBind();
            m.onStatus(r.ctrl.state.status);
            m.onConnectionLost(null);
            const cfg1 = send(r, defs.OP_GET_CONFIG, Buffer.alloc(0));
            await until(() => cfg1.done, 1000, 'config');
            const before = JSON.parse(cfg1.rsp.payload.subarray(2).toString('utf8'));
            r.fw.simulateReboot();
            await advance(500);
            m.onBind();
            const restart = m.onStatus(r.ctrl.state.status);
            assert.ok(restart, 'the reboot is detected by the step counter going back to 0');
            const cfg2 = send(r, defs.OP_GET_CONFIG, Buffer.alloc(0));
            await until(() => cfg2.done, 2000, 'config after reboot');
            const after = JSON.parse(cfg2.rsp.payload.subarray(2).toString('utf8'));
            assert.ok(/^[0-9a-f]{8}$/.test(before.boot_id) && before.boot_id !== after.boot_id, `boot_id changes (${before.boot_id} -> ${after.boot_id})`);
            assert.ok(after.uptime_ms < before.uptime_ms, 'uptime_ms starts again');
        }
        r.close();
    }
    assert.strictEqual(counts['0.2.0'], 0, '0.2.0: probing leaves the step counter at 0 (modelled)');
    assert.ok(counts['0.2.1'] >= 1000, `0.2.1: probe steps are counted (${counts['0.2.1']})`);
    console.log('  ok  reboot after a probe-only session: 0.2.0 counter stays 0; 0.2.1 counts probe steps and changes boot_id');
}

(async () => {
    console.log('Testing jog / move / probe / home / stop / E-stop / reboot on firmware 0.2.0 and 0.2.1...');
    await testDiagonalJogReportsJogging();
    await testResumeDuringDiagonalJogNeverPlungesDiagonally();
    await testLongProbeAndMoveKeepTheLink();
    await testJogCancel();
    await testStopAfterAlarmLostJobWhileJogging();
    await testJogsDoNotPileUp();
    await testCommandsDuringOpMove();
    await testReconnectDuringOpMove();
    await testEstopDuringOpMove();
    await testModalStateDoesNotCarryIntoTheNextJob();
    await testPhysicalEstop();
    await testShortEstopPressDuringProbeAndHome();
    await testEstopDuringDriverPowerUp();
    await testMoveTargetMustBeARealPosition();
    await testDriverPowerUpAfterStop();
    await testRebootDetectedAfterProbeOnlySession();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
