'use strict';

const path = require('path');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

// Decision D5: the first account comes from `cli.js create-user`; after that the
// safest mode that still lets an admin add people is invite-only.
const DEFAULT_SIGNUP = 'invite';

const DEFAULT_LIMITS = Object.freeze({
    maxUploadMb: 25,
    userQuotaMb: 1024,
    totalStorageMb: 5120,
    minFreeDiskMb: 1024,
    maxDevicesPerUser: 10,
    maxLivePairings: 1000,
    fileTtlDays: 7,
    snapshotMaxFps: 2,
    snapshotMaxKb: 300,
    auditRetentionDays: 180,
    credRotateDays: 90,
});

function isLoopbackHost(host) {
    if (!host) return false;
    return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

function parseBool(raw, name, errors) {
    if (raw === undefined || raw === '') return false;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    errors.push(`${name} must be 0 or 1`);
    return false;
}

function parseIntVar(env, name, def, min, max, errors) {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    if (!/^-?\d+$/.test(String(raw).trim())) {
        errors.push(`${name} must be an integer`);
        return def;
    }
    const n = Number(raw);
    if (min != null && n < min) errors.push(`${name} must be >= ${min}`);
    if (max != null && n > max) errors.push(`${name} must be <= ${max}`);
    return n;
}

// Shared by config parsing and createRelay(): http:// only for a loopback host, and
// only when insecure mode is explicitly enabled.
function validatePublicUrl(raw, allowInsecure) {
    let u;
    try {
        u = new URL(raw);
    } catch (_) {
        return 'RELAY_PUBLIC_URL is not a valid URL';
    }
    if (u.protocol === 'https:') return null;
    if (u.protocol === 'http:') {
        if (!isLoopbackHost(u.hostname)) return 'RELAY_PUBLIC_URL must be https:// (http:// is only allowed for 127.0.0.1/localhost)';
        if (!allowInsecure) return 'RELAY_PUBLIC_URL http:// requires RELAY_ALLOW_INSECURE=1';
        return null;
    }
    return 'RELAY_PUBLIC_URL must be https://';
}

function parseConfig(env = process.env, { cwd = process.cwd() } = {}) {
    const errors = [];
    const host = env.RELAY_HOST || '127.0.0.1';
    const port = parseIntVar(env, 'RELAY_PORT', 8787, 0, 65535, errors);
    const allowInsecure = parseBool(env.RELAY_ALLOW_INSECURE, 'RELAY_ALLOW_INSECURE', errors);
    const trustProxy = parseBool(env.RELAY_TRUST_PROXY, 'RELAY_TRUST_PROXY', errors);

    if (allowInsecure && !isLoopbackHost(host)) {
        errors.push('RELAY_ALLOW_INSECURE=1 is refused unless RELAY_HOST is a loopback address');
    }

    const publicUrl = env.RELAY_PUBLIC_URL;
    if (!publicUrl) {
        errors.push('RELAY_PUBLIC_URL is required');
    } else {
        const err = validatePublicUrl(publicUrl, allowInsecure);
        if (err) errors.push(err);
    }

    const signup = env.RELAY_SIGNUP || DEFAULT_SIGNUP;
    if (!['closed', 'invite', 'open'].includes(signup)) errors.push('RELAY_SIGNUP must be closed, invite or open');

    const logLevel = env.RELAY_LOG_LEVEL || 'info';
    if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) errors.push('RELAY_LOG_LEVEL must be debug, info, warn, error or silent');

    const limits = {
        maxUploadMb: parseIntVar(env, 'RELAY_MAX_UPLOAD_MB', DEFAULT_LIMITS.maxUploadMb, 1, 100, errors),
        userQuotaMb: parseIntVar(env, 'RELAY_USER_QUOTA_MB', DEFAULT_LIMITS.userQuotaMb, 1, null, errors),
        totalStorageMb: parseIntVar(env, 'RELAY_TOTAL_STORAGE_MB', DEFAULT_LIMITS.totalStorageMb, 1, null, errors),
        minFreeDiskMb: parseIntVar(env, 'RELAY_MIN_FREE_DISK_MB', DEFAULT_LIMITS.minFreeDiskMb, 0, null, errors),
        maxDevicesPerUser: parseIntVar(env, 'RELAY_MAX_DEVICES_PER_USER', DEFAULT_LIMITS.maxDevicesPerUser, 1, 100, errors),
        maxLivePairings: parseIntVar(env, 'RELAY_MAX_LIVE_PAIRINGS', DEFAULT_LIMITS.maxLivePairings, 1, null, errors),
        fileTtlDays: parseIntVar(env, 'RELAY_FILE_TTL_DAYS', DEFAULT_LIMITS.fileTtlDays, 1, null, errors),
        snapshotMaxFps: parseIntVar(env, 'RELAY_SNAPSHOT_MAX_FPS', DEFAULT_LIMITS.snapshotMaxFps, 1, 2, errors),
        snapshotMaxKb: parseIntVar(env, 'RELAY_SNAPSHOT_MAX_KB', DEFAULT_LIMITS.snapshotMaxKb, 50, 500, errors),
        auditRetentionDays: parseIntVar(env, 'RELAY_AUDIT_RETENTION_DAYS', DEFAULT_LIMITS.auditRetentionDays, 1, null, errors),
        credRotateDays: parseIntVar(env, 'RELAY_CRED_ROTATE_DAYS', DEFAULT_LIMITS.credRotateDays, 0, null, errors),
    };
    if (limits.totalStorageMb < limits.maxUploadMb) errors.push('RELAY_TOTAL_STORAGE_MB must be >= RELAY_MAX_UPLOAD_MB');

    const dataDir = path.resolve(cwd, env.RELAY_DATA_DIR || './data');

    const config = { host, port, publicUrl, dataDir, trustProxy, allowInsecure, signup, logLevel, limits };
    return { ok: errors.length === 0, config, errors };
}

module.exports = { parseConfig, validatePublicUrl, isLoopbackHost, DEFAULT_LIMITS, DEFAULT_SIGNUP };
