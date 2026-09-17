'use strict';

const { randomToken, sha256hex, safeEqual } = require('./tokens');

const SLIDING_MS = 14 * 86400000;
const ABSOLUTE_MS = 30 * 86400000;
const LAST_SEEN_WRITE_MS = 5 * 60000;

class Sessions {
    constructor({ db, clock, logger }) {
        this.db = db;
        this.clock = clock;
        this.logger = logger;
        // token_hash -> {userId, expiresAt, absExpiresAt, csrfToken, lastSeenWrite}
        this.index = new Map();
        this.listeners = [];
        this.lastRevocationId = 0;
        this._loadIndex();
    }

    _loadIndex() {
        const rows = this.db.all('SELECT token_hash, user_id, csrf_token, expires_at, abs_expires_at, last_seen_at FROM sessions');
        for (const r of rows) {
            this.index.set(r.token_hash, {
                userId: r.user_id, expiresAt: r.expires_at, absExpiresAt: r.abs_expires_at,
                csrfToken: r.csrf_token, lastSeenWrite: r.last_seen_at,
            });
        }
        const last = this.db.get('SELECT MAX(id) AS id FROM session_revocations');
        this.lastRevocationId = (last && last.id) || 0;
    }

    onRevoked(fn) {
        this.listeners.push(fn);
    }

    create(userId, { ip = null, userAgent = null } = {}) {
        const token = randomToken('ors_');
        const tokenHash = sha256hex(token);
        const csrfToken = randomToken('', 24);
        const now = this.clock.now();
        const expiresAt = now + SLIDING_MS;
        const absExpiresAt = now + ABSOLUTE_MS;
        this.db.run(
            'INSERT INTO sessions(token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, abs_expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?)',
            tokenHash, userId, csrfToken, now, now, expiresAt, absExpiresAt, ip, userAgent ? String(userAgent).slice(0, 120) : null,
        );
        this.index.set(tokenHash, { userId, expiresAt, absExpiresAt, csrfToken, lastSeenWrite: now });
        return { token, tokenHash, csrfToken };
    }

    // Resolves a cookie token, sliding the 14-day window (capped by the 30-day absolute
    // limit). The DB is written at most every 5 minutes per session.
    resolve(token) {
        if (typeof token !== 'string' || !token.startsWith('ors_') || token.length > 100) return null;
        const tokenHash = sha256hex(token);
        return this.resolveHash(tokenHash, { slide: true });
    }

    resolveHash(tokenHash, { slide = false } = {}) {
        const entry = this.index.get(tokenHash);
        if (!entry) return null;
        const now = this.clock.now();
        if (now >= entry.expiresAt || now >= entry.absExpiresAt) return null;
        if (slide) {
            entry.expiresAt = Math.min(now + SLIDING_MS, entry.absExpiresAt);
            if (now - entry.lastSeenWrite >= LAST_SEEN_WRITE_MS) {
                entry.lastSeenWrite = now;
                try {
                    this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?', now, entry.expiresAt, tokenHash);
                } catch (err) {
                    this.logger.warn('session touch failed', { err });
                }
            }
        }
        return { tokenHash, userId: entry.userId, csrfToken: entry.csrfToken, expiresAt: entry.expiresAt, absExpiresAt: entry.absExpiresAt };
    }

    isValid(tokenHash) {
        return !!this.resolveHash(tokenHash);
    }

    checkCsrf(session, header) {
        return !!session && safeEqual(String(header || ''), session.csrfToken);
    }

    // The single path for every session deletion (§4.2), so live sockets are always closed.
    revoke(tokenHashes, reason) {
        const hashes = [...new Set([].concat(tokenHashes).filter(Boolean))];
        if (hashes.length === 0) return 0;
        this.db.transaction(() => {
            for (const h of hashes) this.db.run('DELETE FROM sessions WHERE token_hash = ?', h);
        });
        for (const h of hashes) this.index.delete(h);
        for (const fn of this.listeners) {
            try {
                fn(hashes, reason);
            } catch (err) {
                this.logger.error('session revoke listener failed', { err });
            }
        }
        return hashes.length;
    }

    hashesForUser(userId, { except } = {}) {
        return this.db.all('SELECT token_hash FROM sessions WHERE user_id = ?', userId)
            .map((r) => r.token_hash)
            .filter((h) => h !== except);
    }

    revokeUser(userId, reason, opts) {
        return this.revoke(this.hashesForUser(userId, opts), reason);
    }

    listForUser(userId, currentHash) {
        return this.db.all('SELECT token_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC', userId)
            .map((r) => ({
                id: r.token_hash.slice(0, 12),
                createdAt: r.created_at,
                lastSeenAt: r.last_seen_at,
                ip: r.ip,
                userAgent: r.user_agent ? r.user_agent.slice(0, 120) : null,
                current: r.token_hash === currentHash,
            }));
    }

    findByShortId(userId, shortId) {
        if (typeof shortId !== 'string' || !/^[0-9a-f]{12}$/.test(shortId)) return null;
        const row = this.db.get('SELECT token_hash FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 12) = ?', userId, shortId);
        return row ? row.token_hash : null;
    }

    // The CLI runs in another process; it deletes rows and leaves a revocation marker
    // that this poll turns into socket closes.
    pollRevocations() {
        const rows = this.db.all('SELECT id, token_hash, user_id FROM session_revocations WHERE id > ? ORDER BY id', this.lastRevocationId);
        if (rows.length === 0) return 0;
        const hashes = new Set();
        const users = new Set();
        for (const r of rows) {
            this.lastRevocationId = Math.max(this.lastRevocationId, r.id);
            if (r.token_hash) hashes.add(r.token_hash);
            if (r.user_id) users.add(r.user_id);
        }
        // Revocations for a user who is now disabled carry 'user-disabled', matching the
        // API disable path, so machines audit the same reason however the user was disabled.
        const disabled = new Set();
        for (const u of users) {
            const row = this.db.get('SELECT disabled FROM users WHERE id = ?', u);
            if (row && row.disabled) disabled.add(u);
        }
        const reasons = new Map(); // token_hash -> reason
        const add = (h, userId) => {
            if (userId && disabled.has(userId)) reasons.set(h, 'user-disabled');
            else if (!reasons.has(h)) reasons.set(h, 'session-revoked');
        };
        for (const h of hashes) {
            const entry = this.index.get(h);
            add(h, entry ? entry.userId : null);
        }
        for (const [h, entry] of this.index) {
            if (users.has(entry.userId)) add(h, entry.userId);
        }
        for (const u of users) for (const h of this.hashesForUser(u)) add(h, u);
        for (const reason of ['user-disabled', 'session-revoked']) {
            this.revoke([...reasons].filter(([, r]) => r === reason).map(([h]) => h), reason);
        }
        this.db.run('DELETE FROM session_revocations WHERE id <= ?', this.lastRevocationId);
        return reasons.size;
    }

    sweepExpired() {
        const now = this.clock.now();
        const expired = [];
        for (const [h, e] of this.index) {
            if (now >= e.expiresAt || now >= e.absExpiresAt) expired.push(h);
        }
        const rows = this.db.all('SELECT token_hash FROM sessions WHERE expires_at <= ? OR abs_expires_at <= ? LIMIT 1000', now, now);
        for (const r of rows) {
            const e = this.index.get(r.token_hash);
            if (!e || now >= e.expiresAt || now >= e.absExpiresAt) expired.push(r.token_hash);
        }
        return this.revoke(expired, 'session-revoked');
    }
}

module.exports = { Sessions, SLIDING_MS, ABSOLUTE_MS };
