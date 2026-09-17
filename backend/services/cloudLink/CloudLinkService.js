/**
 * CloudLinkService -- the machine's single outbound connection to the
 * user's relay (spec §5.1).
 *
 * Everything that arrives here is untrusted: commands go only through
 * gate.execute(), files only through FileIngest, and nothing is ever sent to
 * the local HTTP server or Socket.IO (loopback traffic counts as the
 * operator, which is exactly the localtunnel PIN-bypass mistake).
 *
 * Offline means offline: no command is buffered, reports are dropped rather
 * than queued, and every jog is cancelled the moment the link goes down.
 */
'use strict';

const defaultClock = require('./clock');
const protocol = require('./protocol');
const { LatencyTracker } = require('./LatencyTracker');
const { ReportThrottle } = require('./TelemetryBuilder');
const { FileIngest } = require('./FileIngest');

const WS_OPEN = 1;
const WS_CONNECTING = 0;
const WELCOME_TIMEOUT_MS = 10000;
const STABLE_RESET_MS = 60000;
const AUTH_RETRY_MS = 15 * 60 * 1000;
const PROTOCOL_RETRY_MS = 60 * 60 * 1000;
const MIN_REPLACED_DELAY_MS = 30000;
const HTTP_TIMEOUT_MS = 10000;
const UNPAIR_TIMEOUT_MS = 5000;
const REPORT_BUFFER_LIMIT = 256 * 1024;
const CAMERA_BUFFER_LIMIT = 32 * 1024;
const CAMERA_ERROR_EVERY_MS = 10000;
const CAMERA_NO_FRAME_MS = 5000;
const DEFAULT_SNAPSHOT_MAX_BYTES = 307200;
const WARMUP_PINGS = 3;
const WARMUP_SPACING_MS = 200;
const ROTATE_ID_RE = /^r_[A-Za-z0-9_-]{1,38}$/;
const PAIRING_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CAMERA_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '[::1]', '::1', 'localhost']);

const CLOUD_DEFAULTS = Object.freeze({
    enabled: false,
    relayUrl: null,
    credential: null,
    nextCredential: null,
    pendingCredential: null,
    relayDeviceId: null,
    accountLabel: null,
    pairedAt: null,
    credCreatedAt: null,
    maxFileMb: 25,
    cloudLibraryCapMb: 500,
});

/** Validates and normalises a relay URL to its origin. Throws Error('invalid_url'). */
function normalizeRelayUrl(url) {
    if (typeof url !== 'string' || url.length > 2048) throw new Error('invalid_url');
    let u;
    try {
        u = new URL(url.trim());
    } catch (_) {
        throw new Error('invalid_url');
    }
    if (u.username || u.password) throw new Error('invalid_url');
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && LOOPBACK_HOSTS.includes(u.hostname)) return u.origin;
    throw new Error('invalid_url');
}

function wsUrlFor(relayUrl) {
    const u = new URL('/ws/device', relayUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
}

/** §3.3 binary snapshot frame. */
function buildSnapshotFrame(header, jpeg) {
    const json = Buffer.from(JSON.stringify(header), 'utf-8');
    const head = Buffer.alloc(3);
    head[0] = 0x01;
    head.writeUInt16BE(json.length, 1);
    return Buffer.concat([head, json, jpeg]);
}

function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : null;
}

class CloudLinkService {
    constructor({
        dataDir, store, logger, gate, getEngine, libraryService, webcamService,
        isLanOnly = () => false, getHardwareId = () => null, getDeviceName = () => 'Onefinity',
        appVersion = '0.0.0',
        onStatus = () => {}, onPairing = () => {}, onCameraDemand = () => {},
        WebSocketImpl, fetchImpl = globalThis.fetch, clock = defaultClock,
        setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, random = Math.random,
        statfs, retryDelaysMs,
    } = {}) {
        this.dataDir = dataDir;
        this.store = store;
        this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
        this.gate = gate;
        this.getEngine = getEngine || (() => null);
        this.libraryService = libraryService || null;
        this.webcamService = webcamService || null;
        this.isLanOnly = isLanOnly;
        this.getHardwareId = getHardwareId;
        this.getDeviceName = getDeviceName;
        this.appVersion = appVersion;
        this._onStatus = onStatus;
        this._onPairing = onPairing;
        this._onCameraDemand = onCameraDemand;
        this.WebSocketImpl = WebSocketImpl || require('ws');
        this.fetchImpl = fetchImpl;
        this.clock = clock;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.random = random;

        this.latency = new LatencyTracker({ clock });
        this.fileIngest = new FileIngest({
            dataDir,
            store,
            logger: this.logger,
            gate,
            libraryService,
            getRelayUrl: () => this._cfg().relayUrl,
            getCredential: () => this._cfg().credential,
            isLanOnly,
            sendResult: (body) => this._send('file.result', body, { topic: this._reportTopic() }),
            fetchImpl,
            clock,
            setTimeoutFn,
            clearTimeoutFn,
            ...(statfs ? { statfs } : {}),
            ...(retryDelaysMs ? { retryDelaysMs } : {}),
        });

        this._ws = null;
        this._online = false;
        this._authFailed = false;
        this._attempt = 0;
        this._lastError = null;
        this._state = null;
        this._since = this.clock.wall();
        this._nextRetryAt = null;
        this._viewers = 0;
        this._connId = null;
        this._deviceId = null;
        this._limits = {};
        this._fallbackToCurrent = false;
        this._pendingRotateId = null;
        this._stopped = false;
        this._initialized = false;
        this._lastStatusJson = null;

        this._reconnectTimer = null;
        this._welcomeTimer = null;
        this._stableTimer = null;
        this._pingTimer = null;
        this._pingDueAt = null;
        this._pongTimer = null;
        this._warmupTimers = [];
        this._throttle = null;

        this._pairing = null;
        this._pairingTimer = null;
        this._pairingOpen = false;

        this._cameras = new Map();

        this._onGateChange = () => this._handleGateChange();
        this._onTelemetryEvent = () => { if (this._throttle) this._throttle.poke(); };
        this._onControllerBound = () => { if (this._online) this._sendHello(); };
    }

    // ─── lifecycle ───────────────────────────────────────────────────

    init() {
        try {
            if (!this._initialized) {
                this._initialized = true;
                this.fileIngest.init();
                if (this.gate && typeof this.gate.on === 'function') {
                    this.gate.on('change', this._onGateChange);
                    const t = this.gate.telemetry;
                    if (t && typeof t.on === 'function') {
                        for (const ev of ['sender', 'workflow', 'alarm-latched', 'alarm-cleared', 'disconnected', 'connected']) {
                            t.on(ev, this._onTelemetryEvent);
                        }
                        t.on('controller-bound', this._onControllerBound);
                    }
                }
            }
            this._stopped = false;
            this._connect();
        } catch (err) {
            this.logger.error(`[cloud-link] init failed: ${err && err.message}`);
        }
        this._emitStatus();
    }

    _cfg() {
        const snap = (this.store && this.store.get()) || {};
        const out = {};
        for (const key of Object.keys(CLOUD_DEFAULTS)) {
            out[key] = snap[key] === undefined ? CLOUD_DEFAULTS[key] : snap[key];
        }
        return out;
    }

    _canConnect() {
        const cfg = this._cfg();
        return !this._stopped && cfg.enabled === true && !this.isLanOnly()
            && !!(cfg.credential || cfg.nextCredential) && !!cfg.relayUrl;
    }

    getStatus() {
        const cfg = this._cfg();
        const state = this._computeState(cfg);
        if (state !== this._state) {
            this._state = state;
            this._since = this.clock.wall();
        }
        return {
            enabled: cfg.enabled === true,
            lanOnly: !!this.isLanOnly(),
            relayUrl: cfg.relayUrl || null,
            paired: !!(cfg.credential || cfg.nextCredential),
            relayDeviceId: cfg.relayDeviceId || null,
            accountLabel: cfg.accountLabel || null,
            pairedAt: cfg.pairedAt || null,
            state,
            since: this._since,
            rttMs: this._online ? this.latency.rttMs : null,
            viewers: this._online ? this._viewers : 0,
            nextRetryAt: this._reconnectTimer ? this._nextRetryAt : null,
            lastError: this._lastError,
            // Operator view only (index.js redacts them for LAN callers).
            maxFileMb: Number.isInteger(cfg.maxFileMb) ? cfg.maxFileMb : CLOUD_DEFAULTS.maxFileMb,
            cloudLibraryCapMb: Number.isInteger(cfg.cloudLibraryCapMb) ? cfg.cloudLibraryCapMb : CLOUD_DEFAULTS.cloudLibraryCapMb,
        };
    }

    _computeState(cfg) {
        if (this.isLanOnly()) return 'lan-only';
        if (cfg.enabled !== true) return 'disabled';
        if (this._pairing && (this._pairing.view.state === 'pending' || this._pairing.view.state === 'claimed')) return 'pairing';
        if (!cfg.credential && !cfg.nextCredential) return 'unpaired';
        if (this._authFailed) return 'auth-failed';
        if (this._online) return 'online';
        if (this._reconnectTimer) return 'backoff';
        return 'connecting';
    }

    _emitStatus() {
        const status = this.getStatus();
        const json = JSON.stringify(status);
        if (json === this._lastStatusJson) return status;
        this._lastStatusJson = json;
        try { this._onStatus(status); } catch (err) { this.logger.warn(`[cloud-link] onStatus failed: ${err && err.message}`); }
        return status;
    }

    setRelayUrl(url) {
        const normalized = normalizeRelayUrl(url);
        const cfg = this._cfg();
        if (normalized !== cfg.relayUrl) {
            this.store.update((d) => { d.relayUrl = normalized; });
            this._closeSocket(1000, 'relay changed', 'link-down');
            this._clearReconnect();
            this._authFailed = false;
            this._attempt = 0;
            this._connect();
        }
        return this._emitStatus();
    }

    setEnabled(enabled) {
        const on = enabled === true;
        this.store.update((d) => { d.enabled = on; });
        if (!on) {
            this._closeSocket(1000, 'disabled', 'link-down');
            this._clearReconnect();
            this.fileIngest.abortAll('disabled');
            this._cameraStopAll();
        } else {
            this._authFailed = false;
            this._attempt = 0;
            this._clearReconnect();
            this._connect();
        }
        return this._emitStatus();
    }

    setLimits({ maxFileMb, cloudLibraryCapMb } = {}) {
        const okFile = maxFileMb === undefined || (Number.isInteger(maxFileMb) && maxFileMb >= 1 && maxFileMb <= 100);
        const okCap = cloudLibraryCapMb === undefined || (Number.isInteger(cloudLibraryCapMb) && cloudLibraryCapMb >= 50 && cloudLibraryCapMb <= 10000);
        if (!okFile || !okCap) throw new Error('invalid_limits');
        this.store.update((d) => {
            if (maxFileMb !== undefined) d.maxFileMb = maxFileMb;
            if (cloudLibraryCapMb !== undefined) d.cloudLibraryCapMb = cloudLibraryCapMb;
        });
        return this._emitStatus();
    }

    applyLanOnly(lanOnly) {
        if (lanOnly) {
            // Synchronous and network-silent by contract: no close handshake
            // wait, no DELETE for the pairing, no file.result.
            this._closeSocket(1000, 'lan-only', 'lan-only');
            this._clearReconnect();
            this.cancelPairing({ notifyRelay: false });
            this.fileIngest.abortAll('lan_only');
            this._cameraStopAll();
        } else {
            this._authFailed = false;
            this._attempt = 0;
            this._clearReconnect();
            this._connect();
        }
        this._emitStatus();
    }

    stop(reason = 'shutdown') {
        this._stopped = true;
        this.fileIngest.stop();
        this.cancelPairing({ notifyRelay: false });
        this._clearReconnect();
        this._cameraStopAll();
        const ws = this._ws;
        this._closeSocket(1000, 'shutdown', 'shutdown');
        this._emitStatus();
        return new Promise((resolve) => {
            if (!ws || ws.readyState === 3) return resolve();
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            try { ws.once('close', finish); } catch (_) { /* fake socket */ }
            const t = this.setTimeoutFn(finish, 1000);
            if (t && typeof t.unref === 'function') t.unref();
        });
    }

    // ─── connection ──────────────────────────────────────────────────

    _clearReconnect() {
        if (this._reconnectTimer) this.clearTimeoutFn(this._reconnectTimer);
        this._reconnectTimer = null;
        this._nextRetryAt = null;
    }

    _scheduleReconnect(delayMs) {
        this._clearReconnect();
        if (!this._canConnect()) return;
        const delay = Math.max(0, Math.round(delayMs));
        this._nextRetryAt = this.clock.wall() + delay;
        this._reconnectTimer = this.setTimeoutFn(() => {
            this._reconnectTimer = null;
            this._nextRetryAt = null;
            this._connect();
        }, delay);
        this._emitStatus();
    }

    _backoffDelay() {
        const cap = Math.min(60000, 1000 * Math.pow(2, this._attempt));
        this._attempt += 1;
        return Math.max(500, this.random() * cap);
    }

    _connect() {
        if (this._ws || this._reconnectTimer || !this._canConnect()) return;
        const cfg = this._cfg();
        const useNext = !!cfg.nextCredential && !this._fallbackToCurrent;
        const cred = useNext ? cfg.nextCredential : cfg.credential;
        this._fallbackToCurrent = false;
        if (!cred) return;
        let ws;
        try {
            ws = new this.WebSocketImpl(wsUrlFor(cfg.relayUrl), {
                headers: { Authorization: 'Bearer ' + cred, 'X-Onefinity-Protocol': '1' },
                handshakeTimeout: 10000,
                maxPayload: 1048576,
                perMessageDeflate: false,
            });
        } catch (err) {
            this._lastError = 'Could not open the relay connection';
            this.logger.warn(`[cloud-link] connect failed: ${err && err.message}`);
            this._scheduleReconnect(this._backoffDelay());
            return;
        }
        ws._olUsingNext = useNext;
        ws._olDown = false;
        this._ws = ws;
        ws.on('open', () => this._onOpen(ws));
        ws.on('message', (data, isBinary) => this._onMessage(ws, data, isBinary));
        ws.on('close', (code, reason) => this._socketDown(ws, { code, closeReason: reason ? String(reason) : '' }));
        ws.on('error', (err) => {
            if (ws === this._ws) this.logger.debug?.(`[cloud-link] socket error: ${err && (err.code || err.message)}`);
        });
        ws.on('unexpected-response', (req, res) => this._onUnexpectedResponse(ws, req, res));
        this._emitStatus();
    }

    _onOpen(ws) {
        if (ws !== this._ws) return;
        this._sendHello();
        this._welcomeTimer = this.setTimeoutFn(() => {
            this._welcomeTimer = null;
            if (ws !== this._ws || this._online) return;
            this.logger.warn('[cloud-link] no welcome from relay within 10 s');
            this._socketDown(ws, { code: 1006 });
            try { ws.terminate(); } catch (_) { /* already closed */ }
        }, WELCOME_TIMEOUT_MS);
    }

    _onUnexpectedResponse(ws, req, res) {
        const status = res && res.statusCode;
        const retryAfter = res && res.headers ? Number(res.headers['retry-after']) : NaN;
        const chunks = [];
        let size = 0;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (_) { body = null; }
            this._socketDown(ws, { httpStatus: status, body, retryAfter });
            try { ws.terminate(); } catch (_) { /* handshake already aborted */ }
        };
        if (!res || typeof res.on !== 'function') return finish();
        res.on('data', (c) => {
            size += c.length;
            if (size <= 4096) chunks.push(c);
        });
        res.on('end', finish);
        res.on('error', finish);
        res.on('close', finish);
    }

    /**
     * Idempotent per socket. Jogs are cancelled before anything else.
     */
    _socketDown(ws, info = {}) {
        if (!ws || ws._olDown) return;
        ws._olDown = true;
        if (ws !== this._ws) return;
        this._ws = null;
        const linkReason = info.reason || 'link-down';
        this.gate.onLinkDown('cloud', linkReason);
        this._online = false;
        this._connId = null;
        this._viewers = 0;
        if (this._welcomeTimer) this.clearTimeoutFn(this._welcomeTimer);
        this._welcomeTimer = null;
        if (this._stableTimer) this.clearTimeoutFn(this._stableTimer);
        this._stableTimer = null;
        this._stopHeartbeat();
        if (this._throttle) this._throttle.stop();
        this._throttle = null;
        this._cameraStopAll(true);
        this.latency.reset();
        this._pendingRotateId = null;

        if (ws._olIntentional) {
            this._emitStatus();
            return;
        }
        this._decideAfterFailure(ws, info);
        this._emitStatus();
    }

    _decideAfterFailure(ws, info) {
        const { code, closeReason, httpStatus, body, retryAfter } = info;
        const errCode = body && typeof body.error === 'string' ? body.error : null;

        if (code === 4401 || httpStatus === 401) {
            const revoked = code === 4401 ? closeReason === 'revoked' : errCode === 'revoked';
            if (revoked) {
                this._wipeCredentials();
                this.fileIngest.abortAll('unpair');
                this._lastError = 'This machine was unpaired on the relay';
                this.logger.warn('[cloud-link] credential revoked by relay -- unpaired');
                return;
            }
            if (httpStatus === 401 && ws._olUsingNext && this._cfg().credential) {
                // Rotation commit was lost: retry at once with the old credential.
                this._fallbackToCurrent = true;
                this._clearReconnect();
                this._connect();
                return;
            }
            this._authFailed = true;
            this._lastError = "Relay rejected this machine's credential — pair again";
            this._scheduleReconnect(AUTH_RETRY_MS);
            return;
        }
        if (httpStatus === 403) {
            if (!this._pairing) this._authFailed = true;
            this._lastError = errCode === 'unconfirmed' ? 'Pairing not confirmed on the relay yet' : 'Relay refused the connection';
            this._scheduleReconnect(AUTH_RETRY_MS);
            return;
        }
        if (httpStatus === 426) {
            this._authFailed = true;
            this._lastError = 'Relay protocol mismatch — update the machine or relay';
            this._scheduleReconnect(PROTOCOL_RETRY_MS);
            return;
        }
        if (httpStatus === 429) {
            const ra = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
            this._lastError = 'Relay is rate limiting this machine';
            this._scheduleReconnect(Math.max(ra, MIN_REPLACED_DELAY_MS, this._backoffDelay()));
            return;
        }
        if (code === 4409 || code === 4429) {
            this._lastError = code === 4409 ? 'Another connection replaced this one' : 'Relay is rate limiting this machine';
            this._scheduleReconnect(Math.max(MIN_REPLACED_DELAY_MS, this._backoffDelay()));
            return;
        }
        if (code === 4400) this.logger.error('[cloud-link] relay closed the link for a protocol violation');
        if (httpStatus) this._lastError = `Relay answered HTTP ${httpStatus}`;
        else if (code !== 1000 && code !== 1001) this._lastError = 'Relay connection lost';
        this._scheduleReconnect(this._backoffDelay());
    }

    _wipeCredentials() {
        this.store.update((d) => {
            d.credential = null;
            d.nextCredential = null;
            d.relayDeviceId = null;
            d.accountLabel = null;
            d.pairedAt = null;
            d.credCreatedAt = null;
        });
        this._authFailed = false;
        this._clearReconnect();
    }

    _closeSocket(code, reason, linkReason) {
        const ws = this._ws;
        if (!ws) {
            this.gate.onLinkDown('cloud', linkReason);
            return;
        }
        ws._olIntentional = true;
        this._socketDown(ws, { reason: linkReason });
        try {
            if (ws.readyState === WS_CONNECTING) ws.terminate();
            else ws.close(code, reason);
        } catch (_) {
            try { ws.terminate(); } catch (__) { /* gone */ }
        }
    }

    _reportTopic() {
        return protocol.reportTopic(this._deviceId || this._cfg().relayDeviceId);
    }

    _send(t, body, { topic = null, id = null } = {}) {
        const ws = this._ws;
        if (!ws || ws.readyState !== WS_OPEN) return false;
        try {
            ws.send(JSON.stringify(protocol.envelope(t, body, { topic, id, ts: this.clock.wall() })));
            return true;
        } catch (err) {
            this.logger.debug?.(`[cloud-link] send ${t} failed: ${err && err.message}`);
            return false;
        }
    }

    _sendHello() {
        const telemetry = this.gate && this.gate.telemetry;
        const type = telemetry ? telemetry.controllerType : null;
        const cameras = this._cameraList().slice(0, 8).map(c => ({ id: String(c.id).slice(0, 64), name: str(c.name, 60) || String(c.id).slice(0, 60) }));
        this._send('hello', {
            protocol: { min: protocol.PROTOCOL_VERSION, max: protocol.PROTOCOL_VERSION },
            hardwareId: this.getHardwareId(),
            appVersion: this.appVersion,
            controllerType: protocol.CONTROLLER_TYPES.includes(type) ? type : null,
            capabilities: { snapshot: !!this.webcamService, webrtc: false, e2e: false, files: !!this.libraryService },
            cameras,
        });
    }

    _cameraList() {
        if (!this.webcamService || typeof this.webcamService.list !== 'function') return [];
        try {
            const list = this.webcamService.list();
            return Array.isArray(list) ? list.filter(c => c && c.id !== undefined) : [];
        } catch (_) {
            return [];
        }
    }

    // ─── inbound ─────────────────────────────────────────────────────

    _onMessage(ws, data, isBinary) {
        if (ws !== this._ws || isBinary) return;
        let env;
        try {
            env = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf-8') : String(data));
        } catch (_) {
            return;
        }
        const v = protocol.validateEnvelope(env);
        if (!v.ok) {
            const refId = env && typeof env.id === 'string' && protocol.ID_RE.test(env.id) ? env.id : null;
            if (env && env.t === 'cmd' && refId) this._sendAck(env, { status: 'rejected', code: v.code, message: null, duplicate: false });
            else this._send('error', { code: v.code, message: 'invalid message', refId });
            return;
        }
        const body = env.body || {};
        if (!this._online && env.t !== 'welcome' && env.t !== 'ping' && env.t !== 'pong' && env.t !== 'error') return;
        try {
            switch (env.t) {
                case 'welcome': return this._onWelcome(ws, body);
                case 'ping': return this._send('pong', {
                    nonce: str(body.nonce, 40),
                    sentAt: Number.isFinite(body.sentAt) ? body.sentAt : null,
                    recvAt: this.clock.wall(),
                });
                case 'pong': return this._onPong(body);
                case 'error':
                    this.logger.warn(`[cloud-link] relay error ${str(body.code, 40)}: ${str(body.message, 200)}`);
                    return;
                case 'viewers':
                    this._viewers = Number.isInteger(body.count) && body.count >= 0 ? body.count : 0;
                    this._emitStatus();
                    return;
                case 'cmd': return this._onCmd(env);
                case 'client.gone':
                    if (typeof body.connId === 'string') this.gate.onClientGone(body.connId);
                    return;
                case 'file.offer':
                    this.fileIngest.handleOffer(body);
                    return;
                case 'camera.demand': return this._onCameraDemandMsg(body);
                case 'cred.rotate': return this._onCredRotate(body);
                case 'cred.commit': return this._onCredCommit(body);
                default:
                    this._send('error', { code: 'UNKNOWN_COMMAND', message: null, refId: env.id || null });
            }
        } catch (err) {
            this.logger.error(`[cloud-link] handling ${str(env.t, 40)} failed: ${err && err.message}`);
            if (env.t === 'cmd') this._sendAck(env, { status: 'failed', code: 'INTERNAL', message: null, duplicate: false });
        }
    }

    _onWelcome(ws, body) {
        if (this._online) return;
        if (this._welcomeTimer) this.clearTimeoutFn(this._welcomeTimer);
        this._welcomeTimer = null;
        this._online = true;
        this._authFailed = false;
        this._lastError = null;
        this._connId = str(body.connId, 40);
        this._limits = body.limits && typeof body.limits === 'object' ? body.limits : {};
        const deviceId = typeof body.deviceId === 'string' && protocol.ID_RE.test(body.deviceId) ? body.deviceId : null;
        this._deviceId = deviceId || this._cfg().relayDeviceId;
        const cfg = this._cfg();
        if (ws._olUsingNext && cfg.nextCredential) {
            this.store.update((d) => {
                d.credential = d.nextCredential;
                d.nextCredential = null;
                d.credCreatedAt = this.clock.wall();
                if (deviceId) d.relayDeviceId = deviceId;
            });
        } else if (cfg.nextCredential || (deviceId && deviceId !== cfg.relayDeviceId)) {
            this.store.update((d) => {
                d.nextCredential = null;
                if (deviceId) d.relayDeviceId = deviceId;
            });
        }
        this.gate.onLinkUp('cloud');
        this._stableTimer = this.setTimeoutFn(() => {
            this._stableTimer = null;
            if (this._online) this._attempt = 0;
        }, STABLE_RESET_MS);

        for (let i = 0; i < WARMUP_PINGS; i++) {
            const t = this.setTimeoutFn(() => this._sendPing(), i * WARMUP_SPACING_MS);
            this._warmupTimers.push(t);
        }
        this._schedulePing((WARMUP_PINGS - 1) * WARMUP_SPACING_MS + this._pingIntervalMs());

        this._throttle = new ReportThrottle({
            clock: this.clock,
            setTimeoutFn: this.setTimeoutFn,
            clearTimeoutFn: this.clearTimeoutFn,
            getState: () => this.gate.getTelemetry(),
            getTier: () => this.gate.getState('cloud'),
            isFast: () => this.gate.isJogActive(),
            canSend: () => !!this._ws && this._ws.readyState === WS_OPEN && (this._ws.bufferedAmount || 0) <= REPORT_BUFFER_LIMIT,
            send: (t, reportBody) => this._send(t, reportBody, { topic: this._reportTopic() }),
        });
        this._throttle.start();
        this.fileIngest.retryReady();
        this.logger.info('[cloud-link] online');
        this._emitStatus();
    }

    _onCmd(env) {
        const body = env.body || {};
        const via = env.via;
        if (typeof body.type !== 'string') {
            return this._sendAck(env, { status: 'rejected', code: 'BAD_ARGS', message: null, duplicate: false });
        }
        const identity = {
            kind: 'cloud',
            userId: str(via.userId, 40),
            userLabel: str(via.userLabel, 60),
            role: str(via.role, 16),
            connId: str(via.connId, 40),
            sessionRef: str(via.sessionRef, 40),
        };
        const ctx = {
            via,
            ttlMs: body.ttlMs,
            relayOffsetMs: this.latency.relayOffsetMs,
            effectiveRttMs: this.latency.effectiveRtt(via),
            linkFresh: this.latency.isFresh(),
            cls: env.cls,
            idem: body.idem,
            seq: via.clientSeq,
        };
        const res = this.gate.execute(identity, body.type, body.args, ctx);
        if (res.status === 'accepted' && body.type === 'jog.cont.keepalive') return;
        this._sendAck(env, res);
    }

    _sendAck(env, res) {
        const body = env.body || {};
        this._send('cmd.ack', {
            refId: env.id,
            idem: typeof body.idem === 'string' ? body.idem.slice(0, 40) : null,
            type: typeof body.type === 'string' ? body.type.slice(0, 40) : null,
            status: res.status,
            code: res.code,
            message: res.message === undefined ? null : res.message,
            duplicate: !!res.duplicate,
            at: this.clock.wall(),
        }, { topic: this._reportTopic() });
    }

    _onCredRotate(body) {
        if (typeof body.rotateId !== 'string' || !ROTATE_ID_RE.test(body.rotateId)) {
            this._send('error', { code: 'BAD_ARGS', message: 'rotateId', refId: null });
            return;
        }
        const next = protocol.newCredential();
        // Persist BEFORE announcing the hash: once the relay swaps hashes the
        // machine must be able to prove the new credential after any crash.
        this.store.update((d) => { d.nextCredential = next; });
        this._pendingRotateId = body.rotateId;
        this._send('cred.rotated', { rotateId: body.rotateId, newCredentialHash: protocol.sha256Hex(next) });
    }

    _onCredCommit(body) {
        if (!this._pendingRotateId || body.rotateId !== this._pendingRotateId) return;
        this._pendingRotateId = null;
        if (!this._cfg().nextCredential) return;
        this.store.update((d) => {
            d.credential = d.nextCredential;
            d.nextCredential = null;
            d.credCreatedAt = this.clock.wall();
        });
    }

    // ─── heartbeat ───────────────────────────────────────────────────

    _pingIntervalMs() {
        let fast = false;
        try {
            fast = this.gate.isJogActive() || this.gate.getState('cloud').tier === 'motion';
        } catch (_) { fast = false; }
        return LatencyTracker.intervalMs(fast);
    }

    _schedulePing(delayMs) {
        if (this._pingTimer) this.clearTimeoutFn(this._pingTimer);
        this._pingDueAt = this.clock.mono() + delayMs;
        this._pingTimer = this.setTimeoutFn(() => {
            this._pingTimer = null;
            if (!this._online) return;
            this._sendPing();
            this._schedulePing(this._pingIntervalMs());
        }, delayMs);
    }

    _sendPing() {
        if (!this._online) return;
        const ping = this.latency.makePing();
        this._send('ping', ping, { id: ping.nonce });
        if (!this._pongTimer) this._armPongDeadline();
    }

    _armPongDeadline() {
        if (this._pongTimer) this.clearTimeoutFn(this._pongTimer);
        this._pongTimer = null;
        const oldest = this.latency.oldestOutstanding();
        if (oldest === null || !this._online) return;
        const deadline = LatencyTracker.deadlineMs(this._pingIntervalMs());
        const wait = Math.max(0, oldest + deadline - this.clock.mono());
        this._pongTimer = this.setTimeoutFn(() => {
            this._pongTimer = null;
            const o = this.latency.oldestOutstanding();
            if (o === null || !this._online) return;
            if (this.clock.mono() - o >= LatencyTracker.deadlineMs(this._pingIntervalMs())) {
                const ws = this._ws;
                this.logger.warn('[cloud-link] relay pong overdue -- dropping link');
                this._socketDown(ws, { code: 1006 });
                try { ws && ws.terminate(); } catch (_) { /* gone */ }
                return;
            }
            this._armPongDeadline();
        }, wait);
    }

    _onPong(body) {
        const rtt = this.latency.onPong(body);
        if (rtt === null) return;
        this.gate.onRttSample(rtt);
        this._armPongDeadline();
        this._emitStatus();
    }

    _stopHeartbeat() {
        if (this._pingTimer) this.clearTimeoutFn(this._pingTimer);
        this._pingTimer = null;
        this._pingDueAt = null;
        if (this._pongTimer) this.clearTimeoutFn(this._pongTimer);
        this._pongTimer = null;
        for (const t of this._warmupTimers) this.clearTimeoutFn(t);
        this._warmupTimers = [];
    }

    _handleGateChange() {
        if (this._throttle) this._throttle.markTierDirty();
        if (!this._online || this._pingDueAt === null) return;
        const interval = this._pingIntervalMs();
        if (this._pingDueAt - this.clock.mono() > interval) this._schedulePing(interval);
    }

    // ─── pairing ─────────────────────────────────────────────────────

    async _http(method, pathname, { bearer = null, json, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
        const relayUrl = this._cfg().relayUrl;
        const url = new URL(pathname, relayUrl);
        if (url.origin !== new URL(relayUrl).origin) throw new Error('relay_unreachable');
        const controller = new AbortController();
        const timer = this.setTimeoutFn(() => controller.abort(), timeoutMs);
        try {
            const headers = { Accept: 'application/json' };
            if (bearer) headers.Authorization = 'Bearer ' + bearer;
            if (json !== undefined) headers['Content-Type'] = 'application/json';
            const res = await this.fetchImpl(url.href, {
                method,
                headers,
                body: json === undefined ? undefined : JSON.stringify(json),
                redirect: 'error',
                signal: controller.signal,
            });
            let data = null;
            try {
                const text = await res.text();
                data = text ? JSON.parse(text) : null;
            } catch (_) { data = null; }
            return { status: res.status, data };
        } finally {
            this.clearTimeoutFn(timer);
        }
    }

    getPairing() {
        return this._pairing ? { ...this._pairing.view } : null;
    }

    async startPairing() {
        const cfg = this._cfg();
        if (this.isLanOnly()) throw new Error('lan_only');
        if (!cfg.relayUrl) throw new Error('no_relay_url');
        if (cfg.credential || cfg.nextCredential) throw new Error('already_paired');
        this._stopPairingPoll();
        this._pairing = null;
        this._pairingOpen = true;
        return this._requestCode(false);
    }

    async _requestCode(retried) {
        let pending = this._cfg().pendingCredential;
        if (!pending || retried) {
            pending = protocol.newCredential();
            this.store.update((d) => { d.pendingCredential = pending; });
        }
        const telemetry = this.gate && this.gate.telemetry;
        const type = telemetry ? telemetry.controllerType : null;
        let res;
        try {
            res = await this._http('POST', '/api/device/pairing', {
                json: {
                    hardwareId: this.getHardwareId(),
                    name: String(this.getDeviceName() || 'Onefinity').slice(0, 60),
                    appVersion: this.appVersion,
                    controllerType: protocol.CONTROLLER_TYPES.includes(type) ? type : null,
                    credentialHash: protocol.sha256Hex(pending),
                },
            });
        } catch (_) {
            throw new Error('relay_unreachable');
        }
        if (this.isLanOnly() || !this._pairingOpen) throw new Error('lan_only');
        if (res.status === 409 && res.data && res.data.error === 'hash_in_use' && !retried) {
            return this._requestCode(true);
        }
        const d = res.data || {};
        if (res.status < 200 || res.status >= 300 || typeof d.pairingId !== 'string' || !PAIRING_ID_RE.test(d.pairingId)
            || typeof d.code !== 'string' || typeof d.pollSecret !== 'string') {
            throw new Error('relay_unreachable');
        }
        const pollMs = Math.min(30000, Math.max(1000, Number(d.pollIntervalMs) || 3000));
        this._pairing = {
            id: d.pairingId,
            pollSecret: d.pollSecret,
            pollMs,
            deviceId: null,
            view: { state: 'pending', code: d.code.slice(0, 16), expiresAt: Number(d.expiresAt) || null },
        };
        this._pairingChanged();
        this._schedulePairingPoll();
        return { code: this._pairing.view.code, expiresAt: this._pairing.view.expiresAt };
    }

    _pairingChanged() {
        try { this._onPairing(this.getPairing()); } catch (err) { this.logger.warn(`[cloud-link] onPairing failed: ${err && err.message}`); }
        this._emitStatus();
    }

    _stopPairingPoll() {
        if (this._pairingTimer) this.clearTimeoutFn(this._pairingTimer);
        this._pairingTimer = null;
    }

    _schedulePairingPoll() {
        this._stopPairingPoll();
        const p = this._pairing;
        if (!p) return;
        this._pairingTimer = this.setTimeoutFn(() => {
            this._pairingTimer = null;
            this._pollPairing(p);
        }, p.pollMs);
    }

    async _pollPairing(p) {
        if (this._pairing !== p || p.view.state !== 'pending' || this.isLanOnly()) return;
        let res;
        try {
            res = await this._http('GET', `/api/device/pairing/${encodeURIComponent(p.id)}`, { bearer: p.pollSecret });
        } catch (_) {
            if (this._pairing === p) this._schedulePairingPoll();
            return;
        }
        if (this._pairing !== p || this.isLanOnly()) return;
        const d = res.data || {};
        if (res.status === 401 || res.status === 404) {
            p.view = { state: 'expired' };
            return this._pairingChanged();
        }
        if (res.status < 200 || res.status >= 300) return this._schedulePairingPoll();
        switch (d.status) {
            case 'pending':
                return this._schedulePairingPoll();
            case 'expired':
                if (this._pairingOpen) {
                    try {
                        await this._requestCode(false);
                    } catch (_) {
                        if (this._pairing === p) {
                            p.view = { state: 'expired' };
                            this._pairingChanged();
                        }
                    }
                    return;
                }
                p.view = { state: 'expired' };
                return this._pairingChanged();
            case 'claimed':
            case 'confirmed':
                p.deviceId = typeof d.deviceId === 'string' && protocol.ID_RE.test(d.deviceId) ? d.deviceId : null;
                p.view = {
                    state: 'claimed',
                    accountLabel: str(d.accountLabel, 254),
                    accountDisplayName: str(d.accountDisplayName, 60),
                    deviceId: p.deviceId,
                };
                if (d.status === 'confirmed') return this._finalizePairing(p);
                return this._pairingChanged();
            case 'rejected':
                p.view = { state: 'rejected' };
                return this._pairingChanged();
            default:
                return this._schedulePairingPoll();
        }
    }

    async confirmPairing() {
        const p = this._pairing;
        if (!p || p.view.state !== 'claimed') throw new Error('not_claimed');
        if (this.isLanOnly()) throw new Error('lan_only');
        let res;
        try {
            res = await this._http('POST', `/api/device/pairing/${encodeURIComponent(p.id)}/confirm`, { bearer: p.pollSecret, json: {} });
        } catch (_) {
            throw new Error('relay_unreachable');
        }
        if (this._pairing !== p) throw new Error('not_claimed');
        if (res.status === 404 || res.status === 410) throw new Error('not_claimed');
        if (res.status < 200 || res.status >= 300) throw new Error('relay_unreachable');
        this._finalizePairing(p);
        return this.getStatus();
    }

    _finalizePairing(p) {
        const now = this.clock.wall();
        this.store.update((d) => {
            d.credential = d.pendingCredential;
            d.pendingCredential = null;
            d.nextCredential = null;
            d.relayDeviceId = p.deviceId;
            d.accountLabel = p.view.accountLabel || null;
            d.pairedAt = now;
            d.credCreatedAt = now;
        });
        this._stopPairingPoll();
        this._pairing = null;
        this._pairingOpen = false;
        this._authFailed = false;
        this._lastError = null;
        this._attempt = 0;
        this._pairingChanged();
        this._clearReconnect();
        this._connect();
        this._emitStatus();
    }

    async rejectPairing() {
        const p = this._pairing;
        if (!p || p.view.state !== 'claimed') throw new Error('not_claimed');
        this._stopPairingPoll();
        this._pairing = null;
        this._pairingOpen = false;
        this.store.update((d) => { d.pendingCredential = null; });
        this._pairingChanged();
        if (this.isLanOnly()) return;
        try {
            await this._http('POST', `/api/device/pairing/${encodeURIComponent(p.id)}/reject`, { bearer: p.pollSecret, json: {} });
        } catch (err) {
            // The relay drops unconfirmed claims after 15 min anyway.
            this.logger.warn('[cloud-link] pairing reject did not reach the relay');
        }
    }

    cancelPairing({ notifyRelay = true } = {}) {
        const p = this._pairing;
        this._stopPairingPoll();
        this._pairingOpen = false;
        this._pairing = null;
        if (!p) return;
        if (notifyRelay && !this.isLanOnly() && this._cfg().relayUrl) {
            this._http('DELETE', `/api/device/pairing/${encodeURIComponent(p.id)}`, { bearer: p.pollSecret })
                .catch(() => { /* best effort */ });
        }
        this._pairingChanged();
    }

    async unpair() {
        const cfg = this._cfg();
        this.cancelPairing({ notifyRelay: false });
        const ws = this._ws;
        if (ws) ws._olIntentional = true;
        if (cfg.credential && cfg.relayUrl && !this.isLanOnly()) {
            try {
                await this._http('DELETE', '/api/device/self', { bearer: cfg.credential, timeoutMs: UNPAIR_TIMEOUT_MS });
            } catch (_) {
                this.logger.warn('[cloud-link] unpair request did not reach the relay; credential wiped locally');
            }
        }
        this.fileIngest.abortAll('unpair');
        this._closeSocket(1000, 'unpaired', 'link-down');
        this._clearReconnect();
        this._wipeCredentials();
        this.store.update((d) => { d.pendingCredential = null; });
        this._lastError = null;
        this._emitStatus();
    }

    // ─── camera pusher (§5.8) ────────────────────────────────────────

    _cameraExists(cameraId) {
        if (!this.webcamService) return false;
        if (typeof this.webcamService.list !== 'function') return true;
        return this._cameraList().some(c => String(c.id) === cameraId);
    }

    _sendCameraError(cam, cameraId, code, message) {
        const now = this.clock.mono();
        if (cam) {
            const key = `_lastErr_${code}`;
            if (now - (cam[key] || -Infinity) < CAMERA_ERROR_EVERY_MS) return;
            cam[key] = now;
        }
        this._send('camera.error', { cameraId, code, message: message || null }, { topic: this._reportTopic() });
    }

    _onCameraDemandMsg(body) {
        const cameraId = typeof body.cameraId === 'string' && CAMERA_ID_RE.test(body.cameraId) ? body.cameraId : null;
        if (!cameraId) return;
        const fpsRaw = Number(body.fps);
        if (fpsRaw === 0) {
            this._cameraStop(cameraId, true);
            return;
        }
        if (this.isLanOnly()) return this._sendCameraError(null, cameraId, 'LAN_ONLY');
        if (!this._cameraExists(cameraId)) return this._sendCameraError(null, cameraId, 'NOT_FOUND');
        const maxFps = Number(this._limits.snapshotMaxFps) > 0 ? Number(this._limits.snapshotMaxFps) : 2;
        const demanded = Math.min(fpsRaw >= 2 ? 2 : 1, maxFps);
        const leaseMs = Math.min(60000, Math.max(1000, Number(body.leaseMs) || 10000));
        const now = this.clock.mono();
        let cam = this._cameras.get(cameraId);
        if (!cam) {
            // Frame seq stays monotonic per camera for the life of this
            // service: a phone polling with ?after=<last seq> must not stall
            // when the camera is stopped and demanded again.
            if (!this._cameraSeqs) this._cameraSeqs = new Map();
            cam = {
                id: cameraId, fps: demanded, effectiveFps: demanded, leaseUntil: now + leaseMs,
                lastBuf: null, lastNewFrameAt: now, skipSince: null, calmSince: now, lastHalveAt: -Infinity,
                seq: this._cameraSeqs.get(cameraId) || 0, timer: null,
            };
            this._cameras.set(cameraId, cam);
            this._notifyCameraDemand({ cameraId, fps: demanded });
            this._scheduleCameraTick(cam, 0);
            return;
        }
        cam.leaseUntil = now + leaseMs;
        if (cam.fps !== demanded) {
            cam.fps = demanded;
            cam.effectiveFps = demanded;
            this._notifyCameraDemand({ cameraId, fps: demanded });
            this._scheduleCameraTick(cam, 1000 / cam.effectiveFps);
        }
    }

    _notifyCameraDemand(d) {
        try { this._onCameraDemand(d); } catch (_) { /* observer */ }
    }

    _scheduleCameraTick(cam, delayMs) {
        if (cam.timer) this.clearTimeoutFn(cam.timer);
        cam.timer = this.setTimeoutFn(() => {
            cam.timer = null;
            this._cameraTick(cam);
        }, delayMs);
    }

    _halveCameraFps(cam, now) {
        cam.effectiveFps = Math.max(0.5, cam.effectiveFps / 2);
        cam.lastHalveAt = now;
        cam.calmSince = null;
    }

    _cameraTick(cam) {
        if (this._cameras.get(cam.id) !== cam) return;
        const now = this.clock.mono();
        if (now >= cam.leaseUntil) {
            this._cameraStop(cam.id, true);
            return;
        }
        const next = () => this._scheduleCameraTick(cam, 1000 / cam.effectiveFps);
        const ws = this._ws;
        if (!this._online || !ws || ws.readyState !== WS_OPEN) return next();

        // 1. control messages first: never queue a frame behind a backlog
        if ((ws.bufferedAmount || 0) >= CAMERA_BUFFER_LIMIT) {
            if (cam.skipSince === null) cam.skipSince = now;
            if (now - cam.skipSince >= 3000) {
                this._halveCameraFps(cam, now);
                cam.skipSince = now;
            }
            cam.calmSince = null;
            return next();
        }
        cam.skipSince = null;

        const rtt = this.latency.rttMs;
        if (rtt !== null && rtt > 200 && now - cam.lastHalveAt >= 3000 && cam.effectiveFps > 0.5) {
            this._halveCameraFps(cam, now);
        } else if (rtt === null || rtt <= 100) {
            if (cam.calmSince === null) cam.calmSince = now;
            if (now - cam.calmSince >= 10000 && cam.effectiveFps < cam.fps) {
                cam.effectiveFps = Math.min(cam.fps, cam.effectiveFps * 2);
                cam.calmSince = now;
            }
        } else {
            cam.calmSince = null;
        }

        // 2. suspended while a remote jog or a laggy motion session runs
        let motion = false;
        try { motion = this.gate.getState('cloud').tier === 'motion'; } catch (_) { motion = false; }
        if (this.gate.isJogActive() || (motion && rtt !== null && rtt > 150)) return next();

        // 3-6
        let buf = null;
        try { buf = this.webcamService.snapshot(cam.id); } catch (_) { buf = null; }
        const isJpeg = Buffer.isBuffer(buf) && buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xD8;
        if (!isJpeg || buf === cam.lastBuf) {
            if (now - cam.lastNewFrameAt >= CAMERA_NO_FRAME_MS) this._sendCameraError(cam, cam.id, 'NO_FRAME');
            return next();
        }
        const maxBytes = Number(this._limits.snapshotMaxBytes) > 0 ? Number(this._limits.snapshotMaxBytes) : DEFAULT_SNAPSHOT_MAX_BYTES;
        if (buf.length > maxBytes) {
            if (now - (cam._lastErr_TOO_LARGE || -Infinity) >= CAMERA_ERROR_EVERY_MS) {
                this._sendCameraError(cam, cam.id, 'TOO_LARGE');
                this._notifyCameraDemand({ cameraId: cam.id, fps: cam.fps, maxBytes });
            }
            return next();
        }
        const frame = buildSnapshotFrame({
            v: 1,
            deviceId: this._deviceId,
            cameraId: cam.id,
            ts: this.clock.wall(),
            seq: cam.seq + 1,
            enc: 'none',
        }, buf);
        try {
            ws.send(frame, { binary: true });
            cam.seq += 1;
            if (this._cameraSeqs) this._cameraSeqs.set(cam.id, cam.seq);
            cam.lastBuf = buf;
            cam.lastNewFrameAt = now;
        } catch (_) { /* socket closing */ }
        return next();
    }

    _cameraStop(cameraId, notify) {
        const cam = this._cameras.get(cameraId);
        if (!cam) return;
        if (cam.timer) this.clearTimeoutFn(cam.timer);
        this._cameras.delete(cameraId);
        if (notify) this._notifyCameraDemand({ cameraId, fps: 0 });
    }

    _cameraStopAll(always = false) {
        const had = this._cameras.size > 0;
        for (const id of [...this._cameras.keys()]) this._cameraStop(id, false);
        if (had || always) this._notifyCameraDemand({ cameraId: null, fps: 0 });
    }

    /** RTT sample hook (spec: every sample is forwarded to the gate). */
    onRttSample(ms) {
        this.gate.onRttSample(ms);
    }
}

module.exports = {
    CloudLinkService,
    CLOUD_DEFAULTS,
    normalizeRelayUrl,
    wsUrlFor,
    buildSnapshotFrame,
};
