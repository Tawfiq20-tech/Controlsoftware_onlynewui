'use strict';

/**
 * The per-connection session log (logs/sessions/*.ndjson) must not hurt a job
 * when the disk misbehaves.
 *
 *   - Disk stalled (OneDrive or a USB drive hanging): the write stream accepts
 *     records into memory for as long as the disk does not answer -- 53 MB
 *     held for 50 MB offered (2026-09-17). Capped now: records are dropped
 *     past 8 MB unwritten, counted, and the count is written when the disk
 *     catches up.
 *   - Disk slow rather than stalled: it fills and drains over and over. That
 *     is reported once, not at every fill (review, 2026-09-17).
 *   - Disk full / drive gone: a regression guard. The session log already
 *     turned itself off and said so once before this work (on stderr); the
 *     report now goes through the app logger, because stderr may be the
 *     closed console pipe of 2026-09-16.
 *
 * Measured from outside (the real fs.WriteStream the logger opens, the file
 * it writes), not through the logger's own diagnostics.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.join(__dirname, '..');

// Capture what SessionLogger reports through the app logger.
const reports = [];
const loggerPath = require.resolve(path.join(BACKEND, 'logger'));
const stub = { warn: (m) => reports.push(String(m)), info() {}, error: (m) => reports.push(String(m)), debug() {} };
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: stub };

// The streams the session logger opens.
const streams = [];
const realCreateWriteStream = fs.createWriteStream;
fs.createWriteStream = function (...a) { const s = realCreateWriteStream.apply(this, a); streams.push(s); return s; };
const { createSessionLogger } = require(path.join(BACKEND, 'services/SessionLogger'));

const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'session-log-')); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* open */ } } });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

let uncaught = 0;
process.on('uncaughtException', (e) => { uncaught++; console.log(`  uncaught: ${e.message}`); });

/** fs.write/writev held until released: a disk that does not answer. */
function holdDiskWrites() {
    const realWrite = fs.write;
    const realWritev = fs.writev;
    const held = [];
    fs.write = function (fd, ...a) { held.push(() => realWrite.call(fs, fd, ...a)); };
    fs.writev = function (fd, ...a) { held.push(() => realWritev.call(fs, fd, ...a)); };
    return {
        release() { for (const w of held.splice(0)) w(); },
        restore() { fs.write = realWrite; fs.writev = realWritev; this.release(); },
    };
}

async function drained(stream) {
    for (let i = 0; i < 500 && stream.writableLength > 0; i++) await tick(10);
    assert.strictEqual(stream.writableLength, 0, 'the disk caught up');
}

async function testDiskFull() {
    reports.length = 0;
    const dir = tmpDir();
    const realWrite = fs.write;
    const realWritev = fs.writev;
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
    fs.write = function (fd, ...a) { return process.nextTick(a[a.length - 1], enospc()); };
    fs.writev = function (fd, ...a) { return process.nextTick(a[a.length - 1], enospc()); };
    let threw = null;
    const s = createSessionLogger(dir, 'COM12');
    const stream = streams[streams.length - 1];
    let writesAfterFailure = 0;
    try {
        for (let i = 0; i < 2000; i++) {
            s.logPosition({ x: i, y: 0, z: 0 });
            s.logConsole(`line ${i}`);
            if (i % 100 === 0) await tick(1);
        }
        await tick(50);
        const realStreamWrite = stream.write;
        stream.write = function (...a) { writesAfterFailure++; return realStreamWrite.apply(this, a); };
        for (let i = 0; i < 100; i++) s.logConsole(`later ${i}`);
    } catch (e) { threw = e; } finally { fs.write = realWrite; fs.writev = realWritev; }
    s.close();
    assert.ifError(threw);
    assert.strictEqual(uncaught, 0, 'no uncaught exception');
    assert.strictEqual(writesAfterFailure, 0, 'the log stops writing once the disk refused');
    assert.strictEqual(reports.filter((r) => /session log disabled/.test(r)).length, 1, `reported once through the app log: ${JSON.stringify(reports)}`);
    console.log('  ok  disk full: the session log turns itself off, one report in the app log, nothing thrown');
}

async function testStalledDiskIsCapped() {
    reports.length = 0;
    const dir = tmpDir();
    const s = createSessionLogger(dir, 'COM12');
    const stream = streams[streams.length - 1];
    await tick(50); // opened
    const disk = holdDiskWrites();
    const big = 'x'.repeat(1000);
    const heapBefore = process.memoryUsage().arrayBuffers;
    let unwritten;
    try {
        for (let i = 0; i < 20000; i++) s.logConsole(`${i} ${big}`);   // ~20 MB offered
        unwritten = stream.writableLength;
    } finally {
        disk.restore();                                   // the disk comes back
    }
    console.log(`  info  stalled disk, ~20 MB offered: ${(unwritten / MB).toFixed(1)} MB held unwritten, arrayBuffers +${((process.memoryUsage().arrayBuffers - heapBefore) / MB).toFixed(1)} MB`);
    assert.ok(unwritten <= 8 * MB + 4096, `memory held for the stalled disk: ${(unwritten / MB).toFixed(1)} MB`);
    assert.strictEqual(reports.filter((r) => /not keeping up/.test(r)).length, 1, `reported once: ${JSON.stringify(reports)}`);
    await drained(stream);
    s.logConsole('after the stall');
    s.close();
    await tick(200);
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.ndjson'));
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const gap = /"event":"session-log","dropped":(\d+)/.exec(text);
    assert.ok(gap, 'the log records how many records were dropped');
    const kept = text.split('\n').filter((l) => l.includes('"event":"console"')).length;
    assert.strictEqual(kept + Number(gap[1]), 20000 + 1, `every record offered was either written or counted as dropped (${kept} + ${gap[1]})`);
    assert.ok(text.includes('after the stall'));
    console.log('  ok  stalled disk: at most 8 MB held in memory, the rest dropped and counted, one report');
}

async function testSlowDiskIsReportedOnce() {
    // A disk that keeps falling behind and catching up: 4 times in a row.
    reports.length = 0;
    const dir = tmpDir();
    const s = createSessionLogger(dir, 'COM12');
    const stream = streams[streams.length - 1];
    await tick(50);
    const big = 'y'.repeat(1000);
    let offered = 0;
    for (let round = 0; round < 4; round++) {
        const disk = holdDiskWrites();
        try {
            for (let i = 0; i < 10000; i++) { s.logConsole(`${round}.${i} ${big}`); offered++; }
            assert.ok(stream.writableLength <= 8 * MB + 4096, `round ${round}: ${(stream.writableLength / MB).toFixed(1)} MB held`);
        } finally {
            disk.restore();
        }
        await drained(stream);
        s.logConsole(`caught up ${round}`);
        offered++;
    }
    s.close();
    await tick(200);
    const notices = reports.filter((r) => /not keeping up/.test(r));
    assert.strictEqual(notices.length, 1, `a slow disk is reported once, not at every fill: ${JSON.stringify(notices)}`);
    const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.ndjson'))), 'utf8');
    const gaps = [...text.matchAll(/"event":"session-log","dropped":(\d+)/g)].map((m) => Number(m[1]));
    assert.strictEqual(gaps.length, 4, `each gap is recorded in the session log itself (${gaps.length})`);
    const kept = text.split('\n').filter((l) => l.includes('"event":"console"')).length;
    assert.strictEqual(kept + gaps.reduce((a, b) => a + b, 0), offered, 'every record written or counted');
    console.log('  ok  slow disk filling and draining 4 times: one report in the app log, every gap counted in the session log');
}

async function testDroppingEndsOnlyWellBelowTheCap() {
    // A disk that is slow rather than stalled hovers around the cap: taking
    // records again at 7.9 MB meant dropping and taking in turn, record by record.
    reports.length = 0;
    const dir = tmpDir();
    const s = createSessionLogger(dir, 'COM12');
    const stream = streams[streams.length - 1];
    await tick(50);
    let level = 0;
    Object.defineProperty(stream, 'writableLength', { configurable: true, get: () => level });
    const written = () => fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.ndjson'))), 'utf8');
    level = 9 * MB; s.logConsole('over the cap');
    level = 6 * MB; s.logConsole('still over half the cap');
    level = 3 * MB; s.logConsole('below half the cap');
    delete stream.writableLength;
    s.close();
    await tick(200);
    const text = written();
    assert.ok(!text.includes('over the cap'), 'dropped over the cap');
    assert.ok(!text.includes('still over half the cap'), 'still dropping just below the cap');
    assert.ok(text.includes('below half the cap'), 'taken again well below it');
    assert.ok(/"event":"session-log","dropped":2\b/.test(text), text);
    console.log('  ok  once dropping, records are taken again only below half the cap');
}

(async () => {
    await testDiskFull();
    await testStalledDiskIsCapped();
    await testSlowDiskIsReportedOnce();
    await testDroppingEndsOnlyWellBelowTheCap();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
})().catch((e) => { console.error(e); process.exit(1); });
