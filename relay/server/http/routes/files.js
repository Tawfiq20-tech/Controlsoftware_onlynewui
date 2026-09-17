'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { HttpError, httpError, sendJson } = require('../router');
const { WindowLimiter } = require('../../ratelimit');
const { newId } = require('../../auth/tokens');
const { requireRole } = require('./devices');

const MiB = 1024 * 1024;
const ALLOWED_EXT = ['.nc', '.gcode', '.ngc', '.tap', '.txt', '.cnc'];
const MAX_OFFERED = 2;
const STORED_BLOB_TTL_MS = 3600000;
const NEVER_CONNECTED_TTL_MS = 24 * 3600000;
const ROW_RETENTION_MS = 90 * 86400000;
const EARLY_DRAIN_MS = 5000;
const TRANSFER_ID =/^x_[a-z0-9]{12}$/;
const RESULT_REJECTED = ['HASH_MISMATCH', 'TOO_LARGE', 'BAD_TYPE', 'NOT_UTF8', 'NO_SPACE', 'INTERNAL'];
const RESULT_DEFERRED = ['DOWNLOAD_FAILED', 'BUSY', 'TIER_REQUIRED', 'LAN_ONLY'];

function validateName(raw) {
    if (typeof raw !== 'string') return { error: 'bad_name' };
    const base = raw.split(/[\\/]/).pop().trim();
    if (base.length < 1 || base.length > 120 || base === '.' || base === '..' || /[\x00-\x1f]/.test(base)) return { error: 'bad_name' };
    const dot = base.lastIndexOf('.');
    const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
    if (!ALLOWED_EXT.includes(ext)) return { error: 'bad_type' };
    return { name: base };
}

function transferView(app, row) {
    const u = app.db.get('SELECT display_name FROM users WHERE id = ?', row.user_id);
    return {
        transferId: row.id, name: row.name, size: row.size, sha256: row.sha256, status: row.status, code: row.code,
        libraryId: row.library_id, uploadedBy: { userId: row.user_id, userLabel: u ? u.display_name : null },
        createdAt: row.created_at, updatedAt: row.updated_at,
    };
}

class TransferManager {
    constructor(app) {
        this.app = app;
    }

    broadcast(row, statusOverride) {
        this.app.hubs.client.notifyDevice(row.device_id, 'file.status', {
            transferId: row.id, deviceId: row.device_id, name: row.name, status: statusOverride || row.status,
            code: row.code || 'OK', libraryId: row.library_id || null,
        });
    }

    offerPending(deviceId, { exclude = null } = {}) {
        const app = this.app;
        if (!app.hubs.device.isOnline(deviceId)) return 0;
        const offered = app.db.get("SELECT COUNT(*) AS n FROM transfers WHERE device_id = ? AND status = 'offered'", deviceId).n;
        let room = MAX_OFFERED - offered;
        if (room <= 0) return 0;
        const rows = app.db.all(
            "SELECT * FROM transfers WHERE device_id = ? AND status = 'pending' AND blob_deleted = 0 ORDER BY created_at ASC, rowid ASC LIMIT 10",
            deviceId,
        );
        let sent = 0;
        for (const row of rows) {
            if (room <= 0) break;
            if (exclude && exclude === row.id) continue;
            const u = app.db.get('SELECT display_name FROM users WHERE id = ?', row.user_id);
            const ok = app.hubs.device.send(deviceId, 'file.offer', {
                transferId: row.id, name: row.name, size: row.size, sha256: row.sha256,
                uploadedBy: { userId: row.user_id, userLabel: u ? u.display_name : null }, createdAt: row.created_at,
            });
            if (!ok) break;
            const now = app.clock.now();
            app.db.run("UPDATE transfers SET status = 'offered', updated_at = ? WHERE id = ?", now, row.id);
            this.broadcast(Object.assign({}, row, { status: 'offered', updated_at: now }));
            room--;
            sent++;
        }
        return sent;
    }

    onResult(deviceId, body) {
        const app = this.app;
        const transferId = body && body.transferId;
        if (typeof transferId !== 'string' || !TRANSFER_ID.test(transferId)) return;
        const row = app.db.get('SELECT * FROM transfers WHERE id = ?', transferId);
        // Binding: a device may only settle its own transfers (§3.4.6).
        if (!row || row.device_id !== deviceId) {
            app.logger.warn('file.result for a transfer not owned by this device dropped', { deviceId });
            return;
        }
        if (row.status !== 'offered' && row.status !== 'pending') return;
        const status = body.status;
        const now = app.clock.now();
        if (status === 'stored') {
            const libraryId = typeof body.libraryId === 'string' ? body.libraryId.slice(0, 64) : null;
            app.db.run("UPDATE transfers SET status = 'stored', code = 'OK', library_id = ?, updated_at = ? WHERE id = ?", libraryId, now, row.id);
        } else if (status === 'rejected') {
            const code = RESULT_REJECTED.includes(body.code) ? body.code : 'INTERNAL';
            app.db.run("UPDATE transfers SET status = 'rejected', code = ?, updated_at = ? WHERE id = ?", code, now, row.id);
        } else if (status === 'deferred') {
            const code = RESULT_DEFERRED.includes(body.code) ? body.code : 'BUSY';
            app.db.run("UPDATE transfers SET status = 'pending', code = ?, updated_at = ? WHERE id = ?", code, now, row.id);
        } else {
            return;
        }
        const updated = app.db.get('SELECT * FROM transfers WHERE id = ?', row.id);
        this.broadcast(updated, status === 'deferred' ? 'deferred' : null);
        app.audit.write({ userId: row.user_id, deviceId, action: 'file.result', detail: { transferId: row.id, status, code: updated.code } });
        this.offerPending(deviceId, { exclude: status === 'deferred' ? row.id : null });
    }

    onDeviceOffline(deviceId) {
        this.app.db.run("UPDATE transfers SET status = 'pending', updated_at = ? WHERE device_id = ? AND status = 'offered'", this.app.clock.now(), deviceId);
    }

    async sweep() {
        const app = this.app;
        const now = app.clock.now();
        const ttl = app.limits.fileTtlDays * 86400000;
        const expire = app.db.all(
            `SELECT t.* FROM transfers t JOIN devices d ON d.id = t.device_id
              WHERE t.status IN ('pending','offered') AND (t.created_at <= ? OR (d.last_seen_at IS NULL AND t.created_at <= ?))
              LIMIT 1000`,
            now - ttl, now - NEVER_CONNECTED_TTL_MS,
        );
        for (const row of expire) {
            app.blobs.delete(row.id);
            app.db.run("UPDATE transfers SET status = 'expired', blob_deleted = 1, updated_at = ? WHERE id = ?", now, row.id);
            this.broadcast(Object.assign({}, row, { status: 'expired', updated_at: now }));
        }
        const done = app.db.all(
            "SELECT id FROM transfers WHERE blob_deleted = 0 AND ((status IN ('stored','rejected') AND updated_at <= ?) OR status = 'expired') LIMIT 1000",
            now - STORED_BLOB_TTL_MS,
        );
        for (const row of done) {
            app.blobs.delete(row.id);
            app.db.run('UPDATE transfers SET blob_deleted = 1 WHERE id = ?', row.id);
        }
        await app.db.deleteBatched('transfers', 'created_at <= ?', [now - ROW_RETENTION_MS], { mono: app.clock.mono });
        return { expired: expire.length, blobsDeleted: done.length };
    }
}

function register(router, app) {
    const uploadsPerUser = new WindowLimiter({ limit: 20, windowMs: 3600000, mono: app.clock.mono });
    // Bytes of uploads that passed the limit checks but have no transfers row yet. Rows are
    // only inserted after the body is streamed, so parallel uploads would otherwise all pass
    // the quota, total and free-disk checks at once.
    const reserved = { total: 0, byUser: new Map() };
    const reserve = (userId, size) => {
        reserved.total += size;
        reserved.byUser.set(userId, (reserved.byUser.get(userId) || 0) + size);
        let done = false;
        return () => {
            if (done) return;
            done = true;
            reserved.total -= size;
            const left = reserved.byUser.get(userId) - size;
            if (left > 0) reserved.byUser.set(userId, left);
            else reserved.byUser.delete(userId);
        };
    };

    // Answers an upload that was refused before its body was read. Closing straight away would
    // leave the client's body unread in the socket, so the close turns into a TCP reset and the
    // client sees a network error instead of the JSON error. The response is written at once but
    // only ended once the body has been drained (never stored, never counted), bounded by the
    // declared length capped at the upload limit and by EARLY_DRAIN_MS (or the upload idle
    // timeout, if shorter), so a client that stalls or never stops sending cannot hold the socket.
    function rejectBeforeBody(ctx, err) {
        const { req, res } = ctx;
        const body = JSON.stringify(Object.assign({ error: err.code }, err.extra || {}));
        if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'close');
        res.statusCode = err.status;
        res.write(body);
        const declared = Number(req.headers['content-length']);
        const cap = app.limits.maxUploadMb * MiB;
        const limit = Number.isFinite(declared) ? Math.min(declared, cap) : cap;
        let drained = 0;
        let done = false;
        const finish = (graceful) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            req.removeListener('data', onData);
            if (graceful) res.end();
            else res.destroy();
        };
        const onData = (chunk) => {
            drained += chunk.length;
            // Past the limit, stop reading instead of closing: a reset now could still discard the
            // response on the client. TCP backpressure stalls the sender until the timer closes.
            if (drained > limit) req.pause();
        };
        const timer = setTimeout(() => finish(false), Math.min(EARLY_DRAIN_MS, app.limits.transferIdleMs || 60000));
        res.on('close', () => clearTimeout(timer));
        req.on('data', onData);
        req.on('error', () => finish(false));
        if (req.readableEnded) finish(true);
        else req.once('end', () => finish(true));
        req.resume();
    }

    router.add('PUT', '/api/devices/:id/files', async (ctx) => {
        let u;
        try {
            u = checkUpload(ctx);
        } catch (err) {
            if (!(err instanceof HttpError)) throw err;
            rejectBeforeBody(ctx, err);
            return;
        }
        const release = reserve(ctx.user.id, u.size);
        try {
            await receiveUpload(ctx, u.deviceId, u.name, u.size, u.expectHash);
        } finally {
            release();
        }
    }, { auth: 'session', body: 'raw', streaming: true });

    function checkUpload(ctx) {
        const { req } = ctx;
        const deviceId = ctx.params.id;
        requireRole(app, ctx, 'operator');
        const v = validateName(ctx.query.get('name'));
        if (v.error) throw httpError(400, v.error);
        const lenHeader = req.headers['content-length'];
        if (lenHeader === undefined || !/^\d+$/.test(String(lenHeader))) throw httpError(411, 'length_required');
        const size = Number(lenHeader);
        if (size > app.limits.maxUploadMb * MiB) throw httpError(413, 'too_large');
        if (size < 1) throw httpError(400, 'empty');
        const expectHash = req.headers['x-content-sha256'];
        if (expectHash !== undefined && !/^[0-9a-fA-F]{64}$/.test(String(expectHash))) throw httpError(400, 'bad_sha256');

        const used = app.db.get("SELECT COALESCE(SUM(size), 0) AS n FROM transfers WHERE user_id = ? AND blob_deleted = 0 AND status != 'expired'", ctx.user.id).n;
        const userReserved = reserved.byUser.get(ctx.user.id) || 0;
        if (used + userReserved + size > app.limits.userQuotaMb * MiB) throw httpError(413, 'quota');
        const total = app.db.get("SELECT COALESCE(SUM(size), 0) AS n FROM transfers WHERE blob_deleted = 0 AND status != 'expired'").n;
        if (total + reserved.total + size > app.limits.totalStorageMb * MiB) throw httpError(507, 'insufficient_storage');
        if (app.blobs.freeBytes() - reserved.total - size < app.limits.minFreeDiskMb * MiB) throw httpError(507, 'insufficient_storage');
        if (!uploadsPerUser.tryHit(ctx.user.id)) throw httpError(429, 'rate_limited');

        return { deviceId, name: v.name, size, expectHash };
    }

    async function receiveUpload(ctx, deviceId, name, size, expectHash) {
        const { req, res } = ctx;
        const transferId = newId('x_');
        const tmp = app.blobs.tmpPath(transferId);
        const fd = fs.openSync(tmp, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        let received = 0;
        let failed = null;
        app.inflight++;
        const idleMs = app.limits.transferIdleMs || 60000;
        let idleTimer = null;

        const result = await new Promise((resolve) => {
            const out = fs.createWriteStream(null, { fd, autoClose: false });
            const fail = (status, code) => {
                if (failed) return;
                failed = { status, code };
                clearTimeout(idleTimer);
                req.unpipe(out);
                req.pause();
                resolve(failed);
            };
            const armIdle = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => fail(408, 'timeout'), idleMs);
            };
            armIdle();
            req.on('data', (chunk) => {
                if (failed) return;
                received += chunk.length;
                if (received > size) return fail(413, 'too_large');
                hash.update(chunk);
                armIdle();
                return undefined;
            });
            req.on('aborted', () => fail(400, 'aborted'));
            req.on('error', () => fail(400, 'aborted'));
            out.on('error', () => fail(500, 'internal'));
            req.pipe(out);
            req.on('end', () => {
                if (failed) return;
                out.end(() => {
                    clearTimeout(idleTimer);
                    if (failed) return;
                    resolve(received === size ? null : { status: 400, code: 'incomplete' });
                });
            });
        });

        try {
            if (result) {
                try { fs.closeSync(fd); } catch (_) { /* already closed */ }
                app.blobs.discardTmp(transferId);
                if (!res.headersSent) sendJson(res, result.status, { error: result.code }, { Connection: 'close' });
                setImmediate(() => req.destroy());
                return;
            }
            // The grant or the device may have gone while the body streamed.
            const role = app.acl.role(ctx.user.id, deviceId);
            if (!role || !app.acl.atLeast(role, 'operator')) {
                try { fs.closeSync(fd); } catch (_) { /* already closed */ }
                app.blobs.discardTmp(transferId);
                throw httpError(404, 'not_found');
            }
            try {
                await app.blobs.commit(transferId, fd);
            } catch (err) {
                app.blobs.discardTmp(transferId);
                app.blobs.delete(transferId);
                throw err;
            }
            const digest = hash.digest('hex');
            if (expectHash !== undefined && digest !== String(expectHash).toLowerCase()) {
                app.blobs.delete(transferId);
                throw httpError(400, 'hash_mismatch');
            }
            const now = app.clock.now();
            try {
                app.db.run(
                    "INSERT INTO transfers(id, device_id, user_id, name, size, sha256, status, created_at, updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)",
                    transferId, deviceId, ctx.user.id, name, size, digest, now, now,
                );
            } catch (err) {
                // No row will ever reference this blob (e.g. the device was unpaired while the
                // body streamed and the foreign key failed), so the retention sweep cannot find it.
                app.blobs.delete(transferId);
                if (!app.db.get("SELECT 1 AS x FROM devices WHERE id = ? AND status = 'active'", deviceId)) throw httpError(404, 'not_found');
                throw err;
            }
            const row = app.db.get('SELECT * FROM transfers WHERE id = ?', transferId);
            app.audit.write({ userId: ctx.user.id, deviceId, ip: ctx.ip, action: 'file.upload', detail: { transferId, name, size } });
            app.transfers.broadcast(row);
            app.transfers.offerPending(deviceId);
            const fresh = app.db.get('SELECT * FROM transfers WHERE id = ?', transferId);
            ctx.json(201, { transfer: transferView(app, fresh) });
        } finally {
            app.inflight--;
        }
    }

    router.add('GET', '/api/devices/:id/files', (ctx) => {
        requireRole(app, ctx, 'viewer');
        const rows = app.db.all('SELECT * FROM transfers WHERE device_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50', ctx.params.id);
        ctx.json(200, rows.map((r) => transferView(app, r)));
    }, { auth: 'session' });

    router.add('DELETE', '/api/devices/:id/files/:transferId', (ctx) => {
        const role = requireRole(app, ctx, 'operator');
        const row = app.db.get('SELECT * FROM transfers WHERE id = ? AND device_id = ?', ctx.params.transferId, ctx.params.id);
        if (!row) throw httpError(404, 'not_found');
        if (role !== 'owner' && row.user_id !== ctx.user.id) throw httpError(403, 'forbidden');
        app.blobs.delete(row.id);
        const now = app.clock.now();
        const status = row.status === 'stored' || row.status === 'rejected' ? row.status : 'expired';
        app.db.run('UPDATE transfers SET status = ?, blob_deleted = 1, updated_at = ? WHERE id = ?', status, now, row.id);
        app.transfers.broadcast(Object.assign({}, row, { status, updated_at: now }));
        app.audit.write({ userId: ctx.user.id, deviceId: ctx.params.id, ip: ctx.ip, action: 'file.delete', detail: { transferId: row.id } });
        ctx.json(204);
    }, { auth: 'session' });
}

module.exports = { register, TransferManager, validateName, transferView, ALLOWED_EXT };
