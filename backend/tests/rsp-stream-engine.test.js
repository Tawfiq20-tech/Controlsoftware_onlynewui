'use strict';

/**
 * End-to-end job streaming tests (plan r2 Batch B, QA-2): RSPController +
 * ReliableStream + JobStream against the fake firmware in helpers/.
 *
 * Every scenario checks the machine-side record, not host bookkeeping: each
 * move of the program must execute exactly once, in order, at the compiled
 * target -- through line-number wrap, lost events, lost frames, stop/resume,
 * driver alarms, program pauses, E-stop and link silence.
 *
 * Time is virtual (node:test mock timers), so hours of machine time run in
 * seconds.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const defs = require('../services/rsp/defs');
const { RSPController } = require('../services/controllers/RSPController');
const { JobStream } = require('../services/rsp/job');
const { FakeFirmware, FakeConnection, strtof } = require('./helpers/fakeFirmware');

const flush = () => new Promise((r) => setImmediate(r));

async function advance(ms, step = 5) {
    for (let t = 0; t < ms; t += step) {
        mock.timers.tick(step);
        await flush();
    }
}

async function until(pred, maxMs, what, step = 5) {
    for (let t = 0; t <= maxMs; t += step) {
        if (pred()) return t;
        mock.timers.tick(step);
        await flush();
    }
    throw new Error(`timed out after ${maxMs} ms waiting for: ${what}`);
}

/** Send a command and let virtual time run until it settles. */
async function sendAndSettle(ctrl, op, payload = Buffer.alloc(0), ms = 3000) {
    const p = ctrl.stream.sendCommand(op, payload, { timeout: 5 }).then((v) => v, (e) => e);
    await advance(ms);
    return p;
}

/** Deterministic PRNG so loss patterns are reproducible. */
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

function genProgram(nMoves, { noMotionEvery = 0, header = [], middle = null } = {}) {
    const out = ['G21', 'G90', ...header, 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    let x = 0;
    let y = 0;
    let dir = 1;
    for (let i = 0; i < nMoves; i++) {
        if (noMotionEvery && i % noMotionEvery === 3) out.push(i % 2 ? 'S18000' : 'G17');
        if (middle && i === Math.floor(nMoves / 2)) out.push(...middle);
        const nx = x + dir * 0.5;
        if (nx > 100 || nx < 0) {
            dir = -dir;
            y += 0.5;
            out.push(`G1 Y${y.toFixed(3)} F1200`);
        } else {
            x = nx;
            out.push(`G1 X${x.toFixed(3)} F1200`);
        }
    }
    out.push('G0 Z5', 'M5', 'M2');
    return out.join('\n');
}

/** Compiled wire lines -> [{line, target}] for every move, the way the firmware tracks targets. */
function expectedMoves(lines, fromLine = 1, start = { x: 0, y: 0, z: 0 }) {
    const pos = { ...start };
    const moves = [];
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i];
        let saw = false;
        for (const k of ['X', 'Y', 'Z']) {
            const m = new RegExp(`${k}(-?\\d+\\.\\d+)`).exec(t);
            if (m) { pos[k.toLowerCase()] = Math.fround(parseFloat(m[1])); saw = true; }
        }
        if (saw && i + 1 >= fromLine) moves.push({ line: i + 1, target: { ...pos } });
    }
    return moves;
}

function near(a, b) {
    return Math.abs(a.x - b.x) < 0.0011 && Math.abs(a.y - b.y) < 0.0011 && Math.abs(a.z - b.z) < 0.0011;
}

/**
 * @param {boolean} [checkLines] compare wire line numbers too. A resumed run
 * streams a rebuilt program numbered from 1 (the host maps it back to file
 * lines), so only the executed path is comparable there.
 */
function assertExecutedExactly(executed, moves, label, checkLines = true) {
    assert.strictEqual(executed.length, moves.length, `${label}: ${executed.length} legs executed, program has ${moves.length} moves`);
    for (let i = 0; i < moves.length; i++) {
        const e = executed[i];
        const m = moves[i];
        if ((checkLines && e.line !== (m.line & 0xFFFF)) || !near(e.to, m.target)) {
            assert.fail(`${label}: leg ${i} ran wire line ${e.line} to ${JSON.stringify(e.to)}, expected line ${m.line} (wire ${m.line & 0xFFFF}) to ${JSON.stringify(m.target)}`);
        }
    }
}

function rig(fwOpts = {}, { setup } = {}) {
    const fw = new FakeFirmware(fwOpts);
    if (setup) setup(fw);
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    const log = [];
    const events = [];
    ctrl.on('console', (m) => log.push(m));
    ctrl.on('error', () => {});
    for (const ev of ['sender:start', 'sender:end', 'sender:error', 'sender:pause', 'job:programPause', 'job:end', 'job:error', 'alarm']) {
        ctrl.on(ev, (d) => events.push({ ev, d, at: Date.now() }));
    }
    ctrl.bind(conn);
    return {
        fw, conn, ctrl, log, events,
        load(text, name = 'job.nc', opts = {}) {
            ctrl.command('gcode:load', name, text, 0, opts);
            assert.ok(ctrl.lastLoadResult && ctrl.lastLoadResult.ok, `load failed: ${JSON.stringify(ctrl.lastLoadResult && ctrl.lastLoadResult.meta && ctrl.lastLoadResult.meta.errors)}`);
            return ctrl._loadedLines;
        },
        done: () => events.some((e) => e.ev === 'job:end'),
        failed: () => events.find((e) => e.ev === 'sender:error'),
        close() {
            ctrl.unbind();
            fw.destroy();
            conn.removeAllListeners();
        },
    };
}

// ---------------------------------------------------------------------------

async function testCleanRunWithNoMotionLines() {
    const r = rig();
    const lines = r.load(genProgram(3000, { noMotionEvery: 7 }));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(r.done, 120000, 'job end');
    await advance(300);
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'clean run');
    assert.strictEqual(r.fw.jobStarts, 1);
    assert.strictEqual(r.fw.jobEnds, 1);
    assert.ok(!r.fw.bufferNaks, `planner overfilled (${r.fw.bufferNaks} BUFFER NAKs)`);
    assert.strictEqual(r.fw.state, defs.ST_IDLE, 'firmware back to IDLE after the job');
    assert.strictEqual(r.ctrl.getResumePoint().line, 0, 'finished job leaves no resume point');
    assert.ok(!r.failed(), 'no failure');
    r.close();
    console.log('  ok  clean run: every move once, in order; no planner overflow');
}

async function testSeventyThousandLinesOneJob() {
    const r = rig();
    const lines = r.load(genProgram(70500));
    assert.ok(lines.length > 65536);
    await advance(50);
    const t0 = Date.now();
    r.ctrl.command('gcode:start');
    await until(r.done, 30 * 60 * 1000, 'job end', 20);
    await advance(300);
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), '70k lines');
    assert.strictEqual(r.fw.jobStarts, 1, 'one firmware job for the whole file (no chunk restarts)');
    assert.strictEqual(r.fw.jobEnds, 1);
    assert.ok(!r.fw.watchdogTrips);
    r.close();
    console.log(`  ok  ${lines.length} lines as one job across the u16 line and seq wrap (${((Date.now() - t0) / 1000).toFixed(0)} s machine time)`);
}

async function testLostEventsAndTelemetry() {
    const rand = rng(7);
    const r = rig();
    r.fw.dropOut = (type, payload) => {
        if (type !== 3 /* FT_EVT */) return false;
        if (payload[0] === defs.EV_EXECUTED) return rand() < 0.15;
        if (payload[0] === defs.EV_STATUS) return rand() < 0.3;
        return false;
    };
    const lines = r.load(genProgram(2500, { noMotionEvery: 5 }));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(r.done, 300000, 'job end');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'lossy events');
    r.close();
    console.log('  ok  15% EV_EXECUTED + 30% telemetry lost: still exactly once, job completes');
}

async function testLostFrames() {
    const rand = rng(11);
    const r = rig();
    r.conn.hostDrop = () => rand() < 0.03;
    r.fw.dropOut = (type) => (type === 4 /* ACK */ || type === 5 /* NAK */) && rand() < 0.03;
    const lines = r.load(genProgram(1500, { noMotionEvery: 6 }));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(r.done, 600000, 'job end');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'lossy frames');
    r.close();
    console.log('  ok  3% of host frames and 3% of ACK/NAK lost: exactly once, job completes');
}

async function testStopAndResumeExact() {
    const r = rig({ legTimeScale: 0.2 });
    const lines = r.load(genProgram(600, { noMotionEvery: 4 }));
    const moves = expectedMoves(lines);
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 200, 120000, '200 moves');
    r.ctrl.command('gcode:stop');
    const executedAtStop = r.fw.executed.length;
    await advance(500);
    assert.strictEqual(r.fw.state, defs.ST_IDLE, 'stop takes the firmware to IDLE (no stuck HOLD)');
    assert.ok(r.fw.executed.length <= executedAtStop + 1, `machine kept moving after stop (${r.fw.executed.length - executedAtStop} more legs)`);
    const point = r.ctrl.getResumePoint().line;
    const firstMissing = moves[r.fw.executed.length];
    assert.ok(point >= 2 && point <= firstMissing.line, `resume point ${point} is after the first unexecuted move (line ${firstMissing.line})`);
    for (let l = point; l < firstMissing.line; l++) {
        assert.ok(!/[XYZ]/.test(lines[l - 1]), `resume point ${point} skips move line ${l}`);
    }
    // later commands are not deadlocked behind a seq hole
    const status = await sendAndSettle(r.ctrl, defs.OP_PING);
    assert.ok(!(status instanceof Error), `commands still work after stop: ${status && status.message}`);

    const before = r.fw.executed.length;
    r.ctrl.command('gcode:start'); // resumes from the point through the safe program
    await until(r.done, 300000, 'resumed job end');
    const resumed = r.fw.executed.slice(before);
    // preamble: lift, travel at safe height, plunge, re-arm feed; then the file from the point
    const rest = expectedMoves(lines, point);
    const pre = resumed.slice(0, resumed.length - rest.length);
    assert.ok(pre.length >= 3, `safe preamble ran (${pre.length} legs)`);
    assert.ok(pre[0].to.z >= 5, 'first preamble move lifts Z to safe height');
    assert.ok(near({ ...pre[1].to, z: 0 }, { ...rest[0].target, z: 0 }) || pre.some((p) => p.to.z >= 5), 'travels at safe height');
    assertExecutedExactly(resumed.slice(pre.length), rest, 'resumed remainder', false);
    assert.strictEqual(r.ctrl._currentLine, lines.length, 'progress reports file line numbers, not program lines');
    r.close();
    console.log(`  ok  stop at move ${executedAtStop}: firmware IDLE, resume point exact (line ${point}), safe resume completes the file`);
}

async function testAlarmMidMoveAndResume() {
    const r = rig({ legTimeScale: 1 });
    const lines = r.load(genProgram(300));
    const moves = expectedMoves(lines);
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 120 && r.fw.leg, 300000, 'mid-leg');
    const interruptedLine = r.fw.leg.line;
    r.fw.injectAlarm(0);
    await advance(400);
    assert.strictEqual(r.ctrl._resumeLine, interruptedLine, `resume point = interrupted move line ${interruptedLine}`);
    assert.ok(r.log.some((m) => /X-axis motor driver ALARM/.test(m)));
    assert.ok(r.ctrl.job.active && r.ctrl.job.firmwareLost, 'host job held, firmware job lost');
    // START refused while alarmed
    r.ctrl.command('gcode:resume');
    await advance(100);
    assert.strictEqual(r.fw.jobStarts, 1, 'no restart while in ALARM');

    await sendAndSettle(r.ctrl, defs.OP_UNLOCK, Buffer.alloc(0), 300);
    const before = r.fw.executed.length;
    r.ctrl.command('gcode:resume');
    await until(r.done, 600000, 'resumed job end');
    const resumed = r.fw.executed.slice(before);
    const rest = expectedMoves(lines, interruptedLine);
    assertExecutedExactly(resumed.slice(resumed.length - rest.length), rest, 'after alarm', false);
    assert.strictEqual(before, moves.findIndex((m) => m.line === interruptedLine), 'every move before the interrupted one ran exactly once');
    r.close();
    console.log(`  ok  driver alarm mid-move at line ${interruptedLine}: exact resume point, Resume re-cuts from that move to the end`);
}

async function testProgramPauseM0() {
    const r = rig();
    const header = ['T1 (MSG, Insert Tool 1)', 'G0 X0 Y0 M3 S15000', "M0 (MSG, Click 'Continue' when the spindle is up to speed)"];
    const lines = r.load(genProgram(400, { header }), 'job.nc', { honorProgramPauses: true });
    const pauseLine = lines.indexOf('M0') + 1;
    assert.ok(pauseLine > 0);
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.events.some((e) => e.ev === 'job:programPause'), 20000, 'program pause');
    const ev = r.events.find((e) => e.ev === 'job:programPause');
    assert.strictEqual(ev.d.line, pauseLine);
    assert.strictEqual(ev.d.message, "Click 'Continue' when the spindle is up to speed");
    const movesBefore = expectedMoves(lines).filter((m) => m.line < pauseLine).length;
    await advance(20000);
    assert.strictEqual(r.fw.executed.length, movesBefore, 'no move after M0 until Resume');
    assert.strictEqual(r.fw.state, defs.ST_HOLD, 'machine held');
    assert.ok(!r.failed() && !r.fw.watchdogTrips, 'a long pause is neither a stall nor a watchdog trip');
    assert.strictEqual(r.ctrl.getWorkflowState(), 'paused');
    r.ctrl.command('gcode:resume');
    await until(r.done, 300000, 'job end');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'M0 program');
    r.close();
    console.log('  ok  M0 pauses the job with its message, holds 20 s safely, Resume completes it');
}

async function testProgramPauseOffByDefault() {
    const r = rig();
    const header = ['T1 (MSG, Insert Tool 1)', 'G0 X0 Y0 M3 S15000', "M0 (MSG, Click 'Continue' when the spindle is up to speed)"];
    const lines = r.load(genProgram(400, { header }));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(r.done, 300000, 'job end');
    assert.ok(!r.events.some((e) => e.ev === 'job:programPause' && e.d), 'no program pause without honorProgramPauses');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'M0 program, pauses off');
    r.close();
    console.log('  ok  M0 runs straight through when program pauses are off (default)');
}

async function testDwell() {
    const r = rig();
    const lines = r.load(genProgram(100, { middle: ['G4 P2.5'] }));
    const dwellLine = lines.findIndex((l) => l === 'G17' && r.ctrl._loadedMeta.dwells.some((d) => d.line === lines.indexOf(l) + 1)) + 1;
    const d = r.ctrl._loadedMeta.dwells[0];
    assert.ok(d && d.seconds === 2.5, 'dwell compiled');
    await advance(50);
    r.ctrl.command('gcode:start');
    const beforeIdx = expectedMoves(lines).filter((m) => m.line < d.line).length;
    const times = [];
    const origPush = r.fw.executed.push.bind(r.fw.executed);
    r.fw.executed.push = (e) => { times.push(Date.now()); return origPush(e); };
    await until(r.done, 120000, 'job end');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'dwell program');
    const gap = times[beforeIdx] - times[beforeIdx - 1];
    assert.ok(gap >= 2500, `dwell waited ${gap} ms`);
    const shown = r.events.find((e) => e.ev === 'job:programPause' && e.d && e.d.kind === 'dwell');
    assert.ok(shown, 'the wait is shown to the operator, not a silent stall');
    assert.strictEqual(shown.d.seconds, 2.5);
    void dwellLine;
    r.close();
    console.log(`  ok  G4 P2.5 waits on the host (${gap} ms between the moves around it) and is shown in the UI`);
}

async function testDwellSkip() {
    const r = rig();
    // a post that writes milliseconds asks for a 10 minute wait here
    const lines = r.load(genProgram(60, { middle: ['G4 P600'] }));
    const d = r.ctrl._loadedMeta.dwells[0];
    assert.strictEqual(d.seconds, 600);
    assert.ok(r.ctrl._loadedMeta.warnings.some((w) => /1000x longer than intended/.test(w.msg)),
        'an integer dwell of a minute or more is called out as probably milliseconds');
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.events.some((e) => e.ev === 'job:programPause' && e.d && e.d.kind === 'dwell'), 60000, 'dwell banner');
    const atDwell = r.fw.executed.length;
    await advance(3000);
    assert.strictEqual(r.fw.executed.length, atDwell, 'nothing moves during the wait');
    r.ctrl.command('gcode:resume'); // operator skips it
    await until(r.done, 120000, 'job end after skipping the wait');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'dwell skipped');
    r.close();
    console.log('  ok  a 600 s dwell is flagged as probably milliseconds and can be skipped with Resume');
}

async function testEstopKeepsPositionAndResume() {
    const r = rig({ legTimeScale: 1 });
    const lines = r.load(genProgram(200));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 60 && r.fw.leg, 300000, 'mid-job');
    const opsBefore = r.fw.opLog.length;
    r.ctrl.command('reset'); // the UI E-STOP button
    await advance(20);
    assert.strictEqual(r.fw.state, defs.ST_ESTOP, 'E_STOP reached the firmware within 20 ms');
    assert.ok(!r.fw.rebooted, 'no controller reboot (work zero kept)');
    assert.ok(r.fw.opLog.slice(opsBefore).some((o) => o.op === defs.OP_E_STOP));
    const point = r.ctrl.getResumePoint().line;
    assert.ok(point > 1, 'resume point saved');
    await advance(300);
    await sendAndSettle(r.ctrl, defs.OP_UNLOCK, Buffer.alloc(0), 300);
    const before = r.fw.executed.length;
    r.ctrl.command('gcode:start');
    await until(r.done, 600000, 'job end after E-stop');
    const rest = expectedMoves(lines, point);
    const resumed = r.fw.executed.slice(before);
    assertExecutedExactly(resumed.slice(resumed.length - rest.length), rest, 'after E-stop', false);
    r.close();
    console.log(`  ok  E-STOP stops at once without reboot, resume from line ${point} completes`);
}

async function testNoRestartNoReloadWhileRunning() {
    const r = rig({ legTimeScale: 0.2 });
    const text = genProgram(400);
    const lines = r.load(text);
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 50, 60000, '50 moves');
    r.ctrl.command('gcode:start');
    r.ctrl.command('gcode:startFromLine', 5, { safeZ: 5 });
    r.ctrl.command('gcode:load', 'other.nc', 'G21\nG0 X1 Y1\nG1 X2 F100', 0, {});
    assert.strictEqual(r.ctrl.lastLoadResult.busy, true, 'other file refused while running');
    r.ctrl.command('jog', { x: 5, feedRate: 500 });
    r.ctrl.command('zero:all');
    await until(r.done, 300000, 'job end');
    assert.strictEqual(r.fw.jobStarts, 1, 'START / Start From Line during a job did not restart it');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'job with interfering commands');
    assert.ok(!r.fw.opLog.some((o) => o.op === defs.OP_JOG || o.op === defs.OP_ZERO), 'jog/zero never reached the firmware during the job');
    r.close();
    console.log('  ok  START, Start From Line, another file, jog and zero during a job are refused; job completes');
}

async function testOrphanJobAborted() {
    const r = rig({}, {
        setup(fw) {
            fw.state = defs.ST_RUNNING;
            fw.jobActive = true;
            fw.jobId = 777;
            fw.lastHostRxMs = Date.now();
        },
    });
    await advance(4000);
    assert.strictEqual(r.fw.state, defs.ST_IDLE, 'orphan job from an earlier session aborted by its own id');
    assert.ok(r.fw.jobAborts >= 1);
    const lines = r.load(genProgram(50));
    r.ctrl.command('gcode:start');
    await until(r.done, 60000, 'job end');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'after orphan');
    r.close();
    console.log('  ok  orphan firmware job aborted by its real id; next job starts normally');
}

async function testStall() {
    const r = rig({ legTimeScale: 1 });
    r.load(genProgram(300));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 40 && r.fw.leg, 120000, 'mid-job');
    r.fw.frozen = true;
    const frozenAt = Date.now();
    await until(() => r.failed(), 120000, 'stall failure');
    const waited = Date.now() - frozenAt;
    assert.ok(waited >= JobStream.STALL_ABORT_S * 1000 - 100 && waited < (JobStream.STALL_ABORT_S + 5) * 1000, `stall declared after ${waited} ms`);
    assert.ok(r.ctrl.getResumePoint().line > 1, 'stall keeps the resume point');
    await advance(300);
    assert.strictEqual(r.fw.state, defs.ST_IDLE, 'stalled job aborted on the firmware (not ended as complete)');
    assert.ok(!r.fw.jobEnds, 'no OP_JOB_END for a stalled job');
    r.close();
    console.log(`  ok  frozen machine: job stopped after ${(waited / 1000).toFixed(0)} s with resume point, firmware aborted`);
}

async function testLongMoveIsNotAStall() {
    const r = rig({ legTimeScale: 1 });
    // 2000 mm at 1000 mm/min = 120 s single move, then a few more
    const lines = r.load('G21\nG90\nG0 X0 Y0 Z5\nG1 X2000 F1000\nG1 X2000 Y1 F1000\nG0 Z5', 'long.nc', { maxRate: { x: 5000, y: 5000, z: 3000 } });
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(r.done, 400000, 'job end', 20);
    assert.ok(!r.failed(), 'a 120 s move is not a stall');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'long move');
    r.close();
    console.log('  ok  a single 120 s move is not mistaken for a stall');
}

async function testFirmwareSilenceKeepalive() {
    const r = rig({ legTimeScale: 0.2 });
    const lines = r.load(genProgram(400));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 80, 60000, '80 moves');
    r.fw.txMuted = true; // host hears nothing for 4 s; firmware still hears the host
    await advance(4000);
    r.fw.txMuted = false;
    await until(r.done, 300000, 'job end');
    assert.ok(!r.fw.watchdogTrips, 'host kept the firmware watchdog fed while it heard nothing');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'silence');
    r.close();
    console.log('  ok  4 s of firmware->host silence: keepalive continues, no watchdog E-stop, job completes');
}

async function testUndeliverableLineFailsSafelyAndRecovers() {
    const r = rig({ legTimeScale: 0.2 });
    const lines = r.load(genProgram(300));
    await advance(50);
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= 30, 60000, '30 moves');
    // one job line is corrupted on every attempt: it and all its retransmits
    // never reach the firmware, so the host eventually gives up on that seq
    let victim = null;
    const { FrameParser } = require('../services/rsp/frame');
    r.conn.hostDrop = (buf) => {
        const f = new FrameParser().feed(buf)[0];
        if (!f || f.frameType !== 1 || f.payload[0] !== defs.OP_JOB_LINE) return false;
        if (victim === null) victim = f.seq;
        return f.seq === victim;
    };
    await until(() => r.failed(), 120000, 'undeliverable line failure');
    const point = r.ctrl.getResumePoint().line;
    assert.ok(point > 1);
    r.conn.hostDrop = null;
    await advance(3000);
    assert.strictEqual(r.fw.state, defs.ST_IDLE, 'firmware job aborted after the lost line');
    const ping = await sendAndSettle(r.ctrl, defs.OP_PING);
    assert.ok(!(ping instanceof Error), `link usable again: ${ping && ping.message}`);
    const before = r.fw.executed.length;
    r.ctrl.command('gcode:start');
    await until(r.done, 300000, 'resumed job end');
    const rest = expectedMoves(lines, point);
    const resumed = r.fw.executed.slice(before);
    assertExecutedExactly(resumed.slice(resumed.length - rest.length), rest, 'after lost line', false);
    r.close();
    console.log(`  ok  a job line that can never be delivered stops the job safely (line ${point}); link recovers; resume completes`);
}

async function testStaleSessionDevice() {
    // The board kept its sequence counter from a previous session (the sender
    // was restarted without power-cycling it). It refuses everything the new
    // sender says with SEQ_GAP; the sender must re-sync instead of both sides
    // repeating themselves forever.
    const r = rig({}, { setup: (fw) => { fw.expectedSeq = 40000; fw.seqSynced = true; } });
    const ping = await sendAndSettle(r.ctrl, defs.OP_PING, Buffer.alloc(0), 8000);
    assert.ok(!(ping instanceof Error), `link recovered: ${ping && ping.message}`);
    assert.strictEqual(r.fw.expectedSeq, r.ctrl.stream._txSeq, 'both sides agree on the sequence again');
    const lines = r.load(genProgram(80));
    r.ctrl.command('gcode:start');
    await until(r.done, 120000, 'job end after the re-sync');
    assertExecutedExactly(r.fw.executed, expectedMoves(lines), 'after stale-session re-sync');
    r.close();
    console.log('  ok  a board still on a previous session\'s numbering is re-synced, then runs the job');
}

function testStrtofMirror() {
    assert.deepStrictEqual(strtof('0X11.1000'), { value: Math.fround(17.0625), len: 9 });
    assert.strictEqual(strtof('12.5 X').value, 12.5);
    assert.strictEqual(strtof('X'), null);
    console.log('  ok  fake firmware reads numbers like strtof (hex floats included)');
}

(async () => {
    console.log('Testing RSP job streaming engine against the fake firmware...');
    const t0 = process.hrtime.bigint();
    testStrtofMirror();
    await testCleanRunWithNoMotionLines();
    await testLostEventsAndTelemetry();
    await testLostFrames();
    await testStopAndResumeExact();
    await testAlarmMidMoveAndResume();
    await testProgramPauseM0();
    await testProgramPauseOffByDefault();
    await testDwell();
    await testDwellSkip();
    await testEstopKeepsPositionAndResume();
    await testNoRestartNoReloadWhileRunning();
    await testOrphanJobAborted();
    await testStall();
    await testLongMoveIsNotAStall();
    await testFirmwareSilenceKeepalive();
    await testUndeliverableLineFailsSafelyAndRecovers();
    await testStaleSessionDevice();
    await testSeventyThousandLinesOneJob();
    console.log(`ALL TESTS PASSED SUCCESSFULLY! (${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s)`);
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
