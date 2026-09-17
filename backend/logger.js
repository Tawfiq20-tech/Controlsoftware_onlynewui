/**
 * Winston app logger: console + file. Used for requests, errors, and frontend-sent logs (POST /api/log).
 *
 * Folders: lib/runtimePaths.js (EASYCNC_LOG_DIR moves them; tests do).
 *
 * Logging must never hurt the job it is describing:
 *  - a closed console (stdout/stderr pipe gone, EPIPE) turns console output
 *    off; it is not an exception. On 2026-09-16 each console write threw
 *    EPIPE, the uncaught-exception handler logged that through the same
 *    console, which threw again: 60,351 traces in 17 s, a 100 MB app1.log,
 *    a full C: drive and a starved event loop.
 *  - a log target that throws or fails (disk full, drive gone) is dropped
 *    and retried later, reported once. winston's File transport ignores its
 *    own write errors and then waits forever for a 'drain' that never comes,
 *    which silently stopped ALL logging (console too) until a restart.
 *  - nothing here throws into the caller.
 */
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const TransportStream = require('winston-transport');
const runtimePaths = require('./lib/runtimePaths');

const logsDir = runtimePaths.logsDir();
const sessionsDir = runtimePaths.sessionsDir();
const appLogPath = path.join(logsDir, 'app.log');

// How long a failed app.log waits before it is opened again.
const FILE_RETRY_MS = Math.max(50, Number(process.env.EASYCNC_LOG_RETRY_MS) || 30000);

// ---------------------------------------------------------------------------
// One report per problem until it clears. Reports go to stderr (raw, guarded)
// and, when the problem is not the log file itself, to the log.
// ---------------------------------------------------------------------------
const openProblems = new Map();   // key -> { since, count }
let stderrAlive = true;

function rawStderr(line) {
    if (!stderrAlive) return;
    try {
        if (process.stderr && !process.stderr.destroyed) process.stderr.write(`${line}\n`);
    } catch (_) {
        stderrAlive = false;
    }
}

function noteProblem(key, message, { toLog = true } = {}) {
    const open = openProblems.get(key);
    if (open) { open.count++; return false; }
    openProblems.set(key, { since: Date.now(), count: 1 });
    rawStderr(`[logger] ${message}`);
    if (toLog) safeLog('warn', `[logger] ${message}`);
    return true;
}

function clearProblem(key) {
    const open = openProblems.get(key);
    if (!open) return null;
    openProblems.delete(key);
    return open;
}

for (const d of [logsDir, sessionsDir]) {
    try {
        fs.mkdirSync(d, { recursive: true });
    } catch (err) {
        // A read-only or full drive must not stop the sender from starting.
        noteProblem(`mkdir:${d}`, `cannot create ${d}: ${err.message}`, { toLog: false });
    }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

// A transport's log() that throws would throw out of logger.info() into
// whatever code was logging (the job tick, the uncaught-exception handler).
function guardTransport(transport) {
    if (!transport || transport.__easycncGuarded || typeof transport.log !== 'function') return transport;
    transport.__easycncGuarded = true;
    const log = transport.log;
    transport.log = function guardedLog(info, callback) {
        let called = false;
        const once = (...args) => { if (called) return; called = true; if (typeof callback === 'function') callback(...args); };
        try {
            return log.call(this, info, once);
        } catch (err) {
            noteProblem(`throw:${transport.name || 'transport'}`, `log transport "${transport.name || 'transport'}" threw (${err && err.message}); its lines are being dropped`, { toLog: false });
            once();
            return true;
        }
    };
    return transport;
}

// ECSS-E: a Winston transport that forwards log lines to the remote diag
// mirror. Lazy-require to break the dependency cycle (logger ← mirror ← logger).
class RemoteDiagTransport extends TransportStream {
    constructor(opts) { super(opts); this.name = 'RemoteDiagTransport'; }
    log(info, next) {
        setImmediate(() => this.emit('logged', info));
        try {
            const mirror = require('./services/RemoteDiagMirror');
            mirror.mirrorLog(info.level || 'info', info.message);
        } catch (_) { /* mirror not loaded yet during boot */ }
        next();
    }
}

const consoleTransport = guardTransport(new winston.transports.Console({
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
    ),
}));

function makeFileTransport() {
    // Capped: app.log had grown to 100 MB, on a PC whose C: drive ran
    // out of space (2026-09-16). Newest 20 MB x 5 files are kept.
    return guardTransport(new winston.transports.File({ filename: appLogPath, maxsize: 20 * 1024 * 1024, maxFiles: 5, tailable: true }));
}

let fileTransport = makeFileTransport();

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'cnc-backend' },
    transports: [
        consoleTransport,
        fileTransport,
        guardTransport(new RemoteDiagTransport()),
    ],
});

// Transports added later get the same guard.
const addTransport = logger.add.bind(logger);
logger.add = (transport) => addTransport(guardTransport(transport));

/** logger.<level>(msg) that can never throw. */
function safeLog(level, message) {
    try {
        logger.log(level, message);
    } catch (_) { /* a logging failure is already reported by the guards */ }
}

// ---------------------------------------------------------------------------
// Console gone (EPIPE / destroyed pipe)
// ---------------------------------------------------------------------------
let consoleAlive = true;

function disableConsole(err) {
    if (!consoleAlive) return false;
    consoleAlive = false;
    try { logger.remove(consoleTransport); } catch (_) { /* already removed */ }
    const code = (err && (err.code || err.message)) || 'closed';
    safeLog('warn', `[logger] console output closed (${code}) -- logging to ${appLogPath} only from now on`);
    return true;
}

// Without an 'error' listener a failed write to a closed pipe is thrown as an
// uncaught exception -- see the header.
if (process.stdout && typeof process.stdout.on === 'function') {
    process.stdout.on('error', (err) => disableConsole(err));
}
if (process.stderr && typeof process.stderr.on === 'function') {
    process.stderr.on('error', () => { stderrAlive = false; });
}

// ---------------------------------------------------------------------------
// app.log failing (disk full, folder gone)
// ---------------------------------------------------------------------------
let fileRetryTimer = null;

function watchFileTransport(transport) {
    // winston's File transport swallows its write stream's errors (debug
    // only) and then waits for 'drain' forever; hook every stream it opens.
    const hook = (dest) => {
        if (!dest || dest.__easycncHooked || typeof dest.on !== 'function') return;
        dest.__easycncHooked = true;
        dest.on('error', (err) => onFileFailure(transport, err));
    };
    const createStream = transport._createStream;
    if (typeof createStream === 'function') {
        transport._createStream = function hookedCreateStream(...args) {
            const dest = createStream.apply(this, args);
            hook(dest);
            return dest;
        };
    }
    hook(transport._dest);
    // Back to normal only once bytes really reached the file ('logged' fires
    // when winston has buffered the line, not when it is on disk).
    let checkPending = false;
    transport.on('logged', () => {
        if (checkPending || !openProblems.has('file')) return;
        checkPending = true;
        const t = setTimeout(() => {
            checkPending = false;
            const dest = transport._dest;
            if (transport !== fileTransport || !dest || dest.destroyed || !(dest.bytesWritten > 0)) return;
            const was = clearProblem('file');
            if (was) safeLog('warn', `[logger] ${appLogPath} is being written again; log lines from ${new Date(was.since).toISOString()} until now were not saved`);
        }, 200);
        if (t.unref) t.unref();
    });
}

function onFileFailure(transport, err) {
    if (transport !== fileTransport) return;
    noteProblem('file', `cannot write ${appLogPath} (${(err && (err.code || err.message)) || err}); log lines are not being saved -- retrying every ${Math.round(FILE_RETRY_MS / 1000)} s`, { toLog: false });
    // Drop it so the other transports keep flowing, and try a fresh one later.
    // winston re-adds a transport that emits 'error' after being removed
    // (winston#1364): detach that hook first so the dead one stays out.
    if (transport) {
        try {
            if (transport.__winstonerror) transport.removeListener('error', transport.__winstonerror);
            transport.on('error', () => {});
        } catch (_) { /* best effort */ }
        try { logger.remove(transport); } catch (_) { /* already gone */ }
        try { transport.close && transport.close(); } catch (_) { /* broken anyway */ }
    }
    fileTransport = null;
    if (fileRetryTimer) return;
    fileRetryTimer = setTimeout(() => {
        fileRetryTimer = null;
        try {
            fs.mkdirSync(logsDir, { recursive: true });
            fileTransport = makeFileTransport();
            watchFileTransport(fileTransport);
            addTransport(fileTransport);
        } catch (e) {
            onFileFailure(fileTransport, e);
        }
    }, FILE_RETRY_MS);
    if (fileRetryTimer.unref) fileRetryTimer.unref();
}

watchFileTransport(fileTransport);

// A transport emitting 'error' is re-emitted by the logger; with no listener
// that is an uncaught exception at every log line.
logger.on('error', (err, transport) => {
    if (transport && transport === fileTransport) return onFileFailure(transport, err);
    const name = (transport && transport.name) || 'transport';
    noteProblem(`error:${name}`, `log transport "${name}" failed: ${(err && err.message) || err}`, { toLog: transport !== consoleTransport });
});

module.exports = logger;
module.exports.logsDir = logsDir;
module.exports.sessionsDir = sessionsDir;
module.exports.appLogPath = appLogPath;
module.exports.disableConsole = disableConsole;
module.exports.isConsoleAlive = () => consoleAlive;
module.exports.safeLog = safeLog;
module.exports.noteProblem = noteProblem;
module.exports.clearProblem = clearProblem;
