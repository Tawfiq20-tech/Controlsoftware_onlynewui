'use strict';

/**
 * Closing the backend while a job runs must keep the job resumable.
 *
 * Five jobs in 2026-09-10..16 ended because the backend went away mid-job
 * (window closed, Ctrl+C, RUN.bat restarts). The shutdown path sent a Stop
 * and exited 1.5 s later; the resume checkpoint was only as fresh as the
 * last periodic save (every 25 lines, at most once a second), and was written
 * again only if the Stop's own end event came back before the exit.
 *
 * Now the shutdown saves the checkpoint FIRST, logs where, marks the job in
 * the history, then stops the machine. Verified in a real child process:
 *   1. the shutdown sequence with the real resume + history services,
 *   2. the real index.js booted on a spare port with a stand-in controller.
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { GUARD, makeRunRoot, isolatedEnv, removeDir } = require('./helpers/isolatedEnv');

const BACKEND = path.join(__dirname, '..');
const MODE = process.argv[2];
const ORDER = process.env.SHUTDOWN_TEST_ORDER;
const TEXT = ['G21', 'G90', 'G0 Z5', ...Array.from({ length: 100 }, (_, i) => `G1 X${i} F1200`), 'M2'].join('\n');
const LAST_LINE = 57;

const note = (line) => fs.appendFileSync(ORDER, `${line}\n`);

/** A controller that is running a job: records what it is told. */
function standInController() {
    const ctl = new EventEmitter();
    ctl.job = { active: true, paused: false, nextLineToRun: () => LAST_LINE + 1, totalLineCount: 104 };
    ctl.state = { status: { mpos: { x: 12, y: 3, z: -1 }, activeState: 'Run' } };
    ctl.getModalState = () => ({ units: 'G21', wcs: 'G54' });
    ctl.command = (cmd) => note(`command ${cmd}`);
    ctl.unbind = () => {};
    return ctl;
}

/** Load + start + progress to LAST_LINE through the real services. */
function runJob(ctl, jobResumeService) {
    const save = jobResumeService.store.save.bind(jobResumeService.store);
    jobResumeService.store.save = (data) => { note(`save ${data.lastExecutedLine}`); return save(data); };
    jobResumeService.onLoad({ filename: 'dragon.nc', gcodeText: TEXT });
    jobResumeService.onStart({ totalLines: 104 });
    ctl.emit('job:start', { filename: 'dragon.nc', gcode: TEXT, controller: 'RSP' });
    for (let line = 1; line <= LAST_LINE; line++) ctl.emit('sender:status', { lineNo: line, total: 104 });
    note('job running');
}

function listenForSignal() {
    process.on('message', (m) => { if (m && m.signal) process.emit(m.signal, m.signal); });
    note('ready');
    if (process.send) process.send({ ready: true });
}

if (MODE === 'child-sequence') {
    const logger = require(path.join(BACKEND, 'logger'));
    const runtimePaths = require(path.join(BACKEND, 'lib/runtimePaths'));
    const processGuards = require(path.join(BACKEND, 'lib/processGuards'));
    const { JobResumeService } = require(path.join(BACKEND, 'services/jobresume/JobResumeService'));
    const { JobHistoryService } = require(path.join(BACKEND, 'services/jobhistory/JobHistoryService'));
    const io = Object.assign(new EventEmitter(), { emit() {} });
    const engine = new EventEmitter();
    engine.controller = standInController();
    engine._closeConnection = () => note('close connection');
    const dataDir = runtimePaths.dataDir();
    const jobResumeService = new JobResumeService({ dataDir, io, logger, getController: () => engine.controller });
    const jobHistoryService = new JobHistoryService({ dataDir, io, logger, getController: () => engine.controller, getEngine: () => engine });
    engine.emit('controller:bound', engine.controller);
    runJob(engine.controller, jobResumeService);
    const shutdown = processGuards.createShutdown({ logger, getEngine: () => engine, jobResumeService, jobHistoryService, stopDelayMs: 300 });
    processGuards.installSignalHandlers(shutdown);
    listenForSignal();
} else if (MODE === 'child-index') {
    const backend = require(path.join(BACKEND, 'index.js'));
    backend.server.once('listening', () => {
        const ctl = standInController();
        backend.engine.controller = ctl;
        backend.engine.emit('controller:bound', ctl);
        runJob(ctl, backend.jobResumeService);
        listenForSignal();
    });
}

// ---------------------------------------------------------------------------
// parent side
// ---------------------------------------------------------------------------
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

async function runChild(root, mode, env = {}) {
    const iso = isolatedEnv(root, mode);
    const order = path.join(iso.dir, 'order.txt');
    const child = spawn(process.execPath, ['--require', GUARD, __filename, mode], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...iso.env, SHUTDOWN_TEST_ORDER: order, LOG_LEVEL: 'info', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${mode}: child never got ready\n${out.slice(-3000)}`)), 90000);
        child.on('message', (m) => { if (m && m.ready) { clearTimeout(t); resolve(); } });
        child.on('exit', () => { clearTimeout(t); reject(new Error(`${mode}: child exited early\n${out.slice(-3000)}`)); });
    });
    const t0 = Date.now();
    // Windows has no POSIX signals between processes (kill() is TerminateProcess):
    // the child raises the event itself, the way Ctrl+C / closing the window does.
    if (process.platform === 'win32') child.send({ signal: 'SIGINT' });
    else child.kill('SIGTERM');
    const end = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 20000))]);
    if (!end) { child.kill('SIGKILL'); throw new Error(`${mode}: did not exit after the signal\n${out.slice(-3000)}`); }
    return { end, ms: Date.now() - t0, order: fs.readFileSync(order, 'utf8').trim().split('\n'), iso, out };
}

function checkOutcome(name, { end, order, iso, out }) {
    const signal = process.platform === 'win32' ? 'SIGINT' : 'SIGTERM';
    assert.strictEqual(end.code, 0, `${name}: exits cleanly (${JSON.stringify(end)})\n${out.slice(-2000)}`);
    const saveAt = order.indexOf(`save ${LAST_LINE}`);
    const stopAt = order.indexOf('command gcode:stop');
    assert.ok(stopAt > order.indexOf('job running'), `${name}: the job is stopped (${order.join(' | ')})`);
    assert.ok(saveAt > order.indexOf('job running') && saveAt < stopAt, `${name}: checkpoint saved at line ${LAST_LINE} BEFORE the stop (${order.join(' | ')})`);

    const { JobResumeStore } = require(path.join(BACKEND, 'services/jobresume/JobResumeStore'));
    const quiet = { info() {}, warn() {}, error() {} };
    const cp = new JobResumeStore(iso.dataDir, quiet).load();
    assert.ok(cp, `${name}: a checkpoint is on disk after the exit`);
    assert.strictEqual(cp.lastExecutedLine, LAST_LINE, `${name}: at the line the job had reached, not the last periodic save`);
    assert.strictEqual(cp.gcodeText, TEXT);

    const appLog = fs.readFileSync(path.join(iso.logsDir, 'app.log'), 'utf8');
    assert.ok(appLog.includes(`[shutdown] ${signal} received`), `${name}: signal logged`);
    assert.ok(appLog.includes(`resume checkpoint saved at line ${LAST_LINE} of \\"dragon.nc\\"`) || appLog.includes(`resume checkpoint saved at line ${LAST_LINE} of "dragon.nc"`), `${name}: the save is logged`);

    const { JobHistoryService } = require(path.join(BACKEND, 'services/jobhistory/JobHistoryService'));
    const hist = new JobHistoryService({ dataDir: iso.dataDir, io: { emit() {} }, logger: quiet, getController: () => null });
    const rec = hist.records.find((r) => r.filename === 'dragon.nc');
    assert.ok(rec, `${name}: the job is in the history`);
    assert.strictEqual(rec.outcome, 'interrupted', `${name}: and recorded as interrupted`);
    assert.ok(rec.error.includes(signal), `${name}: by the shutdown (${rec.error})`);
    assert.strictEqual(rec.lastLine, LAST_LINE);
}

async function testShutdownSequence(root) {
    const r = await runChild(root, 'child-sequence');
    checkOutcome('shutdown sequence', r);
    console.log(`  ok  shutdown with a job running: checkpoint at line ${LAST_LINE} saved and logged before the Stop, history says why (exit after ${r.ms} ms)`);
}

async function testRealIndexJs(root) {
    const port = await freePort();
    const r = await runChild(root, 'child-index', { PORT: String(port), HOST: '127.0.0.1', NO_BROWSER: '1' });
    checkOutcome('index.js', r);
    console.log(`  ok  the real index.js does the same on ${process.platform === 'win32' ? 'SIGINT' : 'SIGTERM'} (exit after ${r.ms} ms)`);
}

if (!MODE) {
    (async () => {
        const root = makeRunRoot();
        await testShutdownSequence(root);
        await testRealIndexJs(root);
        removeDir(root);
        console.log('ALL TESTS PASSED SUCCESSFULLY!');
    })().catch((e) => { console.error(e); process.exit(1); });
}
