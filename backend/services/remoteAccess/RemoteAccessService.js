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
const MIN_LAN_PIN_LENGTH = 4;
const MIN_TUNNEL_PIN_LENGTH = 6;
const TUNNEL_CONNECT_TIMEOUT_MS = 15 * 1000; // 15 seconds — observed live hangs/502s past this

function isLoopbackAddress(addr) {
    if (!addr) return false;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
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
        return {
            ips: this.getLanIps(),
            port: this.port,
            pinSet: this.hasPin(),
            tunnel: this.getTunnelStatus(),
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
        if (str.length < MIN_LAN_PIN_LENGTH) throw new Error(`PIN must be at least ${MIN_LAN_PIN_LENGTH} characters`);
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(str, salt, 64).toString('hex');
        this.config.set('remoteAccess.pinHash', `${salt}:${hash}`);
        // Only the hash is persisted (never the plaintext), so the length
        // is stored separately to let startTunnel() enforce a stronger
        // minimum for internet-facing access without re-prompting for the PIN.
        this.config.set('remoteAccess.pinLength', str.length);
        this.tokens.clear(); // changing the PIN invalidates every existing remote session
        this.failedAttempts.clear();
    }

    clearPin() {
        // If tunnel is active, stopping tunnel before clearing PIN
        if (this.tunnelStatus === 'running' || this.tunnelStatus === 'starting') {
            this.stopTunnel().catch(() => {});
        }
        this.config.delete('remoteAccess.pinHash');
        this.config.delete('remoteAccess.pinLength');
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

    // localtunnel's connect promise has been observed to hang indefinitely
    // (or resolve to a 502/503-serving tunnel) against the real loca.lt
    // service. Race it against a hard timeout so the UI gets a real error
    // instead of sitting in 'starting' forever; if the tunnel resolves late
    // (after we've already given up), close it immediately so it doesn't
    // leak an unmanaged public endpoint.
    _connectTunnelWithTimeout(timeoutMs) {
        let timedOut = false;
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                reject(new Error(`Tunnel did not connect within ${Math.round(timeoutMs / 1000)}s. The tunnel service may be unreachable or overloaded — try again later.`));
            }, timeoutMs);
        });

        const connectPromise = localtunnel({ port: this.port }).then((tunnel) => {
            clearTimeout(timer);
            if (timedOut) {
                try { tunnel.close(); } catch (_) {}
                return null; // already rejected via timeoutPromise; this branch is unreachable in the race below
            }
            return tunnel;
        }, (err) => {
            clearTimeout(timer);
            throw err;
        });

        return Promise.race([connectPromise, timeoutPromise]);
    }

    async startTunnel() {
        if (!this.hasPin()) {
            throw new Error('A security PIN must be set before enabling Global Remote Access.');
        }
        const pinLength = this.config.get('remoteAccess.pinLength', 0);
        if (pinLength < MIN_TUNNEL_PIN_LENGTH) {
            throw new Error(`Internet tunnel requires a PIN of at least ${MIN_TUNNEL_PIN_LENGTH} characters. Set a longer PIN first.`);
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
            const tunnel = await this._connectTunnelWithTimeout(TUNNEL_CONNECT_TIMEOUT_MS);
            this.tunnelInstance = tunnel;
            this.tunnelUrl = tunnel.url;
            this.tunnelStatus = 'running';

            // Query public IP for localtunnel prompt reminder
            try {
                const https = require('https');
                https.get('https://loca.lt/mytunnelpassword', (res) => {
                    let d = '';
                    res.on('data', (c) => d += c);
                    res.on('end', () => {
                        if (d.trim()) this.tunnelPassword = d.trim();
                    });
                }).on('error', () => {});
            } catch (_) {}

            tunnel.on('close', () => {
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
        if (this.tunnelInstance) {
            try {
                this.tunnelInstance.close();
            } catch (_) {}
        }
        this.tunnelInstance = null;
        this.tunnelStatus = 'stopped';
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

    isLoopback(req) {
        // req.ip resolves via Express's `trust proxy` setting (see index.js:
        // 'loopback' — trusts X-Forwarded-For only when the direct peer is
        // loopback). Do NOT also fall back to req.connection.remoteAddress:
        // that is unconditionally loopback for ALL localtunnel-relayed
        // traffic (the tunnel client always connects to localhost), so an
        // OR-fallback there would let any internet visitor through the
        // tunnel bypass the PIN gate entirely.
        return isLoopbackAddress(req.ip);
    }

    httpGate() {
        const allow = new Set(['/api/remote/info', '/api/remote/verify-pin', '/api/remote/tunnel/status', '/api/log']);
        return (req, res, next) => {
            // Allow tunnel bypass header
            res.setHeader('bypass-tunnel-reminder', 'true');

            if (!req.path.startsWith('/api/')) return next();
            if (this.isLoopback(req)) return next();
            if (!this.hasPin()) return next();
            if (allow.has(req.path)) return next();
            const token = req.headers['x-remote-token'];
            if (this.verifyToken(token)) return next();
            return res.status(401).json({ error: 'Remote PIN required' });
        };
    }

    socketGate() {
        return (socket, next) => {
            // Socket.IO does NOT inherit Express's `trust proxy` setting:
            // engine.io sets handshake.address straight from
            // req.connection.remoteAddress, never consulting X-Forwarded-For
            // (confirmed by reading engine.io/build/socket.js and
            // socket.io/dist/socket.js). So handshake.address is always
            // loopback for tunnel-relayed traffic, same as the raw HTTP
            // case fix #2 addresses. Replicate the same loopback-trusts-XFF
            // logic manually here using the raw handshake headers, which
            // ARE the unmodified request headers and do carry a real
            // X-Forwarded-For from the tunnel relay.
            const rawAddr = socket.handshake.address || '';
            let effectiveAddr = rawAddr;
            if (isLoopbackAddress(rawAddr)) {
                const xff = socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
                if (xff) effectiveAddr = String(xff).split(',')[0].trim();
            }
            if (isLoopbackAddress(effectiveAddr)) return next();
            if (!this.hasPin()) return next();
            const token = socket.handshake.auth && socket.handshake.auth.token;
            if (this.verifyToken(token)) return next();
            next(new Error('Remote PIN required'));
        };
    }
}

module.exports = { RemoteAccessService };
