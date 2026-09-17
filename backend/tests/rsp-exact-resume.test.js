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
    assert.strictEqual(plan.inPlace, false, 'no current X/Y given: the full lift / travel / plunge');
    console.log('  ok  resume program builder');
}

/**
 * 2026-09-17 SHIP roughing: after a Stop the tool stands exactly on the resume
 * line's start, yet the resume lifted to the file's 38.1 mm clearance, moved
 * zero distance and plunged back at 300 mm/min. Already at the start X/Y:
 * no lift, no travel -- straight down, straight up, or nothing.
 */
function testResumeInPlaceBuilder() {
    const lines = cleanGcodeLines(INCH_FILE);
    const base = { safeZMm: 5, fileMaxZMm: 38.1 };
    const at = (z, x = 70.335, y = 11.38) => ({ ...base, currentXMm: x, currentYMm: y, currentZMm: z });

    const above = buildResumeProgram(lines, 9, at(-2));
    assert.ok(above.ok, above.error);
    assert.deepStrictEqual(above.preamble, [
        'G21 G90',
        'M3 S18000',
        'G21 G90 G1 X70.335 Y11.380 Z-12.345 F300',             // same slow plunge, from where the tool is
        'G21 G90 G1 X70.335 Y11.380 Z-12.345 F508',             // re-arm cutting feed
    ]);
    assert.strictEqual(above.inPlace, true);
    assert.strictEqual(above.inPlaceZ, 'lower');
    assert.strictEqual(above.retractMm, -2, 'no lift: the highest point is where the tool already is');
    assert.strictEqual(above.program[above.preamble.length], 'G1 X1.959 Y0.448', 'file continues at line 9');
    assert.strictEqual(above.preamble.length + 1 + above.lineOffset, 9, 'line mapping unchanged');
    assert.ok(buildResumeProgram(lines, 9, { ...at(-2), plungeFeedMm: 120 }).preamble.includes('G21 G90 G1 X70.335 Y11.380 Z-12.345 F120'), 'plunge feed option still applies');

    const onDepth = buildResumeProgram(lines, 9, at(-12.34));
    assert.deepStrictEqual(onDepth.preamble, [
        'G21 G90',
        'M3 S18000',
        'G21 G90 G1 X70.335 Y11.380 Z-12.345 F508',
    ], 'at the resume depth (within 0.01 mm): no Z move at all');
    assert.strictEqual(onDepth.inPlaceZ, 'none');

    const below = buildResumeProgram(lines, 9, at(-14));
    assert.deepStrictEqual(below.preamble, [
        'G21 G90',
        'G21 G90 G0 X70.335 Y11.380 Z-12.345 F3000',            // straight up to the start depth, no higher
        'M3 S18000',
        'G21 G90 G1 X70.335 Y11.380 Z-12.345 F508',
    ]);
    assert.strictEqual(below.inPlaceZ, 'raise');

    assert.strictEqual(buildResumeProgram(lines, 9, at(-2, 70.344)).inPlace, true, 'X within 0.01 mm counts as there');
    const off = buildResumeProgram(lines, 9, at(-2, 70.35));
    assert.strictEqual(off.inPlace, false, 'X 0.015 mm away is not there');
    assert.deepStrictEqual(off.preamble, [
        'G21 G90',
        'G21 G90 G0 Z38.100 F3000',
        'G21 G90 G0 X70.335 Y11.380 Z38.100 F3000',
        'M3 S18000',
        'G21 G90 G1 X70.335 Y11.380 Z-12.345 F300',
        'G21 G90 G1 X70.335 Y11.380 Z-12.345 F508',
    ], 'X/Y differ: exactly the program it was before');
    assert.strictEqual(buildResumeProgram(lines, 9, { ...base, currentXMm: 70.335, currentZMm: -2 }).inPlace, false, 'no Y -> full program');
    // Y checked on its own: X on the start with Y off it must never skip the
    // travel (the next G1 would cut diagonally to the start at cutting feed).
    assert.strictEqual(buildResumeProgram(lines, 9, at(-2, 70.335, 11.389)).inPlace, true, 'Y within 0.01 mm counts as there');
    for (const y of [11.395, 11.365, 16.38]) {
        const yOff = buildResumeProgram(lines, 9, at(-2, 70.335, y));
        assert.strictEqual(yOff.inPlace, false, `X on the start, Y ${y} (off by ${Math.abs(y - 11.38).toFixed(3)} mm) is not there`);
        assert.deepStrictEqual(yOff.preamble, off.preamble, `Y ${y}: the full lift / travel / plunge`);
    }

    // No Z move before the line: the start depth is unknown, so it still lifts.
    const noZ = cleanGcodeLines('G21\nG90\nG0 X1 Y1\nG1 X2 F100\nG1 X3');
    const noZPlan = buildResumeProgram(noZ, 4, { safeZMm: 5, currentXMm: 2, currentYMm: 1, currentZMm: 0 });
    assert.strictEqual(noZPlan.inPlace, false);
    assert.strictEqual(noZPlan.preamble[1], 'G21 G90 G0 Z5.000 F3000');
    console.log('  ok  resume builder: tool already at the start X/Y -> no lift or travel (down / up / stay)');
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
    // Well into the move: X/Y have left the line's start, so the resume needs
    // the full lift / travel / plunge (a tool still AT the start resumes in
    // place -- testStopAtMoveBoundaryResumesInPlace).
    await until(() => r.fw.executed.length >= 40 && r.fw.leg && r.fw.legProgress() > 0.3, 300000, 'mid-move');
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
    assert.ok(/Tool is above line/.test(pauses[0].message), pauses[0].message);
    assert.ok(r.consoleLines.some((m) => /Resume from line \d+: raise Z to/.test(m)), 'console describes the lift and travel');
    assert.ok(r.fw.executed.slice(executedBefore).length >= 2, 'lift and travel ran before the pause');
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
    // The re-zero changed the origin after the resume point was saved, so a
    // plain START no longer resumes silently (start_after_zero_change.test.js):
    // continuing at the saved line is the deliberate Start From Line.
    const line = r.ctrl.getResumePoint().line;
    assert.ok(line > 1, 'resume point kept through the re-zero');
    r.ctrl.command('gcode:startFromLine', line, { safeZ: 5 });
    await advance(500);
    assert.strictEqual(r.fw.jobStarts, startsBefore + 1, 'resume (Start From Line) allowed after re-zero');
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

/** inchProgram with a G4 dwell after move `at`: the machine stands still exactly on a move boundary there. */
function inchProgramWithDwell(nMoves, at) {
    const out = ['(SHIP ROUGH)', 'G20', 'G90', 'M3 S18000', 'G0 Z0.15', 'G0 X2.0 Y0.5', 'G1 Z-0.486 F20'];
    for (let i = 0; i < nMoves; i++) {
        out.push(`G1 X${(2 + i * 0.01).toFixed(3)} Y0.448`);
        if (i === at) out.push('G4 P30');
    }
    out.push('G0 Z0.15', 'M5', 'M2');
    return out.join('\n');
}

/**
 * Run to the dwell and stop there: 'stop' (operator Stop), 'estop' (UI E-STOP,
 * then unlock) or 'alarm' (X driver ALM, operator Stop, unlock). Returns the
 * resume line and where it starts (mm).
 */
async function stopOnMoveBoundary(r, how = 'stop') {
    r.ctrl.command('gcode:load', 'ship.ngc', inchProgramWithDwell(120, 40), 0, {});
    assert.ok(r.ctrl.lastLoadResult.ok);
    await advance(50);
    const dwells = [];
    const onPause = (p) => { if (p && p.kind === 'dwell') dwells.push(p); };
    r.ctrl.on('job:programPause', onPause);
    r.ctrl.command('gcode:start');
    await until(() => dwells.length > 0, 300000, 'dwell');
    r.ctrl.removeListener('job:programPause', onPause);
    if (how === 'estop') {
        r.ctrl.command('reset');
        await advance(300);
    } else if (how === 'alarm') {
        r.fw.injectAlarm(0);
        await advance(300);
        r.ctrl.command('gcode:stop');
        await advance(100);
    } else {
        r.ctrl.command('gcode:stop');
    }
    if (how !== 'stop') {
        r.ctrl.command('unlock');
        await until(() => r.fw.state === defs.ST_IDLE && r.ctrl.state.status.state === defs.ST_IDLE, 60000, 'unlocked');
    }
    await advance(400);
    const point = r.ctrl.getResumePoint().line;
    assert.ok(point > 1, 'stop saved a resume point');
    const start = scanModalState(r.ctrl._loadedLines, point).pos;
    assert.ok(Math.abs(r.fw.cur.x - start.x) < 0.01 && Math.abs(r.fw.cur.y - start.y) < 0.01 && Math.abs(r.fw.cur.z - start.z) < 0.01,
        `test premise: the tool is on line ${point}'s start (${JSON.stringify(r.fw.cur)} vs ${JSON.stringify(start)})`);
    return { point, start };
}

async function testStopAtMoveBoundaryResumesInPlace() {
    const r = rig({ legTimeScale: 1 });
    const { point, start } = await stopOnMoveBoundary(r);

    const preview = r.ctrl._resumePreview(point, { safeZ: 5 });
    assert.strictEqual(preview.plan.inPlace, true, 'preview says no lift or travel');
    assert.strictEqual(preview.plan.inPlaceZ, 'none');
    r.ctrl._positionUncertain = { at: Date.now(), message: 'test' };
    assert.strictEqual(r.ctrl._resumePreview(point, { safeZ: 5 }).plan.inPlace, false, 'an untrusted position never skips the lift');
    r.ctrl._positionUncertain = null;
    const idle = r.ctrl.state.status;
    r.ctrl.state.status = { ...idle, state: defs.ST_JOGGING };
    assert.strictEqual(r.ctrl._resumeBuildOptions({}).currentXMm, undefined, 'a moving machine never skips the lift');
    r.ctrl.state.status = idle;

    const executedBefore = r.fw.executed.length;
    const statusesBefore = r.statuses.length;
    const pauses = [];
    r.ctrl.on('job:programPause', (p) => { if (p) pauses.push(p); });
    r.ctrl.command('gcode:start');
    await until(() => pauses.length > 0, 120000, 'spindle confirmation pause');
    assert.ok(/Tool is at the start of line/.test(pauses[0].message), pauses[0].message);
    assert.ok(/may still be in the material/.test(pauses[0].message) && /If it is off, press Stop and raise Z/.test(pauses[0].message),
        `the pause says the bit is at depth and not to start the spindle there: ${pauses[0].message}`);
    assert.ok(r.consoleLines.some((m) => new RegExp(`Resume from line ${point}: the tool is already at X.* -- no lift, travel or Z move`).test(m)), 'console says it resumes in place');
    assert.strictEqual(r.fw.executed.length, executedBefore, 'nothing moved before the operator confirms');
    // While the preamble runs no file line has executed: progress must not claim line N.
    const preStatuses = r.statuses.slice(statusesBefore).filter((s) => typeof s.lineNo === 'number');
    assert.ok(preStatuses.length > 0 && preStatuses.every((s) => s.lineNo === point - 1), `preamble progress reports line ${point - 1}: ${JSON.stringify(preStatuses.map((s) => s.lineNo))}`);

    r.ctrl.command('gcode:resume');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 600000, 'resumed job end');
    const resumed = r.fw.executed.slice(executedBefore);
    const lastCut = resumed.findIndex((e) => e.to.z > start.z + 0.01);
    const beforeRetract = lastCut < 0 ? resumed : resumed.slice(0, lastCut);
    assert.ok(beforeRetract.length > 50, 'the rest of the cut ran');
    assert.ok(beforeRetract.every((e) => Math.abs(e.to.z - start.z) < 0.01), 'no Z lift anywhere before the file\'s own final retract');
    assert.ok(near2(resumed[0].to, start), 'first move stays on the start point (feed re-arm only)');
    assert.strictEqual(r.fw.jobStarts, 2);
    r.close();
    console.log(`  ok  Stop on a move boundary at line ${point}: resume has no lift or travel, pauses for the spindle, finishes`);
}

async function testJoggedUpResumesStraightDown() {
    const r = rig({ legTimeScale: 1 });
    const { point, start } = await stopOnMoveBoundary(r);
    r.ctrl.command('jog', { z: 3, feedRate: 600 });
    await until(() => r.fw.state === defs.ST_IDLE && r.ctrl.state.status.state === defs.ST_IDLE &&
        Math.abs(r.ctrl.state.status.mpos.z - (start.z + 3)) < 0.01, 60000, 'jog up');

    const executedBefore = r.fw.executed.length;
    const pauses = [];
    r.ctrl.on('job:programPause', (p) => { if (p) pauses.push(p); });
    r.ctrl.command('gcode:start');
    await until(() => pauses.length > 0, 120000, 'spindle confirmation pause');
    assert.ok(/Tool is above line/.test(pauses[0].message), pauses[0].message);
    assert.strictEqual(r.fw.executed.length, executedBefore, 'nothing moves before the operator confirms');
    r.ctrl.command('gcode:resume');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 600000, 'resumed job end');
    const resumed = r.fw.executed.slice(executedBefore);
    assert.ok(near2(resumed[0].to, start), `first move goes straight down to line ${point}'s start: ${JSON.stringify(resumed[0].to)}`);
    assert.strictEqual(resumed[0].feed, 300, 'at the same slow plunge feed the full program uses');
    const lastCut = resumed.findIndex((e) => e.to.z > start.z + 3.01);
    assert.ok(lastCut < 0 || lastCut > 50, 'never above where the operator left the tool before the file\'s own retract');
    r.close();
    console.log(`  ok  jogged up 3 mm after the stop: resume plunges straight down at line ${point}'s X/Y, no lift`);
}

function near2(a, b) {
    return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.z - b.z) < 0.01;
}

/**
 * Start the resume, check the full program ran up to the spindle pause (lift
 * straight up where the tool is, travel at that height to the start), then
 * finish the job. Returns the moves the resume made.
 */
async function resumeExpectingFullLift(r, point, start, label) {
    const from = { ...r.fw.cur };
    const preview = r.ctrl._resumePreview(point, { safeZ: 5 });
    assert.strictEqual(preview.plan.inPlace, false, `${label}: preview shows the lift and travel`);
    const executedBefore = r.fw.executed.length;
    const pauses = [];
    r.ctrl.on('job:programPause', (p) => { if (p) pauses.push(p); });
    r.ctrl.command('gcode:start');
    await until(() => pauses.length > 0, 120000, `${label}: spindle confirmation pause`);
    assert.ok(/Tool is above line/.test(pauses[0].message), `${label}: ${pauses[0].message}`);
    assert.ok(r.consoleLines.some((m) => new RegExp(`Resume from line ${point}: raise Z to`).test(m)), `${label}: console describes the lift and travel`);
    const pre = r.fw.executed.slice(executedBefore);
    assert.strictEqual(pre.length, 2, `${label}: lift and travel ran before the pause: ${JSON.stringify(pre.map((e) => e.to))}`);
    assert.ok(Math.abs(pre[0].to.x - from.x) < 0.01 && Math.abs(pre[0].to.y - from.y) < 0.01 && pre[0].to.z >= 3.8,
        `${label}: first move lifts straight up to clearance: ${JSON.stringify(pre[0].to)}`);
    assert.ok(Math.abs(pre[1].to.x - start.x) < 0.01 && Math.abs(pre[1].to.y - start.y) < 0.01 && Math.abs(pre[1].to.z - pre[0].to.z) < 0.01,
        `${label}: travels to the start at that height: ${JSON.stringify(pre[1].to)}`);
    r.ctrl.command('gcode:resume');
    await until(() => !r.ctrl.job.active && r.fw.state === defs.ST_IDLE, 600000, `${label}: resumed job end`);
    const resumed = r.fw.executed.slice(executedBefore);
    assert.ok(near2(resumed[2].to, start), `${label}: plunges back to line ${point}'s start: ${JSON.stringify(resumed[2].to)}`);
    return resumed;
}

/** SF3 (review 2026-09-17): X still on the start, Y jogged off it -> the full program. */
async function testJoggedYResumesWithFullLift() {
    const r = rig({ legTimeScale: 1 });
    const { point, start } = await stopOnMoveBoundary(r);
    r.ctrl.command('jog', { y: 2, feedRate: 600 });
    await until(() => r.fw.state === defs.ST_IDLE && r.ctrl.state.status.state === defs.ST_IDLE &&
        Math.abs(r.ctrl.state.status.mpos.y - (start.y + 2)) < 0.01, 60000, 'jog Y');
    assert.ok(Math.abs(r.ctrl.state.status.mpos.x - start.x) < 0.001, 'test premise: X is still exactly on the start');
    await resumeExpectingFullLift(r, point, start, 'Y jogged 2 mm');
    r.close();
    console.log(`  ok  X on line ${point}'s start but Y jogged off it: resume lifts, travels and plunges`);
}

/**
 * SF2 (review 2026-09-17): after an E-STOP or a driver alarm the tool can stand
 * exactly on the resume point, but the E-STOP circuit may have cut the spindle
 * and an ALM often means the axis lost its place. The resume lifts the bit out
 * first, as before, so the spindle is never restarted in the material.
 */
async function testHardStopOnStartStillLifts() {
    for (const how of ['estop', 'alarm']) {
        const r = rig({ legTimeScale: 1 });
        const { point, start } = await stopOnMoveBoundary(r, how);
        const reason = r.ctrl.getResumePoint().reason;
        assert.ok(how === 'estop' ? reason === 'E-STOP' : /driver alarm/.test(reason), `${how}: resume point keeps its cause (${reason})`);
        assert.strictEqual(r.ctrl._resumeBuildOptions({}).currentXMm, undefined, `${how}: no in-place resume`);
        await resumeExpectingFullLift(r, point, start, how);
        assert.strictEqual(r.ctrl.getResumePoint().line, 0, `${how}: job finished`);
        r.close();
    }
    // An operator Stop on the same spot still resumes in place (testStopAtMoveBoundaryResumesInPlace).
    console.log('  ok  E-STOP / driver alarm with the tool on the resume point: resume still lifts the bit out first');
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
    // fw 0.1.1+ ignores any ALM signal held for less than 50 ms (stepper.c
    // ALM_FAULT_CONFIRM_MS); "blips under 1 ms" named the longest blip instead.
    assert.ok(/shorter than 50 ms are being ignored/.test(noiseLines[0]), noiseLines[0]);
    assert.ok(/longest so far 1 ms/.test(noiseLines[0]), noiseLines[0]);
    assert.ok(!/blips under \d+ ms are being ignored/.test(noiseLines[0]), 'the wrong 1 ms filter wording is gone');
    // The firmware counts whole ms: a sub-millisecond blip reports 0 (the
    // 2026-09-16 log's X axis), which reads "under 1 ms", not "0 ms".
    const zeroAt = r.consoleLines.length;
    r.ctrl.stream.emit('event', { frameType: 3, payload: Buffer.from([defs.EV_ALM_GLITCH, 0, 5, 0, 0, 0]) });
    const zero = r.consoleLines.slice(zeroAt).find((m) => /X motor-driver alarm/.test(m));
    assert.ok(zero && /longest so far under 1 ms\)/.test(zero), zero);
    // "Longest so far" is the longest of every report on that axis, not just the one that printed.
    r.ctrl._almNoise.axes[0].maxMs = 7;
    r.ctrl._almGlitchLastConsole[0] -= 11 * 60 * 1000;
    const laterAt = r.consoleLines.length;
    r.ctrl.stream.emit('event', { frameType: 3, payload: Buffer.from([defs.EV_ALM_GLITCH, 0, 5, 0, 0, 0]) });
    const later = r.consoleLines.slice(laterAt).find((m) => /X motor-driver alarm/.test(m));
    assert.ok(later && /longest so far 7 ms\)/.test(later), later);
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
    testResumeInPlaceBuilder();
    await testAlarmResumeAgainstFirmware();
    await testOldFirmwarePositionGuard();
    await testStartFromLinePreviewAndMapping();
    await testStopAtMoveBoundaryResumesInPlace();
    await testJoggedUpResumesStraightDown();
    await testJoggedYResumesWithFullLift();
    await testHardStopOnStartStillLifts();
    await testAlmGlitchAggregation();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
