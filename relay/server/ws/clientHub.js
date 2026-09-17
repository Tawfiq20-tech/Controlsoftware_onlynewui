'use strict';

const {
    CLOSE, LIMITS, validateEnvelope, validateCmdBody, clampTtl, envelope, reportTopic, requestTopic, newMessageId,
    isPlainObject,
} = require('../protocol/envelope');
const { TokenBuckets } = require('../ratelimit');
const { newId } = require('../auth/tokens');

const HEARTBEAT_MS = 5000;
const FAST_PING_MS = 1000;
const FAST_AFTER_MOTION_MS = 60000;
const PONG_DEADLINE_MS = 15000;
const RTT_STALE_MS = 3000;
const ACK_TIMEOUT_MS = 5000;
const KEEPALIVE_PENDING_MS = 1000;
const IDEM_MAX = 500;
const IDEM_TTL_MS = 10 * 60000;
const BP_REPLACE_BYTES = 256 * 1024;
const BP_CLOSE_BYTES = 1024 * 1024;
const BP_CLOSE_AFTER_MS = 10000;
const OTHER_SUSTAIN_CLOSE_MS = 10000;
const STOP_DUP_WINDOW_MS = 100;
// Stops are always forwarded (§3.7), but per-command bookkeeping (pending entry, ack routing,
// audit row) is only paid for stops within these budgets. Beyond them a stop is forwarded
// untracked and counted into one coalesced audit row per connection+device per second, so a
// flood cannot grow memory, the audit queue or the DB without bound.
const STOP_TRACK_USER_PER_SEC = 100;
const STOP_OVERFLOW_AUDIT_MS = 1000;
// Forward-rate ceiling for over-budget stops per connection. Beyond it, a stop is coalesced
// with the last forwarded stop of the same type to the same device (any args) when that was
// less than STOP_DUP_WINDOW_MS ago, so every stop TYPE still reaches the machine at least
// every 100 ms while the flood cannot become an unbounded forward/CPU/memory sink.
const STOP_OVERFLOW_PER_SEC = 200;
const STOP_OVERFLOW_BURST = 400;
const LAST_STOPS_MAX = 2048;
const MAX_SUBSCRIPTIONS = 20;
const WARMUP_PINGS = 3;
const WARMUP_GAP_MS = 200;

class ClientHub {
    constructor(app) {
        this.app = app;
        this.clock = app.clock;
        this.logger = app.logger;
        this.conns = new Map(); // connId -> conn
        this.byToken = new Map(); // tokenHash -> Set<conn>
        this.byUser = new Map(); // userId -> Set<conn>
        this.subscribers = new Map(); // deviceId -> Set<conn>
        this.pending = new Map(); // deviceId|refId -> entry
        this.idem = new Map(); // userId|deviceId -> Map(idem -> {ack, inflightKey, at})
        const mono = this.clock.mono;
        this.cmdBuckets = new TokenBuckets({ ratePerSec: 10, burst: 20, mono });
        this.stopBuckets = new TokenBuckets({ ratePerSec: 50, burst: 50, mono });
        this.stopOverflowBuckets = new TokenBuckets({ ratePerSec: STOP_OVERFLOW_PER_SEC, burst: STOP_OVERFLOW_BURST, mono });
        this.stopTrackUserBuckets = new TokenBuckets({ ratePerSec: STOP_TRACK_USER_PER_SEC, burst: STOP_TRACK_USER_PER_SEC, mono });
        this.keepaliveBuckets = new TokenBuckets({ ratePerSec: 20, burst: 30, mono });
        this.pingBuckets = new TokenBuckets({ ratePerSec: 10, burst: 10, mono });
        this.otherBuckets = new TokenBuckets({ ratePerSec: 5, burst: 10, mono });
        this.userBuckets = new TokenBuckets({ ratePerSec: 30, burst: 30, mono });
    }

    accept(ws, { session, user, ip }) {
        const now = this.clock.mono();
        const conn = {
            ws, connId: newId('k_'), userId: user.id,
            user: { id: user.id, displayName: user.display_name, email: user.email },
            tokenHash: session.tokenHash, ip,
            subs: new Set(), lastSeq: 0, commanded: new Set(),
            rtt: [], rttAt: null, pinnedRtt: null, pings: new Map(), lastPingAt: -Infinity,
            fastUntil: 0, otherLimitedSince: null, lastStops: new Map(), lastStopTypes: new Map(),
            stopOverflow: new Map(), stopOverflowAt: now,
            queued: new Map(), bpHighSince: null, closed: false, timers: [],
            openedAt: now,
        };
        this.conns.set(conn.connId, conn);
        addToIndex(this.byToken, conn.tokenHash, conn);
        addToIndex(this.byUser, conn.userId, conn);

        ws.on('message', (data, isBinary) => {
            if (conn.closed) return;
            try {
                this._onMessage(conn, data, isBinary);
            } catch (err) {
                this.logger.error('client message handler failed', { err });
                this._closeConn(conn, CLOSE.INTERNAL, 'internal', 'closed');
            }
        });
        ws.on('close', () => this._cleanup(conn, 'closed'));
        ws.on('error', (err) => this.logger.debug('client socket error', { err: err && err.message }));

        this._send(conn, 'welcome', {
            serverTime: this.clock.now(), connId: conn.connId, deviceId: null, heartbeatMs: HEARTBEAT_MS,
            limits: Object.assign(this.app.hubs.device.welcomeLimits(), { textMaxBytes: LIMITS.clientTextMaxBytes }),
            user: conn.user,
        });
        this._sendPing(conn);
        for (let i = 1; i < WARMUP_PINGS; i++) {
            const t = setTimeout(() => this._sendPing(conn), WARMUP_GAP_MS * i);
            conn.timers.push(t);
        }
        return conn;
    }

    _send(conn, t, body, extra) {
        if (conn.closed || conn.ws.readyState !== 1) return false;
        const env = envelope(t, body, Object.assign({ ts: this.clock.now() }, extra));
        conn.ws.send(JSON.stringify(env));
        return true;
    }

    _sendRaw(conn, data) {
        if (conn.closed || conn.ws.readyState !== 1) return false;
        conn.ws.send(data);
        return true;
    }

    _sendPing(conn) {
        if (conn.closed || conn.ws.readyState !== 1) return;
        const nonce = newMessageId('p_');
        const now = this.clock.mono();
        conn.pings.set(nonce, now);
        if (conn.pings.size > 20) conn.pings.delete(conn.pings.keys().next().value);
        conn.lastPingAt = now;
        this._send(conn, 'ping', { nonce, sentAt: this.clock.now() });
    }

    _error(conn, code, message, refId = null) {
        this._send(conn, 'error', { code, message, refId });
    }

    _onMessage(conn, data, isBinary) {
        if (isBinary) {
            this._closeConn(conn, CLOSE.PROTOCOL, 'binary not allowed', 'closed');
            return;
        }
        const text = data.toString('utf8');
        if (Buffer.byteLength(text) > LIMITS.clientTextMaxBytes) {
            this._closeConn(conn, CLOSE.PROTOCOL, 'text too large', 'closed');
            return;
        }
        let msg;
        try {
            msg = JSON.parse(text);
        } catch (_) {
            if (this._takeOther(conn)) this._error(conn, 'BAD_ARGS', 'invalid json');
            return;
        }
        const v = validateEnvelope(msg);
        if (!v.ok) {
            if (v.code === 'BAD_VERSION') {
                this._error(conn, 'BAD_VERSION', v.message, v.refId || null);
                this._closeConn(conn, CLOSE.PROTOCOL, 'bad version', 'closed');
                return;
            }
            if (isPlainObject(msg) && msg.t === 'cmd' && v.refId) {
                this._reject(conn, msg, v.code, v.message);
                return;
            }
            if (this._takeOther(conn)) this._error(conn, v.code, v.message, v.refId || null);
            return;
        }
        switch (msg.t) {
            case 'ping':
                if (!this.pingBuckets.take(conn.connId)) return;
                this._send(conn, 'pong', { nonce: msg.body && msg.body.nonce, sentAt: msg.body && msg.body.sentAt, recvAt: this.clock.now() });
                return;
            case 'pong':
                this._onPong(conn, msg.body || {});
                return;
            case 'cmd':
                this._onCmd(conn, msg);
                return;
            case 'subscribe':
                if (!this._takeOther(conn)) return;
                this._onSubscribe(conn, msg.body || {});
                return;
            default:
                if (this._takeOther(conn)) this._error(conn, 'UNKNOWN_COMMAND', 'unexpected type', msg.id);
        }
    }

    _takeOther(conn) {
        const now = this.clock.mono();
        if (this.otherBuckets.take(conn.connId)) {
            conn.otherLimitedSince = null;
            return true;
        }
        if (conn.otherLimitedSince == null) conn.otherLimitedSince = now;
        if (now - conn.otherLimitedSince >= OTHER_SUSTAIN_CLOSE_MS) {
            this._closeConn(conn, CLOSE.RATE_LIMITED, 'rate limited', 'closed');
            return false;
        }
        this._error(conn, 'RATE_LIMITED', 'too many messages');
        return false;
    }

    _onPong(conn, body) {
        const sent = conn.pings.get(body.nonce);
        if (sent == null) return;
        const now = this.clock.mono();
        for (const [nonce, at] of conn.pings) {
            if (at <= sent) conn.pings.delete(nonce);
        }
        conn.rtt.push(now - sent);
        if (conn.rtt.length > 3) conn.rtt.shift();
        conn.rttAt = now;
    }

    // Max of the last 3 samples, or null when the newest sample is older than 3 s.
    clientRtt(conn) {
        if (conn.pinnedRtt != null) return { ms: conn.pinnedRtt, fresh: true };
        if (conn.rttAt == null || conn.rtt.length === 0) return { ms: null, fresh: false };
        const ms = Math.round(Math.max(...conn.rtt));
        return { ms, fresh: this.clock.mono() - conn.rttAt <= RTT_STALE_MS };
    }

    _onSubscribe(conn, body) {
        const ids = body.deviceIds;
        if (!Array.isArray(ids) || ids.length > MAX_SUBSCRIPTIONS || !ids.every((x) => typeof x === 'string')) {
            this._error(conn, 'BAD_ARGS', 'deviceIds must be an array of up to 20 ids');
            return;
        }
        const allowed = [];
        const denied = [];
        for (const id of [...new Set(ids)]) {
            if (this.app.acl.role(conn.userId, id)) allowed.push(id);
            else denied.push(id);
        }
        const next = new Set(allowed);
        for (const id of conn.subs) if (!next.has(id)) this._unsubscribe(conn, id);
        for (const id of next) {
            if (conn.subs.has(id)) continue;
            conn.subs.add(id);
            addToIndex(this.subscribers, id, conn);
            this.app.hubs.device.setViewers(id, this.subscribers.get(id).size);
        }
        this._send(conn, 'subscribed', { deviceIds: allowed, denied });
        for (const id of allowed) {
            const device = this.app.hubs.device;
            this._sendRaw(conn, JSON.stringify(device.presenceEnvelope(id)));
            const cached = device.cached(id);
            if (cached.state) this._sendRaw(conn, JSON.stringify(cached.state));
            if (cached.tier) this._sendRaw(conn, JSON.stringify(cached.tier));
        }
    }

    _unsubscribe(conn, deviceId) {
        if (!conn.subs.delete(deviceId)) return;
        removeFromIndex(this.subscribers, deviceId, conn);
        for (const key of [...conn.queued.keys()]) if (key.startsWith(deviceId + '|')) conn.queued.delete(key);
        const set = this.subscribers.get(deviceId);
        this.app.hubs.device.setViewers(deviceId, set ? set.size : 0);
    }

    _ack(deviceId, refId, idem, type, status, code, message) {
        return envelope('cmd.ack', {
            refId, idem: idem || null, type: type || null, status, code, message: message || null, duplicate: false, at: this.clock.now(),
        }, { topic: deviceId ? reportTopic(deviceId) : null, ts: this.clock.now() });
    }

    _reject(conn, msg, code, message, status = 'rejected') {
        const body = isPlainObject(msg.body) ? msg.body : {};
        let deviceId = null;
        const m = typeof msg.topic === 'string' && /^device\/(d_[a-z0-9]{12})\/request$/.exec(msg.topic);
        if (m) deviceId = m[1];
        const env = this._ack(deviceId, msg.id, typeof body.idem === 'string' ? body.idem : null, typeof body.type === 'string' ? body.type : null, status, code, message);
        this._sendRaw(conn, JSON.stringify(env));
    }

    _idemMap(userId, deviceId) {
        const key = userId + '|' + deviceId;
        let m = this.idem.get(key);
        if (!m) {
            m = new Map();
            this.idem.set(key, m);
        }
        return m;
    }

    _onCmd(conn, msg) {
        const app = this.app;
        const now = this.clock.now();
        const mono = this.clock.mono();

        // 1. schema
        const c = validateCmdBody(msg);
        if (!c.ok) return this._reject(conn, msg, c.code, c.message);
        const { deviceId, type, cls } = c;
        const body = msg.body;
        const keepalive = type === 'jog.cont.keepalive';

        // 2. session (in-memory) + ACL
        if (!app.sessions.isValid(conn.tokenHash)) {
            this._reject(conn, msg, 'ACL_DENIED', 'session invalid');
            this._closeConn(conn, CLOSE.AUTH, 'session-revoked', 'session-revoked');
            return undefined;
        }
        const role = app.acl.role(conn.userId, deviceId);
        if (!role || !app.acl.allowsCls(role, cls)) return this._reject(conn, msg, 'ACL_DENIED', null);

        // 3. online
        if (!app.hubs.device.isOnline(deviceId)) return this._reject(conn, msg, 'DEVICE_OFFLINE', null);

        // 4. rate limits; STOP has its own bucket and is never refused (§3.7)
        let tracked = true;
        if (cls === 'stop') {
            const sig = type + '|' + JSON.stringify(body.args);
            // Entries are kept in insertion (= time) order, so pruning stops at the first fresh one.
            for (const [k, at] of conn.lastStops) {
                if (mono - at <= STOP_DUP_WINDOW_MS) break;
                conn.lastStops.delete(k);
            }
            const dup = conn.lastStops.has(sig);
            if (dup) conn.lastStops.delete(sig);
            if (dup || conn.lastStops.size < LAST_STOPS_MAX) conn.lastStops.set(sig, mono);
            const inBucket = this.stopBuckets.take(conn.connId);
            if (!inBucket && dup) return undefined;
            if (!inBucket && !this.stopOverflowBuckets.take(conn.connId)) {
                const lastOfType = conn.lastStopTypes.get(deviceId + '|' + type);
                if (lastOfType != null && mono - lastOfType < STOP_DUP_WINDOW_MS) return undefined;
            }
            tracked = inBucket && this.stopTrackUserBuckets.take(conn.userId);
        } else if (keepalive) {
            if (!this.keepaliveBuckets.take(conn.connId)) return undefined;
        } else {
            if (!this.cmdBuckets.take(conn.connId)) return this._reject(conn, msg, 'RATE_LIMITED', null);
            if (!this.userBuckets.take(conn.userId)) return this._reject(conn, msg, 'RATE_LIMITED', null);
        }

        // 5. replay
        if (body.seq <= conn.lastSeq) return this._reject(conn, msg, 'REPLAY', null);
        conn.lastSeq = body.seq;

        // 6. freshness
        const ttlMs = clampTtl(cls, type, body.ttlMs);
        const issuedAt = body.unsynced === true ? now : body.issuedAt;
        if (issuedAt > now + 2000) return this._reject(conn, msg, 'BAD_ARGS', 'issuedAt in the future');
        if (now - issuedAt > ttlMs) return this._reject(conn, msg, 'EXPIRED', null);

        // 7. idempotency (never for STOP or keepalives)
        const useIdem = cls !== 'stop' && !keepalive;
        let idemMap = null;
        if (useIdem) {
            idemMap = this._idemMap(conn.userId, deviceId);
            const hit = idemMap.get(body.idem);
            if (hit && mono - hit.at > IDEM_TTL_MS) idemMap.delete(body.idem);
            else if (hit && hit.ack) {
                const dupBody = Object.assign({}, hit.ack, { refId: msg.id, duplicate: true });
                this._sendRaw(conn, JSON.stringify(envelope('cmd.ack', dupBody, { topic: reportTopic(deviceId), ts: now })));
                return undefined;
            } else if (hit && hit.inflightKey && this.pending.has(hit.inflightKey)) {
                this.pending.get(hit.inflightKey).extra.push({ connId: conn.connId, refId: msg.id });
                return undefined;
            }
        }

        // 8. forward
        if (cls === 'motion') conn.fastUntil = mono + FAST_AFTER_MOTION_MS;
        const rtt = this.clientRtt(conn);
        let clientRttMs = rtt.ms;
        if (cls === 'motion' && !rtt.fresh) {
            clientRttMs = null;
            this._sendPing(conn);
        }
        // An untracked (over-budget) stop skips the per-command DB read as well.
        const user = tracked ? app.db.get('SELECT display_name FROM users WHERE id = ?', conn.userId) : null;
        const via = {
            userId: conn.userId,
            userLabel: user ? user.display_name : conn.user.displayName,
            role,
            connId: conn.connId,
            sessionRef: 's' + conn.tokenHash.slice(0, 5),
            relayTs: now,
            clientRttMs,
            clientSeq: body.seq,
        };
        const fwd = {
            v: 1, t: 'cmd', id: msg.id, ts: Number.isInteger(msg.ts) ? msg.ts : now, topic: requestTopic(deviceId),
            cls, enc: 'none', kid: null, via,
            body: Object.assign({}, body, { ttlMs, issuedAt }),
        };
        const key = deviceId + '|' + msg.id;
        if (this.pending.has(key)) return this._reject(conn, msg, 'REPLAY', 'duplicate envelope id');
        if (cls === 'stop') {
            const tkey = deviceId + '|' + type;
            conn.lastStopTypes.delete(tkey);
            conn.lastStopTypes.set(tkey, mono);
            while (conn.lastStopTypes.size > LAST_STOPS_MAX) conn.lastStopTypes.delete(conn.lastStopTypes.keys().next().value);
        }
        if (!tracked) {
            // Forwarded without a pending entry: no ack is routed back and no per-command audit row.
            // Droppable: while the device's outbound buffer is over budget it is not draining, and
            // queueing more copies only grows relay memory (the tracked stops already went out).
            conn.commanded.add(deviceId);
            if (app.hubs.device.sendEnvelope(deviceId, fwd, { droppable: true })) {
                conn.stopOverflow.set(deviceId, (conn.stopOverflow.get(deviceId) || 0) + 1);
            }
            return undefined;
        }
        const entry = {
            key, deviceId, refId: msg.id, connId: conn.connId, userId: conn.userId, type, cls, keepalive,
            idem: useIdem ? body.idem : null, extra: [],
            expiresAt: mono + (keepalive ? KEEPALIVE_PENDING_MS : ACK_TIMEOUT_MS),
            auditHandle: keepalive ? null : app.audit.queueCmd({ userId: conn.userId, deviceId, ip: conn.ip, detail: { type, cls, args: body.args } }),
        };
        this.pending.set(key, entry);
        if (useIdem) {
            idemMap.set(body.idem, { ack: null, inflightKey: key, at: mono });
            while (idemMap.size > IDEM_MAX) idemMap.delete(idemMap.keys().next().value);
        }
        conn.commanded.add(deviceId);
        if (!app.hubs.device.sendEnvelope(deviceId, fwd)) {
            this._finishPending(entry, null, { status: 'failed', code: 'DEVICE_OFFLINE', message: null });
        }
        return undefined;
    }

    // Routes a machine-produced ack ONLY to the originating connection (§3.4.4).
    routeAck(deviceId, msg) {
        const body = msg.body || {};
        if (typeof body.refId !== 'string') return false;
        const entry = this.pending.get(deviceId + '|' + body.refId);
        if (!entry || entry.deviceId !== deviceId) return false;
        this._finishPending(entry, body, null);
        return true;
    }

    _finishPending(entry, machineBody, synthetic) {
        this.pending.delete(entry.key);
        const now = this.clock.now();
        const topic = reportTopic(entry.deviceId);
        let ackBody;
        if (machineBody) {
            ackBody = Object.assign({}, machineBody, { refId: entry.refId });
        } else {
            ackBody = {
                refId: entry.refId, idem: entry.idem, type: entry.type, status: synthetic.status, code: synthetic.code,
                message: synthetic.message, duplicate: false, at: now,
            };
        }
        const conn = this.conns.get(entry.connId);
        if (conn) this._sendRaw(conn, JSON.stringify(envelope('cmd.ack', ackBody, { topic, ts: now })));
        for (const x of entry.extra) {
            const c2 = this.conns.get(x.connId);
            if (c2) this._sendRaw(c2, JSON.stringify(envelope('cmd.ack', Object.assign({}, ackBody, { refId: x.refId, duplicate: true }), { topic, ts: now })));
        }
        if (entry.idem) {
            const m = this.idem.get(entry.userId + '|' + entry.deviceId);
            if (m) {
                if (machineBody) {
                    const cachedAck = Object.assign({}, machineBody);
                    delete cachedAck.refId;
                    m.set(entry.idem, { ack: cachedAck, inflightKey: null, at: this.clock.mono() });
                } else {
                    const cur = m.get(entry.idem);
                    if (cur && cur.inflightKey === entry.key) m.delete(entry.idem);
                }
            }
        }
        if (entry.auditHandle) {
            this.app.audit.updateCmd(entry.auditHandle, { status: ackBody.status, code: ackBody.code });
        }
    }

    failPendingForDevice(deviceId, code) {
        for (const entry of [...this.pending.values()]) {
            if (entry.deviceId !== deviceId) continue;
            if (entry.keepalive) {
                this.pending.delete(entry.key);
                continue;
            }
            this._finishPending(entry, null, { status: 'failed', code, message: null });
        }
    }

    // The command was already forwarded and the machine may still execute it, so the entry
    // stays until the real ack (or the 5 s expiry) settles the audit row. Only the route back
    // to the client is cut.
    _dropPendingForConn(conn, deviceId = null) {
        for (const entry of this.pending.values()) {
            if (entry.connId !== conn.connId) continue;
            if (deviceId && entry.deviceId !== deviceId) continue;
            entry.connId = null;
        }
    }

    // Fan-out of device reports. Reports are latest-only per (device, type) while the
    // socket is backed up; control messages are never replaced (§3.4.3).
    fanout(deviceId, env, { replaceKey = null } = {}) {
        const set = this.subscribers.get(deviceId);
        if (!set || set.size === 0) return;
        const data = JSON.stringify(env);
        const qKey = replaceKey ? deviceId + '|' + replaceKey : null;
        for (const conn of set) {
            if (conn.closed || conn.ws.readyState !== 1) continue;
            if (qKey && conn.ws.bufferedAmount > BP_REPLACE_BYTES) {
                // Delete first so a re-queued key moves to the end and flushes in arrival order.
                conn.queued.delete(qKey);
                conn.queued.set(qKey, data);
                continue;
            }
            // A newer report supersedes the queued copy; flushing that copy later would
            // leave the client showing stale state (e.g. an old Motion tier).
            if (qKey) conn.queued.delete(qKey);
            conn.ws.send(data);
        }
    }

    _closeConn(conn, code, reason, goneReason) {
        if (conn.closed) return;
        this._cleanup(conn, goneReason);
        try { conn.ws.close(code, reason); } catch (_) { /* ignore */ }
        // A peer that never answers the close frame must not keep the socket alive.
        const t = setTimeout(() => {
            try { conn.ws.terminate(); } catch (_) { /* ignore */ }
        }, 2000);
        t.unref();
    }

    _cleanup(conn, goneReason) {
        if (conn.closed) return;
        conn.closed = true;
        for (const t of conn.timers) clearTimeout(t);
        this.conns.delete(conn.connId);
        removeFromIndex(this.byToken, conn.tokenHash, conn);
        removeFromIndex(this.byUser, conn.userId, conn);
        for (const id of [...conn.subs]) this._unsubscribe(conn, id);
        this._flushStopOverflow(conn);
        this._dropPendingForConn(conn);
        for (const deviceId of conn.commanded) {
            this.app.hubs.device.send(deviceId, 'client.gone', { connId: conn.connId, userId: conn.userId, reason: goneReason });
        }
        conn.commanded.clear();
        for (const b of [this.cmdBuckets, this.stopBuckets, this.stopOverflowBuckets, this.keepaliveBuckets, this.pingBuckets, this.otherBuckets]) b.delete(conn.connId);
    }

    // One coalesced audit row per device for the stops this connection sent over budget.
    _flushStopOverflow(conn) {
        conn.stopOverflowAt = this.clock.mono();
        if (conn.stopOverflow.size === 0) return;
        const counts = [...conn.stopOverflow];
        conn.stopOverflow.clear();
        for (const [deviceId, count] of counts) {
            try {
                this.app.audit.write({
                    userId: conn.userId, deviceId, ip: conn.ip, action: 'cmd',
                    detail: { type: 'stop-class', cls: 'stop', status: 'forwarded', untracked: count }, result: 'forwarded',
                });
            } catch (err) {
                this.logger.warn('stop overflow audit failed', { err });
            }
        }
    }

    closeTokenHashes(hashes, reason) {
        const goneReason = reason === 'user-disabled' ? 'user-disabled' : 'session-revoked';
        for (const h of hashes) {
            const set = this.byToken.get(h);
            if (!set) continue;
            for (const conn of [...set]) this._closeConn(conn, CLOSE.AUTH, goneReason, goneReason);
        }
    }

    closeUser(userId, reason) {
        const set = this.byUser.get(userId);
        if (!set) return;
        for (const conn of [...set]) this._closeConn(conn, CLOSE.AUTH, reason, reason);
    }

    onGrantRemoved(userId, deviceId) {
        const set = this.byUser.get(userId);
        if (!set) return;
        for (const conn of [...set]) {
            this._unsubscribe(conn, deviceId);
            this._dropPendingForConn(conn, deviceId);
            if (conn.commanded.delete(deviceId)) {
                this.app.hubs.device.send(deviceId, 'client.gone', { connId: conn.connId, userId, reason: 'grant-removed' });
            }
            this._send(conn, 'device.removed', { deviceId }, { topic: reportTopic(deviceId) });
        }
    }

    onDeviceRemoved(deviceId) {
        const set = this.subscribers.get(deviceId);
        const targets = set ? [...set] : [];
        for (const entry of [...this.pending.values()]) {
            if (entry.deviceId === deviceId) this._finishPending(entry, null, { status: 'failed', code: 'DEVICE_OFFLINE', message: 'device removed' });
        }
        for (const conn of targets) {
            conn.subs.delete(deviceId);
            conn.commanded.delete(deviceId);
            this._send(conn, 'device.removed', { deviceId }, { topic: reportTopic(deviceId) });
        }
        this.subscribers.delete(deviceId);
        for (const [key] of this.idem) if (key.endsWith('|' + deviceId)) this.idem.delete(key);
    }

    // User-facing push that is not a report (file.status); never replaced under backpressure.
    notifyDevice(deviceId, t, body) {
        this.fanout(deviceId, envelope(t, body, { topic: reportTopic(deviceId), ts: this.clock.now() }));
    }

    tick() {
        const mono = this.clock.mono();
        for (const entry of [...this.pending.values()]) {
            if (mono < entry.expiresAt) continue;
            if (entry.keepalive) this.pending.delete(entry.key);
            else this._finishPending(entry, null, { status: 'failed', code: 'INTERNAL', message: 'no ack' });
        }
        const device = this.app.hubs.device;
        for (const conn of [...this.conns.values()]) {
            if (conn.closed) continue;
            if (mono - conn.stopOverflowAt >= STOP_OVERFLOW_AUDIT_MS) this._flushStopOverflow(conn);
            if (!this.app.sessions.isValid(conn.tokenHash)) {
                this._closeConn(conn, CLOSE.AUTH, 'session-revoked', 'session-revoked');
                continue;
            }
            let oldestPing = null;
            for (const at of conn.pings.values()) oldestPing = oldestPing == null ? at : Math.min(oldestPing, at);
            if (oldestPing != null && mono - oldestPing > PONG_DEADLINE_MS) {
                this._closeConn(conn, CLOSE.GOING_AWAY, 'pong timeout', 'closed');
                continue;
            }
            let fast = mono < conn.fastUntil;
            if (!fast) for (const id of conn.subs) if (device.cachedTierIsMotion(id)) { fast = true; break; }
            if (mono - conn.lastPingAt >= (fast ? FAST_PING_MS : HEARTBEAT_MS)) this._sendPing(conn);

            const buffered = conn.ws.bufferedAmount;
            if (conn.queued.size > 0 && buffered <= BP_REPLACE_BYTES) {
                const items = [...conn.queued.values()];
                conn.queued.clear();
                for (const data of items) this._sendRaw(conn, data);
            }
            if (buffered > BP_CLOSE_BYTES) {
                if (conn.bpHighSince == null) conn.bpHighSince = mono;
                else if (mono - conn.bpHighSince >= BP_CLOSE_AFTER_MS) this._closeConn(conn, CLOSE.GOING_AWAY, 'backpressure', 'closed');
            } else {
                conn.bpHighSince = null;
            }
        }
        for (const [key, m] of this.idem) {
            for (const [k, v] of m) if (mono - v.at > IDEM_TTL_MS && !v.inflightKey) m.delete(k);
            if (m.size === 0) this.idem.delete(key);
        }
    }

    closeAll(code, reason) {
        for (const conn of [...this.conns.values()]) this._closeConn(conn, code, reason, 'closed');
    }

    setRtt(connId, ms) {
        const conn = this.conns.get(connId);
        if (!conn) return false;
        conn.pinnedRtt = ms;
        conn.rttAt = this.clock.mono();
        return true;
    }

    conn(connId) {
        return this.conns.get(connId) || null;
    }
}

function addToIndex(map, key, value) {
    let set = map.get(key);
    if (!set) {
        set = new Set();
        map.set(key, set);
    }
    set.add(value);
}

function removeFromIndex(map, key, value) {
    const set = map.get(key);
    if (!set) return;
    set.delete(value);
    if (set.size === 0) map.delete(key);
}

module.exports = { ClientHub };
