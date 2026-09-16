/**
 * RemoteAccessService — Dual-mode Remote Access (Local LAN + Global Internet Tunnel)
 * with Industrial-Grade Multi-Layer Security.
 *
 * Capabilities:
 *  1. Local Wi-Fi / LAN parity (direct connection via http://<lan-ip>:<port>).
 *  2. Global Internet Tunnel via secure encrypted HTTPS tunnel (works anywhere
 *     in the world on 5G / cellular / external networks without port forwarding).
 *  3. Mandatory PIN protection for Global Access.
 *  4. Brute-force & Botnet defense: Dynamic rate limiting per IP (5 failed
 *     attempts triggers an automatic 15-minute lockout).
 *  5. Salted scrypt password hashing with high memory/CPU cost.
 *  6. 192-bit cryptographic session tokens with 12-hour expiration.
 *  7. Master Operator Authority: Local loopback (localhost) is never locked out
 *     and can revoke all external sessions at any time.
 */
const os = require('os');
const crypto = require('crypto');
const qrcode = require('qrcode');

let localtunnel = null;
try {
    localtunnel = require('localtunnel');
} catch (_) {
    localtunnel = null;
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function isLoopbackAddress(addr) {
    if (!addr) return false;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Is this request really from the PC at the machine?
 *
 * The socket address alone is NOT proof: the tunnel client runs on this same
 * PC and pipes every internet request into 127.0.0.1, so a loopback-only check
 * treated the whole public URL as the trusted local operator and skipped the
 * PIN entirely (plan item SEC-1). A request that came through a tunnel or a
 * proxy carries the tunnel's own Host / forwarding headers -- those make it
 * remote no matter which address it arrives from.
 */
function isLocalRequest(addr, headers = {}) {
    if (!isLoopbackAddress(addr)) return false;
    if (headers['x-forwarded-for'] || headers['x-forwarded-host'] || headers['x-forwarded-proto'] || headers.forwarded) return false;
    const host = String(headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!host) return false;
    return LOCAL_HOSTS.has(host);
}

class RemoteAccessService {
    constructor({ configStore, port }) {
        this.config = configStore;
        this.port = port;
        this.tokens = new Map(); // token -> { ip, createdAt, expiresAt }
        this.failedAttempts = new Map(); // ip -> { count, lockedUntil }

        // Tunnel state
        this.tunnelInstance = null;
        this.tunnelStatus = 'stopped'; // 'stopped' | 'starting' | 'running' | 'error'
        this.tunnelUrl = null;
        this.tunnelError = null;
        this.tunnelPassword = null;
    }

    // ─── LAN info ───────────────────────────────────────────────────

    getLanIps() {
        const nets = os.networkInterfaces();
        const ips = [];
        for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
                if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
            }
        }
        return ips;
    }

    getInfo() {
        this.cleanupExpiredTokens();
        const lanIps = this.getLanIps();
        const primaryLanIp = lanIps[0] || 'localhost';
        const lanUrl = `http://${primaryLanIp}:${this.port}`;
        const isTunnelRunning = this.tunnelStatus === 'running' && !!this.tunnelUrl;
        const unifiedUrl = isTunnelRunning ? this.tunnelUrl : lanUrl;
        const connectionMode = isTunnelRunning ? 'global' : 'local';

        return {
            ips: lanIps,
            port: this.port,
            pinSet: this.hasPin(),
            tunnel: this.getTunnelStatus(),
            unifiedUrl,
            connectionMode,
            lanUrl,
        };
    }

    async getQrDataUrl(url) {
        return qrcode.toDataURL(url, { margin: 1, width: 260 });
    }

    // ─── PIN management ─────────────────────────────────────────────

    hasPin() {
        return !!this.config.get('remoteAccess.pinHash', null);
    }

    setPin(pin) {
        const str = String(pin || '').trim();
        if (str.length < 4) throw new Error('PIN must be at least 4 characters');
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(str, salt, 64).toString('hex');
        this.config.set('remoteAccess.pinHash', `${salt}:${hash}`);
        this.tokens.clear(); // changing the PIN invalidates every existing remote session
        this.failedAttempts.clear();
    }

    clearPin() {
        // If tunnel is active, stopping tunnel before clearing PIN
        if (this.tunnelStatus === 'running' || this.tunnelStatus === 'starting') {
            this.stopTunnel().catch(() => {});
        }
        this.config.delete('remoteAccess.pinHash');
        this.tokens.clear();
        this.failedAttempts.clear();
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

    verifyPinWithRateLimit(pin, clientIp) {
        if (!this.hasPin()) {
            return { ok: false, error: 'No PIN is set on this machine' };
        }

        const ip = clientIp || 'remote-client';
        const now = Date.now();
        const record = this.failedAttempts.get(ip);

        // Check if currently locked out
        if (record && record.lockedUntil && record.lockedUntil > now) {
            const remainingMinutes = Math.ceil((record.lockedUntil - now) / 60000);
            return {
                ok: false,
                error: `Too many failed attempts. Device locked out for ${remainingMinutes} minute(s).`,
                locked: true,
                remainingMinutes,
            };
        }

        const valid = this.verifyPinRaw(pin);
        if (!valid) {
            const count = (record ? record.count : 0) + 1;
            const locked = count >= MAX_FAILED_ATTEMPTS;
            const lockedUntil = locked ? now + LOCKOUT_DURATION_MS : 0;
            this.failedAttempts.set(ip, { count, lockedUntil });

            if (locked) {
                return {
                    ok: false,
                    error: 'Too many failed attempts. Device locked out for 15 minutes.',
                    locked: true,
                    remainingMinutes: 15,
                };
            }

            const attemptsLeft = Math.max(0, MAX_FAILED_ATTEMPTS - count);
            return {
                ok: false,
                error: `Incorrect PIN. ${attemptsLeft} attempt(s) remaining before temporary lockout.`,
                remainingAttempts: attemptsLeft,
            };
        }

        // Correct PIN! Reset failures and issue token
        this.failedAttempts.delete(ip);
        const token = this.issueToken(ip);
        return { ok: true, token };
    }

    // ─── Session tokens ──────────────────────────────────────────────

    cleanupExpiredTokens() {
        const now = Date.now();
        for (const [token, data] of this.tokens.entries()) {
            const exp = typeof data === 'object' ? data.expiresAt : data;
            if (now > exp) {
                this.tokens.delete(token);
            }
        }
    }

    issueToken(clientIp) {
        this.cleanupExpiredTokens();
        const token = crypto.randomBytes(24).toString('hex');
        this.tokens.set(token, {
            ip: clientIp || 'unknown',
            createdAt: Date.now(),
            expiresAt: Date.now() + TOKEN_TTL_MS,
        });
        return token;
    }

    verifyToken(token) {
        if (!token) return false;
        const data = this.tokens.get(token);
        if (!data) return false;
        const exp = typeof data === 'object' ? data.expiresAt : data;
        if (Date.now() > exp) {
            this.tokens.delete(token);
            return false;
        }
        return true;
    }

    revokeAllSessions() {
        this.tokens.clear();
        return { ok: true };
    }

    getActiveSessions() {
        this.cleanupExpiredTokens();
        return {
            count: this.tokens.size,
            sessions: Array.from(this.tokens.values()).map((s) => ({
                ip: s.ip,
                createdAt: s.createdAt,
            })),
        };
    }

    // ─── Global Tunnel Management ────────────────────────────────────

    async fetchPublicIp() {
        const urls = [
            'https://api.ipify.org',
            'https://icanhazip.com',
            'https://ifconfig.me/ip',
        ];
        const https = require('https');
        for (const u of urls) {
            try {
                const ip = await new Promise((resolve, reject) => {
                    const req = https.get(u, { timeout: 3000 }, (res) => {
                        let d = '';
                        res.on('data', c => d += c);
                        res.on('end', () => resolve(d.trim()));
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                });
                if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
                    return ip;
                }
            } catch (_) {}
        }
        return null;
    }

    async startTunnel() {
        if (!this.hasPin()) {
            throw new Error('A security PIN must be set before enabling Global Remote Access.');
        }
        if (this.tunnelInstance && this.tunnelStatus === 'running') {
            return { ok: true, url: this.tunnelUrl, tunnelPassword: this.tunnelPassword };
        }
        if (!localtunnel) {
            throw new Error('Tunnel subsystem is not available on this server.');
        }

        this.tunnelStatus = 'starting';
        this.tunnelError = null;

        try {
            // Resolve public IP in parallel with tunnel creation
            const ipPromise = this.fetchPublicIp().catch(() => null);

            const tunnel = await localtunnel({ port: this.port });
            this.tunnelInstance = tunnel;
            this.tunnelUrl = tunnel.url;
            this.tunnelStatus = 'running';

            const ip = await ipPromise;
            if (ip) this.tunnelPassword = ip;

            tunnel.on('close', () => {
                if (this.tunnelStatus === 'running') {
                    // Auto-reconnect after 3 seconds if not intentionally stopped
                    setTimeout(() => {
                        if (this.tunnelStatus !== 'stopped') {
                            this.startTunnel().catch(() => {});
                        }
                    }, 3000);
                }
                this.tunnelStatus = 'stopped';
                this.tunnelUrl = null;
                this.tunnelInstance = null;
            });

            tunnel.on('error', (err) => {
                this.tunnelStatus = 'error';
                this.tunnelError = err?.message || String(err);
            });

            return { ok: true, url: this.tunnelUrl, tunnelPassword: this.tunnelPassword };
        } catch (err) {
            this.tunnelStatus = 'error';
            this.tunnelError = err?.message || String(err);
            throw err;
        }
    }

    async stopTunnel() {
        this.tunnelStatus = 'stopped';
        if (this.tunnelInstance) {
            try {
                this.tunnelInstance.close();
            } catch (_) {}
        }
        this.tunnelInstance = null;
        this.tunnelUrl = null;
        this.tunnelError = null;
        return { ok: true };
    }

    getTunnelStatus() {
        this.cleanupExpiredTokens();
        return {
            status: this.tunnelStatus,
            url: this.tunnelUrl,
            error: this.tunnelError,
            tunnelPassword: this.tunnelPassword,
            hasPin: this.hasPin(),
            activeSessions: this.tokens.size,
        };
    }

    // ─── Gates ───────────────────────────────────────────────────────

    /**
     * Which web origins may talk to this server (plan SEC-1).
     *
     * It used to reflect every origin ("cors: {origin: true}"), so ANY page the
     * operator happened to visit could open a socket to http://localhost:4000
     * and drive the machine -- the request comes from the operator's own
     * browser, so it arrives on loopback and passed every check we had. A
     * browser sets Origin honestly and a page cannot forge it, so refusing
     * unknown origins closes that door while leaving the real UI (served from
     * this machine, over localhost, the LAN address or the tunnel) working.
     *
     * No Origin header at all means a non-browser client (curl, a native app);
     * those are still subject to the PIN gate when they are not local.
     */
    isAllowedOrigin(origin) {
        // No Origin header at all = not a browser (curl, a native app).
        // Literal "null" IS a browser: a sandboxed iframe or a file:// page.
        // A hostile page can sandbox an iframe to get exactly that, so it is
        // refused rather than treated as "no origin".
        if (!origin) return true;
        if (origin === 'null') return false;
        let host;
        try {
            host = new URL(origin).hostname.toLowerCase();
        } catch (_) {
            return false;
        }
        if (LOCAL_HOSTS.has(host)) return true;
        if (this.getLanIps().includes(host)) return true;
        if (this.tunnelUrl) {
            try {
                if (new URL(this.tunnelUrl).hostname.toLowerCase() === host) return true;
            } catch (_) { /* malformed tunnel url */ }
        }
        return false;
    }

    /** cors() origin callback for both Express and Socket.IO. */
    corsOrigin() {
        return (origin, cb) => {
            if (this.isAllowedOrigin(origin)) return cb(null, true);
            cb(new Error(`origin not allowed: ${origin}`));
        };
    }

    isLoopback(req) {
        return isLocalRequest(req.ip, req.headers) ||
            isLocalRequest(req.connection && req.connection.remoteAddress, req.headers);
    }

    httpGate() {
        const allow = new Set(['/api/remote/info', '/api/remote/verify-pin', '/api/remote/tunnel/status', '/api/log']);
        return (req, res, next) => {
            // Allow tunnel bypass header
            res.setHeader('bypass-tunnel-reminder', 'true');

            if (!req.path.startsWith('/api/')) return next();
            if (this.isLoopback(req)) return next();
            if (allow.has(req.path)) return next();
            // No PIN set: remote access is OFF, not open. This used to fall
            // through to next() -- anyone on the LAN (or with the tunnel URL)
            // could drive the machine until someone happened to set a PIN.
            if (!this.hasPin()) {
                return res.status(401).json({ error: 'Remote access is off. Set a remote PIN on the machine to allow it.', needsPin: true });
            }
            const token = req.headers['x-remote-token'];
            if (this.verifyToken(token)) return next();
            return res.status(401).json({ error: 'Remote PIN required' });
        };
    }

    socketGate() {
        return (socket, next) => {
            const h = socket.handshake || {};
            if (isLocalRequest(h.address, h.headers || {})) return next();
            if (!this.hasPin()) return next(new Error('Remote access is off. Set a remote PIN on the machine to allow it.'));
            const token = h.auth && h.auth.token;
            if (this.verifyToken(token)) return next();
            next(new Error('Remote PIN required'));
        };
    }
}

module.exports = { RemoteAccessService };
