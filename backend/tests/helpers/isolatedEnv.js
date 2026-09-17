'use strict';

/**
 * A private logs + data folder for one test process.
 *
 * tests/run-all.js runs every test file with EASYCNC_LOG_DIR / EASYCNC_DATA_DIR
 * pointing here (see lib/runtimePaths.js), and preloads
 * productionWriteGuard.js, so a test can neither write nor be confused by the
 * machine's real app.log, session logs, job history, checkpoint or config.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD = path.join(__dirname, 'productionWriteGuard.js');

/** A fresh folder for a whole run: <tmp>/easycnc-tests-<time>-<pid>. */
function makeRunRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), `easycnc-tests-${Date.now().toString(36)}-${process.pid}-`));
}

/**
 * Environment for one test: its own logs/ and data/ under `root/label`.
 * @returns {{ env: object, dir: string, logsDir: string, dataDir: string }}
 */
function isolatedEnv(root, label, baseEnv = process.env) {
    const dir = path.join(root, String(label).replace(/[^a-zA-Z0-9_.-]/g, '_'));
    const logsDir = path.join(dir, 'logs');
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ...baseEnv, EASYCNC_LOG_DIR: logsDir, EASYCNC_DATA_DIR: dataDir, NO_BROWSER: '1' };
    return { env, dir, logsDir, dataDir };
}

function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) { /* best effort */ }
}

module.exports = { GUARD, makeRunRoot, isolatedEnv, removeDir };
