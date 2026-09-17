'use strict';

const { isBusyError } = require('./store/db');
const { scrub } = require('./log');

const DETAIL_MAX = 2048;
const FLUSH_MS = 250;
const QUEUE_MAX = 20000;

function encodeDetail(detail) {
    if (detail == null) return null;
    let s = JSON.stringify(scrub(detail));
    if (Buffer.byteLength(s) > DETAIL_MAX) {
        const small = { truncated: true };
        for (const k of ['type', 'cls', 'code', 'status', 'by', 'name', 'reason', 'role']) {
            if (detail[k] !== undefined) small[k] = typeof detail[k] === 'string' ? detail[k].slice(0, 120) : detail[k];
        }
        s = JSON.stringify(small);
    }
    return s;
}

class Audit {
    constructor({ db, clock, logger }) {
        this.db = db;
        this.clock = clock;
        this.logger = logger;
        this.queue = [];
        this.timer = setInterval(() => this.flush(), FLUSH_MS);
        this.timer.unref();
        this.retrying = false;
        this.dropped = 0;
    }

    // Control-plane events are written synchronously so they survive a crash right after.
    write({ userId = null, deviceId = null, ip = null, action, detail = null, result = null }) {
        try {
            this.db.run(
                'INSERT INTO audit(ts, user_id, device_id, ip, action, detail, result) VALUES (?,?,?,?,?,?,?)',
                this.clock.now(), userId, deviceId, ip, action, encodeDetail(detail), result,
            );
        } catch (err) {
            if (!isBusyError(err)) throw err;
            this.queue.push({ kind: 'insert', row: { ts: this.clock.now(), userId, deviceId, ip, action, detail: encodeDetail(detail), result } });
        }
    }

    // Commands are queued and flushed in one transaction every 250 ms; the returned handle
    // lets the ack update the same row whether or not it has been flushed yet.
    queueCmd({ userId, deviceId, ip, detail }) {
        // Memory bound on the in-memory queue (e.g. while SQLite is busy). Over the cap the
        // command still goes through; only its row is dropped, counted and logged at flush.
        if (this.queue.length >= QUEUE_MAX) {
            this.dropped++;
            return null;
        }
        const handle = { rowId: null, row: { ts: this.clock.now(), userId, deviceId, ip, action: 'cmd', detail: { ...detail, status: 'forwarded' }, result: 'forwarded' } };
        this.queue.push({ kind: 'insert', handle, row: handle.row });
        return handle;
    }

    updateCmd(handle, { status, code }) {
        if (!handle) return;
        if (handle.rowId == null) {
            handle.row.detail = { ...handle.row.detail, status, code };
            handle.row.result = status;
            return;
        }
        this.queue.push({ kind: 'update', handle, status, code });
    }

    flush(tries = 0) {
        if (this.dropped > 0) {
            this.logger.warn('audit queue full; command rows dropped', { dropped: this.dropped });
            this.dropped = 0;
        }
        if (this.queue.length === 0 || !this.db.open) return;
        const batch = this.queue;
        this.queue = [];
        try {
            this.db.transaction(() => {
                for (const item of batch) {
                    if (item.kind === 'insert') {
                        const r = item.row;
                        const detail = typeof r.detail === 'string' ? r.detail : encodeDetail(r.detail);
                        const res = this.db.run(
                            'INSERT INTO audit(ts, user_id, device_id, ip, action, detail, result) VALUES (?,?,?,?,?,?,?)',
                            r.ts, r.userId, r.deviceId, r.ip, r.action, detail, r.result,
                        );
                        if (item.handle) item.handle.pendingRowId = res.lastInsertRowid;
                    } else {
                        const rowId = item.handle.rowId;
                        const row = this.db.get('SELECT detail FROM audit WHERE id = ?', rowId);
                        if (!row) continue;
                        let detail = {};
                        try { detail = JSON.parse(row.detail) || {}; } catch (_) { /* keep empty */ }
                        detail.status = item.status;
                        detail.code = item.code;
                        this.db.run('UPDATE audit SET detail = ?, result = ? WHERE id = ?', encodeDetail(detail), item.status, rowId);
                    }
                }
            });
            for (const item of batch) {
                if (item.handle && item.handle.pendingRowId != null) {
                    item.handle.rowId = item.handle.pendingRowId;
                    delete item.handle.pendingRowId;
                }
            }
        } catch (err) {
            for (const item of batch) if (item.handle) delete item.handle.pendingRowId;
            this.queue = batch.concat(this.queue);
            if (isBusyError(err) && tries < 20) {
                if (!this.retrying) {
                    this.retrying = true;
                    setTimeout(() => {
                        this.retrying = false;
                        this.flush(tries + 1);
                    }, 100).unref();
                }
                return;
            }
            this.logger.error('audit flush failed', { err });
            if (!isBusyError(err)) this.queue = [];
        }
    }

    // `before` alone is an exclusive ts bound. With `beforeId` too it is a
    // (ts, id) cursor, so paging never skips rows that share one millisecond.
    list({ deviceId, userId, onlyUserId, limit = 50, before, beforeId }) {
        const lim = Math.min(200, Math.max(1, Number(limit) || 50));
        const clauses = [];
        const params = [];
        if (deviceId) { clauses.push('device_id = ?'); params.push(deviceId); }
        if (userId) { clauses.push('user_id = ?'); params.push(userId); }
        if (onlyUserId) { clauses.push('user_id = ?'); params.push(onlyUserId); }
        const beforeTs = before != null && before !== '' && Number.isFinite(Number(before)) ? Number(before) : null;
        const cursorId = beforeId != null && beforeId !== '' && Number.isSafeInteger(Number(beforeId)) ? Number(beforeId) : null;
        if (beforeTs !== null && cursorId !== null) {
            clauses.push('(ts < ? OR (ts = ? AND id < ?))');
            params.push(beforeTs, beforeTs, cursorId);
        } else if (beforeTs !== null) {
            clauses.push('ts < ?');
            params.push(beforeTs);
        }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        return this.db.all(`SELECT id, ts, user_id, device_id, ip, action, detail, result FROM audit ${where} ORDER BY ts DESC, id DESC LIMIT ${lim}`, ...params);
    }

    async sweep(retentionDays) {
        const cutoff = this.clock.now() - retentionDays * 86400000;
        return this.db.deleteBatched('audit', 'ts < ?', [cutoff], { mono: this.clock.mono });
    }

    close() {
        clearInterval(this.timer);
        this.flush();
    }
}

module.exports = { Audit, encodeDetail, QUEUE_MAX };
