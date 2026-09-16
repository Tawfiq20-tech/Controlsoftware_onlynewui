'use strict';

/**
 * The sender must work on the firmware that is FLASHED TODAY (0.1.1-almfilter)
 * and on the new build (shortcut/firmware/source_0.2.0) -- customers will be on
 * one or the other, and a sender that only works on the newer one is not
 * shippable.
 *
 * Differences the fake firmware models (see tests/helpers/fakeFirmware.js):
 *   0.1.1: OP_JOB_ABORT refused in ALARM/E-stop; no 0xFFFF wildcard abort;
 *          OP_RESUME doubles as the legacy cycle-start and will set the machine
 *          RUNNING from IDLE on whatever is left in the planner; a feed hold
 *          services nothing (no fault watch, no line completion, no watchdog).
 *   0.2.0: abort always accepted and addressable by wildcard; resume only lifts
 *          a hold; a hold keeps watching the drivers and the host.
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

function program(nMoves, header = []) {
    const out = ['G21', 'G90', ...header, 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    for (let i = 1; i <= nMoves; i++) out.push(`G1 X${(i * 0.5).toFixed(3)} Y0.000 F1200`);
    out.push('G0 Z5', 'M5', 'M2');
    return out.join('\n');
}

function rig(fwVersion, extra = {}) {
    const fw = new FakeFirmware({ fwVersion, legTimeScale: 0.3, ...extra });
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

async function testReportsItsFirmwareVersion(fwVersion) {
    const r = rig(fwVersion);
    await advance(500);
    const expected = fwVersion === '0.1.1' ? '0.1.1-almfilter' : '0.2.0';
    assert.strictEqual(r.ctrl.firmwareVersion, expected, `${fwVersion}: version read from the board`);
    assert.ok(r.log.some((m) => m.includes(`Controller firmware: ${expected}`)),
        `${fwVersion}: the operator is told which firmware is on the board`);
    r.close();
}

async function testPlainRun(fwVersion) {
    const r = rig(fwVersion);
    r.ctrl.command('gcode:load', 'job.nc', program(300), 0, {});
    assert.ok(r.ctrl.lastLoadResult.ok);
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(idle.bind(null, r), 300000, `${fwVersion}: job end`);
    assert.strictEqual(r.fw.executedCount, 304, `${fwVersion}: every move ran`);
    assert.strictEqual(r.fw.jobStarts, 1);
    assert.ok(!r.fw.legacyCycleStarts, `${fwVersion}: never triggered the legacy cycle-start`);
    r.close();
}

async function testPauseResume(fwVersion) {
    const r = rig(fwVersion);
    r.ctrl.command('gcode:load', 'job.nc', program(300), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 40, 120000, `${fwVersion}: 40 moves`);
    r.ctrl.command('gcode:pause');
    await advance(1000);
    const held = r.fw.executedCount;
    assert.strictEqual(r.fw.state, defs.ST_HOLD, `${fwVersion}: machine held`);
    await advance(8000);
    assert.ok(r.fw.executedCount - held <= 1, `${fwVersion}: no cutting while held`);
    assert.ok(!r.fw.watchdogTrips, `${fwVersion}: a pause is not a host-loss`);
    r.ctrl.command('gcode:resume');
    await until(idle.bind(null, r), 300000, `${fwVersion}: job end after pause`);
    assert.strictEqual(r.fw.executedCount, 304, `${fwVersion}: file finished after the pause`);
    r.close();
}

async function testProgramPauseResume(fwVersion) {
    const r = rig(fwVersion);
    r.ctrl.command('gcode:load', 'job.nc', program(200, ["M0 (MSG, Check the spindle)"]), 0, { honorProgramPauses: true });
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.pauses.length > 0, 60000, `${fwVersion}: program pause`);
    await advance(400); // the hold is sent with the event; let it reach the machine
    assert.strictEqual(r.fw.state, defs.ST_HOLD, `${fwVersion}: held at M0`);
    const atPause = r.fw.executedCount;
    await advance(6000);
    assert.strictEqual(r.fw.executedCount, atPause, `${fwVersion}: nothing runs while paused at M0`);
    r.ctrl.command('gcode:resume');
    await until(idle.bind(null, r), 300000, `${fwVersion}: job end after M0`);
    assert.strictEqual(r.fw.executedCount, 204, `${fwVersion}: file finished after M0`);
    r.close();
}

async function testAlarmResume(fwVersion) {
    const r = rig(fwVersion, { legTimeScale: 1 });
    r.ctrl.command('gcode:load', 'job.nc', program(200), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 30 && r.fw.leg, 300000, `${fwVersion}: mid-move`);
    const interrupted = r.fw.leg.line;
    r.fw.injectAlarm(0);
    await advance(400);
    assert.strictEqual(r.ctrl._resumeLine, interrupted, `${fwVersion}: exact resume point`);
    // unlock, then continue
    const p = r.ctrl.stream.sendCommand(defs.OP_UNLOCK, Buffer.alloc(0), { timeout: 5 }).catch(() => {});
    await advance(500);
    await p;
    r.ctrl.command('gcode:start');
    await until(idle.bind(null, r), 600000, `${fwVersion}: job end after alarm`);
    assert.ok(r.fw.executedCount >= 200, `${fwVersion}: the rest of the file was cut (${r.fw.executedCount})`);
    assert.strictEqual(r.ctrl.getResumePoint().line, 0, `${fwVersion}: finished job clears the resume point`);
    r.close();
}

async function testStopResume(fwVersion) {
    const r = rig(fwVersion);
    r.ctrl.command('gcode:load', 'job.nc', program(300), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executedCount >= 50, 120000, `${fwVersion}: 50 moves`);
    r.ctrl.command('gcode:stop');
    await advance(600);
    assert.strictEqual(r.fw.state, defs.ST_IDLE, `${fwVersion}: stop leaves the machine idle`);
    const afterStop = r.fw.executedCount;
    await advance(3000);
    assert.strictEqual(r.fw.executedCount, afterStop, `${fwVersion}: nothing moves after a stop`);
    assert.ok(r.ctrl.getResumePoint().line > 1, `${fwVersion}: resume point saved`);
    r.ctrl.command('gcode:start');
    await until(idle.bind(null, r), 300000, `${fwVersion}: job end after stop`);
    r.close();
}

async function testStartRightAfterAJog(fwVersion) {
    const r = rig(fwVersion, { legTimeScale: 40 }); // a jog that takes a moment
    r.ctrl.command('gcode:load', 'job.nc', program(60), 0, {});
    await advance(50);
    r.ctrl.command('jog', { x: 5, feedRate: 600 });
    await advance(100);
    assert.strictEqual(r.fw.state, defs.ST_JOGGING, `${fwVersion}: machine is jogging`);
    // START pressed while the jog is still finishing: the firmware only starts
    // a job from IDLE, so the sender has to wait rather than fail the job.
    r.ctrl.command('gcode:start');
    await until(idle.bind(null, r), 300000, `${fwVersion}: job end after a jog`);
    assert.strictEqual(r.fw.jobStarts, 1, `${fwVersion}: the job really started`);
    assert.ok(r.fw.executedCount >= 60, `${fwVersion}: file cut after the jog (${r.fw.executedCount})`);
    r.close();
}

async function testOrphanAbort(fwVersion) {
    const r = rig(fwVersion, {});
    // pretend a previous session left a job running and its id is unknown here
    r.fw.state = defs.ST_RUNNING;
    r.fw.jobActive = true;
    r.fw.jobId = 4242;
    r.fw.lastHostRxMs = Date.now();
    await advance(5000);
    assert.strictEqual(r.fw.state, defs.ST_IDLE, `${fwVersion}: orphan job stopped`);
    r.close();
}

(async () => {
    console.log('Testing the sender against firmware 0.1.1 (flashed) and 0.2.0 (new build)...');
    for (const v of ['0.1.1', '0.2.0']) {
        await testReportsItsFirmwareVersion(v);
        await testPlainRun(v);
        await testPauseResume(v);
        await testProgramPauseResume(v);
        await testAlarmResume(v);
        await testStopResume(v);
        await testStartRightAfterAJog(v);
        await testOrphanAbort(v);
        console.log(`  ok  fw ${v}: run, pause, M0 pause, driver alarm, stop, start-after-jog, orphan job -- all recover and finish`);
    }
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
