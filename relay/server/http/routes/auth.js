'use strict';

const { httpError } = require('../router');
const { SlidingWindow, WindowLimiter } = require('../../ratelimit');
const { hashPassword, verifyPassword, validatePassword, normalizeEmail } = require('../../auth/passwords');
const { newId, sha256hex, hmac, safeEqual } = require('../../auth/tokens');
const {
    parseCookies, cookieNames, sessionCookie, clearSessionCookie, knownDeviceCookie, appendSetCookie,
} = require('../cookies');

const FIFTEEN_MIN = 15 * 60000;
const KNOWN_DEVICE_MAX_AGE_MS = 180 * 86400000;

// Lockout policy (§4.2). Built so an attacker cannot lock a real owner out: the hard
// lock is per (email, IP); per-email and per-IP pressure only slows attempts down.
class LoginGuard {
    constructor({ mono }) {
        this.mono = mono;
        this.pairFails = new SlidingWindow({ windowMs: FIFTEEN_MIN, mono, cap: 10 });
        this.pairLockedUntil = new Map();
        this.emailFails = new SlidingWindow({ windowMs: FIFTEEN_MIN, mono, cap: 64 });
        this.ipFails = new SlidingWindow({ windowMs: FIFTEEN_MIN, mono, cap: 1001 });
        this.ipBlockedUntil = new Map();
        this.ipFails5 = new SlidingWindow({ windowMs: 5 * 60000, mono, cap: 2 });
        this.globalFails = new SlidingWindow({ windowMs: 5 * 60000, mono, cap: 1000 });
        // Attempts past check() whose password verify has not finished yet. Failures are only
        // recorded after the ~100 ms scrypt run, so without these a parallel burst would all
        // pass check() before the first failure counts.
        this.inflight = { pair: new Map(), email: new Map(), ip: new Map() };
    }

    _inflight(kind, key) {
        return this.inflight[kind].get(key) || 0;
    }

    _bump(kind, key, by) {
        const n = this._inflight(kind, key) + by;
        if (n > 0) this.inflight[kind].set(key, n);
        else this.inflight[kind].delete(key);
    }

    // check() plus a reservation that counts this attempt as in flight until release() runs.
    // Call release() right after recordFailure()/recordSuccess(), in the same tick.
    begin(email, ip, exempt) {
        const verdict = this.check(email, ip, exempt);
        if (verdict.blocked) return Object.assign(verdict, { release: () => {} });
        const pairKey = email + '|' + ip;
        this._bump('pair', pairKey, 1);
        this._bump('email', email, 1);
        this._bump('ip', ip, 1);
        let released = false;
        verdict.release = () => {
            if (released) return;
            released = true;
            this._bump('pair', pairKey, -1);
            this._bump('email', email, -1);
            this._bump('ip', ip, -1);
        };
        return verdict;
    }

    // Returns {status, retryAfterSec} when the attempt must be refused, else the delay
    // (ms) to apply before the password check.
    check(email, ip, exempt) {
        const now = this.mono();
        const ipUntil = this.ipBlockedUntil.get(ip);
        if (ipUntil != null) {
            if (now < ipUntil) return { blocked: { retryAfterSec: Math.ceil((ipUntil - now) / 1000) }, delayMs: 0 };
            this.ipBlockedUntil.delete(ip);
        }
        if (this.ipFails.count(ip) + this._inflight('ip', ip) >= 1000) return { blocked: { retryAfterSec: 1 }, delayMs: 0 };
        const pairKey = email + '|' + ip;
        if (!exempt) {
            const until = this.pairLockedUntil.get(pairKey);
            if (until != null) {
                if (now < until) return { blocked: { retryAfterSec: Math.ceil((until - now) / 1000) }, delayMs: 0 };
                this.pairLockedUntil.delete(pairKey);
                this.pairFails.reset(pairKey);
            }
            // Pending attempts that would reach the lock if they fail are refused now.
            if (this.pairFails.count(pairKey) + this._inflight('pair', pairKey) >= 5) return { blocked: { retryAfterSec: 1 }, delayMs: 0 };
        }
        return { blocked: null, delayMs: this.delayFor(email, ip, exempt) };
    }

    delayFor(email, ip, exempt) {
        let delay = 0;
        if (!exempt) {
            const f = this.emailFails.count(email) + this._inflight('email', email);
            if (f >= 5) delay += Math.min(2000, 250 * 2 ** (f - 5));
        }
        const fi = this.ipFails.count(ip) + this._inflight('ip', ip);
        if (fi >= 200) delay += Math.min(2000, 250 * 2 ** Math.floor((fi - 200) / 100));
        if (this.globalFails.count('g') > 200 && this.ipFails5.count(ip) > 0) delay += 1000;
        return delay;
    }

    recordFailure(email, ip) {
        const now = this.mono();
        const pairKey = email + '|' + ip;
        if (this.pairFails.hit(pairKey) >= 5) this.pairLockedUntil.set(pairKey, now + FIFTEEN_MIN);
        this.emailFails.hit(email);
        if (this.ipFails.hit(ip) >= 1000) this.ipBlockedUntil.set(ip, now + FIFTEEN_MIN);
        this.ipFails5.hit(ip);
        this.globalFails.hit('g');
    }

    recordSuccess(email, ip) {
        const pairKey = email + '|' + ip;
        this.pairFails.reset(pairKey);
        this.pairLockedUntil.delete(pairKey);
    }
}

function userView(u) {
    return { id: u.id, email: u.email, displayName: u.display_name, isAdmin: !!u.is_admin };
}

function validDisplayName(name) {
    return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 60;
}

function normalizeInvite(code) {
    if (typeof code !== 'string' || code.length > 64) return null;
    const s = code.toUpperCase().replace(/[^A-Z2-7]/g, '');
    return s.length === 12 ? s : null;
}

function register(router, app) {
    const mono = app.clock.mono;
    const guard = new LoginGuard({ mono });
    app.loginGuard = guard;
    const registerPerIp = new WindowLimiter({ limit: 5, windowMs: 3600000, mono });
    const registerGlobal = new WindowLimiter({ limit: 50, windowMs: 3600000, mono });
    const sleep = app.clock.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    function knownDeviceValue(userId) {
        const issuedAt = app.clock.now();
        return `${userId}.${issuedAt}.${hmac(app.serverSecret, userId + '.' + issuedAt)}`;
    }

    function knownDeviceUser(req) {
        const raw = parseCookies(req.headers.cookie)[cookieNames(app.allowInsecure).knownDevice];
        if (!raw) return null;
        const parts = raw.split('.');
        if (parts.length !== 3 || !/^u_[a-z0-9]{12}$/.test(parts[0]) || !/^\d{1,16}$/.test(parts[1])) return null;
        if (!safeEqual(parts[2], hmac(app.serverSecret, parts[0] + '.' + parts[1]))) return null;
        if (app.clock.now() - Number(parts[1]) > KNOWN_DEVICE_MAX_AGE_MS) return null;
        return parts[0];
    }

    function startSession(ctx, user) {
        const s = app.sessions.create(user.id, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
        appendSetCookie(ctx.res, sessionCookie(s.token, app.allowInsecure));
        appendSetCookie(ctx.res, knownDeviceCookie(knownDeviceValue(user.id), app.allowInsecure));
        return s;
    }

    router.add('GET', '/api/health', (ctx) => ctx.json(200, { ok: true, version: app.version, protocol: 1 }));

    router.add('GET', '/api/config', (ctx) => ctx.json(200, {
        signup: app.signup, protocol: 1, maxUploadMb: app.limits.maxUploadMb, snapshotMaxFps: app.limits.snapshotMaxFps,
    }));

    router.add('POST', '/api/auth/register', async (ctx) => {
        if (app.signup === 'closed') throw httpError(403, 'signup_closed');
        if (!registerGlobal.tryHit('g') || !registerPerIp.tryHit(ctx.ip)) throw httpError(429, 'rate_limited');
        const b = ctx.body;
        let inviteHash = null;
        if (app.signup === 'invite') {
            const code = normalizeInvite(b.inviteCode);
            const row = code ? app.db.get('SELECT code_hash, expires_at, used_at FROM invites WHERE code_hash = ?', sha256hex(code)) : null;
            if (!row || row.used_at != null || row.expires_at <= app.clock.now()) throw httpError(400, 'invite_invalid');
            inviteHash = row.code_hash;
        }
        const email = normalizeEmail(b.email);
        if (!email) throw httpError(400, 'invalid_email');
        if (!validatePassword(b.password)) throw httpError(400, 'invalid_password');
        if (!validDisplayName(b.displayName)) throw httpError(400, 'invalid_display_name');
        // Hash before the existence check so both branches cost one scrypt run.
        const passwordHash = await hashPassword(b.password);
        const now = app.clock.now();
        const userId = newId('u_');
        const created = app.db.transaction(() => {
            if (app.db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) return false;
            if (inviteHash) {
                const r = app.db.run('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL', userId, now, inviteHash);
                if (r.changes !== 1) throw httpError(400, 'invite_invalid');
            }
            app.db.run('INSERT INTO users(id, email, display_name, password_hash, created_at) VALUES (?,?,?,?,?)',
                userId, email, b.displayName.trim(), passwordHash, now);
            return true;
        });
        if (!created) {
            // Decision D5: email_taken is only disclosed in explicitly open signup mode.
            if (app.signup === 'open') throw httpError(409, 'email_taken');
            throw httpError(400, 'registration_failed');
        }
        const user = app.db.get('SELECT * FROM users WHERE id = ?', userId);
        const s = startSession(ctx, user);
        app.audit.write({ userId, ip: ctx.ip, action: 'auth.register', detail: { mode: app.signup } });
        ctx.json(201, { user: userView(user), csrfToken: s.csrfToken });
    });

    router.add('POST', '/api/auth/login', async (ctx) => {
        const b = ctx.body;
        const email = normalizeEmail(b.email) || (typeof b.email === 'string' ? b.email.trim().toLowerCase().slice(0, 254) : '');
        const password = typeof b.password === 'string' ? b.password.slice(0, 1024) : '';
        const user = email ? app.db.get('SELECT * FROM users WHERE email = ?', email) : null;
        const kdUser = knownDeviceUser(ctx.req);
        const exempt = !!(user && kdUser && kdUser === user.id);
        const verdict = guard.begin(email, ctx.ip, exempt);
        if (verdict.blocked) {
            throw httpError(429, 'locked', { retryAfterSec: verdict.blocked.retryAfterSec }, { 'Retry-After': String(verdict.blocked.retryAfterSec) });
        }
        let ok = false;
        try {
            if (verdict.delayMs > 0) await sleep(verdict.delayMs);
            ok = await verifyPassword(password, user ? user.password_hash : null);
            if (!ok || !user || user.disabled) {
                ok = false;
                guard.recordFailure(email, ctx.ip);
            } else {
                guard.recordSuccess(email, ctx.ip);
            }
        } finally {
            verdict.release();
        }
        if (!ok) {
            app.audit.write({ userId: user ? user.id : null, ip: ctx.ip, action: 'auth.login_failed', detail: { emailHash: sha256hex(email).slice(0, 16) } });
            throw httpError(401, 'invalid_credentials');
        }
        const s = startSession(ctx, user);
        app.audit.write({ userId: user.id, ip: ctx.ip, action: 'auth.login' });
        ctx.json(200, { user: userView(user), csrfToken: s.csrfToken });
    });

    router.add('POST', '/api/auth/logout', (ctx) => {
        app.sessions.revoke([ctx.session.tokenHash], 'session-revoked');
        appendSetCookie(ctx.res, clearSessionCookie(app.allowInsecure));
        app.audit.write({ userId: ctx.user.id, ip: ctx.ip, action: 'auth.logout' });
        ctx.json(204);
    }, { auth: 'session' });

    router.add('GET', '/api/auth/me', (ctx) => {
        ctx.json(200, { user: userView(ctx.user), csrfToken: ctx.session.csrfToken });
    }, { auth: 'session' });

    router.add('POST', '/api/auth/password', async (ctx) => {
        const { currentPassword, newPassword } = ctx.body;
        if (!validatePassword(newPassword)) throw httpError(400, 'invalid_password');
        const ok = await verifyPassword(typeof currentPassword === 'string' ? currentPassword.slice(0, 1024) : '', ctx.user.password_hash);
        if (!ok) throw httpError(401, 'invalid_credentials');
        const hash = await hashPassword(newPassword);
        app.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, ctx.user.id);
        app.sessions.revokeUser(ctx.user.id, 'session-revoked', { except: ctx.session.tokenHash });
        app.audit.write({ userId: ctx.user.id, ip: ctx.ip, action: 'auth.password_change' });
        ctx.json(204);
    }, { auth: 'session' });

    router.add('GET', '/api/auth/sessions', (ctx) => {
        ctx.json(200, app.sessions.listForUser(ctx.user.id, ctx.session.tokenHash));
    }, { auth: 'session' });

    router.add('DELETE', '/api/auth/sessions/:id', (ctx) => {
        const hash = app.sessions.findByShortId(ctx.user.id, ctx.params.id);
        if (!hash) throw httpError(404, 'not_found');
        app.sessions.revoke([hash], 'session-revoked');
        app.audit.write({ userId: ctx.user.id, ip: ctx.ip, action: 'auth.session_revoke', detail: { current: hash === ctx.session.tokenHash } });
        if (hash === ctx.session.tokenHash) appendSetCookie(ctx.res, clearSessionCookie(app.allowInsecure));
        ctx.json(204);
    }, { auth: 'session' });
}

module.exports = { register, LoginGuard, userView, normalizeInvite };
