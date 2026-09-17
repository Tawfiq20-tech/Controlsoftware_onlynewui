/**
 * Machine-side copy of the wire protocol constants (spec §3). Deliberately
 * not shared with relay/ -- the machine validates everything it receives on
 * its own terms, a compromised relay included.
 */
'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;

const CLS = Object.freeze(['stop', 'job', 'motion', 'monitor']);

const TTL_MAX = Object.freeze({ stop: 10000, job: 5000, monitor: 5000, motion: 500 });

const CONTROLLER_TYPES = Object.freeze(['RSP', 'Grbl', 'GrblHAL', 'FluidNC', 'RTS', 'Generic']);

const ERROR_CODES = Object.freeze([
    'OK', 'BAD_VERSION', 'BAD_ARGS', 'UNKNOWN_COMMAND', 'ENC_UNSUPPORTED', 'ACL_DENIED',
    'DEVICE_OFFLINE', 'RATE_LIMITED', 'REPLAY', 'EXPIRED', 'TIER_REQUIRED', 'LOCKED',
    'JOB_ACTIVE', 'NO_JOB', 'NOT_PAUSED', 'NOT_RUNNING', 'NOT_IDLE', 'NO_FILE',
    'FILE_CHANGED', 'PAUSE_NOT_REMOTE', 'REVIEW_REQUIRED', 'BUSY', 'LATENCY_TOO_HIGH',
    'STALE_TELEMETRY', 'JOG_ACTIVE', 'NOT_SUPPORTED', 'ENGINE_ERROR', 'INTERNAL',
]);

// Every t the machine understands inbound. Anything else -> error UNKNOWN_COMMAND.
const INBOUND_TYPES = Object.freeze([
    'welcome', 'ping', 'pong', 'error', 'viewers', 'cmd', 'client.gone',
    'file.offer', 'camera.demand', 'cred.rotate', 'cred.commit',
]);

const RESERVED_TYPES = Object.freeze(['rtc.offer', 'rtc.answer', 'rtc.ice', 'rtc.close', 'e2e.hello', 'e2e.rekey']);

const FILE_EXTENSIONS = Object.freeze(['.nc', '.gcode', '.ngc', '.tap', '.txt', '.cnc']);

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TRANSFER_ID_RE = /^x_[a-z0-9]{12}$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const USER_ID_RE = /^u_[a-z0-9]{12}$/;
const JOG_ID_RE = /^j_[a-z0-9]{6,20}$/;
const LIBRARY_ID_RE = /^l-\d{10,16}-[a-z0-9]{1,8}$/;

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBase36(len = 12) {
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += BASE36[bytes[i] % 36];
    return out;
}

function makeId(prefix) {
    return `${prefix}${randomBase36(12)}`;
}

function reportTopic(deviceId) {
    return deviceId ? `device/${deviceId}/report` : null;
}

function envelope(t, body, { topic = null, cls = null, id = null, ts = Date.now() } = {}) {
    return {
        v: PROTOCOL_VERSION,
        t,
        id: id || makeId(t === 'ping' ? 'p_' : 'm_'),
        ts,
        topic,
        cls,
        enc: 'none',
        kid: null,
        via: null,
        body: body || {},
    };
}

/**
 * Structural validation of an inbound text frame. Returns {ok:true} or
 * {ok:false, code}. Body schemas are checked by the handler of each type.
 */
function validateEnvelope(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return { ok: false, code: 'BAD_ARGS' };
    if (env.v !== PROTOCOL_VERSION) return { ok: false, code: 'BAD_VERSION' };
    if (typeof env.t !== 'string' || env.t.length === 0 || env.t.length > 40) return { ok: false, code: 'BAD_ARGS' };
    if (env.id !== undefined && env.id !== null && (typeof env.id !== 'string' || !ID_RE.test(env.id))) {
        return { ok: false, code: 'BAD_ARGS' };
    }
    if (env.enc !== undefined && env.enc !== null && env.enc !== 'none') return { ok: false, code: 'ENC_UNSUPPORTED' };
    if (env.body !== undefined && (env.body === null || typeof env.body !== 'object' || Array.isArray(env.body))) {
        return { ok: false, code: 'BAD_ARGS' };
    }
    if (env.t === 'cmd') {
        if (!CLS.includes(env.cls)) return { ok: false, code: 'BAD_ARGS' };
        if (!env.via || typeof env.via !== 'object' || Array.isArray(env.via)) return { ok: false, code: 'BAD_ARGS' };
        if (typeof env.id !== 'string') return { ok: false, code: 'BAD_ARGS' };
    }
    return { ok: true };
}

function hasAllowedExtension(name) {
    const lower = String(name || '').toLowerCase();
    return FILE_EXTENSIONS.some(ext => lower.endsWith(ext) && lower.length > ext.length);
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function newCredential() {
    return 'odc_' + crypto.randomBytes(32).toString('base64url');
}

module.exports = {
    PROTOCOL_VERSION,
    CLS,
    TTL_MAX,
    CONTROLLER_TYPES,
    ERROR_CODES,
    INBOUND_TYPES,
    RESERVED_TYPES,
    FILE_EXTENSIONS,
    ID_RE,
    TRANSFER_ID_RE,
    SHA256_RE,
    USER_ID_RE,
    JOG_ID_RE,
    LIBRARY_ID_RE,
    randomBase36,
    makeId,
    reportTopic,
    envelope,
    validateEnvelope,
    hasAllowedExtension,
    sha256Hex,
    newCredential,
};
