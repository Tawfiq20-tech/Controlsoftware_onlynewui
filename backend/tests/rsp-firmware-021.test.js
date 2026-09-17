'use strict';

/**
 * The sender on firmware 0.2.1 (shortcut/firmware/source_0.2.1).
 *
 * The job-streaming changes of 0.2.1 the sender can see, run on the fake
 * firmware's '0.2.1' personality (tests/helpers/fakeFirmware.js):
 *   F4  OP_JOB_ABORT and the end of a job leave the drivers powered (Z holds
 *       instead of being free to sag). A driver fault still powers off.
 *   F5  a no-motion job line (M3, G17, ...) is reported executed after the
 *       moves received before it, not the moment it arrives. Firmware:
 *       it rides on the newest queued move, or on the leg in flight.
 *   F8  GET_CONFIG says "0.2.1".
 * Plus the probe wire contract: OP_PROBE's Z direction bit stays inverted on
 * the wire for 0.2.1 too (rsp_handle_probe converts it), so the sender's Z
 * flip must stay -- without it a Z probe drives up for its whole travel.
 * The jog / OP_MOVE / probe / E-stop / reboot changes (F9-F15) are covered by
 * firmware_motion_commands.test.js.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const defs = require('../services/rsp/defs');
const { RSPController } = require('../services/controllers/RSPController');
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

/** Moves along X, with no-motion lines (M3, G17) after every `every` moves. */
function program(nMoves, header = [], every = 0) {
    const out = ['G21', 'G90', ...header, 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    for (let i = 1; i <= nMoves; i++) {
        out.push(`G1 X${(i * 0.5).toFixed(3)} Y0.000 F1200`);
        if (every && i % every === 0) out.push('M3 S12000', 'G17');
    }
    out.push('G0 Z5', 'M5', 'M2');
    return out.join('\n');
}

function rig(extra = {}) {
    const fw = new FakeFirmware({ fwVersion: '0.2.1', legTimeScale: 0.3, ...extra });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    const log = [];
    const pauses = [];
    ctrl.on('console', (m) => log.push(m));
    ctrl.on('error', () => {});
    ctrl.on('job:programPause', (p) => pauses.push(p));
    ctrl.bind(conn);
    return { fw, conn, ctrl, log, pauses, close() { ctrl.unbind(); fw.destroy(); } };
}

const idle = (r) => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE;

function assertMonotonic(r, what) {
    for (const o of r.fw.execOrders) {
        for (let i = 1; i < o.length; i++) {
            assert.ok(o[i] >= o[i - 1], `${what}: EV_EXECUTED went backwards ${o[i - 1]} -> ${o[i]} at #${i}`);
        }
    }
}

/** Resume after a stop: a file with M3 pauses for the spindle first -- press Resume like the operator. */
async function finishResumedJob(r, pausesBefore, what) {
    await until(() => idle(r) || r.pauses.length > pausesBefore, 600000, `${what}: resume starts`);
    if (r.pauses.length > pausesBefore) { await advance(400); r.ctrl.command('gcode:resume'); }
    await until(idle.bind(null, r), 600000, `${what}: job end`);
}

async function testVersion() {
    const r = rig();
    await advance(500);
    assert.strictEqual(r.ctrl.firmwareVersion, '0.2.1');
    assert.ok(r.log.some((m) => m.includes('Controller firmware: 0.2.1')));
    r.close();
    console.log('  ok  0.2.1 is accepted and shown');
}

async function testPlainRunWithNoMotionLines() {
    const r = rig();
    r.ctrl.command('gcode:load', 'job.nc', program(300, ['M3 S10000'], 25), 0, {});
    assert.ok(r.ctrl.lastLoadResult.ok, JSON.stringify(r.ctrl.lastLoadResult));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(idle.bind(null, r), 300000, 'job end');
    assert.strictEqual(r.fw.executedCount, 304, 'every move ran');
    assert.strictEqual(r.fw.jobStarts, 1);
    assert.ok(!r.fw.bufferNaks, `no planner-full NAKs (${r.fw.bufferNaks})`);
    assertMonotonic(r, 'plain run');
    assert.strictEqual(r.fw.powered, true, 'drivers still powered after the job ended');
    assert.strictEqual(r.ctrl.getResumePoint().line, 0, 'finished job clears the resume point');
    r.close();
    console.log('  ok  a job with no-motion lines runs to the end; reports stay in order, drivers stay on');
}

async function testPauseResume() {
    const r = rig();
    r.ctrl.command('gcode:load', 'job.nc', program(300, [], 10), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 40, 120000, '40 moves');
    r.ctrl.command('gcode:pause');
    await advance(1000);
    const held = r.fw.executedCount;
    assert.strictEqual(r.fw.state, defs.ST_HOLD);
    await advance(8000);
    assert.ok(r.fw.executedCount - held <= 1, 'no cutting while held');
    r.ctrl.command('gcode:resume');
    await until(idle.bind(null, r), 300000, 'job end after pause');
    assert.strictEqual(r.fw.executedCount, 304);
    assertMonotonic(r, 'pause/resume');
    r.close();
    console.log('  ok  pause and resume');
}

async function testProgramPause() {
    const r = rig();
    r.ctrl.command('gcode:load', 'job.nc', program(200, ['M0 (MSG, Check the spindle)'], 20), 0, { honorProgramPauses: true });
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.pauses.length > 0, 60000, 'program pause');
    await advance(400);
    assert.strictEqual(r.fw.state, defs.ST_HOLD, 'held at M0');
    const atPause = r.fw.executedCount;
    await advance(6000);
    assert.strictEqual(r.fw.executedCount, atPause);
    r.ctrl.command('gcode:resume');
    await until(idle.bind(null, r), 300000, 'job end after M0');
    assert.strictEqual(r.fw.executedCount, 204);
    r.close();
    console.log('  ok  M0 program pause holds and continues');
}

async function testStopResume() {
    const r = rig();
    r.ctrl.command('gcode:load', 'job.nc', program(300, [], 7), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 50, 120000, '50 moves');
    r.ctrl.command('gcode:stop');
    await advance(600);
    assert.strictEqual(r.fw.state, defs.ST_IDLE, 'stop leaves the machine idle');
    assert.strictEqual(r.fw.powered, true, 'drivers still powered after Stop');
    const afterStop = r.fw.executedCount;
    await advance(3000);
    assert.strictEqual(r.fw.executedCount, afterStop, 'nothing moves after a stop');
    assert.ok(r.ctrl.getResumePoint().line > 1, 'resume point saved');
    const pausesBefore = r.pauses.length;
    r.ctrl.command('gcode:start');
    await finishResumedJob(r, pausesBefore, 'stop');
    assertMonotonic(r, 'stop/resume');
    r.close();
    console.log('  ok  Stop keeps the drivers on and the job resumes to the end');
}

async function testAlarmResume() {
    const r = rig({ legTimeScale: 1 });
    r.ctrl.command('gcode:load', 'job.nc', program(200, [], 5), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 30 && r.fw.leg, 300000, 'mid-move');
    const interrupted = r.fw.leg.line;
    r.fw.injectAlarm(0);
    await advance(400);
    assert.strictEqual(r.ctrl._resumeLine, interrupted, 'exact resume point');
    assert.strictEqual(r.fw.powered, false, 'a driver fault still powers off');
    const p = r.ctrl.stream.sendCommand(defs.OP_UNLOCK, Buffer.alloc(0), { timeout: 5 }).catch(() => {});
    await advance(500);
    await p;
    const pausesBefore = r.pauses.length;
    r.ctrl.command('gcode:start');
    await finishResumedJob(r, pausesBefore, 'alarm');
    assert.ok(r.fw.executedCount >= 200);
    r.close();
    console.log('  ok  a driver alarm still powers off; the job resumes from the exact line');
}

async function testStartRightAfterAJog() {
    const r = rig({ legTimeScale: 40 });
    r.ctrl.command('gcode:load', 'job.nc', program(60, [], 9), 0, {});
    await advance(50);
    r.ctrl.command('jog', { x: 5, feedRate: 600 });
    await advance(100);
    assert.strictEqual(r.fw.state, defs.ST_JOGGING);
    r.ctrl.command('gcode:start');
    await until(idle.bind(null, r), 300000, 'job end after a jog');
    assert.strictEqual(r.fw.jobStarts, 1);
    assert.ok(r.fw.executedCount >= 60);
    r.close();
    console.log('  ok  Start right after a jog');
}

// Every other EV_EXECUTED dropped: the sender must still finish from
// telemetry last_executed_line, which on 0.2.1 names a no-motion line only
// once the moves before it are done.
async function testLostExecutedEvents() {
    const r = rig();
    let n = 0;
    r.fw.dropOut = (ft, payload) => payload && payload[0] === defs.EV_EXECUTED && (n++ % 2 === 0);
    r.ctrl.command('gcode:load', 'job.nc', program(150, ['M3 S9000'], 3), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(idle.bind(null, r), 400000, 'job end with lost EV_EXECUTED');
    assert.strictEqual(r.fw.executedCount, 154);
    r.close();
    console.log('  ok  lost EV_EXECUTED events: finishes from telemetry');
}

async function testProbeZWireBitStaysInverted() {
    const sent = [];
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    ctrl.stream = { sendCommand: (op, payload) => { sent.push({ op, payload }); return Promise.reject(new Error('stub')); } };
    const probe = async (axis, dirNeg) => {
        await ctrl.probeAxis(axis, dirNeg, 5, 100).catch(() => {});
        const last = sent[sent.length - 1];
        assert.strictEqual(last.op, defs.OP_PROBE);
        return last.payload.readUInt8(1);
    };
    assert.strictEqual(await probe(2, 1), 0, 'Z down goes out as wire bit 0');
    assert.strictEqual(await probe(2, 0), 1, 'Z up goes out as wire bit 1');
    assert.strictEqual(await probe(0, 1), 1, 'X negative is not flipped');
    assert.strictEqual(await probe(1, 0), 0, 'Y positive is not flipped');
    console.log('  ok  OP_PROBE keeps the Z-only wire flip (0.2.1 relies on it)');
}

(async () => {
    console.log('Testing the sender against firmware 0.2.1...');
    await testProbeZWireBitStaysInverted();
    await testVersion();
    await testPlainRunWithNoMotionLines();
    await testPauseResume();
    await testProgramPause();
    await testStopResume();
    await testAlarmResume();
    await testStartRightAfterAJog();
    await testLostExecutedEvents();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
