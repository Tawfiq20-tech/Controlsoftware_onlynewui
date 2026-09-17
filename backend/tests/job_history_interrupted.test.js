'use strict';

/**
 * Job history must keep the jobs that went wrong.
 *
 * It used to write a record only on job:end / job:error / job:abort. Jobs cut
 * off by a USB drop, a controller reset or a killed backend never got one:
 * 38 starts in 2026-09-10..16 but 29 records, and the missing ones were the
 * real mid-job failures (jobs 8, 9, 16, 20, 24, 31, 32).
 *
 * Now: written at START (running), updated at the end, and a job left
 * running by a backend that is gone is 'interrupted' on the next start, with
 * the last line from the resume checkpoint when it is the same job.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const BACKEND = path.join(__dirname, '..');
const { JobHistoryService } = require(path.join(BACKEND, 'services/jobhistory/JobHistoryService'));

const made = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhistory-')); made.push(d); return d; };
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });
const io = { emit() {} };
function recordingLogger() {
    const lines = { error: [], warn: [], info: [], debug: [] };
    const log = {};
    for (const k of Object.keys(lines)) log[k] = (m) => lines[k].push(String(m));
    log.lines = lines;
    return log;
}
const fileRecords = (dir) => {
    const f = path.join(dir, 'jobhistory.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
/** The last line written for each job id, the way the service reads the file. */
const latestById = (dir) => {
    const m = new Map();
    for (const r of fileRecords(dir)) m.set(r.id, { ...(m.get(r.id) || {}), ...r });
    return m;
};
const osBootTime = () => Date.now() - Math.round(os.uptime() * 1000);
const PROGRAM = ['G21', 'G90', 'G0 Z5', ...Array.from({ length: 200 }, (_, i) => `G1 X${i} F1000`), 'M2'].join('\n');

function rig(dir, extra = {}) {
    let ctl = new EventEmitter();
    const engine = new EventEmitter();
    const svc = new JobHistoryService({ dataDir: dir, io, logger: extra.logger || recordingLogger(), getController: () => ctl, getEngine: () => engine, ...extra });
    engine.emit('controller:bound', ctl);
    return {
        svc,
        get ctl() { return ctl; },
        reconnect() { ctl = new EventEmitter(); engine.emit('controller:bound', ctl); return ctl; },
    };
}

async function testRecordedAtStartAndUpdatedAtEnd() {
    const dir = tmpDir();
    const r = rig(dir);
    r.ctl.emit('job:start', { filename: 'dragon.nc', gcode: PROGRAM, controller: 'RSP', wcs: 'G54', toolNumber: 1 });
    let onDisk = fileRecords(dir);
    assert.strictEqual(onDisk.length, 1, 'the job is on disk as soon as it starts');
    assert.strictEqual(onDisk[0].outcome, 'running');
    assert.strictEqual(onDisk[0].lineCount, 204);
    assert.strictEqual(r.svc.list()[0].outcome, 'running', 'and listed as running');

    r.ctl.emit('sender:status', { lineNo: 150, total: 204 });
    r.ctl.emit('job:end', {});
    const after = new JobHistoryService({ dataDir: dir, io, logger: recordingLogger(), getController: () => null });
    assert.strictEqual(after.records.length, 1, 'one record per job after a restart');
    assert.strictEqual(after.records[0].outcome, 'ok');
    assert.ok(after.records[0].durationMs >= 0 && after.records[0].endedAt >= after.records[0].startedAt);
    assert.strictEqual(after.stats().ok, 1);
    console.log('  ok  a job is written when it starts and updated (same record) when it ends');
}

/** A backend process that starts a job and is then killed outright. */
function runAndKill(dir, line) {
    const script = `
        const { EventEmitter } = require('events');
        const { JobHistoryService } = require(${JSON.stringify(path.join(BACKEND, 'services/jobhistory/JobHistoryService'))});
        const ctl = new EventEmitter();
        new JobHistoryService({ dataDir: ${JSON.stringify(dir)}, io: { emit() {} }, logger: { info() {}, warn() {}, error() {} }, getController: () => ctl });
        ctl.emit('job:start', { filename: 'ship.ngc', gcode: 'G21\\nG1 X1\\nG1 X2\\n', controller: 'RSP' });
        ctl.emit('sender:status', { lineNo: ${line} });
        process.kill(process.pid, 'SIGKILL');
    `;
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
    assert.notStrictEqual(res.status, 0, 'the child was killed, not ended cleanly');
}

async function testKilledBackendLeavesAnInterruptedRecord() {
    const dir = tmpDir();
    runAndKill(dir, 2);
    assert.strictEqual(fileRecords(dir)[0].outcome, 'running', 'premise: the killed backend left it running');

    // the resume checkpoint of that job got further than the history knew
    const checkpoint = { filename: 'ship.ngc', gcodeHash: fileRecords(dir)[0].gcodeHash, lastExecutedLine: 3, savedAt: Date.now() };
    const log = recordingLogger();
    const svc = new JobHistoryService({ dataDir: dir, io, logger: log, getController: () => null, getCheckpointSummary: () => checkpoint });
    const rec = svc.records[0];
    assert.strictEqual(rec.outcome, 'interrupted', 'the next start marks it interrupted');
    assert.strictEqual(rec.lastLine, 3, 'with the last line from the matching checkpoint');
    assert.ok(/stopped while this job was running/.test(rec.error), rec.error);
    assert.ok(log.lines.warn.some((l) => /never finished/.test(l)), 'and says so in the log');
    assert.strictEqual(latestById(dir).size, 1, 'still one job in the file');
    assert.strictEqual(latestById(dir).get(rec.id).outcome, 'interrupted', 'written as interrupted');
    assert.strictEqual(svc.stats().interrupted, 1);

    // a checkpoint of a different job does not lend its line
    const dir2 = tmpDir();
    runAndKill(dir2, 2);
    const other = new JobHistoryService({ dataDir: dir2, io, logger: recordingLogger(), getController: () => null, getCheckpointSummary: () => ({ filename: 'other.nc', gcodeHash: 'x', lastExecutedLine: 999, savedAt: Date.now() }) });
    assert.strictEqual(other.records[0].outcome, 'interrupted');
    assert.strictEqual(other.records[0].lastLine, null, 'unknown line stays unknown (the history had no progress on disk)');

    // the real checkpoint file is used by default
    const dir3 = tmpDir();
    runAndKill(dir3, 2);
    const { JobResumeStore } = require(path.join(BACKEND, 'services/jobresume/JobResumeStore'));
    new JobResumeStore(dir3, recordingLogger()).save({ filename: 'ship.ngc', gcodeText: 'G21\nG1 X1\nG1 X2\n', totalLines: 3, lastExecutedLine: 2 });
    const dflt = new JobHistoryService({ dataDir: dir3, io, logger: recordingLogger(), getController: () => null });
    assert.strictEqual(dflt.records[0].lastLine, 2, 'last line from job_resume.json');
    console.log('  ok  a backend killed mid-job leaves an interrupted record with the checkpoint line on the next start');
}

async function testConnectionLossInterruptsTheJob() {
    const dir = tmpDir();
    const r = rig(dir);
    r.ctl.emit('job:start', { filename: 'fish.nc', gcode: PROGRAM, controller: 'RSP' });
    r.ctl.emit('sender:status', { lineNo: 8779 });
    r.reconnect();   // USB dropped; CNCEngine binds a new controller
    const rec = r.svc.records[0];
    assert.strictEqual(rec.outcome, 'interrupted');
    assert.strictEqual(rec.lastLine, 8779);
    assert.ok(/connection to the controller was lost/.test(rec.error), rec.error);
    assert.strictEqual(fileRecords(dir).pop().outcome, 'interrupted', 'written at once');

    // the new controller's jobs are recorded normally
    r.ctl.emit('job:start', { filename: 'fish.nc', gcode: PROGRAM, controller: 'RSP' });
    r.ctl.emit('job:abort');
    assert.deepStrictEqual(r.svc.list().map((x) => x.outcome), ['aborted', 'interrupted']);
    // a second bind of the same controller must not double the listeners
    r.svc._onControllerBound(r.ctl);
    r.ctl.emit('job:start', { filename: 'x.nc', gcode: 'G0 X1', controller: 'RSP' });
    assert.strictEqual(r.svc.records.length, 3, 'one record per start');
    console.log('  ok  a controller replaced mid-job (connection lost) marks the job interrupted with its last line');
}

async function testJobOfALiveOtherBackendIsLeftAlone() {
    const dir = tmpDir();
    // another backend process, alive, running a job on the same data folder
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
        const startedBy = new JobHistoryService({ dataDir: dir, io, logger: recordingLogger(), getController: () => null });
        const rec = startedBy.startJob({ filename: 'live.nc', gcode: 'G0 X1', controller: 'RSP' });
        rec.pid = other.pid;   // as if that process had written it
        startedBy._rewriteDisk();
        const second = new JobHistoryService({ dataDir: dir, io, logger: recordingLogger(), getController: () => null });
        assert.strictEqual(second.records[0].outcome, 'running', 'a job another live backend is running is not declared interrupted');
    } finally {
        other.kill();
    }
    await new Promise((r) => other.on('exit', r));
    const third = new JobHistoryService({ dataDir: dir, io, logger: recordingLogger(), getController: () => null });
    assert.strictEqual(third.records[0].outcome, 'interrupted', 'once that process is gone it is');
    console.log('  ok  a job still owned by a live backend process is left running; interrupted once it is gone');
}

async function testDiskFullIsContainedAndCaughtUp() {
    const dir = tmpDir();
    const log = recordingLogger();
    const r = rig(dir, { logger: log });
    const orig = fs.appendFileSync;
    fs.appendFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
    let threw = null;
    try {
        for (let i = 0; i < 5; i++) {
            r.ctl.emit('job:start', { filename: `j${i}.nc`, gcode: 'G0 X1', controller: 'RSP' });
            r.ctl.emit('job:end', {});
        }
    } catch (e) { threw = e; } finally { fs.appendFileSync = orig; }
    assert.ifError(threw);
    assert.strictEqual(log.lines.error.filter((l) => /could not write/.test(l)).length, 1, 'reported once, not per write');
    assert.strictEqual(r.svc.records.length, 5, 'kept in memory');
    r.ctl.emit('job:start', { filename: 'j5.nc', gcode: 'G0 X1', controller: 'RSP' });
    assert.ok(log.lines.info.some((l) => /works again/.test(l)));
    assert.strictEqual(fileRecords(dir).length, 6, 'everything missed is written once the disk works again');
    console.log('  ok  disk full: history writes fail quietly (one message), records kept and written on recovery');
}

/**
 * Two backends on one data folder (a dev instance next to the machine's own):
 * the file must never be replaced under the one that is running a job.
 * Every start used to rewrite the whole file as soon as any job had both its
 * start and end line, and catching up after a failed write rewrote it from
 * memory -- either one drops what the other backend appended meanwhile.
 */
async function testStartupNeverRewritesTheFileUnderAnotherBackend() {
    const dir = tmpDir();
    const file = path.join(dir, 'jobhistory.jsonl');
    const finished = (i) => {
        const rec = { id: `job_f${i}`, startedAt: 1000 + i, endedAt: null, durationMs: null, filename: `f${i}.nc`, outcome: 'running', error: null, pid: 1, bootTime: 1 };
        return [JSON.stringify(rec), JSON.stringify({ ...rec, endedAt: 2000 + i, durationMs: 1000, outcome: 'ok' })];
    };
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const live = { id: 'job_live', startedAt: Date.now(), endedAt: null, durationMs: null, filename: 'live.nc', outcome: 'running', error: null, pid: other.pid, bootTime: osBootTime() };
    try {
        // 300 finished jobs (600 lines), then a job the other live backend is running
        const lines = [];
        for (let i = 0; i < 300; i++) lines.push(...finished(i));
        lines.push(JSON.stringify(live));
        fs.writeFileSync(file, lines.join('\n') + '\n');
        const before = fs.readFileSync(file, 'utf8');

        const svc = new JobHistoryService({ dataDir: dir, io, logger: recordingLogger(), getController: () => null });
        assert.strictEqual(svc.records.length, 301);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'not rewritten while another live backend runs a job on it');

        // the other backend finishes its job; this one records one of its own
        fs.appendFileSync(file, JSON.stringify({ ...live, endedAt: Date.now(), durationMs: 5, outcome: 'ok' }) + '\n');
        const mine = svc.startJob({ filename: 'mine.nc', gcode: 'G0 X1', controller: 'RSP' });
        svc.endJob({ outcome: 'ok' });
        assert.ok(fs.readFileSync(file, 'utf8').startsWith(before), 'only ever appended to');
        const latest = latestById(dir);
        assert.strictEqual(latest.get('job_live').outcome, 'ok', 'the other backend\'s append is still there');
        assert.strictEqual(latest.get(mine.id).outcome, 'ok');
    } finally {
        other.kill();
    }
    await new Promise((r) => (other.exitCode !== null ? r() : other.on('exit', r)));

    // no other backend any more, 300+ superseded lines: compacted, once
    const compacted = new JobHistoryService({ dataDir: dir, io, logger: recordingLogger(), getController: () => null });
    assert.strictEqual(compacted.records.length, 302);
    assert.strictEqual(fileRecords(dir).length, 302, 'compacted to one line per job');
    assert.strictEqual(latestById(dir).get('job_live').outcome, 'ok');

    // a handful of finished jobs: no rewrite at every start
    const small = tmpDir();
    const smallFile = path.join(small, 'jobhistory.jsonl');
    fs.writeFileSync(smallFile, [...finished(1), ...finished(2), ...finished(3)].join('\n') + '\n');
    const smallBefore = fs.readFileSync(smallFile, 'utf8');
    const s2 = new JobHistoryService({ dataDir: small, io, logger: recordingLogger(), getController: () => null });
    assert.strictEqual(s2.records.length, 3);
    assert.strictEqual(fs.readFileSync(smallFile, 'utf8'), smallBefore, 'a start does not rewrite a small history');
    console.log('  ok  the history file is only appended to while another backend runs a job; compacted at start-up only past 200 stale lines');
}

async function testCatchUpAfterAFailedWriteKeepsOtherBackendsLines() {
    const dir = tmpDir();
    const file = path.join(dir, 'jobhistory.jsonl');
    const log = recordingLogger();
    const r = rig(dir, { logger: log });
    r.ctl.emit('job:start', { filename: 'a.nc', gcode: 'G0 X1', controller: 'RSP' });
    r.ctl.emit('job:end', {});
    // another backend on the same folder records a job
    fs.appendFileSync(file, JSON.stringify({ id: 'job_other', startedAt: Date.now(), endedAt: Date.now(), durationMs: 1, filename: 'other.nc', outcome: 'ok', error: null, pid: 1, bootTime: 1 }) + '\n');
    // the disk is full for a moment, as this backend's next job starts
    const orig = fs.appendFileSync;
    fs.appendFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
    let b;
    try {
        r.ctl.emit('job:start', { filename: 'b.nc', gcode: 'G0 X2', controller: 'RSP' });
        b = r.svc.activeJob;
    } finally { fs.appendFileSync = orig; }
    r.ctl.emit('sender:status', { lineNo: 1 });
    r.ctl.emit('job:end', {});           // writing works again
    const latest = latestById(dir);
    assert.ok(latest.has('job_other'), 'the other backend\'s record is still in the file');
    assert.strictEqual(latest.get(b.id).outcome, 'ok', 'the job whose start was missed is written');
    assert.ok(log.lines.info.some((l) => /works again/.test(l)));
    console.log('  ok  after a failed write, the missed records are appended, not rewritten over another backend\'s lines');
}

async function testOldHistoryFilesStillLoad() {
    const dir = tmpDir();
    const old = [
        { id: 'job_a', startedAt: 1, endedAt: 2, durationMs: 1, filename: 'a.nc', gcodeHash: 'h', gcodeBytes: 5, lineCount: 1, controller: 'RSP', wcs: 'G54', toolNumber: null, outcome: 'ok', error: null },
        { id: 'job_b', startedAt: 3, endedAt: 9, durationMs: 6, filename: 'b.nc', gcodeHash: 'h', gcodeBytes: 5, lineCount: 1, controller: 'RSP', wcs: 'G54', toolNumber: null, outcome: 'aborted', error: null },
    ];
    fs.writeFileSync(path.join(dir, 'jobhistory.jsonl'), old.map((r) => JSON.stringify(r)).join('\n') + '\n{"torn":\n');
    const svc = new JobHistoryService({ dataDir: dir, io, logger: recordingLogger(), getController: () => null });
    assert.deepStrictEqual(svc.list().map((r) => r.id), ['job_b', 'job_a']);
    assert.deepStrictEqual({ ...svc.stats(), totalMs: svc.stats().totalMs }, { total: 2, ok: 1, fail: 0, aborted: 1, interrupted: 0, running: 0, totalMs: 7 });
    console.log('  ok  history files written before this change still load (a torn last line is skipped)');
}

(async () => {
    await testRecordedAtStartAndUpdatedAtEnd();
    await testKilledBackendLeavesAnInterruptedRecord();
    await testConnectionLossInterruptsTheJob();
    await testJobOfALiveOtherBackendIsLeftAlone();
    await testDiskFullIsContainedAndCaughtUp();
    await testStartupNeverRewritesTheFileUnderAnotherBackend();
    await testCatchUpAfterAFailedWriteKeepsOtherBackendsLines();
    await testOldHistoryFilesStillLoad();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
})().catch((e) => { console.error(e); process.exit(1); });
