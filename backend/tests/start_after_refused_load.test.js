'use strict';

/**
 * A Start must never run something other than what that screen just loaded.
 *
 * Phase 1 D1-F2: the firmware dropped job A (driver ALM), the operator cleared
 * the alarm, loaded design B and pressed Play. CNCEngine refused B as busy
 * (job A still held, firmwareLost), but the Start that followed was still
 * dispatched and RSPController resumed design A -- lift, travel, plunge into
 * the new stock while the screen showed B.
 * D1-M2 (outline echo race, MODE=paused): a refused load while A is paused,
 * then Start, resumed A.
 *
 * Now a refused or failed file:load blocks every Start-type command from that
 * socket (waiting on the load or sent later) until that socket loads a file
 * successfully, with "The file you loaded was not accepted: ... Nothing was started."
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.NO_BROWSER = '1';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const defs = require('../services/rsp/defs');
const { RSPController } = require('../services/controllers/RSPController');
const { JobResumeService } = require('../services/jobresume/JobResumeService');
const { CNCEngine } = require('../services/CNCEngine');
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

const quiet = { info() {}, warn() {}, error() {} };
const tmpDirs = [];

function designA(n = 160) {
    const out = ['(design A)', 'G21', 'G90', 'G0 Z5', 'G0 X10 Y10', 'G1 Z-1.5 F300'];
    for (let i = 1; i <= n; i++) out.push(`G1 X${10 + (i % 2 ? 40 : 0)} Y${(10 + i * 0.5).toFixed(3)} F1500`);
    out.push('G0 Z5', 'M2');
    return out.join('\n');
}
function designB() {
    return ['(design B)', 'G21 G90', 'G0 Z6', 'G0 X-20 Y-15', 'G1 Z-0.8 F250', 'G1 X30 Y-5 F1200', 'G1 Y25', 'G0 Z6', 'M2'].join('\n');
}

function rig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refused-load-'));
    tmpDirs.push(dir);
    const fw = new FakeFirmware({ legTimeScale: 0.05 });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    ctrl.bind(conn);
    // The worker-thread load does not run under mocked timers; same compile, same thread.
    ctrl.loadGcode = async (...a) => { ctrl.command('gcode:load', ...a); return ctrl.lastLoadResult; };

    const io = Object.assign(new EventEmitter(), { emit() { return true; } });
    const engine = new CNCEngine(io);
    engine._restartMonitor = { onStatus: () => null, onBind() {}, onConnectionLost() {} };
    engine.config = { get: (k, d) => d, getMacros: () => [], getTools: () => [], getAll: () => ({}) };
    engine.controller = ctrl;
    engine.jobResumeService = new JobResumeService({ dataDir: dir, io, logger: quiet, getController: () => engine.controller, getConfig: () => ({ get: (k, d) => d }) });
    engine._wireControllerEvents();

    const socket = Object.assign(new EventEmitter(), { id: 'screen1', emitted: [], emit(ev, d) { this.emitted.push([ev, d]); return true; } });
    io.listeners('connection').forEach((fn) => fn(socket));
    const send = (ev, ...args) => socket.listeners(ev).forEach((fn) => fn(...args));
    const cmd = (c, ...a) => send('command', 'COM3', c, ...a);
    const settle = async () => {
        while (engine._loadsInFlight.size > 0) await Promise.all([...engine._loadsInFlight]);
        for (let i = 0; i < 5; i++) await flush();
    };
    const load = async (name, content) => { send('file:load', { name, content }); await settle(); };
    const refusals = () => socket.emitted.filter(([ev, d]) => ev === 'serialport:error' && /The file you loaded was not accepted/.test(d && d.error));
    return {
        fw, ctrl, engine, socket, send, cmd, load, settle, refusals,
        close() { conn.isOpen = false; ctrl.unbind(); fw.destroy(); },
    };
}

async function dropJobA(r) {
    await r.load('A.nc', designA());
    r.cmd('gcode:start');
    await until(() => r.ctrl.job.active && r.ctrl.job.nextLineToRun() > 40 && r.fw.leg, 600000, 'A mid-job');
    r.fw.injectAlarm(1);
    await advance(1000);
    assert.ok(r.ctrl.job.active && r.ctrl.job.firmwareLost, 'premise: the host still holds A as firmware-lost');
    r.cmd('unlock');
    await advance(1500);
}

/** D1-F2 (Play: load, Start 250 ms later) -- B refused, Start must not resume A. */
async function testAlarmThenOtherFilePlay() {
    const r = rig();
    await dropJobA(r);
    const recv = r.fw.received.length;
    const starts = r.fw.jobStarts || 0;
    r.send('file:load', { name: 'B.nc', content: designB() });
    await advance(250);
    r.cmd('gcode:start');
    await r.settle();
    await advance(3000);
    assert.ok(r.socket.emitted.some(([ev, d]) => ev === 'file:loadError' && d.busy), 'B is refused while A is held');
    assert.strictEqual(r.refusals().length, 1, 'the operator is told Start did nothing and why');
    assert.match(r.refusals()[0][1].error, /Nothing was started\./);
    assert.strictEqual((r.fw.jobStarts || 0) - starts, 0, 'no job started on the firmware');
    assert.strictEqual(r.fw.received.length - recv, 0, `no program line sent: ${JSON.stringify(r.fw.received.slice(recv, recv + 3))}`);

    // Later presses from the same screen stay refused, Resume included.
    r.cmd('gcode:resume');
    r.cmd('cyclestart');
    r.cmd('gcode:startFromLine', 5);
    await advance(2000);
    assert.strictEqual(r.refusals().length, 4, 'every Start-type command is refused');
    assert.strictEqual(r.fw.received.length - recv, 0, 'still nothing sent');

    // Deliberately re-loading A (the file the machine holds) is accepted and unblocks.
    await r.load('A.nc', designA());
    r.cmd('gcode:start');
    await advance(4000);
    assert.strictEqual(r.refusals().length, 4, 'after a successful load Start is no longer blocked');
    assert.ok(r.fw.received.length - recv > 0, 'the same file resumes once the operator loaded it on purpose');
    r.close();
    console.log('  ok  firmware-dropped job A: a refused load of B blocks Start/Resume; re-loading A resumes A');
}

/** Space shortcut: load and Start back to back (Start waits on the refused load). */
async function testAlarmThenOtherFileSpace() {
    const r = rig();
    await dropJobA(r);
    const recv = r.fw.received.length;
    r.send('file:load', { name: 'B.nc', content: designB() });
    r.cmd('gcode:start');
    await r.settle();
    await advance(3000);
    assert.strictEqual(r.refusals().length, 1, 'the Start waiting on the refused load is refused');
    assert.strictEqual(r.fw.received.length - recv, 0, 'nothing from A was sent');
    r.close();
    console.log('  ok  Start waiting on a load that is then refused never runs');
}

/** D1-M2: job paused, a different file's load is refused, Start must not resume the paused job. */
async function testPausedThenRefusedLoad() {
    const r = rig();
    await r.load('A.nc', designA());
    r.cmd('gcode:start');
    await until(() => r.ctrl.job.active && r.ctrl.job.nextLineToRun() > 40, 600000, 'A mid-job');
    r.cmd('gcode:pause');
    await until(() => r.ctrl.job.paused && r.fw.state !== defs.ST_RUNNING && !r.fw.leg, 60000, 'A paused');
    const exec = r.fw.executed.length;
    r.send('file:load', { name: 'outline.gcode', content: designB() });
    await advance(200);
    r.cmd('gcode:start');
    await r.settle();
    await advance(3000);
    assert.strictEqual(r.refusals().length, 1, 'Start refused');
    assert.ok(r.ctrl.job.paused, 'A stays paused');
    assert.strictEqual(r.fw.executed.length - exec, 0, 'no motion');
    r.close();
    console.log('  ok  paused job: a refused load then Start does not resume it');
}

/** Normal flows keep working: load -> Start; a failed load on one screen does not block another. */
async function testNormalFlowsUnaffected() {
    const r = rig();
    await r.load('B.nc', designB());
    r.cmd('gcode:start');
    await until(() => r.ctrl.job.active, 20000, 'B started');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 600000, 'B done');
    assert.strictEqual(r.refusals().length, 0);

    // A different screen whose load was refused does not block this one.
    const other = Object.assign(new EventEmitter(), { id: 'screen2', emitted: [], emit(ev, d) { this.emitted.push([ev, d]); return true; } });
    r.engine._noteLoadOutcome(other, { name: 'x.nc' }, { ok: false, reason: 'test' });
    await r.load('A.nc', designA());
    r.cmd('gcode:start');
    await until(() => r.ctrl.job.active, 20000, 'A started');
    assert.strictEqual(r.refusals().length, 0);
    r.close();
    console.log('  ok  load -> Start still runs; a refusal on another screen does not block this one');
}

(async () => {
    console.log('Testing Start after a refused file load...');
    await testAlarmThenOtherFilePlay();
    await testAlarmThenOtherFileSpace();
    await testPausedThenRefusedLoad();
    await testNormalFlowsUnaffected();
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
