'use strict';

/**
 * START / Resume of a very large program must not freeze the backend.
 *
 * JobStream.upload() used to clean and index every line of the program on the
 * main thread in one go: ~1.7 s for a million lines on the shop PC, more on
 * the Raspberry Pi, while the RSP heartbeat window is 3 s and the stream's
 * 5 ms retransmit tick and the socket traffic all wait. Here the preparation
 * must never hold the event loop for more than ~50 ms at a time, and the
 * prepared program must be exactly what the one-shot preparation produced.
 *
 * Real timers (the event-loop delay is the thing measured).
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const defs = require('../services/rsp/defs');
const { JobStream, isMotionLine, MAX_LINE_BYTES, CLEAN_LINE_RE } = require('../services/rsp/job');
const resumeFromLine = require('../lib/resumeFromLine');

const { cleanGcodeLines } = resumeFromLine;
const MAX_BLOCK_MS = 50;
// Wall-clock measurements on a shared PC: a scenario is measured up to this
// many times and judged on its best run (the old one-shot preparation blocked
// for 850-1860 ms every time, so a real regression still fails every run).
const ATTEMPTS = 3;
const CORPUS = process.env.EASYCNC_CORPUS || 'C:/Users/Tawfiq/Downloads/gcode_test_file/file_finity';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Stream double: answers OP_JOB_START, never takes a job line (nothing to stream here). */
function stubStream() {
    const s = new EventEmitter();
    s.linkOk = true;
    s.available = 0;
    s.commands = [];
    s.setHeartbeatPaused = () => {};
    s.sendNowait = () => -1;
    s.cancelPending = () => 0;
    s.sendCommand = (op) => {
        s.commands.push({ op, at: performance.now() });
        return Promise.resolve({ payload: Buffer.from([op, defs.ST_OK]) });
    };
    return s;
}

function compiledProgram(n) {
    const out = ['G21', 'G90', 'M3 S16000', 'G0 Z5.000', 'G0 X0.000 Y0.000'];
    let x = 0;
    let y = 0;
    let dir = 1;
    while (out.length < n) {
        x += dir * 0.25;
        if (x > 300 || x < 0) {
            dir = -dir;
            y += 0.25;
            out.push(`G21 G90 G1 Y${y.toFixed(3)} F1500`);
            continue;
        }
        const z = -1 - 1.5 * Math.sin(x / 7) * Math.cos(y / 9);
        out.push(`G21 G90 G1 X${x.toFixed(3)} Z${z.toFixed(3)} F${1500 + (out.length % 5) * 100}`);
    }
    return out;
}

/** The one-shot preparation upload() did before, kept here as the reference. */
function reference(lines, clean0 = cleanGcodeLines) {
    const clean = clean0(lines.join('\n'));
    const n = clean.length;
    const isMotion = new Uint8Array(n + 2);
    const prefix = new Uint32Array(n + 1);
    for (let i = 1; i <= n; i++) {
        const m = isMotionLine(clean[i - 1]) ? 1 : 0;
        isMotion[i] = m;
        prefix[i] = prefix[i - 1] + m;
    }
    const descend = new Uint8Array(n);
    let z = null;
    for (let i = 0; i < n; i++) {
        if (!isMotion[i + 1]) continue;
        const m = /Z\s*([-+]?(?:\d+\.?\d*|\.\d+))/i.exec(clean[i]);
        if (!m) continue;
        const to = parseFloat(m[1]);
        if (z === null || to < z - 0.001) descend[i] = 1;
        z = to;
    }
    return { clean, isMotion, prefix, descend };
}

function assertPreparedLike(job, ref, label) {
    assert.strictEqual(job.totalLineCount, ref.clean.length, `${label}: line count`);
    // first difference only: a diff of two 60,000-element arrays exhausts the heap
    for (const [name, got, want] of [
        ['cleaned lines', job.lines, ref.clean],
        ['motion flags', job._isMotion, ref.isMotion],
        ['motion prefix', job._motionPrefix, ref.prefix],
        ['descending-Z flags', job._descendLines, ref.descend],
    ]) {
        assert.strictEqual(got.length, want.length, `${label}: ${name}: length`);
        let i = 0;
        while (i < want.length && got[i] === want[i]) i++;
        assert.ok(i === want.length, `${label}: ${name} differ first at index ${i}: ${JSON.stringify(got[i])} instead of ${JSON.stringify(want[i])}`);
    }
}

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

// ---------------------------------------------------------------------------

async function testSameLinesAsTheOneShotPreparation() {
    const R = rng(3);
    const pieces = ['G1 X1.000 F100', 'G0 Z5', ' G1 Y2 ', '(comment)', 'G1 X3 (inline) Y4', 'M3 S1000 ; spindle',
        '%', ' % ', '', '   ', 'G1 X1 %', 'G1 Z-1 ((nested) paren)', 'X5)', ' G1 X6 ', '﻿G21',
        'G1 X7 (unclosed', ';only a comment', 'T1 M6', 'G4 P1', 'g1 z-0.5 f300', 'G1 X1e3', 'G1 Z .5'];
    const small = [];
    for (let i = 0; i < 3000; i++) small.push(pieces[Math.floor(R() * pieces.length)]);
    const big = [];
    for (let i = 0; i < 60000; i++) big.push(i % 997 === 0 ? pieces[Math.floor(R() * pieces.length)] : `G21 G90 G1 X${(i % 300).toFixed(3)} Z${(-(i % 7) / 3).toFixed(3)} F1200`);
    const withBreaks = big.slice();
    withBreaks[12345] = 'G1 X1\rG1 X2';     // lone CR inside an element
    withBreaks[23456] = 'G1 Y1\nG1 Y2\r\n'; // a line break inside an element

    for (const [label, lines] of [['mixed 3000 lines', small], ['60000 lines', big], ['60000 lines with line breaks inside', withBreaks]]) {
        const job = new JobStream(stubStream(), { logger: quiet });
        job.upload(lines, null, {});
        assert.strictEqual(await job.whenPrepared(), true, `${label}: prepared`);
        assertPreparedLike(job, reference(lines), label);
        job.abort();
    }
    console.log('  ok  prepared lines, motion flags and Z-descent flags equal the one-shot preparation (comments, %, odd whitespace, line breaks)');
}

async function testRandomProgramsPrepareLikeTheJoinedText() {
    // Elements are prepared one at a time; the reference cleans the joined
    // text. Line breaks of every kind at element edges and inside, comments
    // opened in one element and closed in the next, '%' lines, null/undefined.
    const R = rng(11);
    const frags = ['G1', ' X1.5', 'Y-2', ' Z.25', 'F300', 'M3', 'S1000', ' ', '\t', '(', ')', ';', '%', 'N10',
        '/', 'g0', '\r', '\n', '\r\n', '\n\r', '﻿', ' ', 'T1 M6', 'G4 P0.5', 'x', '*'];
    for (let p = 0; p < 400; p++) {
        const lines = [];
        const count = 1 + Math.floor(R() * 40);
        for (let i = 0; i < count; i++) {
            const roll = R();
            if (roll < 0.03) { lines.push(null); continue; }
            if (roll < 0.05) { lines.push(undefined); continue; }
            let s = '';
            const parts = Math.floor(R() * 6);
            for (let k = 0; k < parts; k++) s += frags[Math.floor(R() * frags.length)];
            lines.push(s);
        }
        const job = new JobStream(stubStream(), { logger: quiet });
        job.upload(lines, null, {});
        assert.strictEqual(await job.whenPrepared(), true);
        assertPreparedLike(job, reference(lines), `random program ${p} ${JSON.stringify(lines)}`);
        job.abort();
    }
    console.log('  ok  400 random programs (line breaks at and inside element edges, comments across elements, null elements) prepare exactly like the joined text');
}

async function testFastPathAgreesWithTheSharedCleaner() {
    // The fast path takes a line matching CLEAN_LINE_RE as it is; that must be
    // exactly what cleanGcodeLines() returns for it. Random lines, and every
    // line of the reference corpus when it is on this PC.
    const R = rng(21);
    const alphabet = 'GgMmXxYyZzFfSsTtNnPpIiJjKk0123456789.-+ \t();%/*#=[]\r\n﻿ ';
    let fast = 0;
    const check = (l) => {
        if (!CLEAN_LINE_RE.test(l)) return;
        fast++;
        assert.deepStrictEqual(cleanGcodeLines(l), [l], `a line the fast path keeps as it is is changed by cleanGcodeLines(): ${JSON.stringify(l)}`);
    };
    for (let i = 0; i < 200000; i++) {
        let s = '';
        const len = 1 + Math.floor(R() * 24);
        for (let k = 0; k < len; k++) s += alphabet[Math.floor(R() * alphabet.length)];
        check(s);
    }
    const randomFast = fast;
    assert.ok(randomFast > 1000, `premise: ${randomFast} random lines took the fast path`);
    let corpusLines = 0;
    if (fs.existsSync(CORPUS)) {
        // every file's header (post-processor dialect) and a sample of the body
        for (const f of fs.readdirSync(CORPUS).filter((n) => /\.(nc|ngc|gcode|tap|cnc)$/i.test(n))) {
            const all = fs.readFileSync(path.join(CORPUS, f), 'latin1').split(/\r\n|\r|\n/);
            for (let i = 0; i < all.length; i += i < 2000 ? 1 : 97) {
                check(all[i]);
                check(all[i].trim());
                corpusLines++;
            }
        }
    }

    // And if the shared cleaner changes one day, the job follows it: the fast
    // path is dropped and every line goes through the cleaner.
    const real = resumeFromLine.cleanGcodeLines;
    try {
        resumeFromLine.cleanGcodeLines = (text) => real(text).map((l) => l.replace(/^G21 G90 /, ''));
        const lines = compiledProgram(60000);
        const last = lines[lines.length - 1];
        assert.notStrictEqual(resumeFromLine.cleanGcodeLines(last)[0], last, 'premise: the changed cleaner rewrites compiled lines');
        const job = new JobStream(stubStream(), { logger: quiet });
        job.upload(lines, null, {});
        assert.strictEqual(await job.whenPrepared(), true);
        assertPreparedLike(job, reference(lines, resumeFromLine.cleanGcodeLines), 'the job follows a changed cleanGcodeLines()');
        job.abort();
    } finally {
        resumeFromLine.cleanGcodeLines = real;
    }
    console.log(`  ok  lines the fast path keeps are exactly what cleanGcodeLines() returns (${randomFast} random lines, ${corpusLines} corpus lines${corpusLines ? '' : ': corpus not on this PC'}); a changed cleaner is followed`);
}

/** One measured upload + START (or Resume); returns the timings and the job. */
async function measureStart(lines, resumeFrom) {
    const stream = stubStream();
    const job = new JobStream(stream, { logger: quiet });
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    let maxGap = 0;
    let last = performance.now();
    const probe = setInterval(() => {
        const t = performance.now();
        maxGap = Math.max(maxGap, t - last);
        last = t;
    }, 1);
    await new Promise((r) => setTimeout(r, 30));
    maxGap = 0;
    h.reset();
    last = performance.now();

    const t0 = performance.now();
    stream.commands.length = 0;
    job.upload(lines, null, { holds: [{ line: 700000, kind: 'dwell', seconds: 1 }, { line: 10, kind: 'dwell', seconds: 1 }] });
    const uploadMs = performance.now() - t0;
    if (resumeFrom) job.resume(resumeFrom);
    job.start();
    while (!stream.commands.some((c) => c.op === defs.OP_JOB_START)) {
        if (performance.now() - t0 > 60000) throw new Error('OP_JOB_START never sent');
        await new Promise((r) => setTimeout(r, 5));
    }
    const readyMs = stream.commands.find((c) => c.op === defs.OP_JOB_START).at - t0;
    await new Promise((r) => setTimeout(r, 20)); // let the probes see the last stretch
    clearInterval(probe);
    h.disable();
    return { job, uploadMs, readyMs, stallMs: Math.max(maxGap, h.max / 1e6) };
}

async function testMillionLineStartNeverBlocksTheEventLoop() {
    // The compiled program as the controller keeps it from the load (seconds or
    // hours before START). The collections here only settle that load's
    // garbage, which is not what is measured.
    const lines = compiledProgram(1_000_000).join('\n').split(/\r?\n/);
    // The same with a line break left inside an element (a lone CR, which the
    // controller's split does not split on): once took the one-shot path.
    const withCr = lines.slice();
    withCr[20] = 'G21 G90 G1 Z4.000 F1500\rG21 G90 G1 Z5.000 F1500';
    global.gc();
    global.gc();
    // a Resume first, then a fresh START, the way RSPController does them
    for (const [label, program, resumeFrom] of [
        ['Resume at line 600000', lines, 600000],
        ['START', lines, 0],
        ['START (a lone CR inside one element)', withCr, 0],
    ]) {
        let best = null;
        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
            const m = await measureStart(program, resumeFrom);
            const extra = program === withCr ? 1 : 0;
            assert.strictEqual(m.job.totalLineCount, program.length + extra, `${label}: line count`);
            assert.strictEqual(m.job.nextLineToRun(), resumeFrom || 1, `${label}: resume point applied once the lines were ready`);
            assert.strictEqual(m.job._holds[m.job._holdIdx].line, resumeFrom ? 700000 : 10, `${label}: holds before the resume point skipped`);
            if (extra) assert.deepStrictEqual(m.job.lines.slice(20, 22), ['G21 G90 G1 Z4.000 F1500', 'G21 G90 G1 Z5.000 F1500'], `${label}: split at the CR`);
            // What the prepared job keeps: it shares the program's line strings
            // instead of holding a second, re-split copy of the whole text.
            global.gc();
            const withJob = process.memoryUsage().heapUsed;
            m.job.abort();
            m.job.destroy();
            m.job = null;
            global.gc();
            m.keptMB = (withJob - process.memoryUsage().heapUsed) / 1e6;
            const worst = Math.max(m.uploadMs, m.stallMs);
            if (!best || worst < Math.max(best.uploadMs, best.stallMs)) best = m;
            if (worst <= MAX_BLOCK_MS) break;
            console.log(`      (${label}: attempt ${attempt} held the event loop ${worst.toFixed(0)} ms, measuring again)`);
        }
        assert.ok(best.uploadMs <= MAX_BLOCK_MS, `${label}: upload() itself returned in ${best.uploadMs.toFixed(0)} ms`);
        assert.ok(best.stallMs <= MAX_BLOCK_MS, `${label}: event loop held for ${best.stallMs.toFixed(0)} ms at most (limit ${MAX_BLOCK_MS}, best of ${ATTEMPTS})`);
        // a lone CR costs one copy of the line references (8 MB per million)
        const keptLimit = program === withCr ? 60 : 40;
        assert.ok(best.keptMB < keptLimit, `${label}: the prepared job keeps ${best.keptMB.toFixed(0)} MB of heap`);
        console.log(`  ok  ${label} of a 1,000,000-line program: upload() ${best.uploadMs.toFixed(0)} ms, ` +
            `longest event-loop stall ${best.stallMs.toFixed(0)} ms, OP_JOB_START after ${best.readyMs.toFixed(0)} ms, job holds ${best.keptMB.toFixed(0)} MB`);
    }
}

async function testTooLongLineInABigProgramFailsBeforeTheMachineIsTold() {
    const lines = compiledProgram(80000);
    lines[70001] = `G21 G90 G1 X1.000 Y2.000 Z3.000 F1000 (${'x'.repeat(MAX_LINE_BYTES)})`.replace(/\(.*\)/, `S${'1'.repeat(MAX_LINE_BYTES)}`);
    const stream = stubStream();
    const job = new JobStream(stream, { logger: quiet });
    const failed = [];
    job.on('failed', (r) => failed.push(r));
    job.upload(lines, null, {});
    job.start();
    assert.strictEqual(await job.whenPrepared(), false);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(failed.length, 1, 'the job fails');
    assert.ok(/line 70002 is longer than the machine's 63-byte limit/.test(failed[0]), failed[0]);
    assert.ok(!stream.commands.some((c) => c.op === defs.OP_JOB_START), 'OP_JOB_START was never sent');
    assert.strictEqual(job.active, false);

    // small programs still refuse it synchronously, before anything changes
    const small = compiledProgram(100);
    small[50] = lines[70001];
    const job2 = new JobStream(stubStream(), { logger: quiet });
    assert.throws(() => job2.upload(small, null, {}), /line 51 is longer than the machine's 63-byte limit/);
    assert.strictEqual(job2.active, false);
    console.log('  ok  a line over 63 bytes fails a big program before OP_JOB_START (a small one is refused at upload, as before)');
}

async function testStopWhilePreparingSendsNothing() {
    const stream = stubStream();
    const job = new JobStream(stream, { logger: quiet });
    job.upload(compiledProgram(400000), null, {});
    job.start();
    await new Promise((r) => setImmediate(r));
    job.abort();
    assert.strictEqual(await job.whenPrepared(), false);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!stream.commands.some((c) => c.op === defs.OP_JOB_START), 'no OP_JOB_START after Stop');
    // and the next job is not disturbed by the abandoned preparation
    const next = compiledProgram(30000);
    job.upload(next, null, {});
    job.start();
    assert.strictEqual(await job.whenPrepared(), true);
    assert.strictEqual(job.totalLineCount, next.length);
    job.abort();
    console.log('  ok  Stop while a big program is still being prepared: nothing reaches the machine; the next job prepares normally');
}

if (typeof global.gc !== 'function') {
    // The retained-memory check needs a real collection before each reading.
    // Same flags (run-all's write guard) and environment as this process.
    const r = require('child_process').spawnSync(process.execPath, [...process.execArgv, '--expose-gc', __filename], { stdio: 'inherit', env: process.env });
    process.exit(r.status === null ? 1 : r.status);
}

(async () => {
    console.log('Testing job preparation against event-loop stalls...');
    await testSameLinesAsTheOneShotPreparation();
    await testRandomProgramsPrepareLikeTheJoinedText();
    await testFastPathAgreesWithTheSharedCleaner();
    await testMillionLineStartNeverBlocksTheEventLoop();
    await testTooLongLineInABigProgramFailsBeforeTheMachineIsTold();
    await testStopWhilePreparingSendsNothing();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
