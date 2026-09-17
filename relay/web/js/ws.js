// The single /ws/client socket (SPEC §3, §8.2): reconnect, liveness, clock
// sync, per-socket seq and command/ack correlation. Commands are never queued.

import { createClockSync } from './core/clock.js';
import { createLinkWatchdog } from './core/link.js';
import {
    ACK_TIMEOUT_MS, CLOSE, MAX_SUBSCRIPTIONS, PROTOCOL_VERSION, T, TTL_DEFAULT, TTL_MAX,
    commandCls, newId, requestTopic,
} from './protocol.js';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const PING_INTERVAL_MS = 5000;
const RESYNC_INTERVAL_MS = 60000;
const RATE_LIMIT_MIN_MS = 30000;
// A socket that has not produced a welcome by then is treated as dead (a phone on
// a switched network can sit in CONNECTING for the OS TCP timeout).
const WELCOME_TIMEOUT_MS = 10000;
// On a resume event a socket younger than this is still a legitimate handshake.
const RESUME_GRACE_MS = 2000;

export function clientNow() {
    return performance.timeOrigin + performance.now();
}

export class CmdError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

export function createWsClient({
    path = '/ws/client',
    WebSocketImpl = globalThis.WebSocket,
    onAuthLost = () => {},
    probeAuth = null,
} = {}) {
    const listeners = new Map();
    const pending = new Map();      // envelope id -> {timer, resolve, reject, deviceId}
    let ws = null;
    let welcomed = false;
    let everOpened = false;
    let wantOpen = false;
    let attempt = 0;
    let seq = 0;
    let reconnectTimer = null;
    let welcomeTimer = null;
    let socketStartedAt = 0;
    let pingTimer = null;
    let resyncTimer = null;
    let immediateReconnect = false;
    let welcome = null;
    let subscriptions = [];
    let lastStatusKey = '';

    const clock = createClockSync({
        now: clientNow,
        send: (msg) => sendFrame(msg.t, msg.body, { id: newId('p_') }),
        onChange: () => emitStatus(),
    });

    const watchdog = createLinkWatchdog({
        now: clientNow,
        send: (msg) => sendFrame(msg.t, msg.body, { id: newId('p_') }),
        close: (reason) => dropSocket(reason),
        onChange: () => emitStatus(),
    });

    function on(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
        return () => listeners.get(type).delete(fn);
    }

    function emit(type, payload) {
        const set = listeners.get(type);
        if (!set) return;
        for (const fn of Array.from(set)) {
            try { fn(payload); } catch (err) { console.error('[ws] listener', type, err); }
        }
    }

    function url() {
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return scheme + '//' + location.host + path;
    }

    function isOpen() {
        return !!ws && ws.readyState === 1 && welcomed;
    }

    function getStatus() {
        let state = 'closed';
        if (ws && ws.readyState === 0) state = 'connecting';
        else if (ws && ws.readyState === 1) state = welcomed ? 'open' : 'connecting';
        else if (wantOpen) state = 'reconnecting';
        return {
            state,
            live: isOpen() && watchdog.isLive(),
            synced: clock.isSynced(),
            clientRttMs: clock.rttMs(),
            connId: welcome ? welcome.connId : null,
            user: welcome ? welcome.user : null,
            limits: welcome ? welcome.limits : null,
        };
    }

    function emitStatus() {
        const st = getStatus();
        const key = [st.state, st.live, st.synced, st.clientRttMs, st.connId].join('|');
        if (key === lastStatusKey) return;
        lastStatusKey = key;
        emit('status', st);
    }

    function sendFrame(t, body, { id, topic = null, cls = null } = {}) {
        if (!ws || ws.readyState !== 1) return false;
        const frame = {
            v: PROTOCOL_VERSION,
            t,
            id: id || newId('m_'),
            ts: Math.round(clock.nowSynced()),
            topic,
            cls,
            enc: 'none',
            kid: null,
            via: null,
            body,
        };
        try {
            ws.send(JSON.stringify(frame));
            return true;
        } catch (_) {
            return false;
        }
    }

    function clearTimers() {
        if (welcomeTimer !== null) { clearTimeout(welcomeTimer); welcomeTimer = null; }
        if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
        if (resyncTimer !== null) { clearInterval(resyncTimer); resyncTimer = null; }
    }

    function connect() {
        wantOpen = true;
        if (ws) return;
        if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        open();
    }

    function open() {
        reconnectTimer = null;
        if (!wantOpen || ws) return;
        let sock;
        try {
            sock = new WebSocketImpl(url());
        } catch (err) {
            scheduleReconnect({ code: 1006, reason: 'constructor' }, false);
            return;
        }
        ws = sock;
        welcomed = false;
        everOpened = false;
        welcome = null;
        seq = 0;
        socketStartedAt = Date.now();
        clock.resetSocket();
        if (welcomeTimer !== null) clearTimeout(welcomeTimer);
        welcomeTimer = setTimeout(() => {
            welcomeTimer = null;
            if (sock === ws && !welcomed) dropSocket('connect-timeout');
        }, WELCOME_TIMEOUT_MS);
        sock.onopen = () => {
            if (sock !== ws) return;
            everOpened = true;
            emitStatus();
        };
        sock.onmessage = (ev) => {
            if (sock !== ws) return;
            handleMessage(ev.data);
        };
        sock.onerror = () => { /* a close event always follows */ };
        sock.onclose = (ev) => {
            if (sock !== ws) return;
            handleClose({ code: ev.code, reason: ev.reason });
        };
        emitStatus();
    }

    function handleMessage(data) {
        if (typeof data !== 'string') return;
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
        watchdog.onFrame(msg);
        const body = msg.body && typeof msg.body === 'object' ? msg.body : {};

        switch (msg.t) {
        case T.WELCOME:
            onWelcome(body);
            return;
        case T.PING:
            sendFrame(T.PONG, {
                nonce: body.nonce,
                sentAt: body.sentAt,
                recvAt: Math.round(clock.nowSynced()),
            }, { id: newId('p_') });
            return;
        case T.PONG:
            clock.onPong(body);
            emitStatus();
            return;
        case T.CMD_ACK:
            deliverAck(body);
            return;
        case T.ERROR:
            emit('error', body);
            return;
        default:
            emit('message', msg);
        }
    }

    function onWelcome(body) {
        welcomed = true;
        welcome = body;
        attempt = 0;
        clearTimers();
        watchdog.start();
        // Offsets from an earlier socket may predate a suspension; measure afresh.
        clock.resetSocket();
        clock.startBurst();
        pingTimer = setInterval(() => { if (isOpen()) clock.ping(); }, PING_INTERVAL_MS);
        resyncTimer = setInterval(() => { if (isOpen()) clock.startBurst(); }, RESYNC_INTERVAL_MS);
        if (subscriptions.length) sendFrame(T.SUBSCRIBE, { deviceIds: subscriptions });
        emit('open', body);
        emitStatus();
    }

    function deliverAck(body) {
        if (typeof body.refId !== 'string') return;
        const entry = pending.get(body.refId);
        if (entry) {
            clearTimeout(entry.timer);
            pending.delete(body.refId);
        }
        emit('ack', body);
        if (entry && entry.resolve) entry.resolve(body);
    }

    function failPending(code, message) {
        const entries = Array.from(pending.entries());
        pending.clear();
        for (const [refId, entry] of entries) {
            clearTimeout(entry.timer);
            const ack = { refId, status: 'failed', code, message, local: true };
            emit('ack', ack);
            if (entry.reject) entry.reject(new CmdError(code, message));
        }
    }

    // Watchdog verdict or logout: forget the socket now instead of waiting for a
    // closing handshake that a half-open connection will never complete.
    function dropSocket(reason) {
        const sock = ws;
        if (!sock) return;
        immediateReconnect = true;
        sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
        try { sock.close(1000, String(reason || '').slice(0, 60)); } catch (_) { /* already closing */ }
        handleClose({ code: 1006, reason: reason || 'dropped' });
    }

    function handleClose(ev) {
        const opened = everOpened;
        ws = null;
        welcomed = false;
        watchdog.stop();
        clock.cancelBurst();
        clearTimers();
        failPending('DEVICE_OFFLINE', 'connection lost');
        emit('close', ev);
        emitStatus();

        if (ev.code === CLOSE.AUTH) {
            wantOpen = false;
            immediateReconnect = false;
            emitStatus();
            onAuthLost(ev.reason || 'session-revoked');
            return;
        }
        if (!wantOpen) return;
        scheduleReconnect(ev, opened);
    }

    async function scheduleReconnect(ev, opened) {
        if (reconnectTimer !== null) return;
        if (immediateReconnect) {
            immediateReconnect = false;
            attempt = 0;
            reconnectTimer = setTimeout(open, 0);
            return;
        }
        let delay = Math.max(BACKOFF_MIN_MS, Math.random() * Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt));
        attempt += 1;
        if (ev.code === CLOSE.RATE_LIMITED) delay = Math.max(delay, RATE_LIMIT_MIN_MS);

        // A browser cannot read the status of a refused upgrade. When the socket
        // never opened, ask the REST API why (expired session, rate limit).
        reconnectTimer = -1;
        if (!opened && probeAuth) {
            try {
                const r = await probeAuth();
                if (r && r.status === 401) {
                    reconnectTimer = null;
                    wantOpen = false;
                    emitStatus();
                    onAuthLost('unauthorized');
                    return;
                }
                if (r && r.retryAfterSec > 0) delay = Math.max(delay, r.retryAfterSec * 1000);
            } catch (_) { /* offline: plain backoff */ }
        }
        if (!wantOpen) { reconnectTimer = null; return; }
        reconnectTimer = setTimeout(open, delay);
        emitStatus();
    }

    function disconnect() {
        wantOpen = false;
        immediateReconnect = false;
        if (reconnectTimer !== null && reconnectTimer !== -1) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        subscriptions = [];
        if (ws) {
            const sock = ws;
            sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
            try { sock.close(1000, 'logout'); } catch (_) { /* ignore */ }
            handleClose({ code: 1000, reason: 'logout' });
        }
        emitStatus();
    }

    // visibilitychange->visible, pageshow, online. `suspended` is true when the
    // page may have been frozen (hidden, or restored from the back/forward cache):
    // the clock offset is then untrustworthy until fresh pongs arrive.
    function onResume({ suspended = false } = {}) {
        if (!wantOpen) return;
        if (isOpen()) {
            if (suspended) clock.invalidate();
            watchdog.probe();
            clock.startBurst();
            return;
        }
        if (ws) {
            // Stuck handshake or open-but-unwelcomed socket: do not wait for the
            // browser's TCP timeout while STOP is grey.
            if (Date.now() - socketStartedAt >= RESUME_GRACE_MS || Date.now() < socketStartedAt) dropSocket('resume-not-open');
            return;
        }
        if (reconnectTimer !== null && reconnectTimer !== -1) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        attempt = 0;
        open();
    }

    function setSubscriptions(ids) {
        const unique = Array.from(new Set((ids || []).filter((id) => typeof id === 'string'))).slice(0, MAX_SUBSCRIPTIONS);
        subscriptions = unique;
        if (isOpen()) sendFrame(T.SUBSCRIBE, { deviceIds: unique });
    }

    // Returns null when sent, otherwise the local rejection code.
    function trySendCmd(deviceId, cmd, resolve, reject) {
        const cls = commandCls(cmd.type);
        if (!cls || (cmd.cls && cmd.cls !== cls)) return 'UNKNOWN_COMMAND';
        if (!isOpen()) return 'DEVICE_OFFLINE';
        const synced = clock.isSynced();
        if (!synced && cls !== 'stop') return 'NOT_SYNCED';

        const id = cmd.id || newId(cmd.type.startsWith('jog.') ? 'j_' : 'c_');
        const isKeepalive = cmd.type === 'jog.cont.keepalive';
        // An unsynced stop is re-stamped by the relay on receipt; give it the full
        // window so relay-to-machine delay alone never expires it.
        let ttlMs = Number.isInteger(cmd.ttlMs) ? cmd.ttlMs : (synced ? TTL_DEFAULT[cls] : TTL_MAX[cls]);
        ttlMs = Math.min(Math.max(1, ttlMs), TTL_MAX[cls]);
        const body = {
            type: cmd.type,
            args: cmd.args || {},
            seq: seq + 1,
            issuedAt: Math.round(clock.nowSynced()),
            ttlMs,
            idem: isKeepalive ? id : (cmd.idem || id),
        };
        if (!synced) body.unsynced = true;
        if (!sendFrame(T.CMD, body, { id, topic: requestTopic(deviceId), cls })) return 'DEVICE_OFFLINE';
        seq += 1;

        if (cmd.expectAck !== false && !isKeepalive) {
            const timer = setTimeout(() => {
                if (!pending.has(id)) return;
                pending.delete(id);
                const ack = { refId: id, idem: body.idem, type: cmd.type, status: 'failed', code: 'INTERNAL', message: 'no ack', local: true };
                emit('ack', ack);
                if (resolve) resolve(ack);
            }, ACK_TIMEOUT_MS);
            pending.set(id, { timer, resolve, reject, deviceId });
        }
        return null;
    }

    function sendRaw(deviceId, cmd) {
        return trySendCmd(deviceId, cmd, null, null) === null;
    }

    function sendCmd(deviceId, type, args = {}, opts = {}) {
        return new Promise((resolve, reject) => {
            const code = trySendCmd(deviceId, { ...opts, type, args }, resolve, reject);
            if (code) reject(new CmdError(code));
        });
    }

    return {
        on,
        connect,
        disconnect,
        onResume,
        setSubscriptions,
        sendCmd,
        sendRaw,
        getStatus,
        isOpen,
        isSynced: () => clock.isSynced(),
        nowSynced: () => clock.nowSynced(),
        user: () => (welcome ? welcome.user : null),
    };
}
