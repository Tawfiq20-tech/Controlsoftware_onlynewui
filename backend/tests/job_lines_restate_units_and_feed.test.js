'use strict';

/**
 * Every motion line the control software streams says G21 (mm), G90
 * (absolute) and its feed.
 *
 * Firmware 0.2.0 -- the one on the machine -- keeps G20 / G91 and the last
 * feed from whatever ran before it for the whole boot; only 0.2.1 resets them
 * when a job starts. On 0.2.0 this restatement is therefore the ONLY thing
 * between a G20 or G91 left behind by an earlier program and a job cut 25.4
 * times too large or incremental -- the 2026-09-15 Z-254 mm plunge (Phase 1
 * D2-4). This pins it on every way a job is started: Start, Pause + Stop +
 * Start (resume), Start From Line and a 200% feed override, on firmware 0.2.0
 * and 0.2.1, each right after a job that left "G20 G91 F5" behind:
 *   - no streamed motion line lacks G21, G90 or F (FakeFirmware strictWire)
 *   - every move the board ran lands where its own line says in mm absolute,
 *     at its own feed, and inside the program's extents
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const defs = require('../services/rsp/defs');
const codec = require('../services/rsp/codec');
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

const N = 40;
function program() {
    const out = ['G21', 'G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
    for (let i = 1; i <= N; i++) out.push(`G1 X${(i * 2).toFixed(3)} Y${(i % 2).toFixed(3)} F600`);
    out.push('G0 Z5', 'M2');
    return out.join('\n');
}
// X 0..80, Y 0..1, Z -1..safe height (resume lifts to at most 10)
const EXTENTS = { x: [0, 2 * N], y: [0, 1], z: [-1, 10] };

function rig(fwVersion) {
    const fw = new FakeFirmware({ fwVersion, legTimeScale: 0.05, strictWire: true });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    const log = [];
    ctrl.on('console', (m) => log.push(m));
    ctrl.on('error', () => {});
    ctrl.bind(conn);
    return { fw, ctrl, log, close() { ctrl.unbind(); fw.destroy(); } };
}

function send(r, op, payload) {
    const out = { done: false, ok: null };
    r.ctrl.stream.sendCommand(op, payload, { timeout: 10 })
        .then(() => { out.done = true; out.ok = true; })
        .catch(() => { out.done = true; out.ok = false; });
    return out;
}

const LEFTOVER_JOB_IDS = new Set([901, 902, 903, 904]);

/** A program that is not the control software's (another sender, an MDI line) leaves inch + incremental + F5. */
async function leaveInchIncremental(r, jobId) {
    const orphan = r.ctrl._abortOrphanJob;
    r.ctrl._abortOrphanJob = () => {};
    const s = send(r, defs.OP_JOB_START, codec.buildJobStart(jobId, 1));
    await until(() => s.done, 1000, 'raw job start');
    assert.ok(s.ok, 'raw job started');
    const l = send(r, defs.OP_JOB_LINE, codec.buildJobLine(jobId, 1, 'G20 G91 G1 X0.1 F5'));
    await until(() => r.fw.received.some((x) => x.jobId === jobId), 1000, 'raw line');
    const e = send(r, defs.OP_JOB_END, codec.buildJobEnd(jobId));
    await until(() => l.done && e.done && r.fw.state === defs.ST_IDLE && !r.fw.leg, 20000, 'raw job end');
    r.ctrl._abortOrphanJob = orphan;
    if (r.fw.fwVersion === '0.2.0') {
        assert.strictEqual(r.fw.modal.absolute, false, '0.2.0 is left incremental');
        assert.ok(Math.abs(r.fw.modal.scale - 25.4) < 1e-3, '0.2.0 is left in inches');
    }
}

const idle = (r) => !(r.ctrl.job && r.ctrl.job.active) && r.fw.state === defs.ST_IDLE && !r.fw.leg;

/** Each move the board ran, against its own line read as mm absolute. */
function checkLegs(r, fromIdx, what) {
    const v = r.fw.fwVersion;
    const ours = r.fw.wireViolations.filter((w) => !LEFTOVER_JOB_IDS.has(w.jobId));
    assert.deepStrictEqual(ours, [], `${v} ${what}: every streamed motion line says G21, G90 and F`);
    const legs = r.fw.executed.slice(fromIdx).filter((l) => !LEFTOVER_JOB_IDS.has(l.jobId));
    assert.ok(legs.length > 0, `${v} ${what}: moves ran`);
    for (const leg of legs) {
        for (const k of ['x', 'y', 'z']) {
            const m = new RegExp(`(?:^|\\s)${k.toUpperCase()}\\s*(-?\\d+(?:\\.\\d+)?)`, 'i').exec(leg.text);
            // an axis the line does not name stays where the machine is (the
            // leftover program moved it), so only named axes are checked
            if (!m) continue;
            assert.ok(Math.abs(leg.to[k] - parseFloat(m[1])) < 1e-3,
                `${v} ${what}: "${leg.text}" ran to ${k.toUpperCase()}${leg.to[k]} (the line says ${m[1]} mm absolute)`);
            const [lo, hi] = EXTENTS[k];
            assert.ok(leg.to[k] >= lo - 1e-3 && leg.to[k] <= hi + 1e-3, `${v} ${what}: ${k.toUpperCase()}${leg.to[k]} is outside the program (${lo}..${hi})`);
        }
        const f = /(?:^|\s)F\s*(\d+(?:\.\d+)?)/i.exec(leg.text);
        assert.ok(f && Math.abs(leg.feed - parseFloat(f[1])) < 0.01, `${v} ${what}: "${leg.text}" ran at F${leg.feed}`);
    }
    return legs;
}

async function runFor(fwVersion) {
    const r = rig(fwVersion);
    await advance(300);
    r.ctrl.command('gcode:load', 'grid.nc', program(), 0, {});
    await advance(50);

    // Start
    await leaveInchIncremental(r, 901);
    let from = r.fw.executed.length;
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length > from + N && idle(r), 120000, `${fwVersion}: job end`);
    let legs = checkLegs(r, from, 'Start');
    assert.deepStrictEqual(legs[legs.length - 1].to, { x: 80, y: 0, z: 5 }, `${fwVersion} Start: the job ends at its last point`);

    // Pause + Stop, then Start resumes
    from = r.fw.executed.length;
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length >= from + 15, 120000, `${fwVersion}: 15 moves`);
    r.ctrl.command('gcode:pause');
    await until(() => r.fw.state === defs.ST_HOLD && !r.fw.leg, 20000, `${fwVersion}: held`);
    await advance(300);
    r.ctrl.command('gcode:stop');
    await until(() => idle(r), 5000, `${fwVersion}: stopped`);
    await advance(300);
    const resumeLine = r.ctrl.getResumePoint().line;
    assert.ok(resumeLine > 5, `${fwVersion}: resume point saved (${resumeLine})`);
    await leaveInchIncremental(r, 902);
    const fromResume = r.fw.executed.length;
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length > fromResume + 5 && idle(r), 120000, `${fwVersion}: resumed job end`);
    checkLegs(r, from, 'Pause + Stop + Start');
    legs = r.fw.executed.slice(fromResume);
    assert.deepStrictEqual(legs[legs.length - 1].to, { x: 80, y: 0, z: 5 }, `${fwVersion} resume: the job ends at its last point`);

    // Start From Line
    await leaveInchIncremental(r, 903);
    from = r.fw.executed.length;
    r.ctrl.command('gcode:startFromLine', 25, { safeZ: 5 });
    await until(() => r.fw.executed.length > from + 5 && idle(r), 120000, `${fwVersion}: start-from-line job end`);
    legs = checkLegs(r, from, 'Start From Line');
    assert.deepStrictEqual(legs[legs.length - 1].to, { x: 80, y: 0, z: 5 });

    // 200% feed override
    await leaveInchIncremental(r, 904);
    r.ctrl._setFeedOverride(200);
    from = r.fw.executed.length;
    r.ctrl.command('gcode:start');
    await until(() => r.fw.executed.length > from + N && idle(r), 120000, `${fwVersion}: override job end`);
    legs = checkLegs(r, from, '200% feed override');
    assert.ok(legs.some((l) => l.feed > 600), `${fwVersion}: the override raised the cutting feed (${[...new Set(legs.map((l) => l.feed))].join('/')})`);
    r.close();
    console.log(`  ok  ${fwVersion}: Start, resume, Start From Line and 200% override after a G20 G91 F5 leftover all run in mm, absolute, at their own feeds`);
}

(async () => {
    console.log('Testing that every streamed job line restates G21 G90 and F...');
    await runFor('0.2.0');
    await runFor('0.2.1');
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
