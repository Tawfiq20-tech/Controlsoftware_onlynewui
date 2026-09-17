'use strict';

/**
 * Logging must never hurt the job it is describing.
 *
 * 2026-09-16 05:54:38-55 UTC: the backend's stdout pipe closed. Every console
 * write threw EPIPE as an uncaught exception, the handler logged it through
 * the same console, which threw again: 60,351 stack traces in 17 s, a 100 MB
 * app1.log, a full C: drive. Reproduced: 22,945 uncaught exceptions in 3 s,
 * the event loop stalled 1.6 s, a 10 ms timer ran 16 times instead of ~300.
 *
 * Also: a log transport that throws must not throw into the code that logs;
 * a repeating exception must be logged a few times, not every time; and a
 * full disk under app.log must not stop console logging for good (winston's
 * File transport waits forever for a 'drain' after a write error).
 *
 * Each case runs in a child process with its own logs folder.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeRunRoot, isolatedEnv, removeDir } = require('./helpers/isolatedEnv');

const BACKEND = path.join(__dirname, '..');
const MODE = process.argv[2];

// ---------------------------------------------------------------------------
// child side
// ---------------------------------------------------------------------------
function guard(logger, opts) {
    return require(path.join(BACKEND, 'lib/processGuards')).installExceptionGuards({ logger, ...opts });
}

function lagMonitor() {
    const m = { maxLag: 0, ticks: 0 };
    let last = Date.now();
    m.timer = setInterval(() => { const n = Date.now(); m.maxLag = Math.max(m.maxLag, n - last - 10); last = n; m.ticks++; }, 10);
    return m;
}

const finish = (result, delay = 400) => setTimeout(() => {
    fs.writeFileSync(process.argv[3], JSON.stringify(result));
    process.exit(0);
}, delay);

if (MODE === 'child-epipe') {
    const logger = require(path.join(BACKEND, 'logger'));
    const g = guard(logger, {});
    logger.info('child up');
    setInterval(() => logger.info('[RSP] telemetry line'), 100);
    setInterval(() => console.log('plain console line'), 50);
    const t0 = Date.now();
    const wait = setInterval(() => {
        const closed = typeof logger.isConsoleAlive === 'function' ? !logger.isConsoleAlive() : false;
        if (!closed && Date.now() - t0 < 1500) return;
        clearInterval(wait);
        // from the moment the pipe is known broken (or 1.5 s): 3 s of lag
        const lag = lagMonitor();
        let uncaught = 0;
        process.on('uncaughtException', () => { uncaught++; });
        setTimeout(() => {
            clearInterval(lag.timer);
            logger.info('[RSP] telemetry line after the check');
            finish({ uncaught: g.stats ? g.stats.uncaught : uncaught, maxLag: lag.maxLag, ticks: lag.ticks, detected: closed });
        }, 3000);
    }, 5);
} else if (MODE === 'child-storm') {
    const logger = require(path.join(BACKEND, 'logger'));
    const TransportStream = require('winston-transport');
    class Thrower extends TransportStream { log() { throw new Error('transport exploded'); } }
    class Failer extends TransportStream { log(info, cb) { setImmediate(() => this.emit('error', new Error('transport failed'))); cb(); } }
    logger.add(new Thrower());
    logger.add(new Failer());
    const notes = [];
    const g = guard(logger, { windowMs: 1000, notify: (m) => notes.push(m) });
    let callerThrows = 0;
    const log = (m) => { try { logger.info(m); } catch (_) { callerThrows++; } };
    const lag = lagMonitor();
    // timers are ~16 ms apart on Windows: 20 throws per tick
    const storm = setInterval(() => { for (let i = 0; i < 20; i++) setImmediate(() => { throw new Error('same bug every tick'); }); }, 1);
    const rejections = setInterval(() => { for (let i = 0; i < 5; i++) Promise.reject(new Error('same rejection every tick')); }, 5);
    const telemetry = setInterval(() => log('[RSP] telemetry line'), 20);
    setTimeout(() => { clearInterval(storm); clearInterval(rejections); }, 2500);
    setTimeout(() => {
        clearInterval(lag.timer);
        clearInterval(telemetry);
        finish({ stats: g.stats || null, callerThrows, maxLag: lag.maxLag, ticks: lag.ticks, notes: notes.length }, 1300);
    }, 3000);
} else if (MODE === 'child-job-uncaught') {
    // A real JobResumeService on a job that has reached line 137.
    const { EventEmitter } = require('events');
    const logger = require(path.join(BACKEND, 'logger'));
    const pg = require(path.join(BACKEND, 'lib/processGuards'));
    const { JobResumeService } = require(path.join(BACKEND, 'services/jobresume/JobResumeService'));
    const { JobResumeStore } = require(path.join(BACKEND, 'services/jobresume/JobResumeStore'));
    const dataDir = process.env.EASYCNC_DATA_DIR;
    const ctl = new EventEmitter();
    ctl.job = { active: true };
    ctl.getModalState = () => ({});
    ctl.state = { status: { mpos: { x: 1, y: 2, z: 3 } } };
    const engine = { controller: ctl };
    const svc = new JobResumeService({ dataDir, io: new EventEmitter(), logger, getController: () => ctl });
    svc.onLoad({ filename: 'dragon.nc', gcodeText: `G21\n${'G1 X1\n'.repeat(500)}` });
    svc.onStart({ totalLines: 501 });
    const notes = [];
    const g = pg.installExceptionGuards({
        logger,
        notify: (m) => notes.push(m),
        isJobActive: () => pg.jobIsActive(engine),
        saveCheckpoint: (reason) => pg.saveCheckpointNow(svc, reason),
    });
    const quiet = { warn() {}, error() {}, info() {} };
    const onDisk = () => { const cp = new JobResumeStore(dataDir, quiet).load(); return cp ? cp.lastExecutedLine : null; };
    let line = 0;
    const advance = (to) => { while (line < to) ctl.emit('sender:status', { lineNo: ++line, total: 501 }); };
    advance(137);
    setImmediate(() => { throw new TypeError('bug in a stream tick'); });
    setTimeout(() => {
        const afterFirst = onDisk();
        advance(149);
        setImmediate(() => { throw new TypeError('another bug in a stream tick'); });
        setTimeout(() => {
            const afterSecond = onDisk();
            let ticksAfter = 0;
            const t = setInterval(() => { ticksAfter++; advance(line + 1); }, 10);
            setTimeout(() => {
                clearInterval(t);
                finish({ afterFirst, afterSecond, ticksAfter, lineAfter: line, checkpoints: g.stats ? g.stats.checkpoints : null, notes }, 100);
            }, 400);
        }, 100);
    }, 100);
} else if (MODE === 'child-enospc') {
    const logger = require(path.join(BACKEND, 'logger'));
    const g = guard(logger, {});
    let failing = false;
    const realWrite = fs.write;
    const realWritev = fs.writev;
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
    fs.write = function (fd, ...args) { if (failing) return process.nextTick(args[args.length - 1], enospc()); return realWrite.call(this, fd, ...args); };
    fs.writev = function (fd, ...args) { if (failing) return process.nextTick(args[args.length - 1], enospc()); return realWritev.call(this, fd, ...args); };
    logger.info('before failure');
    setTimeout(() => {
        failing = true;
        let n = 0;
        const during = setInterval(() => { for (let i = 0; i < 20; i++) logger.info(`during failure ${n++} ${'x'.repeat(200)}`); }, 10);
        setTimeout(() => {
            clearInterval(during);
            failing = false;
            let k = 0;
            const after = setInterval(() => logger.info(`after recovery ${k++}`), 50);
            setTimeout(() => {
                clearInterval(after);
                finish({ uncaught: g.stats ? g.stats.uncaught : null, linesDuringFailure: n, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6) }, 800);
            }, 1500);
        }, 1000);
    }, 300);
}

// ---------------------------------------------------------------------------
// parent side
// ---------------------------------------------------------------------------
function runChild(root, mode, { breakPipes = false, env = {} } = {}) {
    const iso = isolatedEnv(root, mode);
    const resultFile = path.join(iso.dir, 'result.json');
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, mode, resultFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...iso.env, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
            stdout += d;
            if (breakPipes) { child.stdout.destroy(); child.stderr.destroy(); }
        });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`${mode}: child did not finish`)); }, 60000);
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (!fs.existsSync(resultFile)) return reject(new Error(`${mode}: no result (exit ${code})\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`));
            const appLogFile = path.join(iso.logsDir, 'app.log');
            resolve({
                result: JSON.parse(fs.readFileSync(resultFile, 'utf8')),
                appLog: fs.existsSync(appLogFile) ? fs.readFileSync(appLogFile, 'utf8') : '',
                stdout,
                stderr,
                iso,
            });
        });
    });
}

const count = (text, re) => (text.match(re) || []).length;

async function testBrokenConsolePipe(root) {
    const { result, appLog } = await runChild(root, 'child-epipe', { breakPipes: true });
    console.log(`  info  broken stdout: ${JSON.stringify(result)}`);
    assert.strictEqual(result.detected, true, 'the closed console was noticed');
    // The discriminating check is the count: the old handler raised 1,600 to
    // 37,000 uncaught exceptions here. How badly that starved the event loop
    // varied from run to run (a 10 ms timer ran 16 to 295 times, worst stall
    // 2 ms to 1.6 s), so timer ticks and lag are loose sanity bounds only.
    assert.strictEqual(result.uncaught, 0, `a closed console must not raise uncaught exceptions (got ${result.uncaught} in 3 s)`);
    assert.ok(result.ticks >= 120, `a 10 ms timer ran only ${result.ticks} times in 3 s`);
    assert.ok(result.maxLag < 500, `event loop stalled ${result.maxLag} ms after the pipe broke`);
    assert.strictEqual(count(appLog, /console output closed/g), 1, 'reported once in app.log');
    assert.strictEqual(count(appLog, /UNCAUGHT/g), 0, 'no exception traces in app.log');
    assert.ok(count(appLog, /telemetry line/g) >= 25, 'logging to app.log carried on');
    assert.ok(/telemetry line after the check/.test(appLog));
    console.log('  ok  a broken stdout/stderr pipe: no exception storm, event loop free, reported once, file logging continues');
}

async function testThrowingTransportsAndExceptionStorm(root) {
    const { result, appLog, stderr } = await runChild(root, 'child-storm');
    const s = result.stats;
    console.log(`  info  storm: ${JSON.stringify({ ...result, appLogUncaught: count(appLog, /UNCAUGHT EXCEPTION/g), appLogRejections: count(appLog, /UNHANDLED REJECTION/g) })}`);
    assert.strictEqual(result.callerThrows, 0, 'logger.info() never throws into the caller, whatever a transport does');
    assert.ok(s && s.uncaught > 500, `premise: the storm happened (${s && s.uncaught})`);
    assert.strictEqual(s.reentered, 0);
    const traces = count(appLog, /UNCAUGHT EXCEPTION/g);
    assert.ok(traces >= 1 && traces <= 3 * 5, `one error repeating ${s.uncaught} times logged ${traces} times`);
    const rejectionTraces = count(appLog, /UNHANDLED REJECTION/g);
    assert.ok(rejectionTraces >= 1 && rejectionTraces <= 3 * 5, `rejections logged ${rejectionTraces} times`);
    assert.ok(/more uncaught error\(s\) in the last 1 s were not logged again/.test(appLog), 'repeats are summarised');
    assert.ok(result.notes >= 1 && result.notes <= 5, `the screen is told, not flooded (${result.notes})`);
    // counts above are the gate; lag only a loose bound (machine load varies)
    assert.ok(result.ticks >= 60, `a 10 ms timer ran only ${result.ticks} times in 3 s of storm`);
    assert.ok(result.maxLag < 500, `event loop stalled ${result.maxLag} ms during the storm`);
    assert.strictEqual(count(stderr, /threw \(transport exploded\)/g), 1, 'a throwing transport is reported once');
    assert.strictEqual(count(stderr, /failed: transport failed/g), 1, 'a failing transport is reported once');
    assert.ok(count(appLog, /telemetry line/g) > 50, 'the real log still gets the lines');
    console.log('  ok  throwing/failing transports never throw into callers; a repeating exception is logged a few times and summarised');
}

/**
 * An uncaught exception during a job: the process keeps running (see the
 * header of lib/processGuards.js for why), and the job's resume checkpoint is
 * saved at once -- at most once per 5 s however often the bug repeats.
 */
async function testUncaughtExceptionDuringAJob(root) {
    const { result, appLog } = await runChild(root, 'child-job-uncaught');
    console.log(`  info  uncaught during a job: ${JSON.stringify({ ...result, notes: result.notes.length })}`);
    assert.strictEqual(result.afterFirst, 137, 'the resume checkpoint on disk is at the line the job had reached');
    assert.strictEqual(result.afterSecond, 137, 'a second emergency save within 5 s is not made (line 149 would be on disk)');
    assert.strictEqual(result.checkpoints, 1);
    assert.strictEqual(count(appLog, /resume checkpoint saved at line 137 after an internal error/g), 1, 'the save is logged');
    assert.strictEqual(count(appLog, /UNCAUGHT EXCEPTION during a job/g), 2, 'both errors logged with their stack');
    assert.strictEqual(result.notes.length, 2, 'the screen is told about each distinct error');
    assert.ok(result.notes.every((n) => /The job continues; restart the sender when the machine is idle/.test(n)), result.notes.join(' | '));
    assert.ok(result.ticksAfter >= 10 && result.lineAfter > 149, `the process and the job carry on (${result.ticksAfter} ticks, line ${result.lineAfter})`);
    console.log('  ok  uncaught exception during a job: checkpoint saved at the current line once, logged, screen told, process keeps running');
}

async function testFullDiskUnderAppLog(root) {
    const { result, appLog, stdout, stderr } = await runChild(root, 'child-enospc', { env: { EASYCNC_LOG_RETRY_MS: '300' } });
    console.log(`  info  app.log ENOSPC: ${JSON.stringify(result)}`);
    assert.strictEqual(result.uncaught, 0, 'no uncaught exceptions');
    assert.strictEqual(count(stderr, /cannot write .*app\.log/g), 1, `reported once (stderr: ${stderr.slice(0, 500)})`);
    assert.ok(count(stdout, /during failure/g) > 100, 'the console kept logging while app.log could not be written');
    assert.ok(count(stdout, /after recovery/g) >= 10, 'and after');
    assert.ok(/before failure/.test(appLog));
    assert.ok(count(appLog, /after recovery/g) >= 5, 'app.log is written again once the disk has space');
    assert.ok(/is being written again; log lines from .* were not saved/.test(appLog), 'the gap is recorded');
    console.log('  ok  disk full under app.log: console keeps working, reported once, app.log resumes by itself');
}

if (!MODE) {
    (async () => {
        const root = makeRunRoot();
        await testBrokenConsolePipe(root);
        await testThrowingTransportsAndExceptionStorm(root);
        await testUncaughtExceptionDuringAJob(root);
        await testFullDiskUnderAppLog(root);
        removeDir(root);
        console.log('ALL TESTS PASSED SUCCESSFULLY!');
    })().catch((e) => { console.error(e); process.exit(1); });
}
