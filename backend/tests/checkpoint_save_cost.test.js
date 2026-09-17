'use strict';

/**
 * A progress checkpoint must not stall the sender while the machine cuts.
 *
 * JobResumeService saves the resume checkpoint every 25 lines (at most once a
 * second) on the main thread. Each save used to sha1 the WHOLE program again
 * and fsync + copy on the main thread: 25-40 ms every ~2.5 s on the 17 MB
 * SHIP FINISHING file (2026-09-17), while the stream tick runs every 5 ms.
 *
 * What must still hold: atomic replace, CRC, a .bak that is always a
 * checkpoint already on the disk for good, old checkpoint files still load,
 * and a locked (OneDrive) or full disk never throws, stalls the sender or
 * floods the log.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const BACKEND = path.join(__dirname, '..');
const { JobResumeStore, computeCrc32 } = require(path.join(BACKEND, 'services/jobresume/JobResumeStore'));

const made = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cost-')); made.push(d); return d; };
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });
const durable = (store) => (typeof store.whenDurable === 'function' ? store.whenDurable() : new Promise((r) => setTimeout(r, 50)));
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function recordingLogger() {
    const lines = { error: [], warn: [], info: [], debug: [] };
    const log = {};
    for (const k of Object.keys(lines)) log[k] = (m) => lines[k].push(String(m));
    log.lines = lines;
    return log;
}

/** ~17 MB of plausible 3D-finishing G-code, built once. */
function bigProgram(targetBytes = 17 * 1024 * 1024) {
    const parts = ['G21', 'G90', 'M3 S18000'];
    let size = 20;
    for (let i = 0; size < targetBytes; i++) {
        const l = `G1 X${(i % 6000 / 10).toFixed(3)} Y${(i / 7000).toFixed(3)} Z${(-(i % 37) / 100).toFixed(3)} F2400`;
        parts.push(l);
        size += l.length + 1;
    }
    parts.push('M5', 'M2');
    return parts.join('\n');
}

function spyOn(obj, name, counter) {
    const orig = obj[name];
    obj[name] = function spied(...args) { counter.n++; if (counter.onCall) counter.onCall(args); return orig.apply(this, args); };
    return () => { obj[name] = orig; };
}

async function testProgressSavesDoNotRehashOrBlock() {
    // The gate is what the save DOES (no sha1 of the program, no fsync on the
    // main thread) and that its cost does not grow with the program. An
    // absolute "< 10 ms" failed on a PC at ~35% CPU (12-14 ms: one open and
    // two renames under antivirus), which says nothing about this fix.
    const bigDir = tmpDir();
    const tinyDir = tmpDir();
    const text = bigProgram();
    const big = new JobResumeStore(bigDir, recordingLogger());
    const tiny = new JobResumeStore(tinyDir, recordingLogger());
    const bigJob = { filename: 'ship.ngc', gcodeText: text, totalLines: 1017473, lastExecutedLine: 0, modalState: { units: 'G21' } };
    const tinyJob = { filename: 'tiny.nc', gcodeText: 'G21\nG0 X1\nG0 X2\n', totalLines: 3, lastExecutedLine: 0, modalState: { units: 'G21' } };
    big.save(bigJob);                      // job start: writes the program once
    tiny.save(tinyJob);
    await Promise.all([durable(big), durable(tiny)]);

    const sha1 = { n: 0 };
    const unspyHash = spyOn(crypto, 'createHash', sha1);
    const fsyncs = { n: 0 };
    const unspyFsync = spyOn(fs, 'fsyncSync', fsyncs);
    const bigTimes = [];
    const tinyTimes = [];
    const timed = (store, job, into) => { const t = performance.now(); store.save(job); into.push(performance.now() - t); };
    try {
        // interleaved, so machine load hits both alike
        for (let i = 1; i <= 20; i++) {
            bigJob.lastExecutedLine = tinyJob.lastExecutedLine = i * 25;
            if (i % 2) { timed(big, bigJob, bigTimes); timed(tiny, tinyJob, tinyTimes); } else { timed(tiny, tinyJob, tinyTimes); timed(big, bigJob, bigTimes); }
            await Promise.all([durable(big), durable(tiny)]);   // saves are >= 1 s apart in a real job
        }
    } finally {
        unspyHash();
        unspyFsync();
    }
    assert.strictEqual(sha1.n, 0, `a progress save must not hash the program again (hashed ${sha1.n} times in 40 saves)`);
    assert.strictEqual(fsyncs.n, 0, `a progress save must not fsync on the main thread (${fsyncs.n} in 40 saves)`);
    const bigMed = median(bigTimes);
    const tinyMed = median(tinyTimes);
    console.log(`  info  progress saves on the main thread, median (max): 17 MB program ${bigMed.toFixed(2)} (${Math.max(...bigTimes).toFixed(2)}) ms, 17-byte program ${tinyMed.toFixed(2)} (${Math.max(...tinyTimes).toFixed(2)}) ms`);
    assert.ok(bigMed <= tinyMed * 2 + 2, `a progress save costs more for a bigger program: ${bigMed.toFixed(1)} ms vs ${tinyMed.toFixed(1)} ms`);
    // generous ceiling: the old save was 25-40 ms idle, 155-175 ms under load
    assert.ok(bigMed < 60, `median progress save blocked the main thread ${bigMed.toFixed(1)} ms`);

    const cp = new JobResumeStore(bigDir).load();
    assert.ok(cp, 'checkpoint loads');
    assert.strictEqual(cp.lastExecutedLine, 500);
    assert.strictEqual(cp.gcodeHash, crypto.createHash('sha1').update(text).digest('hex'), 'hash is of the program');
    assert.strictEqual(cp.gcodeText.length, text.length, 'program text comes back whole');
    fs.rmSync(bigDir, { recursive: true, force: true });
    fs.rmSync(tinyDir, { recursive: true, force: true });
    console.log('  ok  progress saves of a 17 MB job: no re-hash, no main-thread fsync, same cost as a tiny program, checkpoint intact');
}

async function testBakIsAlwaysADurableCheckpoint() {
    const dir = tmpDir();
    const store = new JobResumeStore(dir, recordingLogger());
    const job = { filename: 'a.nc', gcodeText: 'G21\nG0 X1\nG0 X2\n', totalLines: 3, lastExecutedLine: 1 };
    store.save(job);
    await durable(store);
    job.lastExecutedLine = 2;
    store.save(job);
    // A Stop/error right after: the main written a moment ago may not be
    // flushed yet. It must be flushed before it becomes the backup.
    const fsyncs = { n: 0 };
    const unspy = spyOn(fs, 'fsyncSync', fsyncs);
    job.lastExecutedLine = 3;
    try { store.save(job); } finally { unspy(); }
    await durable(store);
    assert.ok(fsyncs.n >= 1 || typeof store.whenDurable !== 'function', 'an unflushed main is flushed before it is rotated into .bak');
    const bak = JSON.parse(fs.readFileSync(path.join(dir, 'job_resume.json.bak'), 'utf8'));
    assert.strictEqual(bak.lastExecutedLine, 2, '.bak holds the previous checkpoint');
    assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 3);

    // main corrupted (e.g. torn by a power cut): the backup is used
    fs.writeFileSync(path.join(dir, 'job_resume.json'), '{"torn":');
    const log = recordingLogger();
    assert.strictEqual(new JobResumeStore(dir, log).load().lastExecutedLine, 2, 'falls back to .bak');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok  .bak is the previous checkpoint and is flushed before rotation; torn main falls back to it');
}

async function testBackToBackSavesAllLand() {
    // Stop, then the Stop's own end event, then an error: saves milliseconds
    // apart, while the previous files' flushes are still running (Windows
    // refuses to rename over a file that is still open).
    const dir = tmpDir();
    const log = recordingLogger();
    const store = new JobResumeStore(dir, log);
    const job = { filename: 'a.nc', gcodeText: 'G21\nG0 X1\nG0 X2\n', totalLines: 3, lastExecutedLine: 0 };
    for (let i = 1; i <= 30; i++) {
        job.lastExecutedLine = i;
        assert.strictEqual(store.save(job), true, `save ${i} landed: ${JSON.stringify(log.lines.error)}`);
        if (i % 7 === 0) assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, i, 'another instance reads it at once');
        if (i === 15) {
            store.clear();
            assert.strictEqual(store.has(), false);
            job.gcodeText = 'G21\nG0 Y1\n';   // next job, next program
        }
    }
    assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 30);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'job_resume.json.bak'), 'utf8')).lastExecutedLine, 29);
    await durable(store);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['job_resume.json', 'job_resume.json.bak', 'job_resume_gcode.nc'], 'no temporary files left');
    assert.deepStrictEqual(log.lines.error, []);
    console.log('  ok  30 back-to-back saves (with a clear and a new program in between) all land; no stray files');
}

async function testOldCheckpointFilesStillLoad() {
    const text = 'G21\nG90\nG0 X1 Y1\nG1 Z-1 F300\nG1 X5\nM2\n';
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    const modal = { wcs: 'G54', units: 'G21', distanceMode: 'G90', feedMode: 'G94', spindleState: 'M3', spindleRpm: 12000, coolantState: 'M9', feedRate: 300, toolNumber: 1, feedOverridePct: 100 };
    const withCrc = (base) => JSON.stringify({ ...base, crc32: computeCrc32(JSON.stringify(base)) }, null, 2);

    // v2 with the program in its own file (written by the code before this change)
    let dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'job_resume_gcode.nc'), text);
    fs.writeFileSync(path.join(dir, 'job_resume.json'), withCrc({ version: 2, filename: 'old.nc', gcodeFile: 'job_resume_gcode.nc', gcodeHash: hash, totalLines: 6, lastExecutedLine: 4, lastConfirmedPos: { x: 5, y: 1, z: -1 }, modalState: modal, spindleDelay: 2, compileOptions: { arcs: true }, savedAt: 1700000000000 }));
    let store = new JobResumeStore(dir, recordingLogger());
    let cp = store.load();
    assert.ok(cp && cp.lastExecutedLine === 4 && cp.gcodeText === text && cp.spindleDelay === 2, 'v2 + program file loads');
    // and a new save over it keeps the old one as the backup
    assert.strictEqual(store.save({ ...cp, lastExecutedLine: 5 }), true);
    await durable(store);
    assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 5);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'job_resume.json.bak'), 'utf8')).lastExecutedLine, 4);
    fs.rmSync(dir, { recursive: true, force: true });

    // v2 with the program inline (older still)
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'job_resume.json'), withCrc({ version: 2, filename: 'inline.nc', gcodeText: text, gcodeHash: hash, totalLines: 6, lastExecutedLine: 3, lastConfirmedPos: { x: 0, y: 0, z: 0 }, modalState: modal, savedAt: 1700000000000 }));
    cp = new JobResumeStore(dir, recordingLogger()).load();
    assert.ok(cp && cp.lastExecutedLine === 3 && cp.gcodeText === text, 'v2 inline loads');
    fs.rmSync(dir, { recursive: true, force: true });

    // v1: no version, no CRC, wcs at the top
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'job_resume.json'), JSON.stringify({ filename: 'v1.nc', gcodeText: text, gcodeHash: hash, totalLines: 6, lastExecutedLine: 2, wcs: 'G55', savedAt: 1 }));
    cp = new JobResumeStore(dir, recordingLogger()).load();
    assert.ok(cp && cp.lastExecutedLine === 2 && cp.modalState.wcs === 'G55', 'v1 loads and migrates');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok  checkpoint files written before this change still load; a new save keeps them as .bak');
}

async function testLockedFileIsRetriedAndReportedOnce() {
    const dir = tmpDir();
    const log = recordingLogger();
    const store = new JobResumeStore(dir, log);
    const job = { filename: 'a.nc', gcodeText: 'G21\nG0 X1\n', totalLines: 2, lastExecutedLine: 1 };
    assert.notStrictEqual(store.save(job), false);
    await durable(store);

    const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' });
    const origRename = fs.renameSync;
    // OneDrive holds the file for a moment: two refusals, then it lets go
    let refusals = 2;
    fs.renameSync = function (...a) { if (refusals > 0) { refusals--; throw eperm(); } return origRename.apply(this, a); };
    try {
        job.lastExecutedLine = 2;
        assert.strictEqual(store.save(job), true, 'a brief lock is retried and the save succeeds');
    } finally { fs.renameSync = origRename; }
    await durable(store);
    assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 2);

    // held for good: every save fails, one message, the last good checkpoint stays
    fs.renameSync = function () { throw eperm(); };
    let threw = null;
    try {
        for (let i = 3; i <= 8; i++) { job.lastExecutedLine = i; assert.strictEqual(store.save(job), false); }
    } catch (e) { threw = e; } finally { fs.renameSync = origRename; }
    assert.ifError(threw);
    const saveErrors = log.lines.error.filter((l) => /save failed/.test(l));
    assert.strictEqual(saveErrors.length, 1, `reported once, not per save: ${JSON.stringify(saveErrors)}`);
    assert.ok(/held by another program/.test(saveErrors[0]), saveErrors[0]);
    assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 2, 'previous checkpoint intact');
    job.lastExecutedLine = 9;
    assert.strictEqual(store.save(job), true, 'works again once the lock is gone');
    assert.ok(log.lines.info.some((l) => /works again/.test(l)), 'recovery is logged');
    await durable(store);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok  EPERM/EBUSY on rename: short locks retried, long locks reported once, checkpoint never lost');
}

/**
 * Another program holds a checkpoint file open for a long time (OneDrive
 * syncing, a backup tool, antivirus, an editor). Seen on Windows with the
 * file held without sharing: renaming the held main away fails EBUSY, renaming
 * over it fails EPERM; a held .bak fails EPERM. Retrying used to sleep
 * 1/3/8/16 ms per operation -- each sleep a whole 15.6 ms timer tick on
 * Windows -- so every save blocked the sender 80-160 ms for as long as the
 * file stayed held (review, 2026-09-17).
 */
async function testHeldFileDoesNotStallSaves() {
    const code = (c, what) => () => Object.assign(new Error(`${c}: ${what}, rename`), { code: c, syscall: 'rename' });
    for (const held of ['main', 'bak']) {
        const dir = tmpDir();
        const log = recordingLogger();
        const store = new JobResumeStore(dir, log);
        const job = { filename: 'a.nc', gcodeText: 'G21\nG0 X1\n', totalLines: 2, lastExecutedLine: 1 };
        store.save(job);
        await durable(store);
        job.lastExecutedLine = 2;
        store.save(job);                   // .bak = line 1, main = line 2
        await durable(store);

        const free = [];
        for (let i = 0; i < 8; i++) {
            job.lastExecutedLine = 3 + i;
            const t = performance.now();
            store.save(job);
            free.push(performance.now() - t);
            await durable(store);
        }
        // now main = line 10, .bak = line 9; from here the file is held
        const mainPath = path.resolve(dir, 'job_resume.json');
        const bakPath = path.resolve(dir, 'job_resume.json.bak');
        const origRename = fs.renameSync;
        fs.renameSync = function (from, to, ...a) {
            const f = path.resolve(String(from));
            const t = path.resolve(String(to));
            if (held === 'main' && f === mainPath) throw code('EBUSY', 'resource busy or locked')();
            if (held === 'main' && t === mainPath) throw code('EPERM', 'operation not permitted')();
            if (held === 'bak' && t === bakPath) throw code('EPERM', 'operation not permitted')();
            return origRename.call(this, from, to, ...a);
        };
        const heldTimes = [];
        const results = [];
        try {
            for (let i = 0; i < 8; i++) {
                job.lastExecutedLine = 20 + i;
                const t = performance.now();
                results.push(store.save(job));
                heldTimes.push(performance.now() - t);
                await durable(store);
            }
        } finally { fs.renameSync = origRename; }

        const freeMed = median(free);
        const heldMed = median(heldTimes);
        const heldMax = Math.max(...heldTimes);
        console.log(`  info  ${held} held: saves ${JSON.stringify(results)}, blocked median ${heldMed.toFixed(2)} ms, max ${heldMax.toFixed(2)} ms (free: median ${freeMed.toFixed(2)} ms)`);
        // any sleeping retry adds >= 28 ms per held operation (78 ms on Windows)
        assert.ok(heldMed <= freeMed + 10, `a held ${held} file stalls every save: median ${heldMed.toFixed(1)} ms vs ${freeMed.toFixed(1)} ms when free`);
        assert.ok(heldMax <= Math.max(...free) + 40, `a held ${held} file stalled a save ${heldMax.toFixed(1)} ms`);

        if (held === 'main') {
            assert.deepStrictEqual(results, Array(8).fill(false), 'the main file cannot be replaced while held');
            const errors = log.lines.error.filter((l) => /save failed/.test(l));
            assert.strictEqual(errors.length, 1, `reported once, not per save: ${JSON.stringify(errors)}`);
            assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 10, 'the last good checkpoint is intact');
        } else {
            assert.deepStrictEqual(results, Array(8).fill(true), 'a held .bak does not stop the checkpoint being saved');
            assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 27);
            assert.strictEqual(JSON.parse(fs.readFileSync(bakPath, 'utf8')).lastExecutedLine, 9, 'the older backup is kept');
            assert.strictEqual(log.lines.warn.filter((l) => /job_resume\.json\.bak/.test(l)).length, 1, `reported once: ${JSON.stringify(log.lines.warn)}`);
            assert.deepStrictEqual(log.lines.error, []);
        }
        // released: the next save works and is fast again
        job.lastExecutedLine = 40;
        assert.strictEqual(store.save(job), true, 'works again once the file is released');
        await durable(store);
        assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 40);
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('  ok  a checkpoint file held open by another program: saves do not stall, reported once, last good checkpoint kept');
}

async function testClearRemovesTheRestWhenOneFileIsHeld() {
    // job finished; OneDrive holds job_resume.json. The .bak and the program
    // must still go, or the finished job comes back as resumable.
    const dir = tmpDir();
    const log = recordingLogger();
    const store = new JobResumeStore(dir, log);
    const job = { filename: 'a.nc', gcodeText: 'G21\nG0 X1\n', totalLines: 2, lastExecutedLine: 1 };
    store.save(job);
    await durable(store);
    job.lastExecutedLine = 2;
    store.save(job);
    await durable(store);
    assert.ok(fs.existsSync(path.join(dir, 'job_resume.json.bak')), 'premise: a .bak exists');

    const origUnlink = fs.unlinkSync;
    const mainPath = path.resolve(dir, 'job_resume.json');
    fs.unlinkSync = function (p, ...a) {
        if (path.resolve(String(p)) === mainPath) throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM', syscall: 'unlink' });
        return origUnlink.call(this, p, ...a);
    };
    let threw = null;
    try { store.clear(); } catch (e) { threw = e; } finally { fs.unlinkSync = origUnlink; }
    assert.ifError(threw);
    assert.ok(!fs.existsSync(path.join(dir, 'job_resume.json.bak')), 'the backup is removed');
    assert.ok(!fs.existsSync(path.join(dir, 'job_resume_gcode.nc')), 'the program file is removed');
    assert.strictEqual(new JobResumeStore(dir, recordingLogger()).load(), null, 'the finished job does not come back as resumable');
    assert.strictEqual(log.lines.warn.filter((l) => /clear/.test(l)).length, 1, `warned once: ${JSON.stringify(log.lines.warn)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok  clear() with job_resume.json held: backup and program still removed, nothing resumable, one warning');
}

async function testDiskFullIsContained() {
    const dir = tmpDir();
    const log = recordingLogger();
    const store = new JobResumeStore(dir, log);
    const job = { filename: 'a.nc', gcodeText: 'G21\nG0 X1\n', totalLines: 2, lastExecutedLine: 1 };
    store.save(job);
    await durable(store);
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
    const origWriteSync = fs.writeSync;
    const origWriteFileSync = fs.writeFileSync;
    fs.writeSync = function () { throw enospc(); };
    fs.writeFileSync = function () { throw enospc(); };
    let threw = null;
    try {
        for (let i = 2; i < 12; i++) { job.lastExecutedLine = i; store.save(job); }
    } catch (e) { threw = e; } finally { fs.writeSync = origWriteSync; fs.writeFileSync = origWriteFileSync; }
    assert.ifError(threw);
    const errors = log.lines.error.filter((l) => /save failed/.test(l));
    assert.strictEqual(errors.length, 1, `disk full reported once: ${JSON.stringify(errors)}`);
    assert.ok(/disk is full/.test(errors[0]), errors[0]);
    assert.ok(!fs.existsSync(path.join(dir, 'job_resume.json.tmp')), 'no half-written temp file left behind');
    assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 1, 'the last good checkpoint is intact');
    job.lastExecutedLine = 12;
    assert.strictEqual(store.save(job), true);
    await durable(store);
    assert.strictEqual(new JobResumeStore(dir).load().lastExecutedLine, 12);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok  disk full: save returns false, reported once, last good checkpoint intact, recovers');
}

async function testClearIsFinalEvenWithFlushPending() {
    const dir = tmpDir();
    const store = new JobResumeStore(dir, recordingLogger());
    const job = { filename: 'a.nc', gcodeText: 'G21\nG0 X1\n', totalLines: 2, lastExecutedLine: 1 };
    store.save(job);
    job.lastExecutedLine = 2;
    store.save(job);
    store.clear();                    // job finished while a flush is still running
    await durable(store);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(store.has(), false, 'nothing left');
    assert.strictEqual(new JobResumeStore(dir).load(), null, 'a finished job does not come back as resumable');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'folder empty');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok  clear() right after a save: nothing comes back when the pending flush completes');
}

(async () => {
    await testProgressSavesDoNotRehashOrBlock();
    await testBakIsAlwaysADurableCheckpoint();
    await testBackToBackSavesAllLand();
    await testOldCheckpointFilesStillLoad();
    await testLockedFileIsRetriedAndReportedOnce();
    await testHeldFileDoesNotStallSaves();
    await testClearRemovesTheRestWhenOneFileIsHeld();
    await testDiskFullIsContained();
    await testClearIsFinalEvenWithFlushPending();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
})().catch((e) => { console.error(e); process.exit(1); });
