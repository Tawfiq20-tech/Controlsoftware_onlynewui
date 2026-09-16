'use strict';

/**
 * Start-from-line / exact-resume regression tests for the 2026-09-15
 * DRAGON ROUGH incident:
 *   - X driver ALM fault stopped the job at line 3237
 *   - re-sending the same file wiped the resume point
 *   - the old Start From Line preamble (G53 G0 Z-10 before G20) plunged Z 254 mm
 *   - old firmware dropped the steps of the interrupted move (~20 mm X error)
 *
 * The controller half runs against the fake firmware (tests/helpers), so the
 * resume point is whatever the machine really executed.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const defs = require('../services/rsp/defs');
const codec = require('../services/rsp/codec');
const { RSPController } = require('../services/controllers/RSPController');
const { FakeFirmware, FakeConnection } = require('./helpers/fakeFirmware');
const { cleanGcodeLines, scanModalState, buildResumeProgram } = require('../lib/resumeFromLine');

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

// Inch file shaped like the Buildbotics export (values are inches).
const INCH_FILE = [
    '(DRAGON ROUGH)',
    'G20',
    'G90',
    'M3 S18000',
    'G0 Z0.15',
    'G0 X2.0 Y0.5',
    'G1 Z-0.486 F20',
    'F999',                 // bare F: firmware ignores it (no motion on the line)
    'G1 X2.769 Y0.448',
    'G1 X1.959 Y0.448',     // line 9 (cleaned numbering, comment line dropped)
    'G1 X2.2 Y0.6',
    'G0 Z0.15',
].join('\n');

function testResumeProgramBuilder() {
    const lines = cleanGcodeLines(INCH_FILE);
    assert.strictEqual(lines.length, 11, 'comment line is dropped exactly like JobStream.upload()');

    const st = scanModalState(lines, 9);
    assert.strictEqual(st.unitScale, 25.4);
    assert.ok(Math.abs(st.pos.x - 2.769 * 25.4) < 1e-9, 'X start = end of line 8');
    assert.ok(Math.abs(st.pos.z - (-0.486 * 25.4)) < 1e-9);
    assert.ok(Math.abs(st.feedMm - 20 * 25.4) < 1e-9, 'bare F999 line must not change the feed');

    const plan = buildResumeProgram(lines, 9, { safeZMm: 5 });
    assert.ok(plan.ok, plan.error);
    // Preamble is always absolute G21 on the 0.005 mm grid with an explicit F on
    // every move (wire rules of lib/wireCompiler.js), whatever units the source used.
    assert.deepStrictEqual(plan.preamble, [
        'G21 G90',
        'G21 G90 G0 Z5.000 F3000',                              // lift first, above work zero
        'G21 G90 G0 X70.335 Y11.380 Z5.000 F3000',              // travel at safe height (2.769, 0.448 in)
        'M3 S18000',
        'G21 G90 G1 X70.335 Y11.380 Z-12.345 F300',             // slow plunge to -0.486 in
        'G21 G90 G1 X70.335 Y11.380 Z-12.345 F508',             // re-arm cutting feed F20 in/min
    ]);
    assert.ok(!plan.preamble.some((l) => /G53|G20/.test(l)), 'no machine-coordinate move, no inch mode on the wire');
    assert.strictEqual(plan.program[plan.preamble.length], 'G1 X1.959 Y0.448', 'file continues at line 9');
    assert.strictEqual(plan.preamble.length + 1 + plan.lineOffset, 9, 'first file line maps back to 9');
    const capped = buildResumeProgram(lines, 9, { safeZMm: 50, zHeadroomMm: 20 });
    assert.strictEqual(capped.retractMm, 18, 'retract never above Z headroom - 2 mm');
    // The tool is parked above the safe height: the resume must not drop to it
    // first (a blind descent over clamps/workpiece) -- stay high and travel.
    const high = buildResumeProgram(lines, 9, { safeZMm: 5, currentZMm: 42.5 });
    assert.strictEqual(high.retractMm, 42.5, 'retract height is raised to where the tool already is');
    assert.strictEqual(high.preamble[1], 'G21 G90 G0 Z42.500 F3000');
    const low = buildResumeProgram(lines, 9, { safeZMm: 5, currentZMm: -3 });
    assert.strictEqual(low.retractMm, 5, 'a tool below the safe height still lifts to it');

    assert.ok(!buildResumeProgram(lines, 0).ok);
    assert.ok(!buildResumeProgram(lines, 99).ok);
    assert.ok(!buildResumeProgram(cleanGcodeLines('G21\nG0 Z5\nG1 Z-1'), 3).ok, 'no XY yet -> refuse');
    assert.ok(!buildResumeProgram(cleanGcodeLines('G21\nG0 X1 Y1\nG91\nG1 X1\nG1 X1'), 5).ok, 'G91 -> refuse');
    console.log('  ok  resume program builder');
}

function rig(fwOpts) {
    const fw = new FakeFirmware(fwOpts);
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    const consoleLines = [];
    const points = [];
    const statuses = [];
    ctrl.on('console', (m) => consoleLines.push(m));
    ctrl.on('error', () => {});
    ctrl.on('job:resumePoint', (p) => points.push(p));
    ctrl.on('sender:status', (s) => statuses.push(s));
    ctrl.bind(conn);
    return { fw, conn, ctrl, consoleLines, points, statuses, close() { ctrl.unbind(); fw.destroy(); } };
}

/** A longer inch file so there is something to interrupt. */
function inchProgram(nMoves) {
    const out = ['(DRAGON ROUGH)', 'G20', 'G90', 'M3 S18000', 'G0 Z0.15', 'G0 X2.0 Y0.5', 'G1 Z-0.486 F20'];
    for (let i = 0; i < nMoves; i++) out.push(`G1 X${(2 + i * 0.01).toFixed(3)} Y0.448`);
    out.push('G0 Z0.15', 'M5', 'M2');
    return out.join('\n');
}

async function testAlarmResumeAgainstFirmware() {
    const r = rig({ legTimeScale: 1 });
    r.ctrl.command('gcode:load', 'dragon.ngc', inchProgram(200), 0, {});
    assert.ok(r.ctrl.lastLoadResult.ok);
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 40 && r.fw.leg, 300000, 'mid-move');
    const interrupted = r.fw.leg.line;

    // --- X driver fault mid-move -------------------------------------------
    r.fw.injectAlarm(0);
    await advance(400);
    assert.ok(r.consoleLines.some((m) => /X-axis motor driver ALARM/.test(m)), 'fault names the X driver');
    assert.strictEqual(r.ctrl._resumeLine, interrupted, 'resume point is the interrupted line');
    assert.ok(r.consoleLines.some((m) => new RegExp(`Job paused by X-axis driver alarm \\(ALM\\) at line ${interrupted}`).test(m)));
    assert.strictEqual(r.points[r.points.length - 1].line, interrupted);
    assert.strictEqual(r.ctrl._positionUncertain, null, 'POS_EXACT firmware -> no position warning');

    // Re-sending the SAME file keeps the resume point (this wiped it on 09-15)
    r.ctrl.command('gcode:load', 'dragon.ngc', inchProgram(200), 0, {});
    assert.strictEqual(r.ctrl._resumeLine, interrupted, 'same file re-sent keeps resume point');
    assert.strictEqual(r.ctrl.getResumePoint().line, interrupted);

    // --- Unlock and resume from that exact line -----------------------------
    r.ctrl.command('unlock');
    await advance(500);
    assert.ok(r.consoleLines.some((m) => /Alarm cleared \/ unlocked/.test(m)));
    assert.ok(r.consoleLines.some((m) => new RegExp(`Press START to resume from line ${interrupted}`).test(m)));

    const executedBefore = r.fw.executed.length;
    const pauses = [];
    r.ctrl.on('job:programPause', (p) => pauses.push(p));
    r.ctrl.command('gcode:start');
    // The file cuts with the spindle on (M3), so the resume stops at safe
    // height and asks the operator to confirm the spindle before plunging.
    await until(() => pauses.length > 0, 120000, 'spindle confirmation pause');
    assert.ok(/spindle is running/.test(pauses[0].message), pauses[0].message);
    assert.ok(r.fw.executed.slice(executedBefore).every((e) => e.to.z >= 5), 'nothing plunges before the operator confirms');
    r.ctrl.command('gcode:resume');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 600000, 'resumed job end');
    const resumed = r.fw.executed.slice(executedBefore);
    assert.ok(resumed.length > 0);
    assert.ok(resumed[0].to.z >= 5, 'resume lifts Z to safe height first');
    assert.strictEqual(r.ctrl.getResumePoint().line, 0, 'a completed job leaves no resume point');
    assert.strictEqual(r.statuses[r.statuses.length - 1].lineNo, r.ctrl._loadedLines.length, 'progress reports file line numbers');
    r.close();
    console.log(`  ok  alarm at line ${interrupted}: exact resume point, START continues from there`);
}

async function testOldFirmwarePositionGuard() {
    const r = rig({ legTimeScale: 1, posExact: false });
    r.ctrl.command('gcode:load', 'dragon.ngc', inchProgram(200), 0, {});
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 30 && r.fw.leg && r.fw.legProgress() > 0.3, 300000, 'part-way through a move');
    r.fw.injectAlarm(0);
    await advance(400);
    assert.ok(r.ctrl._positionUncertain, 'interrupted move on old firmware flags the position');
    assert.ok(r.consoleLines.some((m) => /Position may be wrong/.test(m)));

    r.ctrl.command('unlock');
    await advance(400);
    const startsBefore = r.fw.jobStarts;
    r.ctrl.command('gcode:start');
    await advance(300);
    assert.ok(r.consoleLines.some((m) => /blocked/.test(m)), 'resume refused while the position is unknown');
    assert.strictEqual(r.fw.jobStarts, startsBefore, 'no job started');
    r.ctrl.command('gcode:startFromLine', 20, { safeZ: 5 });
    await advance(300);
    assert.strictEqual(r.fw.jobStarts, startsBefore, 'start-from-line refused too');

    r.ctrl.command('zero:all');
    await advance(300);
    assert.strictEqual(r.ctrl._positionUncertain, null, 're-zero clears it');
    r.ctrl.command('gcode:start');
    await advance(500);
    assert.strictEqual(r.fw.jobStarts, startsBefore + 1, 'resume allowed after re-zero');
    r.close();
    console.log('  ok  old firmware (no POS_EXACT): resume blocked until the operator re-zeroes');
}

async function testStartFromLinePreviewAndMapping() {
    const r = rig();
    r.ctrl.command('gcode:load', 'dragon.ngc', INCH_FILE, 0, {});
    await advance(50);
    const line9 = r.ctrl._loadedLines[8];
    assert.strictEqual(line9, 'G21 G90 G1 X49.760 Y11.380 Z-12.345 F5000', 'bare F999 is modal (clamped to X max rate)');
    const preview = r.ctrl._resumePreview(9, { safeZ: 5 });
    assert.ok(preview.plan.ok);
    assert.strictEqual(preview.context.find((c) => c.num === 9).text, line9);

    const pauses = [];
    r.ctrl.on('job:programPause', (p) => pauses.push(p));
    r.ctrl.command('gcode:startFromLine', 9, { safeZ: 5 });
    await until(() => pauses.length > 0, 120000, 'spindle confirmation pause');
    r.ctrl.command('gcode:resume');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 120000, 'start-from-line job end');
    // Z lifted first, then the travel move to line 9's start, then the plunge
    const z = r.fw.executed.map((e) => e.to.z);
    assert.ok(z[0] >= 5, 'lifts to safe height before travelling');
    assert.ok(r.fw.executed.some((e) => Math.abs(e.to.x - 70.335) < 0.01 && e.to.z >= 5), 'travels at safe height');
    assert.ok(r.fw.executed.some((e) => Math.abs(e.to.z + 12.345) < 0.01), 'plunges back to the cutting depth');
    assert.ok(!r.fw.executed.some((e) => e.to.z < -200), 'no 254 mm plunge (the 09-15 G53/G20 bug)');
    r.close();
    console.log('  ok  Start From Line 9 lifts, travels, plunges and runs the rest');
}

async function testAlmGlitchAggregation() {
    const r = rig();
    const summaries = [];
    r.ctrl.on('alm:noise', (s) => summaries.push(s));
    const g = codec.parseEvAlmGlitch(Buffer.from([1, 0x2C, 0x01, 1, 0]));
    assert.deepStrictEqual(g, { axis: 1, count: 300, maxMs: 1 });
    const before = r.consoleLines.length;
    for (let i = 0; i < 50; i++) r.ctrl.stream.emit('event', { frameType: 3, payload: Buffer.from([defs.EV_ALM_GLITCH, 1, 0x2C, 0x01, 1, 0]) });
    const noiseLines = r.consoleLines.slice(before).filter((m) => /Y1 motor-driver alarm \(ALM\) wire is noisy/.test(m));
    assert.strictEqual(noiseLines.length, 1, '50 reports -> one console note, not 50');
    assert.strictEqual(summaries.length, 0, 'no summary before a minute has passed');
    r.ctrl._almNoise.since -= 61000;
    r.ctrl.stream.emit('event', { frameType: 3, payload: Buffer.from([defs.EV_ALM_GLITCH, 2, 0xFF, 0xFF, 1, 0]) });
    assert.strictEqual(summaries.length, 1, 'one summary per minute');
    const y1 = summaries[0].axes.find((a) => a.axis === 'Y1');
    const y2 = summaries[0].axes.find((a) => a.axis === 'Y2');
    assert.strictEqual(y1.blips, 15000);
    assert.ok(y2.saturated, 'saturated 65535 count is flagged');
    r.close();
    console.log('  ok  ALM glitch reports are aggregated, not one warning each');
}

(async () => {
    console.log('Testing exact resume + start from line...');
    testResumeProgramBuilder();
    await testAlarmResumeAgainstFirmware();
    await testOldFirmwarePositionGuard();
    await testStartFromLinePreviewAndMapping();
    await testAlmGlitchAggregation();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
