'use strict';

// The ONLY module that touches node:sqlite (experimental API, §4.1 / R5). Everything
// else goes through this wrapper so an API change is a one-file fix.
const sqlite = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const CHECKPOINT_INTERVAL_MS = 100;
const CHECKPOINTER_STOP_TIMEOUT_MS = 2000;

// Background checkpointer (runs when this file is loaded as a worker). SQLite's automatic
// checkpoint copies the whole WAL into the database synchronously inside whichever write
// crosses the page threshold; on a large retention sweep that one step stalled the event
// loop for 250-450 ms under load, long enough to delay relayed jog keepalives and STOP.
// A PASSIVE checkpoint on its own connection in another thread does the same copying
// without blocking the relay's loop or its writers.
if (!isMainThread && workerData && workerData.relayCheckpointer) {
    const conn = new sqlite.DatabaseSync(workerData.file);
    conn.exec('PRAGMA busy_timeout = 1000');
    const step = () => {
        try { conn.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch (_) { /* busy: retry next tick */ }
    };
    const timer = setInterval(step, workerData.intervalMs);
    parentPort.on('message', (msg) => {
        if (msg !== 'stop') return;
        clearInterval(timer);
        step();
        try { conn.close(); } catch (_) { /* already closed */ }
        parentPort.close();
    });
}

function isBusyError(err) {
    if (!err) return false;
    if (err.errcode === 5 || err.errcode === 6) return true;
    return /SQLITE_BUSY|database is locked|database table is locked/i.test(String(err.message || ''));
}

class Db {
    constructor(file, { busyTimeoutMs = 200 } = {}) {
        this.file = file;
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
        this.raw = new sqlite.DatabaseSync(file);
        this._stmts = new Map();
        this._txDepth = 0;
        this._checkpointer = null;   // { worker, users, restoreAutocheckpoint, exited }
        this.open = true;
        this.raw.exec(`PRAGMA busy_timeout = ${Math.max(0, busyTimeoutMs | 0)}`);
        if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
        this.raw.exec('PRAGMA synchronous = NORMAL');
        this.raw.exec('PRAGMA foreign_keys = ON');
    }

    _stmt(sql) {
        let st = this._stmts.get(sql);
        if (!st) {
            st = this.raw.prepare(sql);
            if (this._stmts.size > 500) this._stmts.clear();
            this._stmts.set(sql, st);
        }
        return st;
    }

    exec(sql) {
        this.raw.exec(sql);
    }

    run(sql, ...params) {
        const r = this._stmt(sql).run(...params);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    }

    get(sql, ...params) {
        const row = this._stmt(sql).get(...params);
        return row === undefined ? null : { ...row };
    }

    all(sql, ...params) {
        return this._stmt(sql).all(...params).map((r) => ({ ...r }));
    }

    pragma(name) {
        const row = this.raw.prepare(`PRAGMA ${name}`).get();
        return row ? Object.values(row)[0] : undefined;
    }

    // BEGIN IMMEDIATE takes the write lock up front so single-use operations (pairing
    // claims, credential rotation) can never interleave with another writer.
    transaction(fn) {
        if (this._txDepth > 0) {
            this._txDepth++;
            try {
                return fn();
            } finally {
                this._txDepth--;
            }
        }
        this.raw.exec('BEGIN IMMEDIATE');
        this._txDepth = 1;
        try {
            const result = fn();
            this.raw.exec('COMMIT');
            return result;
        } catch (err) {
            try { this.raw.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
            throw err;
        } finally {
            this._txDepth = 0;
        }
    }

    // Retention sweeps delete in bounded batches and yield between them so a large
    // backlog never blocks the event loop (§4.1 "Sweeps never block the loop"). While any
    // sweep runs, automatic checkpoints are off and the background checkpointer keeps the
    // WAL bounded instead (see the worker at the top of this file).
    async deleteBatched(table, where, params = [], { batchSize = 1000, onStep, mono } = {}) {
        if (!/^[a-z_]+$/.test(table)) throw new Error('bad table');
        const sql = `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${batchSize | 0})`;
        const clockFn = mono || (() => Number(process.hrtime.bigint() / 1000n) / 1000);
        let total = 0;
        let busyTries = 0;
        this._acquireCheckpointer();
        try {
            for (;;) {
                if (!this.open) return total;
                const t0 = clockFn();
                let changes;
                try {
                    changes = this.run(sql, ...params).changes;
                    busyTries = 0;
                } catch (err) {
                    if (!isBusyError(err) || ++busyTries > 20) throw err;
                    await new Promise((r) => setTimeout(r, 100));
                    continue;
                }
                total += changes;
                if (onStep) onStep({ changes, ms: clockFn() - t0 });
                if (changes < batchSize) return total;
                await new Promise((r) => setImmediate(r));
            }
        } finally {
            await this._releaseCheckpointer();
        }
    }

    // Reference-counted: the hourly, file and daily sweeps can overlap.
    _acquireCheckpointer() {
        if (this.file === ':memory:' || !this.open) return;
        if (this._checkpointer) {
            this._checkpointer.users++;
            return;
        }
        let worker;
        try {
            worker = new Worker(__filename, {
                workerData: { relayCheckpointer: true, file: this.file, intervalMs: CHECKPOINT_INTERVAL_MS },
            });
        } catch (_) {
            return; // no worker threads: keep SQLite's automatic checkpoints
        }
        const cp = { worker, users: 1, restoreAutocheckpoint: Number(this.pragma('wal_autocheckpoint')) || 1000, exited: null };
        cp.exited = new Promise((resolve) => worker.once('exit', resolve));
        // If the worker dies, fall back to automatic checkpoints at once so the WAL can't grow.
        worker.once('error', () => this._restoreAutocheckpoint(cp));
        worker.once('exit', () => this._restoreAutocheckpoint(cp));
        worker.unref();
        this._checkpointer = cp;
        this.raw.exec('PRAGMA wal_autocheckpoint = 0');
    }

    async _releaseCheckpointer() {
        const cp = this._checkpointer;
        if (!cp || --cp.users > 0) return;
        this._checkpointer = null;
        this._restoreAutocheckpoint(cp);
        try { cp.worker.postMessage('stop'); } catch (_) { /* already gone */ }
        const timeout = new Promise((resolve) => setTimeout(resolve, CHECKPOINTER_STOP_TIMEOUT_MS).unref());
        await Promise.race([cp.exited, timeout]);
        cp.worker.terminate().catch(() => {});
    }

    _restoreAutocheckpoint(cp) {
        if (cp.restored || !this.open) return;
        cp.restored = true;
        try { this.raw.exec(`PRAGMA wal_autocheckpoint = ${cp.restoreAutocheckpoint}`); } catch (_) { /* closing */ }
    }

    checkpoint() {
        if (this.file === ':memory:') return;
        try { this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* best effort at shutdown */ }
    }

    close() {
        if (!this.open) return;
        if (this._checkpointer) {
            this._checkpointer.worker.terminate().catch(() => {});
            this._checkpointer = null;
        }
        this.open = false;
        this._stmts.clear();
        this.raw.close();
    }
}

function openDatabase(file, opts) {
    return new Db(file, opts);
}

// rate = pages per step; small steps keep each lock hold short so a running server
// (busy_timeout 200 ms) never stalls behind a backup.
function backupDatabase(db, destination, { rate = 100 } = {}) {
    return sqlite.backup(db.raw, destination, { rate });
}

module.exports = { openDatabase, backupDatabase, isBusyError, Db };
