'use strict';

const {
    CLOSE, LIMITS, validateEnvelope, envelope, reportTopic, isPlainObject,
} = require('../protocol/envelope');
const { TokenBuckets } = require('../ratelimit');
const { newId } = require('../auth/tokens');
const { CAMERA_ID, MAX_CAMERAS } = require('../snapshots');
const { CONTROLLER_TYPES } = require('../auth/pairing');

const HEARTBEAT_MS = 5000;
const HELLO_TIMEOUT_MS = 10000;
const MOTION_LIVENESS_MS = 4000;
const LAST_SEEN_WRITE_MS = 60000;
const ERROR_THROTTLE_MS = 10000;
const HEX64 = /^[0-9a-f]{64}$/;
const ROTATE_ID = /^r_[a-z0-9]{12}$/;
// Relay->device backpressure. A healthy machine drains its socket continuously and never gets
// near these numbers; a machine that stops reading cannot receive a stop anyway, so liveness is
// judged on the send side too (not only lastRxAt, which a peer that pings but never reads keeps
// fresh). Above HIGH, droppable sends (over-budget untracked stops) are not queued; above HIGH
// for DEV_BP_CLOSE_AFTER_MS, or above HARD at any time, the link is treated as dead: it goes
// offline (pending cmds fail DEVICE_OFFLINE) and is terminated. The machine reconnects.
const DEV_BP_HIGH_BYTES = 1024 * 1024;
const DEV_BP_HARD_BYTES = 8 * 1024 * 1024;
const DEV_BP_CLOSE_AFTER_MS = 10000;

class DeviceHub {
    constructor(app) {
        this.app = app;
        this.clock = app.clock;
        this.logger = app.logger;
        this.conns = new Map(); // deviceId -> conn
        this.info = new Map(); // deviceId -> {controllerType, appVersion, cameras, since, online}
        this.cache = new Map(); // deviceId -> {state, tier}
        this.viewerCounts = new Map();
        const mono = this.clock.mono;
        this.stateBuckets = new TokenBuckets({ ratePerSec: 10, burst: 20, mono });
        this.otherBuckets = new TokenBuckets({ ratePerSec: 20, burst: 40, mono });
    }

    welcomeLimits() {
        const l = this.app.limits;
        return {
            textMaxBytes: LIMITS.deviceTextMaxBytes,
            binaryMaxBytes: LIMITS.deviceBinaryMaxBytes,
            cmdPerSec: 10,
            reportPerSec: 10,
            snapshotMaxBytes: l.snapshotMaxKb * 1024,
            snapshotMaxFps: l.snapshotMaxFps,
            maxUploadBytes: l.maxUploadMb * 1024 * 1024,
        };
    }

    isOnline(deviceId) {
        const c = this.conns.get(deviceId);
        return !!(c && c.hello && !c.dead);
    }

    accept(ws, device) {
        const deviceId = device.id;
        const now = this.clock.mono();
        const conn = {
            ws, deviceId, connId: newId('k_'), hello: false, dead: false, replaced: false,
            openedAt: now, lastRxAt: now, lastSeenWriteAt: now, lastErrorAt: new Map(), bpHighSince: null,
        };
        const existing = this.conns.get(deviceId);
        this.conns.set(deviceId, conn);
        if (existing) {
            existing.replaced = true;
            existing.dead = true;
            this.app.transfers.onDeviceOffline(deviceId);
            this.app.hubs.client.failPendingForDevice(deviceId, 'DEVICE_OFFLINE');
            try { existing.ws.close(CLOSE.REPLACED, 'replaced'); } catch (_) { /* already closing */ }
        }
        this._touchLastSeen(deviceId);

        ws.on('message', (data, isBinary) => {
            if (conn.dead) return;
            conn.lastRxAt = this.clock.mono();
            try {
                if (isBinary) this._onBinary(conn, data);
                else this._onText(conn, data);
            } catch (err) {
                this.logger.error('device message handler failed', { deviceId, err });
                this._close(conn, CLOSE.INTERNAL, 'internal');
            }
        });
        ws.on('close', () => this._onClose(conn));
        ws.on('error', (err) => this.logger.debug('device socket error', { deviceId, err: err && err.message }));
    }

    _send(conn, t, body, extra) {
        if (!conn || conn.dead || conn.ws.readyState !== 1) return false;
        const env = envelope(t, body, Object.assign({ ts: this.clock.now() }, extra));
        return this._write(conn, JSON.stringify(env), false);
    }

    // Single write path to a device socket; enforces the outbound buffer budget.
    _write(conn, text, droppable) {
        const buffered = conn.ws.bufferedAmount || 0;
        if (buffered > DEV_BP_HARD_BYTES) {
            this._killBackpressured(conn, buffered, true);
            return false;
        }
        if (droppable && buffered > DEV_BP_HIGH_BYTES) return false;
        conn.ws.send(text);
        return true;
    }

    // Called from inside command handling, so the offline bookkeeping (which fails pending
    // entries and fans out presence) is deferred: the caller still owns its pending entry and
    // settles it from our `false` return. The conn is marked dead now so nothing else is sent
    // and isOnline() is false immediately.
    _killBackpressured(conn, buffered, deferOffline) {
        if (conn.dead) return;
        this.logger.warn('device link not draining; terminating', { deviceId: conn.deviceId, bufferedBytes: buffered });
        conn.dead = true;
        try { conn.ws.terminate(); } catch (_) { /* ignore */ }
        if (deferOffline) setImmediate(() => this._goOffline(conn));
        else this._goOffline(conn);
    }

    send(deviceId, t, body, extra) {
        const conn = this.conns.get(deviceId);
        if (!conn || !conn.hello) return false;
        return this._send(conn, t, body, extra);
    }

    // opts.droppable: the envelope may be skipped (returns false) while the device's outbound
    // buffer is over budget. Used for over-budget untracked stops only.
    sendEnvelope(deviceId, env, opts) {
        const conn = this.conns.get(deviceId);
        if (!conn || !conn.hello || conn.dead || conn.ws.readyState !== 1) return false;
        return this._write(conn, JSON.stringify(env), !!(opts && opts.droppable));
    }

    _error(conn, code, message, refId = null, throttleKey = null) {
        if (throttleKey) {
            const last = conn.lastErrorAt.get(throttleKey);
            const now = this.clock.mono();
            if (last != null && now - last < ERROR_THROTTLE_MS) return;
            conn.lastErrorAt.set(throttleKey, now);
        }
        this._send(conn, 'error', { code, message, refId });
    }

    _close(conn, code, reason) {
        try { conn.ws.close(code, reason); } catch (_) { /* ignore */ }
    }

    _onBinary(conn, data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat([].concat(data));
        if (buf.length > LIMITS.deviceBinaryMaxBytes) {
            this._error(conn, 'BAD_ARGS', 'binary frame too large');
            this._close(conn, CLOSE.PROTOCOL, 'binary too large');
            return;
        }
        if (!conn.hello) {
            this._close(conn, CLOSE.PROTOCOL, 'hello required');
            return;
        }
        const reason = this.app.snapshots.acceptFrame(conn.deviceId, buf);
        if (reason) this._error(conn, 'SNAPSHOT_REJECTED', reason, null, 'snapshot');
    }

    _onText(conn, data) {
        const text = data.toString('utf8');
        if (Buffer.byteLength(text) > LIMITS.deviceTextMaxBytes) {
            this._error(conn, 'BAD_ARGS', 'text frame too large');
            this._close(conn, CLOSE.PROTOCOL, 'text too large');
            return;
        }
        let msg;
        try {
            msg = JSON.parse(text);
        } catch (_) {
            this._error(conn, 'BAD_ARGS', 'invalid json');
            this._close(conn, CLOSE.PROTOCOL, 'invalid json');
            return;
        }
        // Binding rule (§3.4.2): a device may only speak for its own authenticated id.
        if (isPlainObject(msg) && msg.topic != null && msg.topic !== reportTopic(conn.deviceId)) {
            this._error(conn, 'BAD_ARGS', 'topic not bound to this device', typeof msg.id === 'string' ? msg.id : null);
            this._close(conn, CLOSE.PROTOCOL, 'topic binding');
            return;
        }
        const v = validateEnvelope(msg);
        if (!v.ok) {
            this._error(conn, v.code, v.message, v.refId || null);
            if (v.code === 'BAD_VERSION') this._close(conn, CLOSE.PROTOCOL, 'bad version');
            return;
        }
        const body = msg.body || {};
        if (!conn.hello) {
            if (msg.t === 'hello') return this._onHello(conn, body);
            if (msg.t === 'ping') return this._onPing(conn, body);
            this._error(conn, 'BAD_ARGS', 'hello required', msg.id);
            this._close(conn, CLOSE.PROTOCOL, 'hello required');
            return;
        }
        switch (msg.t) {
            case 'hello': return this._onHello(conn, body);
            case 'ping': return this._onPing(conn, body);
            case 'pong': return undefined;
            case 'error':
                this.logger.warn('device reported error', { deviceId: conn.deviceId, code: body.code, message: body.message });
                return undefined;
            case 'report.state': return this._onReport(conn, msg, 'state', text);
            case 'report.tier': return this._onReport(conn, msg, 'tier', text);
            case 'cmd.ack': return this._onAck(conn, msg);
            case 'file.result':
                if (!this.otherBuckets.take(conn.deviceId)) return undefined;
                this.app.transfers.onResult(conn.deviceId, body);
                return undefined;
            case 'camera.error': return this._onCameraError(conn, msg);
            case 'cred.rotated': return this._onRotated(conn, body);
            default:
                this._error(conn, 'UNKNOWN_COMMAND', 'unexpected type', msg.id);
                return undefined;
        }
    }

    _onPing(conn, body) {
        this._send(conn, 'pong', { nonce: body.nonce, sentAt: body.sentAt, recvAt: this.clock.now() });
    }

    _onHello(conn, body) {
        const p = body.protocol;
        if (!isPlainObject(p) || !Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min > 1 || p.max < 1) {
            this._error(conn, 'BAD_VERSION', 'protocol 1 required');
            this._close(conn, CLOSE.PROTOCOL, 'protocol');
            return;
        }
        const controllerType = CONTROLLER_TYPES.includes(body.controllerType) ? body.controllerType : null;
        const appVersion = typeof body.appVersion === 'string' ? body.appVersion.slice(0, 40) : null;
        const cameras = Array.isArray(body.cameras)
            ? body.cameras.filter((c) => isPlainObject(c) && typeof c.id === 'string' && CAMERA_ID.test(c.id))
                .slice(0, MAX_CAMERAS).map((c) => ({ id: c.id, name: typeof c.name === 'string' ? c.name.slice(0, 60) : c.id }))
            : [];
        const deviceId = conn.deviceId;
        const first = !conn.hello;
        const prevInfo = this.info.get(deviceId);
        const since = first ? this.clock.now() : (prevInfo ? prevInfo.since : this.clock.now());
        this.info.set(deviceId, { controllerType, appVersion, cameras, since, online: true });
        try {
            this.app.db.run('UPDATE devices SET controller_type = ?, app_version = ?, last_seen_at = ? WHERE id = ?', controllerType, appVersion, this.clock.now(), deviceId);
        } catch (err) {
            this.logger.warn('device hello update failed', { err });
        }
        if (first) {
            conn.hello = true;
            this._send(conn, 'welcome', {
                serverTime: this.clock.now(), connId: conn.connId, deviceId, heartbeatMs: HEARTBEAT_MS,
                limits: this.welcomeLimits(), user: null,
            });
            this.app.audit.write({ deviceId, action: 'device.online', detail: { controllerType, appVersion } });
            const viewers = this.viewerCounts.get(deviceId) || 0;
            this._send(conn, 'viewers', { count: viewers });
            this._maybeRotate(conn);
            this.app.transfers.offerPending(deviceId);
        }
        this.app.hubs.client.fanout(deviceId, this.presenceEnvelope(deviceId));
    }

    presenceBody(deviceId) {
        const info = this.info.get(deviceId);
        const online = this.isOnline(deviceId);
        if (info) {
            return { online, since: info.since, controllerType: info.controllerType, appVersion: info.appVersion, cameras: online ? info.cameras : [] };
        }
        const row = this.app.db.get('SELECT controller_type, app_version, last_seen_at FROM devices WHERE id = ?', deviceId);
        return {
            online, since: row ? row.last_seen_at : null, controllerType: row ? row.controller_type : null,
            appVersion: row ? row.app_version : null, cameras: [],
        };
    }

    presenceEnvelope(deviceId) {
        return envelope('presence', this.presenceBody(deviceId), { topic: reportTopic(deviceId), ts: this.clock.now() });
    }

    cached(deviceId) {
        return this.cache.get(deviceId) || { state: null, tier: null };
    }

    cachedTierIsMotion(deviceId) {
        const c = this.cache.get(deviceId);
        return !!(c && c.tier && c.tier.body && c.tier.body.tier === 'motion');
    }

    _onReport(conn, msg, kind, text) {
        const deviceId = conn.deviceId;
        if (kind === 'state') {
            if (Buffer.byteLength(text) > LIMITS.reportStateMaxBytes + 1024) {
                this._error(conn, 'BAD_ARGS', 'report.state too large', msg.id, 'state-size');
                return;
            }
            if (!this.stateBuckets.take(deviceId)) {
                this._error(conn, 'RATE_LIMITED', 'report.state rate', null, 'state-rate');
                return;
            }
        } else if (!this.otherBuckets.take(deviceId)) {
            return;
        }
        const env = Object.assign({}, msg, { topic: reportTopic(deviceId), via: null });
        let entry = this.cache.get(deviceId);
        if (!entry) {
            entry = { state: null, tier: null };
            this.cache.set(deviceId, entry);
        }
        const prev = entry[kind];
        entry[kind] = env;
        this.app.hubs.client.fanout(deviceId, env, { replaceKey: msg.t });

        // §3.4.6 re-offer triggers: tier rises to job/motion, or a job ends.
        const body = msg.body || {};
        if (kind === 'tier') {
            const rank = (t) => (t === 'motion' ? 2 : t === 'job' ? 1 : 0);
            const before = prev && prev.body ? rank(prev.body.tier) : 0;
            if (rank(body.tier) > before && rank(body.tier) >= 1) this.app.transfers.offerPending(deviceId);
        } else {
            const wasActive = !!(prev && prev.body && prev.body.job && prev.body.job.active);
            const isActive = !!(body.job && body.job.active);
            if (wasActive && !isActive) this.app.transfers.offerPending(deviceId);
        }
    }

    _onAck(conn, msg) {
        const matched = this.app.hubs.client.routeAck(conn.deviceId, msg);
        if (!matched) {
            this.otherBuckets.take(conn.deviceId);
            this.logger.debug('unmatched ack dropped', { deviceId: conn.deviceId });
        }
    }

    _onCameraError(conn, msg) {
        if (!this.otherBuckets.take(conn.deviceId)) return;
        const body = msg.body || {};
        const clean = {
            cameraId: typeof body.cameraId === 'string' ? body.cameraId.slice(0, 40) : null,
            code: typeof body.code === 'string' ? body.code.slice(0, 32) : 'NO_FRAME',
            message: typeof body.message === 'string' ? body.message.slice(0, 200) : null,
        };
        const env = envelope('camera.error', clean, { topic: reportTopic(conn.deviceId), ts: this.clock.now() });
        this.app.hubs.client.fanout(conn.deviceId, env, { replaceKey: 'camera.error' });
    }

    _maybeRotate(conn) {
        const days = this.app.limits.credRotateDays;
        if (!days) return;
        const row = this.app.db.get('SELECT cred_created_at, pending_rotate_id FROM devices WHERE id = ?', conn.deviceId);
        if (!row || row.pending_rotate_id) return;
        if (this.clock.now() - row.cred_created_at > days * 86400000) this.requestRotation(conn.deviceId);
    }

    requestRotation(deviceId) {
        const conn = this.conns.get(deviceId);
        if (!conn || !conn.hello || conn.dead) return false;
        const rotateId = newId('r_');
        this.app.db.run('UPDATE devices SET pending_rotate_id = ?, pending_since = ? WHERE id = ?', rotateId, this.clock.now(), deviceId);
        this._send(conn, 'cred.rotate', { rotateId });
        return true;
    }

    _onRotated(conn, body) {
        if (!this.otherBuckets.take(conn.deviceId)) return;
        const rotateId = body.rotateId;
        const hash = body.newCredentialHash;
        if (typeof rotateId !== 'string' || !ROTATE_ID.test(rotateId) || typeof hash !== 'string' || !HEX64.test(hash)) {
            this._error(conn, 'BAD_ARGS', 'bad cred.rotated');
            return;
        }
        let ok = false;
        try {
            ok = this.app.db.transaction(() => {
                const row = this.app.db.get('SELECT credential_hash, pending_rotate_id FROM devices WHERE id = ?', conn.deviceId);
                if (!row || row.pending_rotate_id !== rotateId) return false;
                if (hash === row.credential_hash) return false;
                const clash = this.app.db.get(
                    'SELECT 1 AS x FROM devices WHERE credential_hash = ? OR previous_credential_hash = ? UNION SELECT 1 FROM revoked_credentials WHERE credential_hash = ? UNION SELECT 1 FROM pairings WHERE credential_hash = ?',
                    hash, hash, hash, hash,
                );
                if (clash) return false;
                const now = this.clock.now();
                this.app.db.run(
                    `UPDATE devices SET previous_credential_hash = credential_hash, credential_hash = ?, pending_rotate_id = NULL,
                     pending_since = NULL, rotated_at = ?, cred_created_at = ? WHERE id = ?`,
                    hash, now, now, conn.deviceId,
                );
                return true;
            });
        } catch (err) {
            this.logger.error('credential rotation failed', { deviceId: conn.deviceId, err });
            ok = false;
        }
        if (!ok) {
            this._error(conn, 'BAD_ARGS', 'rotation rejected');
            return;
        }
        this.app.audit.write({ deviceId: conn.deviceId, action: 'device.rotate' });
        this._send(conn, 'cred.commit', { rotateId });
    }

    _touchLastSeen(deviceId) {
        try {
            this.app.db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', this.clock.now(), deviceId);
        } catch (err) {
            this.logger.debug('last_seen update failed', { err: err.message });
        }
    }

    _onClose(conn) {
        if (conn.replaced) return;
        this._goOffline(conn);
    }

    _goOffline(conn) {
        if (conn.offlineHandled) return;
        conn.offlineHandled = true;
        conn.dead = true;
        const deviceId = conn.deviceId;
        if (this.conns.get(deviceId) !== conn) return;
        this.conns.delete(deviceId);
        const wasOnline = conn.hello;
        this._touchLastSeen(deviceId);
        const info = this.info.get(deviceId);
        if (info) {
            info.online = false;
            info.since = this.clock.now();
        }
        const entry = this.cache.get(deviceId);
        if (entry) entry.tier = null;
        this.app.hubs.client.failPendingForDevice(deviceId, 'DEVICE_OFFLINE');
        this.app.transfers.onDeviceOffline(deviceId);
        this.app.snapshots.dropDevice(deviceId);
        if (wasOnline) {
            this.app.audit.write({ deviceId, action: 'device.offline' });
            this.app.hubs.client.fanout(deviceId, this.presenceEnvelope(deviceId));
        }
    }

    setViewers(deviceId, count) {
        const prev = this.viewerCounts.get(deviceId) || 0;
        if (count === prev) return;
        if (count === 0) this.viewerCounts.delete(deviceId);
        else this.viewerCounts.set(deviceId, count);
        this.send(deviceId, 'viewers', { count });
        if (count === 0) {
            for (const demand of this.app.snapshots.stopDemand(deviceId)) this.send(deviceId, 'camera.demand', demand);
        }
    }

    // Owner unpair or machine self-unpair: close with 4401 revoked (§4.4.4).
    revoke(deviceId) {
        const conn = this.conns.get(deviceId);
        if (conn) {
            this._goOffline(conn);
            this._close(conn, CLOSE.AUTH, 'revoked');
        }
        this.info.delete(deviceId);
        this.cache.delete(deviceId);
        this.viewerCounts.delete(deviceId);
    }

    tick() {
        const now = this.clock.mono();
        for (const conn of [...this.conns.values()]) {
            if (conn.dead) continue;
            if (!conn.hello && now - conn.openedAt > HELLO_TIMEOUT_MS) {
                this._goOffline(conn);
                this._close(conn, CLOSE.HELLO_TIMEOUT, 'hello timeout');
                continue;
            }
            const c = this.cache.get(conn.deviceId);
            const fast = !!(c && c.tier && c.tier.body && (c.tier.body.tier === 'motion' || c.tier.body.activeJog));
            const windowMs = fast ? MOTION_LIVENESS_MS : Math.max(3 * HEARTBEAT_MS, 15000);
            if (now - conn.lastRxAt > windowMs) {
                this.logger.info('device link dead', { deviceId: conn.deviceId, silentMs: Math.round(now - conn.lastRxAt) });
                this._goOffline(conn);
                try { conn.ws.terminate(); } catch (_) { /* ignore */ }
                continue;
            }
            // Send-side liveness: a peer that keeps pinging but never reads is also dead.
            const buffered = conn.ws.bufferedAmount || 0;
            if (buffered > DEV_BP_HIGH_BYTES) {
                if (conn.bpHighSince == null) conn.bpHighSince = now;
                if (buffered > DEV_BP_HARD_BYTES || now - conn.bpHighSince >= DEV_BP_CLOSE_AFTER_MS) {
                    this._killBackpressured(conn, buffered, false);
                    continue;
                }
            } else {
                conn.bpHighSince = null;
            }
            if (now - conn.lastSeenWriteAt >= LAST_SEEN_WRITE_MS) {
                conn.lastSeenWriteAt = now;
                this._touchLastSeen(conn.deviceId);
            }
        }
    }

    sweepRotations() {
        const cutoff = this.clock.now() - 5 * 60000;
        this.app.db.run('UPDATE devices SET pending_rotate_id = NULL, pending_since = NULL WHERE pending_rotate_id IS NOT NULL AND pending_since <= ?', cutoff);
    }

    closeAll(code, reason) {
        for (const conn of [...this.conns.values()]) {
            this._goOffline(conn);
            this._close(conn, code, reason);
        }
    }

    lastRxAt(deviceId) {
        const c = this.conns.get(deviceId);
        return c ? c.lastRxAt : null;
    }
}

module.exports = {
    DeviceHub, HEARTBEAT_MS, DEV_BP_HIGH_BYTES, DEV_BP_HARD_BYTES, DEV_BP_CLOSE_AFTER_MS,
};
