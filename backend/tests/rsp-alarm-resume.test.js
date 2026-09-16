'use strict';

/**
 * Alarm / mid-run stop / power-cut recovery, end to end against the fake
 * firmware (tests/helpers/fakeFirmware.js).
 *
 * Covers the paths a user hits after a job is interrupted:
 *   - driver alarm -> unlock -> START continues from the exact line
 *   - Stop -> START resumes (no "job already running" refusal)
 *   - power cut -> JobResumeService checkpoint -> resume from the saved line,
 *     with the controller's own safe preamble (never a raw prepended one)
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

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

function program(nMoves) {
    const out = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    for (let i = 0; i < nMoves; i++) out.push(`G1 X${(i * 0.5).toFixed(3)} Y0.000 F1200`);
    out.push('G0 Z5', 'M5', 'M2');
    return out.join('\n');
}

function rig(fwOpts) {
    const fw = new FakeFirmware(fwOpts);
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    const log = [];
    ctrl.on('console', (m) => log.push(m));
    ctrl.on('error', () => {});
    ctrl.bind(conn);
    return { fw, conn, ctrl, log, close() { ctrl.unbind(); fw.destroy(); } };
}

async function testAlarmThenUnlockThenStart() {
    const r = rig({ legTimeScale: 1 });
    const text = program(150);
    r.ctrl.command('gcode:load', 'test.nc', text, 0, {});
    assert.ok(r.ctrl.lastLoadResult.ok);
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 30 && r.fw.leg, 120000, 'mid-move');
    const interrupted = r.fw.leg.line;

    r.fw.injectAlarm(0);
    await advance(400);
    assert.strictEqual(r.ctrl.job.paused, true, 'job holds when the driver alarms');
    assert.strictEqual(r.ctrl._resumeLine, interrupted, 'resume line captured from what really ran');
    assert.strictEqual(r.ctrl._resumeGcode, r.ctrl._loadedGcode, 'resume G-code is the loaded (compiled) program');
    assert.ok(r.ctrl._loadedGcode.includes('G21 G90 G1 X'), 'loaded G-code is the compiled wire program');

    r.ctrl.command('unlock');
    await advance(500);
    assert.ok(r.log.some((m) => m.includes('Alarm cleared / unlocked')), 'emits alarm cleared message');
    assert.ok(r.log.some((m) => m.includes(`Press START to resume from line ${interrupted}`)), 'prompts to resume');

    const before = r.log.length;
    r.ctrl.command('gcode:start');
    await advance(500);
    assert.ok(!r.log.slice(before).some((m) => /already running/.test(m)), 'START after unlock is not refused');
    assert.strictEqual(r.ctrl.job.active, true, 'job runs again');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 300000, 'job end');
    assert.strictEqual(r.ctrl.getResumePoint().line, 0, 'finished job clears the resume point');
    r.close();
    console.log(`  ok  alarm at line ${interrupted} -> unlock -> START continues and finishes`);
}

async function testStopThenStartResumes() {
    const r = rig({ legTimeScale: 0.5 });
    r.ctrl.command('gcode:load', 'test.nc', program(200), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 40, 120000, '40 moves');
    r.ctrl.command('gcode:stop');
    await advance(400);
    const point = r.ctrl.getResumePoint().line;
    assert.ok(point > 1, 'stop saves a resume point');
    // The console line names the point at the moment of the stop; a move that
    // finished while the abort was in flight can push the saved point one further.
    const stopMsg = r.log.find((m) => /Stopped at line (\d+)/.test(m));
    assert.ok(stopMsg, 'stop is reported with its line');
    assert.ok(point - Number(/Stopped at line (\d+)/.exec(stopMsg)[1]) <= 1);
    r.ctrl.command('gcode:start');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 300000, 'job end');
    assert.strictEqual(r.fw.jobStarts, 2, 'resume is a second firmware job');
    assert.ok(r.fw.executed.some((e) => e.to.z >= 5), 'resume lifted Z to safe height');
    r.close();
    console.log(`  ok  Stop at line ${point} -> START resumes there and finishes`);
}

async function testCheckpointResumeUsesControllerPreamble() {
    const r = rig({ legTimeScale: 0.5 });
    const text = program(200);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'));
    const io = new EventEmitter();
    io.emit = () => {};
    const resumeService = new JobResumeService({
        dataDir: tmpDir,
        io,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        getController: () => r.ctrl,
        getConfig: () => ({ get: (k, d) => (k === 'preferences.safeHeight' ? 8 : d) }),
    });

    r.ctrl.command('gcode:load', 'test.nc', text, 0, {});
    await advance(50);
    resumeService.onLoad({ filename: 'test.nc', gcodeText: text, modalState: { units: 'G21', spindleRpm: 12000, spindleState: 'M3' } });
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 50, 120000, '50 moves');
    const cutSoFar = r.fw.executed.length;
    const lastLine = r.ctrl.job.nextLineToRun() - 1;
    resumeService.store.save({
        filename: 'test.nc',
        gcodeText: text,
        gcodeHash: 'testhash',
        totalLines: r.ctrl._loadedLines.length,
        lastExecutedLine: lastLine,
        lastConfirmedPos: r.ctrl.job.lastConfirmedPos,
        modalState: { units: 'G21', spindleRpm: 12000, spindleState: 'M3', feedRate: 1200 },
        timestamp: Date.now(),
    });

    // power cut: the job dies with the machine
    r.ctrl.command('gcode:stop');
    await advance(400);

    // The checkpoint really is on disk, and a progress checkpoint is small:
    // the program is written once to its own file, not inlined into every
    // save (that would have rewritten 13 MB every 25 lines on the big files).
    const cpPath = path.join(tmpDir, 'job_resume.json');
    const gcodePath = path.join(tmpDir, 'job_resume_gcode.nc');
    assert.ok(fs.existsSync(cpPath), 'checkpoint written to disk');
    assert.ok(fs.existsSync(gcodePath), 'program stored once, alongside it');
    const cpSize = fs.statSync(cpPath).size;
    assert.ok(cpSize < 4096, `progress checkpoint is ${cpSize} bytes -- it should not carry the program`);
    assert.ok(fs.statSync(gcodePath).size > 1000, 'the program file holds the program');
    assert.ok(!JSON.parse(fs.readFileSync(cpPath, 'utf8')).gcodeText, 'no inline copy of the program');

    const res = resumeService.resumeFromCheckpoint();
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.fromLine, lastLine + 1);
    assert.deepStrictEqual(res.preamble, [], 'the controller builds the resume moves, not the service');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 300000, 'resumed job end');
    const resumed = r.fw.executed.slice(cutSoFar);
    assert.ok(resumed.length > 0);
    assert.ok(resumed[0].to.z >= 8, 'resume lifts to the configured safe height first');
    assert.ok(resumed.some((e) => Math.abs(e.to.z + 1) < 0.01), 'and plunges back to the cutting depth');
    // the machine finished the file: last executed target is the final move
    const lastMove = resumed[resumed.length - 1];
    assert.ok(lastMove.to.z >= 5, 'program ends with the retract');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    r.close();
    console.log(`  ok  power-cut checkpoint resumes at line ${res.fromLine} through the controller's safe preamble`);
}

(async () => {
    console.log('Testing RSP alarm / stop / power-cut resume...');
    await testAlarmThenUnlockThenStart();
    await testStopThenStartResumes();
    await testCheckpointResumeUsesControllerPreamble();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
