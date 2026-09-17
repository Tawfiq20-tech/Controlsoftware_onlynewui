/**
 * RemoteAccessService — remote access over the local network or a Tailscale
 * tailnet, with an optional PIN gate.
 *
 * Reachability is not this service's job: a phone reaches the PC directly on
 * the same Wi-Fi, or from anywhere over Tailscale's end-to-end encrypted
 * WireGuard mesh (see TailscaleService.js). The old public relay
 * (localtunnel) was removed: a relay that connects to localhost makes every
 * internet visitor look like the operator sitting at the PC, and the relay
 * operator could read all traffic.
 *
 * Trust model (identify() returns one of these kinds, or null)
 *  - operator: a request from this PC (loopback socket, not proxied) that also
 *    carries the kiosk operator cookie (OperatorToken.js). Without an
 *    operatorToken configured, loopback alone is the operator (legacy).
 *  - local:    loopback, not proxied, but no operator cookie — e.g. a second
 *    browser on the PC. Full local machine control and no PIN, but none of
 *    the operator-only administration.
 *  - lan:      everything else (LAN, Tailscale). Once a PIN is set it needs a
 *    session, obtained from POST /api/remote/verify-pin and presented as the
 *    X-Remote-Token header, the Socket.IO auth token, or an HttpOnly cookie
 *    (the cookie is what lets <img> camera streams and every fetch work).
 *  - Browser guard: requests whose Host or Origin don't belong to this
 *    machine are refused, so a web page open in a browser on the PC can't
 *    drive the machine through http://localhost (drive-by / DNS rebinding).
 *
 * Never expose the port through a raw TCP forwarder (ssh -R, ngrok tcp,
 * localtunnel): those connect from localhost without proxy headers and are
 * indistinguishable from the operator.
 */
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const qrcode = require('qrcode');
const { OPERATOR_COOKIE, IDENTITY_KINDS } = require('./OperatorToken');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // sliding: renewed on use
const SESSION_TOUCH_PERSIST_MS = 10 * 60 * 1000;   // throttle lastSeen writes
const MIN_PIN_LENGTH = 6;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
// Per-IP lockout alone is useless against guesses from many addresses, so
// failures across all clients are also capped.
const GLOBAL_FAIL_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_FAIL_LIMIT = 30;
const GLOBAL_COOLDOWN_MS = 5 * 60 * 1000;
// Operator claims have their own limiter that only loopback, non-proxied
// failures can raise, so PIN guesses from the LAN never lock the kiosk out.
const CLAIM_FAIL_WINDOW_MS = 15 * 60 * 1000;
const CLAIM_FAIL_LIMIT = 20;

// Room joined by every socket with local control (operator and local).
// Secret-bearing pushes (notification services, camera URLs, full config)
// go only to this room.
const LOCAL_ROOM = 'local';
const OPERATOR_ROOM = 'operator';

const SESSION_COOKIE = 'cnc_remote_session';
const PIN_SOURCES = ['custom', 'access-code'];

// Headers that mean "a proxy relayed this request". Their presence on a
// loopback socket means the real client is somewhere else. X-Forwarded-For
// is checked separately: a same-PC dev proxy (Vite, xfwd) only lists
// loopback addresses and is still the operator.
const PROXY_IDENTITY_HEADERS = ['forwarded', 'cf-connecting-ip', 'true-client-ip', 'tailscale-user-login', 'fly-client-ip'];

// Private/internal DNS suffixes that public DNS can't point at 127.0.0.1,
// so they can't be used for DNS rebinding.
const LOCAL_HOST_SUFFIX = /\.(local|lan|home|internal|localdomain|home\.arpa|ts\.net)$/;

function normalizeAddress(addr) {
    if (!addr) return '';
    let a = String(addr).trim().toLowerCase();
    if (a.startsWith('[') && a.includes(']')) a = a.slice(1, a.indexOf(']'));
    if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
    return a;
}

function isLoopbackAddress(addr) {
    const a = normalizeAddress(addr);
    if (!a) return false;
    if (a === '::1') return true;
    return net.isIPv4(a) && a.startsWith('127.');
}

/** Tailscale assigns 100.64.0.0/10 (CGNAT range) and fd7a:115c:a1e0::/48. */
function isTailscaleAddress(addr) {
    const a = normalizeAddress(addr);
    if (net.isIPv4(a)) {
        const [o1, o2] = a.split('.').map(Number);
        return o1 === 100 && o2 >= 64 && o2 <= 127;
    }
    return a.startsWith('fd7a:115c:a1e0:');
}

function isProxied(headers) {
    const h = headers || {};
    if (PROXY_IDENTITY_HEADERS.some((name) => h[name] !== undefined)) return true;
    const realIp = h['x-real-ip'];
    if (realIp !== undefined && !isLoopbackAddress(realIp)) return true;
    const xff = h['x-forwarded-for'];
    if (xff !== undefined) {
        const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
        if (hops.some((hop) => !isLoopbackAddress(hop))) return true;
    }
    return false;
}

/** "host:port", "[::1]:4000", "Host.Example." → bare lowercase hostname. */
function hostnameOf(hostHeader) {
    if (!hostHeader) return '';
    let h = String(hostHeader).trim().toLowerCase();
    if (h.startsWith('[')) {
        const end = h.indexOf(']');
        return end > 0 ? h.slice(1, end) : '';
    }
    // A bare IPv6 literal has several colons; host:port has exactly one.
    if ((h.match(/:/g) || []).length === 1) h = h.slice(0, h.indexOf(':'));
    return h.replace(/\.$/, '');
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const key = part.slice(0, eq).trim();
        if (!key) continue;
        try {
            out[key] = decodeURIComponent(part.slice(eq + 1).trim());
        } catch (_) {
            out[key] = part.slice(eq + 1).trim();
        }
    }
    return out;
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function describeDevice(userAgent) {
    const ua = String(userAgent || '');
    const platform = /iPhone/.test(ua) ? 'iPhone'
        : /iPad/.test(ua) ? 'iPad'
        : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
        : /Linux/.test(ua) ? 'Linux'
        : '';
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /OPR\//.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
        : '';
    return [browser, platform].filter(Boolean).join(' on ') || 'Unknown device';
}

class RemoteAccessService {
    /**
     * @param {object} opts
     * @param {object} opts.configStore       ConfigStore (get/set/delete)
     * @param {number} opts.port
     * @param {() => string[]} [opts.getTrustedHostnames]  extra names that
     *        belong to this PC (e.g. its Tailscale MagicDNS name)
     * @param {import('./OperatorToken').OperatorToken} [opts.operatorToken]
     *        kiosk second factor; when absent, loopback alone is the operator
     */
    constructor({ configStore, port, getTrustedHostnames, operatorToken }) {
        this.config = configStore;
        this.port = port;
        this.getTrustedHostnames = getTrustedHostnames || (() => []);
        this.operatorToken = operatorToken || null;
        this.sessions = new Map();        // sha256(token) -> session
        this.lastPersisted = new Map();   // sha256(token) -> ms of last lastSeen write
        this.failedAttempts = new Map();  // ip -> { count, lockedUntil }
        this.globalFailures = [];         // timestamps of recent failures (any IP)
        this.globalCooldownUntil = 0;
        this.claimFailures = [];          // timestamps of recent loopback claim failures
        this.claimCooldownUntil = 0;
        // Live Socket.IO sockets admitted by socketGate. Revoking a session,
        // changing the PIN or rotating the operator token must reach them:
        // their identity was fixed at the handshake.
        this._sockets = new Set();
        this._loadSessions();
    }

    // ─── Addresses ──────────────────────────────────────────────────

    /** Non-internal IPv4 addresses, split into LAN and Tailscale. */
    getAddresses() {
        const lan = [];
        const tailscale = [];
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const addr of nets[name] || []) {
                if (addr.family !== 'IPv4' && addr.family !== 4) continue;
                if (addr.internal) continue;
                if (addr.address.startsWith('169.254.')) continue; // link-local, unreachable
                (isTailscaleAddress(addr.address) ? tailscale : lan).push(addr.address);
            }
        }
        return { lan, tailscale };
    }

    /** Kept for callers that only want LAN addresses. */
    getLanIps() {
        return this.getAddresses().lan;
    }

    getInfo({ authorized = true, operator = false } = {}) {
        const pinSet = this.hasPin();
        if (!authorized) {
            // Unauthenticated remote: just enough to show the PIN screen.
            return { pinSet, authorized: false, operator: false, minPinLength: MIN_PIN_LENGTH };
        }
        const { lan } = this.getAddresses();
        const lanUrls = lan.map((ip) => `http://${ip}:${this.port}`);
        return {
            authorized: true,
            operator,
            pinSet,
            pinSource: this.getPinSource(),
            minPinLength: MIN_PIN_LENGTH,
            port: this.port,
            ips: lan,
            lanUrl: lanUrls[0] || null,
            lanUrls,
            unifiedUrl: lanUrls[0] || `http://localhost:${this.port}`,
            activeSessions: this.getActiveSessions().count,
        };
    }

    async getQrDataUrl(url) {
        return qrcode.toDataURL(url, { margin: 1, width: 260 });
    }

    // ─── PIN ────────────────────────────────────────────────────────

    hasPin() {
        return !!this.config.get('remoteAccess.pinHash', null);
    }

    setPin(pin, { source = 'custom' } = {}) {
        const str = String(pin || '').trim();
        if (str.length < MIN_PIN_LENGTH) {
            throw new Error(`PIN must be at least ${MIN_PIN_LENGTH} characters`);
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(str, salt, 64).toString('hex');
        this.config.set('remoteAccess.pinHash', `${salt}:${hash}`);
        this.config.set('remoteAccess.pinSource', PIN_SOURCES.includes(source) ? source : 'custom');
        // A new PIN invalidates every existing remote session, and every LAN
        // socket (including ones admitted while no PIN was set).
        this.revokeAllSessions();
        this.disconnectSockets((id) => !!id && id.kind === 'lan', 'pin_changed');
        this.failedAttempts.clear();
        this.globalFailures = [];
        this.globalCooldownUntil = 0;
    }

    /** 'custom' | 'access-code' | null. Not secret. */
    getPinSource() {
        if (!this.hasPin()) return null;
        const source = this.config.get('remoteAccess.pinSource', null);
        // A PIN stored before sources existed was typed by the operator.
        return PIN_SOURCES.includes(source) ? source : 'custom';
    }

    clearPin() {
        this.config.delete('remoteAccess.pinHash');
        this.config.delete('remoteAccess.pinSource');
        this.revokeAllSessions();
        this.failedAttempts.clear();
        this.globalFailures = [];
        this.globalCooldownUntil = 0;
    }

    verifyPinRaw(pin) {
        const stored = this.config.get('remoteAccess.pinHash', null);
        if (!stored) return false;
        const [salt, hash] = stored.split(':');
        if (!salt || !hash) return false;
        const check = crypto.scryptSync(String(pin || '').trim(), salt, 64).toString('hex');
        try {
            return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
        } catch (_) {
            return false;
        }
    }

    verifyPinWithRateLimit(pin, clientIp, { userAgent } = {}) {
        if (!this.hasPin()) {
            return { ok: false, error: 'No PIN is set on this machine' };
        }

        const ip = normalizeAddress(clientIp) || 'remote-client';
        const now = Date.now();

        if (this.globalCooldownUntil > now) {
            const remainingMinutes = Math.ceil((this.globalCooldownUntil - now) / 60000);
            return {
                ok: false,
                error: `Too many failed PIN attempts on this machine. Try again in ${remainingMinutes} minute(s).`,
                locked: true,
                global: true,
                remainingMinutes,
            };
        }

        let record = this.failedAttempts.get(ip);
        if (record && record.lockedUntil) {
            if (record.lockedUntil > now) {
                const remainingMinutes = Math.ceil((record.lockedUntil - now) / 60000);
                return {
                    ok: false,
                    error: `Too many failed attempts. Device locked out for ${remainingMinutes} minute(s).`,
                    locked: true,
                    remainingMinutes,
                };
            }
            // Lockout served: start counting from zero again.
            this.failedAttempts.delete(ip);
            record = null;
        }

        if (!this.verifyPinRaw(pin)) {
            this._noteGlobalFailure(now);
            const count = (record ? record.count : 0) + 1;
            if (count >= MAX_FAILED_ATTEMPTS) {
                this.failedAttempts.set(ip, { count, lockedUntil: now + LOCKOUT_DURATION_MS });
                return {
                    ok: false,
                    error: 'Too many failed attempts. Device locked out for 15 minutes.',
                    locked: true,
                    remainingMinutes: 15,
                };
            }
            this.failedAttempts.set(ip, { count, lockedUntil: 0 });
            const attemptsLeft = MAX_FAILED_ATTEMPTS - count;
            return {
                ok: false,
                error: `Incorrect PIN. ${attemptsLeft} attempt(s) remaining before temporary lockout.`,
                remainingAttempts: attemptsLeft,
            };
        }

        this.failedAttempts.delete(ip);
        const token = this.issueToken(ip, userAgent);
        return { ok: true, token };
    }

    _noteGlobalFailure(now) {
        this.globalFailures = this.globalFailures.filter((t) => now - t < GLOBAL_FAIL_WINDOW_MS);
        this.globalFailures.push(now);
        if (this.globalFailures.length >= GLOBAL_FAIL_LIMIT) {
            this.globalCooldownUntil = now + GLOBAL_COOLDOWN_MS;
            this.globalFailures = [];
        }
    }

    // ─── Sessions ───────────────────────────────────────────────────
    // Only sha256(token) is stored (and persisted), so a leaked
    // remote-access.json can't be replayed as a session.

    _loadSessions() {
        const saved = this.config.get('remoteAccess.sessions', null);
        if (!saved || typeof saved !== 'object') return;
        const now = Date.now();
        for (const [hash, s] of Object.entries(saved)) {
            if (s && typeof s === 'object' && s.expiresAt > now) {
                this.sessions.set(hash, s);
            }
        }
    }

    _persistSessions() {
        const obj = {};
        for (const [hash, s] of this.sessions.entries()) obj[hash] = s;
        this.config.set('remoteAccess.sessions', obj);
    }

    cleanupExpiredTokens() {
        const now = Date.now();
        const expired = [];
        for (const [hash, s] of this.sessions.entries()) {
            if (now > s.expiresAt) {
                this.sessions.delete(hash);
                this.lastPersisted.delete(hash);
                expired.push(s.id);
            }
        }
        if (expired.length) {
            this._persistSessions();
            this._disconnectSessions(expired, 'session_expired');
        }
    }

    issueToken(clientIp, userAgent) {
        this.cleanupExpiredTokens();
        const token = crypto.randomBytes(24).toString('hex');
        const hash = hashToken(token);
        const now = Date.now();
        this.sessions.set(hash, {
            id: hash.slice(0, 12),
            ip: normalizeAddress(clientIp) || 'unknown',
            device: describeDevice(userAgent),
            via: isTailscaleAddress(clientIp) ? 'tailscale' : 'lan',
            createdAt: now,
            lastSeen: now,
            expiresAt: now + SESSION_TTL_MS,
        });
        this.lastPersisted.set(hash, now);
        this._persistSessions();
        return token;
    }

    verifyToken(token) {
        return !!this.resolveSession(token);
    }

    /** The session behind a token (a copy), renewing its sliding expiry; null when invalid. */
    resolveSession(token) {
        if (!token || typeof token !== 'string') return null;
        const hash = hashToken(token);
        const session = this.sessions.get(hash);
        if (!session) return null;
        const now = Date.now();
        if (now > session.expiresAt) {
            this.sessions.delete(hash);
            this.lastPersisted.delete(hash);
            this._persistSessions();
            this._disconnectSessions([session.id], 'session_expired');
            return null;
        }
        // Sliding expiry: a device in regular use never gets logged out.
        session.lastSeen = now;
        session.expiresAt = now + SESSION_TTL_MS;
        if (now - (this.lastPersisted.get(hash) || 0) > SESSION_TOUCH_PERSIST_MS) {
            this.lastPersisted.set(hash, now);
            this._persistSessions();
        }
        const { id, ip, device, via, createdAt, lastSeen, expiresAt } = session;
        return { id, ip, device, via, createdAt, lastSeen, expiresAt };
    }

    revokeToken(token) {
        if (!token || typeof token !== 'string') return false;
        const hash = hashToken(token);
        const session = this.sessions.get(hash);
        const existed = this.sessions.delete(hash);
        this.lastPersisted.delete(hash);
        if (existed) {
            this._persistSessions();
            this._disconnectSessions([session.id], 'session_revoked');
        }
        return existed;
    }

    revokeSession(id) {
        for (const [hash, s] of this.sessions.entries()) {
            if (s.id === id) {
                this.sessions.delete(hash);
                this.lastPersisted.delete(hash);
                this._persistSessions();
                this._disconnectSessions([s.id], 'session_revoked');
                return true;
            }
        }
        return false;
    }

    revokeAllSessions() {
        this.sessions.clear();
        this.lastPersisted.clear();
        this._persistSessions();
        this.disconnectSockets((id) => !!id && id.kind === 'lan' && !!id.sessionId, 'session_revoked');
        return { ok: true };
    }

    /**
     * True while a LAN identity captured at a socket handshake is still
     * valid: its session exists and has not expired, or (no-PIN identity) no
     * PIN has been set since. Checked on every LAN socket packet.
     */
    isLanIdentityCurrent(identity) {
        if (!identity || identity.kind !== 'lan') return false;
        if (identity.sessionId) {
            const now = Date.now();
            for (const s of this.sessions.values()) {
                if (s.id === identity.sessionId) return now <= s.expiresAt;
            }
            return false;
        }
        return !this.hasPin();
    }

    // ─── Live sockets ───────────────────────────────────────────────

    _trackSocket(socket) {
        // Drop entries whose transport is already gone (e.g. a handshake a
        // later middleware refused) so the set cannot grow without bound.
        for (const s of this._sockets) {
            if (s.conn && s.conn.readyState === 'closed') this._sockets.delete(s);
        }
        this._sockets.add(socket);
        if (typeof socket.once === 'function') socket.once('disconnect', () => this._sockets.delete(socket));
    }

    /**
     * Disconnects every tracked socket whose handshake identity matches.
     * @returns {number} how many were disconnected
     */
    disconnectSockets(predicate, reason = 'revoked', { reconnect = false } = {}) {
        let count = 0;
        for (const socket of [...this._sockets]) {
            let match = false;
            try { match = !!predicate(socket.data && socket.data.identity, socket); } catch (_) { match = false; }
            if (!match) continue;
            this._sockets.delete(socket);
            try { socket.data.revokedReason = reason; } catch (_) { /* no data */ }
            try {
                // reconnect: close only the transport, so the client
                // reconnects by itself and is identified afresh (kiosk after
                // an operator token rotation). Otherwise an explicit server
                // disconnect, which the client does not retry.
                if (reconnect && socket.conn && typeof socket.conn.close === 'function') socket.conn.close();
                else socket.disconnect(true);
            } catch (_) { /* already gone */ }
            count += 1;
        }
        return count;
    }

    _disconnectSessions(ids, reason) {
        const set = new Set(ids);
        return this.disconnectSockets((id) => !!id && id.kind === 'lan' && !!id.sessionId && set.has(id.sessionId), reason);
    }

    /** Operator token rotated: sockets authenticated with the old cookie must reconnect. */
    disconnectOperatorSockets(reason = 'operator_token_rotated') {
        return this.disconnectSockets((id) => isOperatorIdentity(id), reason, { reconnect: true });
    }

    getActiveSessions() {
        this.cleanupExpiredTokens();
        const sessions = Array.from(this.sessions.values())
            .map(({ id, ip, device, via, createdAt, lastSeen, expiresAt }) => ({ id, ip, device, via, createdAt, lastSeen, expiresAt }))
            .sort((a, b) => b.lastSeen - a.lastSeen);
        return { count: sessions.length, sessions };
    }

    /** Session token from X-Remote-Token or the session cookie. */
    tokenFromRequest(req) {
        const headers = (req && req.headers) || {};
        return headers['x-remote-token'] || parseCookies(headers.cookie)[SESSION_COOKIE] || null;
    }

    sessionCookie(token) {
        return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
    }

    clearedSessionCookie() {
        return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    }

    // ─── Who is asking ──────────────────────────────────────────────

    /** True only for a request made on this PC and not relayed by a proxy. */
    isLoopback(req) {
        if (!req) return false;
        return isLoopbackAddress(requestAddress(req)) && !isProxied(req.headers);
    }

    /**
     * Loopback AND the kiosk operator cookie. A header-less TCP forwarder
     * also arrives from 127.0.0.1, so loopback alone is not proof.
     */
    isOperator(req) {
        if (!this.isLoopback(req)) return false;
        return this._hasOperatorCookie(req.headers);
    }

    isOperatorHandshake(handshake) {
        const hs = handshake || {};
        const headers = hs.headers || {};
        if (!isLoopbackAddress(hs.address) || isProxied(headers)) return false;
        return this._hasOperatorCookie(headers);
    }

    _hasOperatorCookie(headers) {
        if (!this.operatorToken) return true;
        const value = parseCookies((headers || {}).cookie)[OPERATOR_COOKIE];
        return this.operatorToken.verifyCookie(value);
    }

    /**
     * @returns {{kind:'operator'} | {kind:'local'} | {kind:'lan', sessionId:string|null, ip:string, via:string} | null}
     * null means "nobody we recognise" (unauthenticated remote while a PIN is set).
     */
    identify(req) {
        if (!req) return null;
        const loopback = this.isLoopback(req);
        return this._resolveIdentity({
            loopback,
            operator: loopback && this._hasOperatorCookie(req.headers),
            token: this.tokenFromRequest(req),
            ip: requestAddress(req),
        });
    }

    identifyHandshake(handshake) {
        const hs = handshake || {};
        const headers = hs.headers || {};
        const loopback = isLoopbackAddress(hs.address) && !isProxied(headers);
        return this._resolveIdentity({
            loopback,
            operator: loopback && this._hasOperatorCookie(headers),
            token: (hs.auth && hs.auth.token) || headers['x-remote-token'] || parseCookies(headers.cookie)[SESSION_COOKIE] || null,
            ip: hs.address,
        });
    }

    _resolveIdentity({ loopback, operator, token, ip }) {
        if (operator) return { kind: 'operator' };
        // Unverified loopback keeps full local control but no operator powers.
        if (loopback) return { kind: 'local' };
        const clientIp = normalizeAddress(ip) || 'unknown';
        const session = this.resolveSession(token);
        if (session) return { kind: 'lan', sessionId: session.id, ip: clientIp, via: session.via };
        if (!this.hasPin()) return { kind: 'lan', sessionId: null, ip: clientIp, via: 'no-pin' };
        return null;
    }

    /** Operator, local, no PIN configured, or a valid remote session. */
    isAuthorized(req) {
        return !!this.identify(req);
    }

    /**
     * POST /api/remote/operator/claim has its own cooldown. Only failed
     * loopback claims (the caller refuses non-loopback claims before any
     * accounting) raise it, so remote PIN guesses can never keep the kiosk
     * from claiming operator. A failed loopback claim still also counts
     * toward the global PIN cooldown (spec 6.5).
     */
    isOperatorClaimBlocked() {
        return this.claimCooldownUntil > Date.now();
    }

    noteFailedOperatorClaim() {
        const now = Date.now();
        this.claimFailures = this.claimFailures.filter((t) => now - t < CLAIM_FAIL_WINDOW_MS);
        this.claimFailures.push(now);
        if (this.claimFailures.length >= CLAIM_FAIL_LIMIT) {
            this.claimCooldownUntil = now + GLOBAL_COOLDOWN_MS;
            this.claimFailures = [];
        }
        this._noteGlobalFailure(now);
    }

    // ─── Browser guard (drive-by / DNS rebinding) ───────────────────

    /** Hostnames and addresses that belong to this PC. */
    isOwnHostname(hostname) {
        const h = normalizeAddress(hostname).replace(/\.$/, '');
        if (!h) return false;
        if (h === 'localhost' || isLoopbackAddress(h)) return true;
        const machine = os.hostname().toLowerCase();
        if (h === machine || h === `${machine}.local`) return true;
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const addr of nets[name] || []) {
                if (normalizeAddress(addr.address) === h) return true;
            }
        }
        const extra = [
            ...(this.getTrustedHostnames() || []),
            ...(this.config.get('remoteAccess.allowedHosts', []) || []),
        ];
        return extra.some((name) => name && String(name).toLowerCase().replace(/\.$/, '') === h);
    }

    isAllowedHost(hostHeader) {
        if (!hostHeader) return true; // HTTP/1.0 and non-browser clients
        const h = hostnameOf(hostHeader);
        if (!h) return false;
        if (net.isIP(normalizeAddress(h))) return true; // DNS rebinding needs a name
        if (!h.includes('.')) return true;               // single-label: localhost, PC name
        if (LOCAL_HOST_SUFFIX.test(h)) return true;
        return this.isOwnHostname(h);
    }

    isAllowedOrigin(origin, hostHeader) {
        if (origin === undefined || origin === null || origin === '') return true;
        let url;
        try {
            url = new URL(origin);
        } catch (_) {
            return false; // includes the opaque "null" origin (file://, sandboxed frames)
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        const h = normalizeAddress(url.hostname).replace(/\.$/, '');
        if (hostHeader && h === hostnameOf(hostHeader)) return true; // same host, any port
        return this.isOwnHostname(h);
    }

    /** @returns {string|null} refusal reason, or null when the request is fine. */
    checkBrowserRequest(headers) {
        const h = headers || {};
        if (!this.isAllowedHost(h.host)) return 'Host not allowed';
        if (h.origin !== undefined) {
            if (!this.isAllowedOrigin(h.origin, h.host)) return 'Cross-site request refused';
        } else if (h['sec-fetch-site'] === 'cross-site') {
            // e.g. <img src="http://localhost:4000/api/..."> on another site
            return 'Cross-site request refused';
        }
        return null;
    }

    /** Express middleware for /api/*. Mount before httpGate(). */
    requestGuard() {
        return (req, res, next) => {
            if (!req.path.startsWith('/api/')) return next();
            const reason = this.checkBrowserRequest(req.headers);
            if (reason) return res.status(403).json({ error: reason });
            return next();
        };
    }

    /** Per-request CORS options: reflect only this machine's own origins. */
    corsOptionsDelegate() {
        return (req, callback) => {
            const allowed = !!req.headers.origin && this.isAllowedOrigin(req.headers.origin, req.headers.host);
            callback(null, { origin: allowed, credentials: true });
        };
    }

    /** Socket.IO `allowRequest`: same guard for polling and WebSocket handshakes. */
    socketAllowRequest() {
        return (req, callback) => {
            const reason = this.checkBrowserRequest(req.headers);
            callback(reason, !reason);
        };
    }

    // ─── Gates ──────────────────────────────────────────────────────

    httpGate() {
        const open = new Set(['/api/remote/info', '/api/remote/verify-pin', '/api/remote/logout', '/api/log']);
        return (req, res, next) => {
            // Downstream filters rely on remoteIdentity being set on every path.
            const identity = this.identify(req);
            req.remoteIdentity = identity;
            if (!req.path.startsWith('/api/')) return next();
            if (identity) return next();
            if (open.has(req.path)) return next();
            return res.status(401).json({ error: 'Remote PIN required' });
        };
    }

    socketGate() {
        return (socket, next) => {
            const identity = this.identifyHandshake(socket.handshake);
            if (!identity) return next(new Error('Remote PIN required'));
            if (!socket.data || typeof socket.data !== 'object') socket.data = {};
            socket.data.identity = identity;
            if (typeof socket.join === 'function') {
                if (hasLocalControl(identity)) socket.join(LOCAL_ROOM);
                if (isOperatorIdentity(identity)) socket.join(OPERATOR_ROOM);
            }
            this._trackSocket(socket);
            return next();
        };
    }
}

/**
 * The one predicate for "someone at this PC is driving the machine" (D1):
 * operator and local both skip the LAN allowlist AND must feed the
 * operator activity tap (gate.onLocalCommand), otherwise local motion would
 * not cancel remote jogs or set the local-activity lock. Only
 * requireOperator tells the two apart.
 */
function hasLocalControl(identity) {
    return !!identity && (identity.kind === 'operator' || identity.kind === 'local');
}

function isOperatorIdentity(identity) {
    return !!identity && identity.kind === 'operator';
}

function requestAddress(req) {
    return (req.socket && req.socket.remoteAddress)
        || (req.connection && req.connection.remoteAddress)
        || req.ip;
}

module.exports = {
    RemoteAccessService,
    hasLocalControl,
    isOperatorIdentity,
    // exported for tests
    isLoopbackAddress,
    isTailscaleAddress,
    isProxied,
    hostnameOf,
    parseCookies,
    MIN_PIN_LENGTH,
    SESSION_COOKIE,
    LOCAL_ROOM,
    OPERATOR_ROOM,
    OPERATOR_COOKIE,
    IDENTITY_KINDS,
};
