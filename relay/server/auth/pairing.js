'use strict';

const crypto = require('crypto');
const { sha256hex, randomToken, newId, safeEqual } = require('./tokens');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 8;
const PAIRING_TTL_MS = 10 * 60000;
const CLAIM_CONFIRM_MS = 15 * 60000;
const PAIRING_ROW_MAX_AGE_MS = 24 * 3600000;
const HEX64 = /^[0-9a-f]{64}$/;
const HARDWARE_ID = /^[0-9a-f]{12}$/;
const CONTROLLER_TYPES = ['RSP', 'Grbl', 'GrblHAL', 'FluidNC', 'RTS', 'Generic'];

function generateCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return s;
}

function formatCode(code) {
    return code.slice(0, 4) + '-' + code.slice(4);
}

// Uppercase, drop separators, map the look-alikes 0->O and 1->I. O and I are not in
// the alphabet, so a mistyped zero/one fails as code_invalid instead of matching.
function normalizeCode(input) {
    if (typeof input !== 'string' || input.length > 32) return null;
    const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/1/g, 'I');
    if (s.length !== CODE_LEN) return null;
    for (const ch of s) if (!ALPHABET.includes(ch)) return null;
    return s;
}

function maskEmail(email) {
    const at = String(email).indexOf('@');
    if (at < 1) return '***';
    return email[0] + '***@' + email.slice(at + 1);
}

function relayWsUrl(publicUrl) {
    const u = new URL(publicUrl);
    const scheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${u.host}/ws/device`;
}

class PairingError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

class Pairing {
    constructor({ db, clock, audit, limits, getPublicUrl, logger }) {
        this.db = db;
        this.clock = clock;
        this.audit = audit;
        this.limits = limits;
        this.getPublicUrl = getPublicUrl;
        this.logger = logger;
    }

    validateRequest(body) {
        const b = body || {};
        if (typeof b.hardwareId !== 'string' || !HARDWARE_ID.test(b.hardwareId)) return null;
        if (typeof b.name !== 'string' || b.name.trim().length < 1 || b.name.length > 60) return null;
        if (b.appVersion != null && (typeof b.appVersion !== 'string' || b.appVersion.length > 40)) return null;
        if (b.controllerType != null && !CONTROLLER_TYPES.includes(b.controllerType)) return null;
        if (typeof b.credentialHash !== 'string' || !HEX64.test(b.credentialHash)) return null;
        return {
            hardwareId: b.hardwareId, name: b.name.trim(), appVersion: b.appVersion || null,
            controllerType: b.controllerType || null, credentialHash: b.credentialHash,
        };
    }

    create(req, ip) {
        const now = this.clock.now();
        return this.db.transaction(() => {
            const h = req.credentialHash;
            const inDevices = this.db.get('SELECT 1 AS x FROM devices WHERE credential_hash = ? OR previous_credential_hash = ?', h, h);
            if (inDevices || this.db.get('SELECT 1 AS x FROM revoked_credentials WHERE credential_hash = ?', h)) {
                throw new PairingError(409, 'hash_in_use');
            }
            const existing = this.db.get('SELECT id, expires_at, rejected_at, claimed_at FROM pairings WHERE credential_hash = ?', h);
            if (existing) {
                const live = existing.expires_at > now && existing.rejected_at == null && existing.claimed_at == null;
                if (live) throw new PairingError(409, 'hash_in_use');
                // A machine re-requests a code with the same pending credential after expiry.
                this.db.run('DELETE FROM pairings WHERE id = ?', existing.id);
            }
            const liveGlobal = this.db.get('SELECT COUNT(*) AS n FROM pairings WHERE expires_at > ? AND claimed_at IS NULL AND rejected_at IS NULL', now).n;
            if (liveGlobal >= this.limits.maxLivePairings) throw new PairingError(503, 'pairing_capacity');

            const livePerIp = this.db.all('SELECT id FROM pairings WHERE ip = ? AND expires_at > ? AND claimed_at IS NULL AND rejected_at IS NULL ORDER BY created_at ASC', ip, now);
            for (let i = 0; i <= livePerIp.length - 5; i++) {
                this.db.run('UPDATE pairings SET expires_at = ? WHERE id = ?', now, livePerIp[i].id);
            }

            let code;
            let codeHash;
            for (let attempt = 0; ; attempt++) {
                code = generateCode();
                codeHash = sha256hex(code);
                if (!this.db.get('SELECT 1 AS x FROM pairings WHERE code_hash = ?', codeHash)) break;
                if (attempt > 10) throw new PairingError(503, 'pairing_capacity');
            }
            const pollSecret = randomToken('ops_');
            const id = newId('pr_');
            const expiresAt = now + PAIRING_TTL_MS;
            this.db.run(
                `INSERT INTO pairings(id, code_hash, poll_secret_hash, hardware_id, name, app_version, controller_type, ip, created_at, expires_at, credential_hash)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                id, codeHash, sha256hex(pollSecret), req.hardwareId, req.name, req.appVersion, req.controllerType, ip, now, expiresAt, h,
            );
            return { pairingId: id, code: formatCode(code), expiresAt, pollSecret, pollIntervalMs: 3000 };
        });
    }

    countOwnedDevices(userId) {
        return this.db.get("SELECT COUNT(*) AS n FROM grants WHERE user_id = ? AND role = 'owner'", userId).n;
    }

    claim({ userId, code, name, ip }) {
        const normalized = normalizeCode(code);
        if (name != null && (typeof name !== 'string' || name.trim().length < 1 || name.length > 60)) {
            throw new PairingError(400, 'bad_name');
        }
        if (this.countOwnedDevices(userId) >= this.limits.maxDevicesPerUser) throw new PairingError(409, 'device_limit');
        if (!normalized) throw new PairingError(400, 'code_invalid');
        const now = this.clock.now();
        const device = this.db.transaction(() => {
            const p = this.db.get(
                'SELECT * FROM pairings WHERE code_hash = ? AND expires_at > ? AND claimed_at IS NULL AND rejected_at IS NULL',
                sha256hex(normalized), now,
            );
            if (!p) throw new PairingError(400, 'code_invalid');
            const deviceId = newId('d_');
            const devName = (name && name.trim()) || p.name;
            this.db.run(
                `INSERT INTO devices(id, name, hardware_id, app_version, controller_type, status, credential_hash, cred_created_at, paired_at)
                 VALUES (?,?,?,?,?,'pending_confirmation',?,?,?)`,
                deviceId, devName, p.hardware_id, p.app_version, p.controller_type, p.credential_hash, now, now,
            );
            this.db.run("INSERT INTO grants(user_id, device_id, role, created_at) VALUES (?,?,'owner',?)", userId, deviceId, now);
            this.db.run('UPDATE pairings SET claimed_at = ?, claimed_by = ?, claimed_device_id = ? WHERE id = ?', now, userId, deviceId, p.id);
            return this.db.get('SELECT * FROM devices WHERE id = ?', deviceId);
        });
        this.audit.write({ userId, deviceId: device.id, ip, action: 'device.claim', detail: { name: device.name } });
        return device;
    }

    _authPoll(pairingId, bearer) {
        if (typeof pairingId !== 'string' || !/^pr_[a-z0-9]{12}$/.test(pairingId)) return null;
        const p = this.db.get('SELECT * FROM pairings WHERE id = ?', pairingId);
        if (!p || typeof bearer !== 'string' || !bearer.startsWith('ops_')) return null;
        return safeEqual(sha256hex(bearer), p.poll_secret_hash) ? p : null;
    }

    poll(pairingId, bearer) {
        const p = this._authPoll(pairingId, bearer);
        if (!p) throw new PairingError(404, 'not_found');
        const now = this.clock.now();
        if (p.rejected_at != null) return { status: 'rejected' };
        if (p.claimed_at != null) {
            const device = p.claimed_device_id ? this.db.get('SELECT id, status FROM devices WHERE id = ?', p.claimed_device_id) : null;
            if (!device) return { status: 'expired' };
            const user = this.db.get('SELECT email, display_name FROM users WHERE id = ?', p.claimed_by);
            const view = {
                deviceId: device.id,
                accountLabel: user ? maskEmail(user.email) : null,
                accountDisplayName: user ? user.display_name : null,
                relayWsUrl: relayWsUrl(this.getPublicUrl()),
            };
            return Object.assign({ status: p.confirmed_at != null || device.status === 'active' ? 'confirmed' : 'claimed' }, view);
        }
        if (p.expires_at <= now) return { status: 'expired' };
        return { status: 'pending' };
    }

    confirm(pairingId, bearer, ip) {
        const p = this._authPoll(pairingId, bearer);
        if (!p) throw new PairingError(404, 'not_found');
        if (p.claimed_at == null || p.rejected_at != null) throw new PairingError(409, 'not_claimed');
        const device = this.db.get('SELECT id, status FROM devices WHERE id = ?', p.claimed_device_id);
        if (!device) throw new PairingError(409, 'not_claimed');
        if (device.status === 'active') return device.id;
        const now = this.clock.now();
        this.db.transaction(() => {
            this.db.run("UPDATE devices SET status = 'active' WHERE id = ?", device.id);
            this.db.run('UPDATE pairings SET confirmed_at = ? WHERE id = ?', now, p.id);
        });
        this.audit.write({ userId: p.claimed_by, deviceId: device.id, ip, action: 'device.confirm' });
        return device.id;
    }

    reject(pairingId, bearer, ip) {
        const p = this._authPoll(pairingId, bearer);
        if (!p) throw new PairingError(404, 'not_found');
        return this._rejectRow(p, ip, 'device.claim_rejected');
    }

    _rejectRow(p, ip, action) {
        if (p.claimed_at == null || p.confirmed_at != null) return null;
        const device = p.claimed_device_id ? this.db.get('SELECT id, status FROM devices WHERE id = ?', p.claimed_device_id) : null;
        if (device && device.status === 'active') return null;
        const now = this.clock.now();
        this.db.transaction(() => {
            if (device) this.db.run('DELETE FROM devices WHERE id = ?', device.id);
            this.db.run('UPDATE pairings SET rejected_at = ? WHERE id = ?', now, p.id);
        });
        this.audit.write({ userId: p.claimed_by, deviceId: p.claimed_device_id, ip, action });
        return p.claimed_device_id;
    }

    cancel(pairingId, bearer, ip) {
        const p = this._authPoll(pairingId, bearer);
        if (!p) throw new PairingError(404, 'not_found');
        if (p.claimed_at != null && p.confirmed_at == null && p.rejected_at == null) {
            return this._rejectRow(p, ip, 'device.claim_rejected');
        }
        this.db.run('DELETE FROM pairings WHERE id = ?', p.id);
        return null;
    }

    // Returns the device ids removed so the caller can notify live clients.
    sweep() {
        const now = this.clock.now();
        const removed = [];
        const stale = this.db.all(
            'SELECT * FROM pairings WHERE claimed_at IS NOT NULL AND confirmed_at IS NULL AND rejected_at IS NULL AND claimed_at <= ?',
            now - CLAIM_CONFIRM_MS,
        );
        for (const p of stale) {
            const device = p.claimed_device_id ? this.db.get('SELECT id, status FROM devices WHERE id = ?', p.claimed_device_id) : null;
            this.db.transaction(() => {
                if (device && device.status !== 'active') this.db.run('DELETE FROM devices WHERE id = ?', device.id);
                this.db.run('DELETE FROM pairings WHERE id = ?', p.id);
            });
            if (device && device.status !== 'active') {
                removed.push(device.id);
                this.audit.write({ userId: p.claimed_by, deviceId: device.id, action: 'device.claim_expired' });
            }
        }
        this.db.run('DELETE FROM pairings WHERE created_at <= ?', now - PAIRING_ROW_MAX_AGE_MS);
        return removed;
    }
}

module.exports = {
    Pairing, PairingError, ALPHABET, normalizeCode, formatCode, generateCode, maskEmail, relayWsUrl,
    PAIRING_TTL_MS, CLAIM_CONFIRM_MS, CONTROLLER_TYPES,
};
