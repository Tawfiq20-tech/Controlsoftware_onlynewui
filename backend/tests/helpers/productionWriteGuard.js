'use strict';

/**
 * Preloaded into every test process by tests/run-all.js (node --require):
 * blocks and reports any write a test makes under the machine's real
 * backend/logs or backend/data folders.
 *
 * The env variables (lib/runtimePaths.js) move everything that honours them;
 * this catches whatever still does not -- a service with a hard-coded path,
 * a new test that forgets. The write fails with EACCES (so production files
 * are never touched), and the test process exits non-zero with the list.
 *
 * If EASYCNC_LOG_DIR / EASYCNC_DATA_DIR are not set yet (the guard used on its
 * own: node -r ./tests/helpers/productionWriteGuard.js some.test.js), they
 * are pointed at a fresh temp folder here.
 *
 * EASYCNC_GUARD_REPORT=<file>: the list of blocked writes is also written
 * there as JSON (used by tests/test_isolation.test.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimePaths = require('../../lib/runtimePaths');

let ownTempDir = null;
if (!process.env.EASYCNC_LOG_DIR || !process.env.EASYCNC_DATA_DIR) {
    ownTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycnc-guarded-'));
    if (!process.env.EASYCNC_LOG_DIR) process.env.EASYCNC_LOG_DIR = path.join(ownTempDir, 'logs');
    if (!process.env.EASYCNC_DATA_DIR) process.env.EASYCNC_DATA_DIR = path.join(ownTempDir, 'data');
}

const WIN = process.platform === 'win32';
const norm = (p) => { const r = path.resolve(p); return WIN ? r.toLowerCase() : r; };
const PROTECTED = [runtimePaths.DEFAULT_LOGS_DIR, runtimePaths.DEFAULT_DATA_DIR].map(norm);

const blocked = [];

function toPath(p) {
    if (typeof p === 'string') return p;
    if (Buffer.isBuffer(p)) return p.toString();
    if (p instanceof URL && p.protocol === 'file:') return require('url').fileURLToPath(p);
    return null; // a file descriptor: its open() was already checked
}

function isProtected(p) {
    const s = toPath(p);
    if (!s) return false;
    const n = norm(s);
    return PROTECTED.some((root) => n === root || n.startsWith(root + path.sep));
}

function violation(api, p) {
    const where = (new Error().stack || '').split('\n').slice(4, 7).map((l) => l.trim()).join(' <- ');
    blocked.push({ api, path: toPath(p), where });
    return Object.assign(new Error(`EACCES: test tried to write the machine's own ${toPath(p)} (${api}); blocked by tests/helpers/productionWriteGuard.js`), { code: 'EACCES', errno: -13, syscall: api, path: toPath(p) });
}

const WRITE_FLAG = /[wa+]/;
const openWrites = (flags) => {
    if (flags === undefined || flags === null) return false;
    if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0;
    return WRITE_FLAG.test(String(flags));
};
const dirExists = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };

// name -> which arguments are destinations, and when they count as a write
const CHECKS = {
    writeFile: (a) => [a[0]],
    appendFile: (a) => [a[0]],
    rename: (a) => [a[0], a[1]],
    copyFile: (a) => [a[1]],
    cp: (a) => [a[1]],
    unlink: (a) => [a[0]],
    rm: (a) => [a[0]],
    rmdir: (a) => [a[0]],
    truncate: (a) => [a[0]],
    utimes: (a) => [a[0]],
    symlink: (a) => [a[1]],
    link: (a) => [a[1]],
    mkdir: (a) => (dirExists(a[0]) ? [] : [a[0]]),
    open: (a) => (openWrites(a[1]) ? [a[0]] : []),
};

function hit(name, args) {
    const targets = CHECKS[name](args);
    for (const t of targets) if (isProtected(t)) return violation(name, t);
    return null;
}

for (const name of Object.keys(CHECKS)) {
    const sync = `${name}Sync`;
    if (typeof fs[sync] === 'function') {
        const orig = fs[sync];
        fs[sync] = function guardedSync(...args) {
            const err = hit(name, args);
            if (err) throw err;
            return orig.apply(this, args);
        };
    }
    if (typeof fs[name] === 'function') {
        const orig = fs[name];
        fs[name] = function guardedAsync(...args) {
            const err = hit(name, args);
            if (err) {
                const cb = args[args.length - 1];
                if (typeof cb === 'function') { process.nextTick(cb, err); return undefined; }
                throw err;
            }
            return orig.apply(this, args);
        };
    }
    if (fs.promises && typeof fs.promises[name] === 'function') {
        const orig = fs.promises[name];
        fs.promises[name] = function guardedPromise(...args) {
            const err = hit(name, args);
            if (err) return Promise.reject(err);
            return orig.apply(this, args);
        };
    }
}

const origCreateWriteStream = fs.createWriteStream;
fs.createWriteStream = function guardedCreateWriteStream(p, options) {
    if (isProtected(p)) throw violation('createWriteStream', p);
    return origCreateWriteStream.call(this, p, options);
};

// ---------------------------------------------------------------------------
// Interim routing for services that still hard-code backend/data (owned by
// another change; see contracts/PROCESS-needs.md): CNCEngine builds its
// ConfigStore on backend/data/config.json and ControllerRestartMonitor
// defaults to backend/data/controller_last_seen.json. In a test process they
// get the test's own data folder instead. Remove once both use
// lib/runtimePaths.dataDir() (tests/test_isolation.test.js reports it).
// ---------------------------------------------------------------------------
const Module = require('module');
const BACKEND = norm(runtimePaths.BACKEND_DIR);
const routeDataPath = (p) => {
    const s = toPath(p);
    if (!s || !isProtected(s) || !norm(s).startsWith(norm(runtimePaths.DEFAULT_DATA_DIR))) return p;
    return path.join(runtimePaths.dataDir(), path.relative(runtimePaths.DEFAULT_DATA_DIR, path.resolve(s)));
};
const ROUTES = {
    [norm(path.join(BACKEND, 'services', 'ConfigStore.js'))]: (exp) => {
        const Orig = exp.ConfigStore;
        if (typeof Orig !== 'function') return;
        exp.ConfigStore = class ConfigStore extends Orig {
            constructor(configPath, ...rest) { super(routeDataPath(configPath), ...rest); }
        };
    },
    [norm(path.join(BACKEND, 'services', 'ControllerRestartMonitor.js'))]: (exp) => {
        const Orig = exp.ControllerRestartMonitor;
        if (typeof Orig !== 'function') return;
        exp.ControllerRestartMonitor = class ControllerRestartMonitor extends Orig {
            constructor(file, ...rest) {
                super(file === undefined ? path.join(runtimePaths.dataDir(), 'controller_last_seen.json') : routeDataPath(file), ...rest);
            }
        };
    },
};
const routed = new WeakSet();
const origLoad = Module._load;
// EASYCNC_GUARD_NO_ROUTING=1: blocking only (tests/test_isolation.test.js
// uses it to see whether the services honour the data folder by themselves).
if (!process.env.EASYCNC_GUARD_NO_ROUTING) Module._load = function guardedLoad(request, parent, isMain) {
    const exp = origLoad.apply(this, arguments);
    if (typeof request === 'string' && /(ConfigStore|ControllerRestartMonitor)(\.js)?$/.test(request) && exp && typeof exp === 'object' && !routed.has(exp)) {
        try {
            const route = ROUTES[norm(Module._resolveFilename(request, parent, isMain))];
            if (route) { route(exp); routed.add(exp); }
        } catch (_) { /* not ours */ }
    }
    return exp;
};

process.on('exit', () => {
    if (ownTempDir) {
        try { fs.rmSync(ownTempDir, { recursive: true, force: true }); } catch (_) { /* files still open: left behind */ }
    }
    if (process.env.EASYCNC_GUARD_REPORT) {
        try { fs.writeFileSync(process.env.EASYCNC_GUARD_REPORT, JSON.stringify(blocked)); } catch (_) { /* best effort */ }
    }
    if (!blocked.length) return;
    const lines = blocked.slice(0, 20).map((b) => `  ${b.api} ${b.path}\n      at ${b.where}`).join('\n');
    try { process.stderr.write(`\nPRODUCTION WRITE BLOCKED (${blocked.length}): this test tried to write the machine's real logs/data:\n${lines}\n`); } catch (_) { /* stderr gone */ }
    process.exitCode = 1;
});

module.exports = { blocked, isProtected, PROTECTED };
