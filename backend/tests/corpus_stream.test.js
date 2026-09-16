'use strict';

/**
 * The product promise, end to end (plan QA-11): every reference file the
 * customer carves must load, stream and finish in ONE run.
 *
 * Each file in the corpus is loaded through the real controller and streamed
 * to the fake firmware (tests/helpers/fakeFirmware.js). Checked per file:
 *   - it loads (arcs converted, wire-compiled, no refusal)
 *   - every compiled move executes exactly once, in order, at the target the
 *     compiler wrote -- verified leg by leg, without buffering millions of them
 *   - the file runs as ONE firmware job: one JOB_START, one JOB_END, no abort,
 *     no planner overflow, no host-watchdog trip, no stall
 *
 * Set EASYCNC_CORPUS to point at the folder; skipped if it is missing.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const defs = require('../services/rsp/defs');
const { RSPController } = require('../services/controllers/RSPController');
const { FakeFirmware, FakeConnection } = require('./helpers/fakeFirmware');

const CORPUS = process.env.EASYCNC_CORPUS || 'C:/Users/Tawfiq/Downloads/gcode_test_file/file_finity';
// Which firmware to stream against: '0.2.0' (default) or '0.1.1' (what is on
// the board today). EASYCNC_FW_VERSION=0.1.1 npm test -- runs the same 13
// files against the flashed firmware's behaviour.
const FW_VERSION = process.env.EASYCNC_FW_VERSION || '0.2.0';
// Machine limits the sender ships with (plan CAL-1 measures the real ones).
const COMPILE_OPTIONS = { rapidFeed: 3000, maxRate: { x: 5000, y: 5000, z: 3000 }, safeHeight: 10, zHeadroom: null, honorProgramPauses: true };

const flush = () => new Promise((r) => setImmediate(r));

/** Expected target of each compiled move, in order, without building an array. */
function moveChecker(lines) {
    const pos = { x: null, y: null, z: null };
    const targets = [];
    const AX = /([XYZ])(-?\d+\.\d+)/g;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i];
        if (!/^G21 G90 G[01] /.test(t)) continue;
        AX.lastIndex = 0;
        let m;
        while ((m = AX.exec(t)) !== null) pos[m[1].toLowerCase()] = parseFloat(m[2]);
        targets.push({ line: i + 1, x: pos.x, y: pos.y, z: pos.z });
    }
    let idx = 0;
    const problems = [];
    return {
        total: targets.length,
        get index() { return idx; },
        problems,
        check(leg) {
            const e = targets[idx];
            if (!e) { problems.push(`extra leg after the last move: line ${leg.line}`); return; }
            const near = (a, b) => a === null || Math.abs(a - b) < 0.0011;
            if (leg.line !== (e.line & 0xFFFF) || !near(e.x, leg.to.x) || !near(e.y, leg.to.y) || !near(e.z, leg.to.z)) {
                if (problems.length < 5) {
                    problems.push(`move ${idx + 1}: ran wire line ${leg.line} to (${leg.to.x}, ${leg.to.y}, ${leg.to.z}), expected file line ${e.line} to (${e.x}, ${e.y}, ${e.z})`);
                }
            }
            idx += 1;
        },
    };
}

async function streamFile(file) {
    const text = fs.readFileSync(path.join(CORPUS, file), 'utf8');
    const t0 = process.hrtime.bigint();
    let checker = null;
    const fw = new FakeFirmware({
        fwVersion: FW_VERSION,
        recordExecuted: false,
        onExecuted: (leg) => { if (checker) checker.check(leg); },
    });
    const conn = new FakeConnection(fw);
    const ctrl = new RSPController();
    const problems = [];
    ctrl.on('console', (m) => { if (/^⛔|^⚠️/.test(m)) problems.push(m); });
    ctrl.on('error', () => {});
    let ended = null;
    ctrl.on('job:end', () => { ended = 'done'; });
    ctrl.on('sender:error', (e) => { ended = `failed: ${e && e.reason}`; });
    ctrl.bind(conn);

    ctrl.command('gcode:load', file, text, 0, COMPILE_OPTIONS);
    const load = ctrl.lastLoadResult;
    assert.ok(load && load.ok, `${file}: refused at load -- ${JSON.stringify(load && load.meta && load.meta.errors)}`);
    const lines = ctrl._loadedLines;
    checker = moveChecker(lines);
    const pauses = ctrl._loadedMeta.pauses.length;

    mock.timers.tick(50);
    await flush();
    ctrl.command('gcode:start');

    // Program pauses (M0) are answered the way an operator would.
    let resumes = 0;
    ctrl.on('job:programPause', () => { resumes += 1; setImmediate(() => ctrl.command('gcode:resume')); });

    const stepMs = 20;
    const maxVirtualMs = 12 * 60 * 60 * 1000; // 12 h of machine time
    let virtual = 0;
    while (!ended && virtual < maxVirtualMs) {
        mock.timers.tick(stepMs);
        await flush();
        virtual += stepMs;
    }
    const wall = Number(process.hrtime.bigint() - t0) / 1e9;

    assert.strictEqual(ended, 'done', `${file}: job did not finish (${ended || 'timed out'}) at move ${checker.index}/${checker.total}`);
    assert.deepStrictEqual(checker.problems, [], `${file}: executed path differs from the program`);
    assert.strictEqual(checker.index, checker.total, `${file}: ${checker.index} of ${checker.total} moves executed`);
    assert.strictEqual(fw.jobStarts, 1, `${file}: ${fw.jobStarts} firmware jobs (the file must run as one)`);
    assert.strictEqual(fw.jobEnds, 1, `${file}: ${fw.jobEnds} job ends`);
    assert.ok(!fw.jobAborts, `${file}: the job was aborted`);
    assert.ok(!fw.watchdogTrips, `${file}: the controller's host watchdog tripped`);
    assert.ok(!fw.bufferNaks, `${file}: planner overflowed (${fw.bufferNaks} BUFFER NAKs)`);
    assert.strictEqual(fw.state, defs.ST_IDLE, `${file}: machine not idle at the end`);
    assert.deepStrictEqual(problems, [], `${file}: warnings/refusals on the console`);
    assert.strictEqual(resumes, pauses, `${file}: ${pauses} program pause(s), ${resumes} seen`);

    ctrl.unbind();
    fw.destroy();
    conn.removeAllListeners();
    return { file, lines: lines.length, moves: checker.total, pauses, machineHours: virtual / 3600000, wall };
}

(async () => {
    console.log(`Streaming the reference corpus through the fake firmware (fw ${FW_VERSION})...`);
    if (!fs.existsSync(CORPUS)) {
        console.log(`  SKIP: corpus not found at ${CORPUS}`);
        console.log('ALL TESTS PASSED SUCCESSFULLY! (corpus SKIPPED -- nothing was streamed)');
        process.exit(0);
    }
    const files = fs.readdirSync(CORPUS).filter((f) => /\.(nc|ngc|gcode|tap|cnc)$/i.test(f)).sort();
    assert.ok(files.length > 0, 'corpus is empty');
    for (const f of files) {
        const r = await streamFile(f);
        console.log(`  ok  ${r.file}: ${r.moves} moves of ${r.lines} lines, ${r.pauses} pause(s), ${r.machineHours.toFixed(2)} h machine time (${r.wall.toFixed(1)} s)`);
        global.gc?.();
    }
    console.log(`ALL TESTS PASSED SUCCESSFULLY! (${files.length} files ran start to finish)`);
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
