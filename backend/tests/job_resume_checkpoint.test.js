'use strict';

/**
 * The durable resume checkpoint (services/jobresume/JobResumeService.js) must
 * survive a Stop and stay right across feed override changes, macros and
 * several jobs on one connection.
 *
 * 2026-09-17: Stop saved the checkpoint and the sender:end { aborted: true }
 * of that same Stop cleared it 22 ms later, so after a backend restart the
 * resume point was gone. Found with it: a sender:status carrying only
 * { feedOverridePct } was read as progress (line undefined, saved as 0), and
 * the end/error listeners were once() on a service that attaches once per
 * controller, so every job after the first never saved or cleared on end.
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
function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-'));
    tmpDirs.push(d);
    return d;
}

function newService(dataDir, getController) {
    const io = Object.assign(new EventEmitter(), { emit() { return true; } });
    return new JobResumeService({ dataDir, io, logger: quiet, getController, getConfig: () => ({ get: (k, d) => d }) });
}

class FakeCtl extends EventEmitter {
    constructor() {
        super();
        this.state = { status: { mpos: { x: 1, y: 2, z: -3 } } };
    }
    getModalState() { return { units: 'G21' }; }
}

const TEXT = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600', ...Array.from({ length: 120 }, (_, i) => `G1 X${i} F1200`), 'G0 Z5', 'M2'].join('\n');
const JOB_EVENTS = ['sender:status', 'sender:end', 'sender:error', 'sender:pause', 'error'];

function testStopKeepsTheCheckpoint() {
    const dir = tmpDir();
    const ctl = new FakeCtl();
    const svc = newService(dir, () => ctl);
    svc.onLoad({ filename: 'ship.ngc', gcodeText: TEXT });
    svc.onStart({ totalLines: 127 });
    ctl.emit('sender:status', { lineNo: 40, total: 127 });
    ctl.emit('sender:status', { feedOverridePct: 150 }); // RSPController._setFeedOverride
    svc.onStop();                                        // CNCEngine, before the controller stops
    assert.strictEqual(svc.getCheckpoint().lastExecutedLine, 40, 'a feed override status is not progress');
    ctl.emit('sender:end', { aborted: true });            // the Stop's own end event

    const afterRestart = newService(dir, () => null);
    const cp = afterRestart.getCheckpoint();
    assert.ok(cp, 'checkpoint survives the Stop (and a backend restart)');
    assert.strictEqual(cp.lastExecutedLine, 40);
    assert.strictEqual(afterRestart.validateCheckpoint().valid, true);

    ctl.emit('sender:status', { lineNo: 41 });
    ctl.emit('sender:status', {});
    ctl.emit('sender:status', { lineNo: 'x' });
    ctl.emit('sender:error', { reason: 'driver alarm' });
    assert.strictEqual(svc.getCheckpoint().lastExecutedLine, 41, 'an error saves it; events without a line change nothing');
    ctl.emit('sender:end', { jobId: 7 });
    assert.strictEqual(svc.getCheckpoint(), null, 'only a finished job clears it');
    console.log('  ok  Stop keeps the checkpoint across a restart; override status is not progress; finishing clears it');
}

function testEveryJobOnOneConnection() {
    const dir = tmpDir();
    let current = new FakeCtl();
    const first = current;
    const svc = newService(dir, () => current);
    for (let job = 1; job <= 3; job++) {
        svc.onLoad({ filename: `job${job}.nc`, gcodeText: TEXT });
        svc.onStart({ totalLines: 127 });
        current.emit('sender:status', { lineNo: 10 * job });
        current.emit('sender:end', { aborted: true });
        assert.strictEqual(svc.getCheckpoint().lastExecutedLine, 10 * job, `job ${job}: Stop keeps it`);

        // START resumes it: the first save must not put it back to line 0
        svc.onLoad({ filename: `job${job}.nc`, gcodeText: TEXT });
        svc.onStart({ totalLines: 127, startLine: 10 * job + 1 });
        assert.strictEqual(svc.getCheckpoint().lastExecutedLine, 10 * job, `job ${job}: resuming keeps the line`);
        current.emit('sender:pause');
        current.emit('error', { message: 'x' });
        current.emit('sender:end', { jobId: job });
        assert.strictEqual(svc.getCheckpoint(), null, `job ${job}: finishing clears it (once() only did this for job 1)`);
    }
    svc.onLoad({ filename: 'job4.nc', gcodeText: TEXT });
    svc.onStart({ totalLines: 127 });
    current.emit('sender:status', { lineNo: 55 });
    current.emit('sender:error', { reason: 'link lost' });
    assert.strictEqual(svc.getCheckpoint().lastExecutedLine, 55, 'an error on a later job still saves');
    for (const ev of JOB_EVENTS) assert.strictEqual(first.listenerCount(ev), 1, `one ${ev} listener after 4 jobs`);

    current = new FakeCtl(); // reconnect: a new controller instance
    svc.onLoad({ filename: 'job5.nc', gcodeText: TEXT });
    svc.onStart({ totalLines: 127 });
    for (const ev of JOB_EVENTS) {
        assert.strictEqual(first.listenerCount(ev), 0, `${ev} detached from the old controller`);
        assert.strictEqual(current.listenerCount(ev), 1, `${ev} attached to the new one`);
    }
    console.log('  ok  every job on a connection saves/clears on end and error; no listener leak across controllers');
}

function testMacroLeavesTheCheckpointAlone() {
    const dir = tmpDir();
    const ctl = new FakeCtl();
    const svc = newService(dir, () => ctl);
    svc.onLoad({ filename: 'ship.ngc', gcodeText: TEXT });
    svc.onStart({ totalLines: 127 });
    ctl.emit('sender:status', { lineNo: 40 });
    ctl.emit('sender:end', { aborted: true });
    ctl.emit('sender:status', { lineNo: 2, macro: true });
    ctl.emit('sender:end', { jobId: 3, macro: true });
    ctl.emit('sender:end', { aborted: true, macro: true });
    assert.strictEqual(svc.getCheckpoint().lastExecutedLine, 40, 'a macro\'s progress and end do not touch it');
    console.log('  ok  macro progress / end never overwrite or clear the job\'s checkpoint');
}

function program(nMoves) {
    const out = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    for (let i = 0; i < nMoves; i++) out.push(`G1 X${(i * 0.5).toFixed(3)} Y0.000 F1200`);
    out.push('G0 Z5', 'M5', 'M2');
    return out.join('\n');
}

/** The real path: RSPController on the fake firmware, events wired by CNCEngine. */
async function testThroughEngineAndController() {
    const dir = tmpDir();
    const fw = new FakeFirmware({ legTimeScale: 0.5 });
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    ctrl.bind(new FakeConnection(fw));

    const io = Object.assign(new EventEmitter(), { emit() { return true; } });
    const engine = new CNCEngine(io);
    engine._restartMonitor = { onStatus: () => null, onBind() {}, onConnectionLost() {} };
    engine.controller = ctrl;
    const text = program(200);
    engine.loadedFile = { name: 'ship.ngc' };
    engine._loadedGcodeContent = text;
    const svc = newService(dir, () => engine.controller);
    engine.jobResumeService = svc;
    engine._wireControllerEvents();
    const cmd = (c, ...a) => engine._handleCommand({ emit() {} }, 'COM3', c, ...a);
    const idle = () => !ctrl.job.active && fw.state === defs.ST_IDLE;

    ctrl.command('gcode:load', 'ship.ngc', text, 0, {});
    await advance(50);
    cmd('gcode:start');
    await until(() => fw.executed.length >= 80, 120000, '80 moves');
    await advance(300);
    cmd('feedOverride:coarsePlus');
    cmd('gcode:stop');
    await advance(400);
    const stopLine = ctrl.getResumePoint().line;
    assert.ok(stopLine > 1);
    const cp = newService(dir, () => null).getCheckpoint();
    assert.ok(cp, 'after Stop the checkpoint is still on disk');
    assert.ok(cp.lastExecutedLine > 1 && cp.lastExecutedLine < stopLine && stopLine - cp.lastExecutedLine < 30,
        `checkpoint line ${cp.lastExecutedLine} is just behind the stop point ${stopLine} (never 0, never past it)`);

    // A macro run after the stop (e.g. to lift Z) is not the job. Enough lines
    // that its progress events would pass for the file's if they were not
    // flagged, then a save (Stop pressed while idle) writes what the service holds.
    const macroProgress = [];
    const onStatus = (s) => { if (s && typeof s.lineNo === 'number') macroProgress.push(s); };
    ctrl.on('sender:status', onStatus);
    const macro = ['G21', 'G90', ...Array.from({ length: 30 }, (_, i) => `G0 Z${(5 + (i % 2)).toFixed(1)}`)].join('\n');
    cmd('macro:run', macro);
    await until(() => fw.executed.filter((e) => e.jobId === fw.jobId).length >= 30 && idle(), 60000, 'macro');
    ctrl.off('sender:status', onStatus);
    assert.ok(macroProgress.length > 0 && macroProgress.every((s) => s.macro === true), 'the controller flags a macro\'s progress');
    assert.ok(macroProgress.some((s) => s.lineNo !== cp.lastExecutedLine), 'test premise: macro line numbers differ from the checkpoint\'s');
    assert.strictEqual(svc.getCheckpoint().lastExecutedLine, cp.lastExecutedLine, 'macro did not overwrite the checkpoint');
    cmd('gcode:stop');
    await advance(50);
    assert.strictEqual(svc.getCheckpoint().lastExecutedLine, cp.lastExecutedLine, 'a later save still has the file\'s line, not the macro\'s');

    // START resumes; its checkpoint starts at the resume point, not line 0.
    cmd('gcode:start');
    await advance(20);
    assert.ok(ctrl.job.active);
    assert.strictEqual(svc.getCheckpoint().lastExecutedLine, stopLine - 1, 'resumed job checkpoint starts at the resume point');
    await until(idle, 300000, 'resumed job end');
    assert.strictEqual(svc.getCheckpoint(), null, 'finished resumed job clears it');

    // A second job on the same connection.
    cmd('gcode:start');
    await until(() => ctrl.job.active && ctrl.job.watermark >= 60, 120000, 'second job underway');
    cmd('gcode:stop');
    await advance(400);
    assert.ok(svc.getCheckpoint(), 'second job: Stop keeps it');
    cmd('gcode:start');
    await until(idle, 300000, 'second job end');
    assert.strictEqual(svc.getCheckpoint(), null, 'second job: finishing clears it');

    ctrl.unbind();
    fw.destroy();
    console.log(`  ok  engine + controller: Stop at line ${stopLine} keeps the checkpoint, macro leaves it, resume and a second job clear it on finish`);
}

/** CNCEngine + RSPController + JobResumeService on one fake firmware and data dir. */
function engineRig(dir, fw, { spindleDelay = 0 } = {}) {
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    ctrl.on('error', () => {});
    const consoleLines = [];
    ctrl.on('console', (m) => consoleLines.push(m));
    ctrl.bind(conn);
    // The worker-thread load does not run under mocked timers; same compile, same thread.
    ctrl.loadGcode = async (...a) => { ctrl.command('gcode:load', ...a); return ctrl.lastLoadResult; };

    const io = Object.assign(new EventEmitter(), { emit() { return true; } });
    const engine = new CNCEngine(io);
    engine._restartMonitor = { onStatus: () => null, onBind() {}, onConnectionLost() {} };
    engine.config = { get: (k, d) => (k === 'preferences.spindleDelay' ? spindleDelay : d) };
    engine.controller = ctrl;
    const svc = newService(dir, () => engine.controller);
    engine.jobResumeService = svc;
    engine._wireControllerEvents();
    const socket = { emit() {} };
    return {
        conn, ctrl, engine, svc, consoleLines,
        cmd: (c, ...a) => engine._handleCommand(socket, 'COM3', c, ...a),
        load: (name, content) => engine._handleFileLoad(socket, { name, content }),
        unload: () => engine._handleFileUnload(socket),
        idle: () => !ctrl.job.active && fw.state === defs.ST_IDLE,
        close() { conn.isOpen = false; ctrl.unbind(); },
    };
}

/**
 * Resume from the durable checkpoint after a backend restart, with a spindle
 * spin-up delay: the delay adds a G4 line after each M3, so the checkpoint's
 * line numbers only mean the same lines when the file is compiled the same way.
 */
async function testCheckpointResumeAfterRestart() {
    const dir = tmpDir();
    const fw = new FakeFirmware({ legTimeScale: 0.5 });
    const text = ['G21', 'G90', 'M3 S12000', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600',
        ...Array.from({ length: 150 }, (_, i) => `G1 X${(i * 0.5).toFixed(3)} Y0.000 F1200`), 'G0 Z5', 'M5', 'M2'].join('\n');

    const a = engineRig(dir, fw, { spindleDelay: 2 });
    await a.load('ship.ngc', text);
    assert.ok(a.consoleLines.some((m) => /spin-up dwell/.test(m)), 'test premise: the delay added a line');
    const compiled = a.ctrl._loadedLines.slice();
    a.cmd('gcode:start');
    await until(() => fw.executed.length >= 60, 120000, '60 moves');
    await advance(300);
    a.cmd('gcode:stop');
    await advance(400);
    const cp = a.svc.getCheckpoint();
    assert.ok(cp && cp.lastExecutedLine > 10, 'Stop kept the checkpoint');
    assert.strictEqual(cp.spindleDelay, 2, 'the checkpoint records how the file was compiled');
    a.close();

    // Backend restart: new engine, controller and service; nothing loaded.
    const b = engineRig(dir, fw, { spindleDelay: 0 });
    await advance(300);
    const pauses = [];
    b.ctrl.on('job:programPause', (p) => { if (p) pauses.push(p); });
    const res = b.svc.resumeFromCheckpoint();
    assert.ok(res.ok, res.error);
    assert.deepStrictEqual(b.ctrl._loadedLines, compiled, 'reloaded with the same spin-up delay: same line numbers as the checkpoint');
    await until(() => pauses.length > 0, 120000, 'spindle confirmation pause');
    const during = b.svc.getCheckpoint();
    assert.strictEqual(b.svc.validateCheckpoint().valid, true, 'the resumed job\'s checkpoint still holds the program');
    assert.strictEqual(during.gcodeText, text);
    assert.strictEqual(during.lastExecutedLine, cp.lastExecutedLine);
    assert.strictEqual(during.spindleDelay, 2);
    b.cmd('gcode:resume');
    await until(b.idle, 300000, 'resumed job end');
    assert.strictEqual(b.svc.getCheckpoint(), null, 'finished: cleared');
    b.close();
    fw.destroy();
    console.log(`  ok  checkpoint resume after a restart: same compile (spin-up delay kept), the resumed job keeps its program in the checkpoint`);
}

/**
 * Unloading a file discards its checkpoint, as the controller drops its own
 * resume point on unload; a Stop keeping the checkpoint made it outlive the file.
 */
async function testUnloadDiscardsItsCheckpoint() {
    const dir = tmpDir();
    const fw = new FakeFirmware({ legTimeScale: 0.5 });
    const r = engineRig(dir, fw);
    const fileA = program(200);
    const stopA = async () => {
        await r.load('a.ngc', fileA);
        r.cmd('gcode:start');
        await until(() => r.ctrl.job.active && r.ctrl.job.watermark >= 40, 120000, 'job A underway');
        r.cmd('gcode:stop');
        await advance(400);
        assert.ok(r.svc.getCheckpoint(), 'Stop keeps the checkpoint');
    };

    await stopA();
    r.unload();
    assert.strictEqual(r.svc.getCheckpoint(), null, 'unloading the stopped file clears its checkpoint');
    assert.strictEqual(r.ctrl.getResumePoint().line, 0, 'as the controller cleared its resume point');

    // Another file loaded and unloaded meanwhile: A's checkpoint is not its to clear.
    await stopA();
    await r.load('b.ngc', program(50));
    assert.ok(r.svc.getCheckpoint(), 'loading another file keeps it (the checkpoint carries its own program)');
    r.unload();
    assert.ok(r.svc.getCheckpoint(), 'unloading a different file keeps it');
    assert.strictEqual(r.svc.getCheckpoint().filename, 'a.ngc');
    r.close();
    fw.destroy();
    console.log('  ok  unloading a file clears its kept checkpoint; unloading another file does not');
}

(async () => {
    console.log('Testing the durable job resume checkpoint...');
    testStopKeepsTheCheckpoint();
    testEveryJobOnOneConnection();
    testMacroLeavesTheCheckpointAlone();
    await testThroughEngineAndController();
    await testCheckpointResumeAfterRestart();
    await testUnloadDiscardsItsCheckpoint();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
