'use strict';

/**
 * After a link silence longer than JobStream.LINK_GRACE_S the job is failed
 * here, but the machine does not stop with it: it finishes the moves already
 * queued in its planner (until its own 5 s host watchdog E-stops it), and
 * their EV_EXECUTED is lost with the link. The saved resume point stayed at
 * the last line heard of, so START cut up to 8 finished moves again
 * (Phase 1, D6-7).
 *
 * When the machine can be heard again, the resume point must match what it
 * really finished -- from its telemetry, or from OP_GET_RUN_STATE when no
 * telemetry arrives -- and must never pass a move it did not finish (a
 * no-motion line is reported on receipt, ahead of queued moves).
 *
 * ReliableStream + JobStream against the fake firmware (0.2.0 and 0.2.1),
 * virtual time.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const { EventEmitter } = require('events');
const defs = require('../services/rsp/defs');
const { ReliableStream } = require('../services/rsp/stream');
const { JobStream } = require('../services/rsp/job');
const { FT_EVT } = require('../services/rsp/frame');
const { FakeFirmware, FakeConnection } = require('./helpers/fakeFirmware');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const flush = () => new Promise((r) => setImmediate(r));

async function advance(ms, step = 5) {
    for (let t = 0; t < ms; t += step) {
        mock.timers.tick(step);
        await flush();
    }
}

async function until(pred, maxMs, what, step = 5) {
    for (let t = 0; t <= maxMs; t += step) {
        if (pred()) return;
        mock.timers.tick(step);
        await flush();
    }
    throw new Error(`timed out after ${maxMs} ms waiting for: ${what}`);
}

/** rsp_handle_get_run_state() of firmware 0.2.0: job_id, last_executed_line, x, y, z. */
class RunStateFirmware extends FakeFirmware {
    _handle(seq, op, pl) {
        if (op !== defs.OP_GET_RUN_STATE) return super._handle(seq, op, pl);
        const d = Buffer.alloc(16);
        d.writeUInt16LE(this.jobId & 0xFFFF, 0);
        d.writeUInt16LE(this.lastExecutedLine & 0xFFFF, 2);
        d.writeFloatLE(this.cur.x, 4);
        d.writeFloatLE(this.cur.y, 8);
        d.writeFloatLE(this.cur.z, 12);
        this.runStateQueries = (this.runStateQueries || 0) + 1;
        this._ok(seq, op, d);
        return 1;
    }
}

/** Moves of `stepMm` at `feed`, a no-motion line after every second move. */
function program(nMoves, { stepMm = 1, feed = 1200 } = {}) {
    const out = ['G21', 'G90', 'M3 S12000', 'G21 G90 G1 Z-1.000 F600'];
    for (let i = 1; i <= nMoves; i++) {
        out.push(`G21 G90 G1 X${(i * stepMm).toFixed(3)} F${feed}`);
        if (i % 2 === 0) out.push(i % 4 ? 'G17' : 'S12000');
    }
    out.push('M5');
    return out;
}

const isMove = (text) => /[XYZ]\s*-?\d/.test(text);

function rig(fwVersion) {
    const fw = new RunStateFirmware({ legTimeScale: 1, fwVersion });
    const conn = new FakeConnection(fw);
    const transport = new EventEmitter();
    transport.send = (buf) => conn.writeRaw(buf);
    conn.on('rawData', (buf) => transport.emit('data', buf));
    const stream = new ReliableStream(transport, { logger: quiet });
    const job = new JobStream(stream, { logger: quiet });
    // what RSPController does: telemetry reaches noteTelemetry() while a job is active
    stream.on('status', (dict) => { if (job.active) job.noteTelemetry(dict); });
    const ev = { failed: null, late: [] };
    job.on('failed', (reason) => { ev.failed = { reason, next: job.nextLineToRun(), fwMoves: fw.executed.length }; });
    job.on('lateProgress', (p) => ev.late.push(p.nextLine));
    stream.start();
    return {
        fw, conn, stream, job, ev,
        mute() { fw.txMuted = true; conn.hostDrop = () => true; },
        unmute() { fw.txMuted = false; conn.hostDrop = null; },
        close() { job.destroy(); stream.stop(); fw.destroy(); conn.removeAllListeners(); },
    };
}

/**
 * The resume point after the silence is exact: every move before it ran on
 * the machine, and nothing from it on did (lines between the last finished
 * move and the resume point are no-motion lines only).
 */
function assertResumePointExact(r, lines, label) {
    const next = r.job.nextLineToRun();
    const moveLines = [];
    lines.forEach((t, i) => { if (isMove(t)) moveLines.push(i + 1); });
    const ran = r.fw.executed.map((e) => e.line);
    assert.deepStrictEqual(ran, moveLines.slice(0, ran.length), `${label}: test premise, the machine ran the program's moves in order`);
    const firstNotRun = moveLines[ran.length];
    const lastRun = ran[ran.length - 1];
    assert.ok(next > lastRun, `${label}: resume point ${next} would cut line ${lastRun} again (the machine finished moves up to line ${lastRun})`);
    assert.ok(next <= firstNotRun, `${label}: resume point ${next} skips line ${firstNotRun}, a move the machine never ran`);
    for (let l = next; l < firstNotRun; l++) assert.ok(!isMove(lines[l - 1]), `${label}: line ${l} between the resume point and the first unfinished move is a move`);
    return { next, lastRun, firstNotRun };
}

// ---------------------------------------------------------------------------

async function testTelemetryMovesResumePointToWhatTheMachineFinished(fwVersion) {
    const r = rig(fwVersion);
    const lines = program(400);
    await advance(200);
    r.job.upload(lines, null, {});
    r.job.start();
    await until(() => r.fw.executed.length >= 120 && r.fw.leg, 120000, 'mid-job');
    r.mute(); // cable half out: nothing either way
    await until(() => r.ev.failed, 30000, 'job failed for lost contact');
    assert.ok(/lost contact with the machine/.test(r.ev.failed.reason), r.ev.failed.reason);
    await advance(20000 - (JobStream.LINK_GRACE_S + 3) * 1000);
    assert.ok(r.fw.executed.length > r.ev.failed.fwMoves - 1, 'premise');
    assert.strictEqual(r.fw.state, defs.ST_ESTOP, 'premise: the firmware watchdog stopped the machine during the silence');
    const heardUpTo = r.ev.failed.next;
    r.unmute();
    await advance(2000);
    const { next, lastRun } = assertResumePointExact(r, lines, 'telemetry');
    assert.ok(heardUpTo <= lastRun, `premise: at the failure the host had heard only up to line ${heardUpTo - 1}, the machine finished line ${lastRun}`);
    assert.strictEqual(r.ev.late[r.ev.late.length - 1], next, 'the controller is told the new resume point (lateProgress)');
    assert.ok(r.job.firmwareLost, 'a job lost this way resumes as after a hard stop (lift first)');
    r.close();
    console.log(`  ok  fw ${fwVersion}: 20 s silence: failed at line ${heardUpTo}, machine finished line ${lastRun}; resume point moved to ${next} when it was heard again`);
}

async function testRunStateWhenNoTelemetryArrives(fwVersion) {
    const r = rig(fwVersion);
    const lines = program(400);
    await advance(200);
    r.job.upload(lines, null, {});
    r.job.start();
    await until(() => r.fw.executed.length >= 150 && r.fw.leg, 120000, 'mid-job');
    r.mute();
    await until(() => r.ev.failed, 30000, 'job failed for lost contact');
    await advance(3000);
    // the link comes back, but status frames do not
    r.fw.dropOut = (type, payload) => type === FT_EVT && payload[0] === defs.EV_STATUS;
    r.unmute();
    await advance(2000);
    assert.ok(r.fw.runStateQueries >= 1, 'the sender asked the machine for its run state');
    const { next, lastRun } = assertResumePointExact(r, lines, 'run state');
    assert.ok(r.ev.failed.next <= lastRun, 'premise: the host had not heard of every finished move');
    r.close();
    console.log(`  ok  fw ${fwVersion}: link back without telemetry: OP_GET_RUN_STATE moved the resume point from ${r.ev.failed.next} to ${next}`);
}

async function testNeverPassesAMoveTheMachineDidNotFinish(fwVersion) {
    // 6 s moves: the watchdog E-stops the machine before the move in flight
    // ends, with moves still queued. On 0.2.0 its last_executed_line then
    // names a no-motion line it merely received, AHEAD of those queued moves.
    const r = rig(fwVersion);
    const lines = program(40, { stepMm: 100, feed: 1000 });
    await advance(200);
    r.job.upload(lines, null, {});
    r.job.start();
    await until(() => r.fw.executed.length >= 3 && r.fw.leg && r.fw.legProgress() < 0.1 &&
        r.fw.lastExecutedLine > 0 && !isMove(lines[r.fw.lastExecutedLine - 1]), 600000, 'start of a move, no-motion line reported last');
    r.mute();
    await until(() => r.ev.failed, 30000, 'job failed for lost contact');
    await advance(3000);
    r.unmute();
    await advance(3000);
    assert.strictEqual(r.fw.state, defs.ST_ESTOP, 'premise: E-stopped mid-move');
    const lastRun = r.fw.executed[r.fw.executed.length - 1].line;
    if (fwVersion === '0.2.0') {
        assert.ok(r.fw.lastExecutedLine > lastRun && !isMove(lines[r.fw.lastExecutedLine - 1]),
            `premise: the machine reports no-motion line ${r.fw.lastExecutedLine}, received ahead of unfinished moves (last finished move: line ${lastRun})`);
    }
    assert.ok(r.fw.runStateQueries >= 1, 'premise: run state was asked');
    const { next } = assertResumePointExact(r, lines, 'E-stop with moves queued');
    r.close();
    console.log(`  ok  fw ${fwVersion}: E-stop with moves still queued: machine reports line ${r.fw.lastExecutedLine}, resume point stays at ${next} (first unfinished move)`);
}

(async () => {
    console.log('Testing the resume point after a long link silence...');
    // 0.2.0 is on the machine today; 0.2.1 reports no-motion lines after the
    // moves before them (F5), which lets more of the silence be credited.
    for (const fwVersion of ['0.2.0', '0.2.1']) {
        await testTelemetryMovesResumePointToWhatTheMachineFinished(fwVersion);
        await testRunStateWhenNoTelemetryArrives(fwVersion);
        await testNeverPassesAMoveTheMachineDidNotFinish(fwVersion);
    }
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
