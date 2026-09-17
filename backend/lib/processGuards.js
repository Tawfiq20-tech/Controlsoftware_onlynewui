'use strict';

/**
 * Process-level guards for the backend (wired in index.js):
 *   installExceptionGuards() -- uncaughtException / unhandledRejection
 *   createShutdown()         -- SIGINT / SIGTERM / SIGHUP / SIGBREAK
 *
 * The controller stops the machine by itself if the PC goes quiet for 5 s
 * (host watchdog). So a backend crash, or this window being closed during a
 * carve, does not just end the program -- it stops the machine mid-cut and
 * leaves the spindle in the material.
 *
 * WHAT AN UNCAUGHT EXCEPTION DOES (decided 2026-09-17): the process keeps
 * running, whether a job is running or not.
 *  - During a job, exiting hands the machine to the 5 s watchdog E-stop:
 *    drivers drop at feed, the tool stays in the work and the position may be
 *    lost. If the exception did break streaming, the job's own stall and link
 *    checks stop the machine the controlled way, which is strictly better.
 *    The resume checkpoint is saved at once, so if the process does die after
 *    all, no more progress is lost than necessary.
 *  - Idle, RUN.bat does not restart the sender: exiting leaves the operator
 *    with a dead screen and no idea why.
 * It is NOT swallowed: the first occurrences of each distinct error go to
 * app.log with the stack and to the screen as an internal error; repeats are
 * counted and summarised once per window. The old handler logged every
 * occurrence through a logger that could itself throw -- on 2026-09-16 that
 * was 60,351 EPIPE traces in 17 s, 100 MB of log and a full C: drive.
 */

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_PER_SIGNATURE = 3;     // stack traces per distinct error per window
const DEFAULT_PER_WINDOW = 20;       // stack traces in total per window
const CHECKPOINT_EVERY_MS = 5000;    // at most one emergency checkpoint per 5 s

function describe(err) {
    if (err && err.stack) return String(err.stack);
    if (err && err.message) return String(err.message);
    try { return String(err); } catch (_) { return '(unprintable error)'; }
}

function signatureOf(kind, err) {
    const message = String((err && err.message) || describe(err)).slice(0, 200);
    const frame = err && err.stack ? String(err.stack).split('\n')[1] || '' : '';
    return `${kind}|${(err && err.code) || ''}|${message}|${frame.trim()}`;
}

/**
 * Save the running job's resume checkpoint now.
 * @returns {{line:number, filename:string}|null} what was saved, or null
 */
function saveCheckpointNow(jobResumeService, reason) {
    const svc = jobResumeService;
    if (!svc) return null;
    if (typeof svc.saveNow === 'function') return svc.saveNow(reason) || null;
    const active = svc._active;
    if (!active) return null;
    // JobResumeService.onStop() saves the active job's checkpoint and nothing
    // else (it is what CNCEngine calls before sending a Stop).
    svc.onStop();
    const last = svc.store && svc.store.lastSave;
    if (last && last.ok === false) return null;
    return { line: active.lastExecutedLine, filename: active.filename };
}

function jobIsActive(engine) {
    return !!(engine && engine.controller && engine.controller.job && engine.controller.job.active);
}

/**
 * @param {object} opts
 * @param {object}   opts.logger               winston logger (logger.js)
 * @param {function} [opts.notify]             (message) -> tell the screen
 * @param {function} [opts.isJobActive]        () -> boolean
 * @param {function} [opts.saveCheckpoint]     (reason) -> save the running job's checkpoint
 * @param {number}   [opts.windowMs]
 * @param {number}   [opts.perSignature]
 * @param {number}   [opts.perWindow]
 * @param {object}   [opts.proc]               process (tests)
 */
function installExceptionGuards(opts = {}) {
    const logger = opts.logger;
    const proc = opts.proc || process;
    const windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
    const perSignature = opts.perSignature || DEFAULT_PER_SIGNATURE;
    const perWindow = opts.perWindow || DEFAULT_PER_WINDOW;
    const notify = typeof opts.notify === 'function' ? opts.notify : () => {};
    const isJobActive = typeof opts.isJobActive === 'function' ? opts.isJobActive : () => false;
    const saveCheckpoint = typeof opts.saveCheckpoint === 'function' ? opts.saveCheckpoint : null;

    const stats = { uncaught: 0, rejections: 0, logged: 0, suppressed: 0, reentered: 0, checkpoints: 0 };
    const seen = new Map();      // signature -> { total, inWindow }
    let windowStart = Date.now();
    let loggedInWindow = 0;
    let suppressed = new Map();  // signature -> { count, label }
    let summaryTimer = null;
    let inHandler = false;
    let lastCheckpointAt = 0;

    function write(level, message) {
        try {
            if (logger && typeof logger.log === 'function') { logger.log(level, message); return; }
        } catch (_) { /* fall through to stderr */ }
        try { if (proc.stderr && !proc.stderr.destroyed) proc.stderr.write(`${message}\n`); } catch (_) { /* nowhere left */ }
    }

    function summarise() {
        summaryTimer = null;
        if (!suppressed.size) return;
        let total = 0;
        let top = null;
        for (const s of suppressed.values()) { total += s.count; if (!top || s.count > top.count) top = s; }
        write('error', `[process] ${total} more uncaught error(s) in the last ${Math.round(windowMs / 1000)} s were not logged again; most frequent (${top.count}x): ${top.label}`);
        suppressed = new Map();
    }

    function rollWindow(now) {
        if (now - windowStart < windowMs) return;
        windowStart = now;
        loggedInWindow = 0;
        for (const s of seen.values()) s.inWindow = 0;
    }

    function handle(kind, err) {
        if (kind === 'uncaught') stats.uncaught++; else stats.rejections++;
        // Nothing below should throw, but a handler that throws kills the
        // process and one that re-enters itself is the storm this prevents.
        if (inHandler) { stats.reentered++; return; }
        inHandler = true;
        try {
            const now = Date.now();
            rollWindow(now);
            const sig = signatureOf(kind, err);
            let entry = seen.get(sig);
            if (!entry) {
                if (seen.size >= 500) seen.delete(seen.keys().next().value);
                entry = { total: 0, inWindow: 0 };
                seen.set(sig, entry);
            }
            entry.total++;
            // Belt and braces: logger.js already turns a closed console into
            // "console off" through the stdout 'error' listener.
            if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') && proc.stdout && proc.stdout.destroyed &&
                logger && typeof logger.disableConsole === 'function') {
                logger.disableConsole(err);
            }
            const label = kind === 'uncaught' ? 'UNCAUGHT EXCEPTION' : 'UNHANDLED REJECTION';
            const active = (() => { try { return !!isJobActive(); } catch (_) { return false; } })();
            if (entry.inWindow < perSignature && loggedInWindow < perWindow) {
                entry.inWindow++;
                loggedInWindow++;
                stats.logged++;
                const repeat = entry.total > 1 ? ` (occurrence ${entry.total})` : '';
                write('error', `${label}${repeat}${active ? ' during a job' : ''}: ${describe(err)}`);
                if (entry.inWindow === 1 && kind === 'uncaught') {
                    const msg = (err && err.message) || describe(err).split('\n')[0];
                    try {
                        notify(active
                            ? `Internal error in the sender: ${msg}. The job continues; restart the sender when the machine is idle.`
                            : `Internal error in the sender: ${msg}. If something stops working, restart the sender.`);
                    } catch (_) { /* the screen is best effort */ }
                }
            } else {
                stats.suppressed++;
                const s = suppressed.get(sig) || { count: 0, label: `${label}: ${String((err && err.message) || describe(err)).split('\n')[0].slice(0, 200)}` };
                s.count++;
                suppressed.set(sig, s);
                if (!summaryTimer) {
                    summaryTimer = setTimeout(summarise, Math.max(10, windowMs - (now - windowStart)));
                    if (summaryTimer.unref) summaryTimer.unref();
                }
            }
            if (kind === 'uncaught' && active && saveCheckpoint && now - lastCheckpointAt >= CHECKPOINT_EVERY_MS) {
                lastCheckpointAt = now;
                try {
                    const saved = saveCheckpoint('uncaught exception');
                    stats.checkpoints++;
                    if (saved) write('warn', `[process] resume checkpoint saved at line ${saved.line} after an internal error`);
                } catch (e) {
                    write('error', `[process] could not save the resume checkpoint after an internal error: ${(e && e.message) || e}`);
                }
            }
        } catch (_) {
            /* never throw from here */
        } finally {
            inHandler = false;
        }
    }

    const onUncaught = (err) => handle('uncaught', err);
    const onRejection = (reason) => handle('rejection', reason);
    proc.on('uncaughtException', onUncaught);
    proc.on('unhandledRejection', onRejection);

    return {
        stats,
        flushSummary: summarise,
        uninstall() {
            proc.removeListener('uncaughtException', onUncaught);
            proc.removeListener('unhandledRejection', onRejection);
            if (summaryTimer) clearTimeout(summaryTimer);
        },
    };
}

/**
 * The shutdown sequence for SIGINT/SIGTERM/SIGHUP/SIGBREAK (Ctrl+C, window
 * closed, service stop):
 *   1. a job is running or paused: save its resume checkpoint FIRST (a Stop
 *      that has not reached the controller before the port closes must not
 *      cost the resume point), log it, mark the job in the history,
 *   2. then stop it cleanly (drivers off, position kept) rather than letting
 *      the watchdog fire,
 *   3. close the port and exit.
 * @returns {function(string)} shutdown(signal)
 */
function createShutdown({ logger, getEngine, jobResumeService, jobHistoryService, exit, stopDelayMs = 1500, idleDelayMs = 100 }) {
    let shuttingDown = false;
    const doExit = typeof exit === 'function' ? exit : (code) => process.exit(code);
    const log = (level, msg) => { try { logger[level](msg); } catch (_) { /* logging is best effort here */ } };

    return function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        log('info', `[shutdown] ${signal} received`);
        const engine = typeof getEngine === 'function' ? getEngine() : null;
        const hadJob = jobIsActive(engine);
        if (hadJob) {
            let saved = null;
            try {
                saved = saveCheckpointNow(jobResumeService, `backend shutdown (${signal})`);
            } catch (exc) {
                log('error', `[shutdown] could not save the resume checkpoint: ${(exc && exc.message) || exc}`);
            }
            if (saved) {
                log('warn', `[shutdown] a job is running -- resume checkpoint saved at line ${saved.line} of "${saved.filename}"; stopping the machine`);
            } else {
                log('error', '[shutdown] a job is running -- NO resume checkpoint could be saved; stopping the machine');
            }
            try {
                if (jobHistoryService && typeof jobHistoryService.noteShutdown === 'function') jobHistoryService.noteShutdown(signal);
            } catch (exc) {
                log('warn', `[shutdown] could not update the job history: ${(exc && exc.message) || exc}`);
            }
            try {
                engine.controller.command('gcode:stop');
            } catch (exc) {
                log('error', `[shutdown] could not stop the job: ${(exc && exc.message) || exc}`);
            }
        }
        // Let the stop frame reach the controller before the port closes.
        setTimeout(() => {
            try { if (engine && typeof engine._closeConnection === 'function') engine._closeConnection(); } catch (_) { /* exiting anyway */ }
            doExit(0);
        }, hadJob ? stopDelayMs : idleDelayMs);
    };
}

function installSignalHandlers(shutdown, proc = process) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        proc.on(sig, () => shutdown(sig));
    }
}

module.exports = { installExceptionGuards, createShutdown, installSignalHandlers, saveCheckpointNow, jobIsActive };
