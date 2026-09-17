'use strict';

/**
 * Gate: a test run must never write the machine's own logs or data.
 *
 * Test runs on the machine PC wrote into backend/logs/app.log: on 2026-09-11
 * a test's fake "RSP link up / tx error / RSP link lost" landed inside job
 * 8's window and was first read as a real link loss (43 test lines in the
 * production log). The same runs could write job history, the resume
 * checkpoint, controller_last_seen.json or config.json.
 *
 * tests/run-all.js gives every test its own EASYCNC_LOG_DIR / EASYCNC_DATA_DIR
 * and preloads tests/helpers/productionWriteGuard.js. This checks that it
 * holds, with a unique sentinel written through every real writer:
 *   1. the guard blocks and reports a direct write into backend/data,
 *   2. logger, session log, job history, resume checkpoint, engine config and
 *      controller-restart memory all land in the test's folders, and the
 *      sentinel is nowhere under backend/logs or backend/data,
 *   3. a representative existing test (engine + controller) runs with zero
 *      blocked writes.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const runtimePaths = require('../lib/runtimePaths');
const { GUARD, makeRunRoot, isolatedEnv, removeDir } = require('./helpers/isolatedEnv');

const BACKEND = path.join(__dirname, '..');
const PROD_LOGS = runtimePaths.DEFAULT_LOGS_DIR;
const PROD_DATA = runtimePaths.DEFAULT_DATA_DIR;
const root = makeRunRoot();
const SENTINEL = `isolation-sentinel-${crypto.randomBytes(6).toString('hex')}`;

function runGuarded(label, args, extraEnv = {}) {
    const iso = isolatedEnv(root, label);
    const report = path.join(iso.dir, 'guard-report.json');
    const r = spawnSync(process.execPath, ['--require', GUARD, ...args], {
        encoding: 'utf8',
        env: { ...iso.env, EASYCNC_GUARD_REPORT: report, SENTINEL, ...extraEnv },
        timeout: 10 * 60 * 1000,
    });
    const blocked = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
    return { r, iso, blocked };
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };

/** Does `needle` appear in any file name or small file under `dir`? */
function foundUnder(dir, needle, maxBytes = 32 * 1024 * 1024) {
    const hits = [];
    const walk = (d, depth) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.name.includes(needle)) hits.push(p);
            if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
            try {
                const st = fs.statSync(p);
                if (st.size <= maxBytes && st.mtimeMs >= STARTED - 5000 && read(p).includes(needle)) hits.push(p);
            } catch (_) { /* vanished */ }
        }
    };
    walk(dir, 0);
    return hits;
}
const STARTED = Date.now();

function testGuardBlocksProductionWrites() {
    const probe = path.join(PROD_DATA, `__guard_probe_${SENTINEL}.json`);
    const { r, blocked } = runGuarded('guard-self-check', ['-e', `
        const fs = require('fs');
        try { fs.writeFileSync(${JSON.stringify(probe)}, 'x'); } catch (e) { console.log('write refused: ' + e.code); }
    `]);
    const existed = fs.existsSync(probe);
    if (existed) fs.unlinkSync(probe);
    assert.ok(!existed, 'the guard stopped the write reaching backend/data');
    assert.ok(/write refused: EACCES/.test(r.stdout), r.stdout + r.stderr);
    assert.notStrictEqual(r.status, 0, 'and failed the process');
    assert.ok(/PRODUCTION WRITE BLOCKED/.test(r.stderr), r.stderr);
    assert.strictEqual(blocked && blocked.length, 1);
    console.log('  ok  the write guard blocks a write into backend/data and fails the test that tried');
}

const SENTINEL_SCRIPT = `
    const path = require('path');
    const { EventEmitter } = require('events');
    const BACKEND = ${JSON.stringify(BACKEND)};
    const S = process.env.SENTINEL;
    const logger = require(path.join(BACKEND, 'logger'));
    const runtimePaths = require(path.join(BACKEND, 'lib/runtimePaths'));
    logger.warn('[RSP] RSP link lost ' + S);

    const { createSessionLogger } = require(path.join(BACKEND, 'services/SessionLogger'));
    const session = createSessionLogger(logger.sessionsDir, S);
    session.logConsole(S);
    session.close();

    const ctl = new EventEmitter();
    const { JobHistoryService } = require(path.join(BACKEND, 'services/jobhistory/JobHistoryService'));
    new JobHistoryService({ dataDir: runtimePaths.dataDir(), io: { emit() {} }, logger, getController: () => ctl });
    ctl.emit('job:start', { filename: S + '.nc', gcode: 'G0 X1', controller: 'RSP' });
    ctl.emit('job:end', {});

    const { JobResumeStore } = require(path.join(BACKEND, 'services/jobresume/JobResumeStore'));
    new JobResumeStore(runtimePaths.dataDir(), logger).save({ filename: S + '.nc', gcodeText: 'G0 X1', totalLines: 1, lastExecutedLine: 1 });

    const { CNCEngine } = require(path.join(BACKEND, 'services/CNCEngine'));
    const engine = new CNCEngine(Object.assign(new EventEmitter(), { emit() {} }));
    engine.config.set('isolationSentinel', S);
    engine.config.flush();
    engine._restartMonitor.onConnectionLost({ name: S, line: 1, at: Date.now() });
    console.log('paths ' + JSON.stringify({ config: engine.config.configPath, restart: engine._restartMonitor._file }));
    setTimeout(() => process.exit(0), 700);
`;

function testEveryWriterLandsInTheTestFolder() {
    const { r, iso, blocked } = runGuarded('sentinel', ['-e', SENTINEL_SCRIPT]);
    assert.strictEqual(r.status, 0, `sentinel script failed:\n${r.stdout}\n${r.stderr}`);
    assert.deepStrictEqual(blocked, [], `no write reached the guard: ${JSON.stringify(blocked)}`);

    assert.ok(read(path.join(iso.logsDir, 'app.log')).includes(SENTINEL), 'app.log is the test\'s own');
    assert.ok(fs.readdirSync(path.join(iso.logsDir, 'sessions')).some((f) => f.includes(SENTINEL)), 'session log too');
    assert.ok(read(path.join(iso.dataDir, 'jobhistory.jsonl')).includes(SENTINEL), 'job history too');
    assert.ok(read(path.join(iso.dataDir, 'job_resume.json')).includes(SENTINEL), 'resume checkpoint too');
    assert.ok(read(path.join(iso.dataDir, 'config.json')).includes(SENTINEL), 'engine config too');
    assert.ok(read(path.join(iso.dataDir, 'controller_last_seen.json')).includes(SENTINEL), 'controller restart memory too');

    const leaks = [...foundUnder(PROD_LOGS, SENTINEL), ...foundUnder(PROD_DATA, SENTINEL)];
    assert.deepStrictEqual(leaks, [], 'the sentinel reached the machine\'s own logs/data');
    console.log('  ok  logger, session log, job history, checkpoint, config and restart memory all write the test\'s folders; nothing under backend/logs or backend/data');
}

function testServicesHonourTheDataFolderThemselves() {
    // Without the guard's interim routing: which services still hard-code
    // backend/data? (blocking stays on, so nothing is written there)
    const probe = `
        const path = require('path');
        const { EventEmitter } = require('events');
        const { CNCEngine } = require(${JSON.stringify(path.join(BACKEND, 'services/CNCEngine'))});
        const engine = new CNCEngine(Object.assign(new EventEmitter(), { emit() {} }));
        console.log('paths ' + JSON.stringify({ config: engine.config.configPath, restart: engine._restartMonitor._file }));
        process.exit(0);
    `;
    const { r, iso } = runGuarded('no-routing', ['-e', probe], { EASYCNC_GUARD_NO_ROUTING: '1' });
    const m = /paths (\{.*\})/.exec(r.stdout);
    assert.ok(m, r.stdout + r.stderr);
    const paths = JSON.parse(m[1]);
    const inside = (p) => path.resolve(p).toLowerCase().startsWith(path.resolve(iso.dataDir).toLowerCase());
    const gaps = Object.entries(paths).filter(([, p]) => !inside(p)).map(([k, p]) => `${k}: ${p}`);
    if (gaps.length) {
        console.log(`  SKIPPED: still hard-coded to backend/data, routed only by the test guard until fixed (contracts/PROCESS-needs.md): ${gaps.join('; ')}`);
    } else {
        console.log('  ok  CNCEngine config and ControllerRestartMonitor honour EASYCNC_DATA_DIR on their own');
    }
}

function testRepresentativeTestRunsClean() {
    const { r, blocked } = runGuarded('representative', [path.join(__dirname, 'load_start_race.test.js')]);
    assert.strictEqual(r.status, 0, `load_start_race.test.js failed under the guard:\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
    assert.ok(r.stdout.includes('ALL TESTS PASSED SUCCESSFULLY!'));
    assert.deepStrictEqual(blocked, [], `no production writes: ${JSON.stringify(blocked)}`);
    console.log('  ok  a representative engine test runs isolated with zero blocked writes');
}

/**
 * Every file under backend/logs and backend/data: path -> size + mtime.
 * The guard only sees writes made through the fs module of a process it was
 * preloaded into; this sees any write at all (a child process started without
 * it, a native module, a shell command).
 */
function snapshot() {
    const files = new Map();
    const walk = (d, depth) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (depth < 6) walk(p, depth + 1); continue; }
            try { const st = fs.statSync(p); files.set(p, `${st.size}@${st.mtimeMs}`); } catch (_) { /* vanished */ }
        }
    };
    walk(PROD_LOGS, 0);
    walk(PROD_DATA, 0);
    return files;
}

function changesBetween(before, after) {
    const out = [];
    for (const [p, v] of after) {
        if (!before.has(p)) out.push(`added ${p}`);
        else if (before.get(p) !== v) out.push(`changed ${p} (${before.get(p)} -> ${v})`);
    }
    for (const p of before.keys()) if (!after.has(p)) out.push(`removed ${p}`);
    return out;
}

/** Is the machine's own backend running (it writes these folders itself)? */
function productionBackendRunning() {
    const r = spawnSync(process.execPath, ['-e', `
        const s = require('net').connect(4000, '127.0.0.1');
        s.on('connect', () => { console.log('in use'); process.exit(0); });
        s.on('error', () => { console.log('free'); process.exit(0); });
        setTimeout(() => { console.log('free'); process.exit(0); }, 1500);
    `], { encoding: 'utf8', timeout: 5000 });
    return /in use/.test(r.stdout || '');
}

const liveBackend = productionBackendRunning();
const before = liveBackend ? null : snapshot();
testGuardBlocksProductionWrites();
testEveryWriterLandsInTheTestFolder();
testServicesHonourTheDataFolderThemselves();
testRepresentativeTestRunsClean();
if (liveBackend) {
    console.log('  SKIPPED: a backend is running on port 4000 and writes backend/logs and backend/data itself; the before/after comparison of those folders was not made');
} else {
    const changes = changesBetween(before, snapshot());
    assert.deepStrictEqual(changes, [], 'nothing under backend/logs or backend/data changed while the tests above ran');
    console.log(`  ok  backend/logs and backend/data identical before and after (${before.size} files: size and modification time)`);
}
removeDir(root);
console.log('ALL TESTS PASSED SUCCESSFULLY!');
