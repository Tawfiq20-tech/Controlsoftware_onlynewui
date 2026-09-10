/**
 * RemoteAccessService — LAN parity with gSender's "Wireless Control" plus
 * a minimal PIN gate (recommended addition beyond straight gSender parity,
 * since this app already has a standing zero-auth finding — see plan doc).
 *
 * Baseline behavior (no PIN configured): identical to gSender — anyone on
 * the LAN who opens http://<lan-ip>:<port> gets the full app, no login.
 * This matches what Sienci ships and is not a regression from today.
 *
 * With a PIN configured (opt-in, set from Settings on the control PC only):
 * the local machine (loopback) is never gated. Any other LAN client must
 * exchange the PIN for a token once, then send that token on every /api
 * request and on the Socket.IO handshake. The PIN itself is never stored
 * or transmitted in the clear — only a salted scrypt hash is kept on disk.
 */
const os = require('os');
const crypto = require('crypto');
const qrcode = require('qrcode');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // matches plan's "cached client-side after first entry"

function isLoopbackAddress(addr) {
    if (!addr) return false;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

class RemoteAccessService {
    constructor({ configStore, port }) {
        this.config = configStore;
        this.port = port;
        this.tokens = new Map(); // token -> expiresAt(ms)
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
        return { ips: this.getLanIps(), port: this.port, pinSet: this.hasPin() };
    }

    async getQrDataUrl(url) {
        return qrcode.toDataURL(url, { margin: 1, width: 240 });
    }

    // ─── PIN management ─────────────────────────────────────────────

    hasPin() {
        return !!this.config.get('remoteAccess.pinHash', null);
    }

    setPin(pin) {
        const str = String(pin || '');
        if (str.length < 4) throw new Error('PIN must be at least 4 characters');
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(str, salt, 64).toString('hex');
        this.config.set('remoteAccess.pinHash', `${salt}:${hash}`);
        this.tokens.clear(); // changing the PIN invalidates every existing remote session
    }

    clearPin() {
        this.config.delete('remoteAccess.pinHash');
        this.tokens.clear();
    }

    verifyPin(pin) {
        const stored = this.config.get('remoteAccess.pinHash', null);
        if (!stored) return false;
        const [salt, hash] = stored.split(':');
        if (!salt || !hash) return false;
        const check = crypto.scryptSync(String(pin || ''), salt, 64).toString('hex');
        try {
            return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
        } catch (_) {
            return false; // length mismatch etc. -- not a match
        }
    }

    // ─── Session tokens ──────────────────────────────────────────────

    issueToken() {
        const token = crypto.randomBytes(24).toString('hex');
        this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
        return token;
    }

    verifyToken(token) {
        if (!token) return false;
        const exp = this.tokens.get(token);
        if (!exp) return false;
        if (Date.now() > exp) {
            this.tokens.delete(token);
            return false;
        }
        return true;
    }

    // ─── Gates ───────────────────────────────────────────────────────

    isLoopback(req) {
        return isLoopbackAddress(req.ip) || isLoopbackAddress(req.connection && req.connection.remoteAddress);
    }

    /**
     * Express middleware. Only ever gates /api/* — the static frontend
     * shell always loads for anyone on the LAN (same as gSender), so a
     * remote device can at least reach the PIN-entry screen. A small
     * bootstrap allowlist stays open even once a PIN is set, so the UI can
     * ask "is a PIN required" and exchange one for a token.
     */
    httpGate() {
        const allow = new Set(['/api/remote/info', '/api/remote/verify-pin', '/api/log']);
        return (req, res, next) => {
            if (!req.path.startsWith('/api/')) return next();
            if (this.isLoopback(req)) return next();
            if (!this.hasPin()) return next(); // opt-in: same zero-auth baseline as gSender until a PIN is set
            if (allow.has(req.path)) return next();
            const token = req.headers['x-remote-token'];
            if (this.verifyToken(token)) return next();
            return res.status(401).json({ error: 'Remote PIN required' });
        };
    }

    /** Socket.IO handshake middleware — same rule as httpGate(). */
    socketGate() {
        return (socket, next) => {
            const addr = socket.handshake.address || '';
            if (isLoopbackAddress(addr) || addr.endsWith('127.0.0.1')) return next();
            if (!this.hasPin()) return next();
            const token = socket.handshake.auth && socket.handshake.auth.token;
            if (this.verifyToken(token)) return next();
            next(new Error('Remote PIN required'));
        };
    }
}

module.exports = { RemoteAccessService };
