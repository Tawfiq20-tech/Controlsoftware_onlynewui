'use strict';

/**
 * Where the backend keeps what it writes at run time.
 *
 *   logs     backend/logs            (app.log, sessions/)   EASYCNC_LOG_DIR
 *   data     backend/data            (config, job history,  EASYCNC_DATA_DIR
 *                                     checkpoints, ...)
 *
 * The defaults are the folders the machine has always used. The variables
 * move them: tests/run-all.js points both at a fresh temp folder, because test
 * runs on the machine PC wrote into the real app.log -- on 2026-09-11 a
 * test's fake "RSP link up / RSP link lost" landed inside job 8's window and
 * was first read as a real link loss. A test must never be able to touch the
 * machine's logs, job history, resume checkpoint or config.
 *
 * Read at call time, not at require time, so a test that sets the variables
 * before constructing a service gets them.
 */

const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const DEFAULT_LOGS_DIR = path.join(BACKEND_DIR, 'logs');
const DEFAULT_DATA_DIR = path.join(BACKEND_DIR, 'data');

function fromEnv(name, fallback) {
    const v = process.env[name];
    return typeof v === 'string' && v.trim() ? path.resolve(v.trim()) : fallback;
}

function logsDir() { return fromEnv('EASYCNC_LOG_DIR', DEFAULT_LOGS_DIR); }
function sessionsDir() { return path.join(logsDir(), 'sessions'); }
function dataDir() { return fromEnv('EASYCNC_DATA_DIR', DEFAULT_DATA_DIR); }

module.exports = { BACKEND_DIR, DEFAULT_LOGS_DIR, DEFAULT_DATA_DIR, logsDir, sessionsDir, dataDir };
