'use strict';

const { randomBase36 } = require('../auth/tokens');

const PROTOCOL_VERSION = 1;

const LIMITS = Object.freeze({
    deviceTextMaxBytes: 64 * 1024,
    deviceBinaryMaxBytes: 512 * 1024,
    deviceMaxPayload: 600 * 1024,
    clientTextMaxBytes: 16 * 1024,
    clientMaxPayload: 32 * 1024,
    reportStateMaxBytes: 4 * 1024,
});

const ERROR_CODES = Object.freeze([
    'OK', 'BAD_VERSION', 'BAD_ARGS', 'UNKNOWN_COMMAND', 'ENC_UNSUPPORTED', 'ACL_DENIED', 'DEVICE_OFFLINE',
    'RATE_LIMITED', 'REPLAY', 'EXPIRED', 'TIER_REQUIRED', 'LOCKED', 'JOB_ACTIVE', 'NO_JOB', 'NOT_PAUSED',
    'NOT_RUNNING', 'NOT_IDLE', 'NO_FILE', 'FILE_CHANGED', 'PAUSE_NOT_REMOTE', 'REVIEW_REQUIRED', 'BUSY',
    'LATENCY_TOO_HIGH', 'STALE_TELEMETRY', 'JOG_ACTIVE', 'NOT_SUPPORTED', 'ENGINE_ERROR', 'INTERNAL',
    'SNAPSHOT_REJECTED',
]);

const CLOSE = Object.freeze({
    NORMAL: 1000,
    GOING_AWAY: 1001,
    DEAD_LINK: 4000,
    PROTOCOL: 4400,
    AUTH: 4401,
    HELLO_TIMEOUT: 4408,
    REPLACED: 4409,
    RATE_LIMITED: 4429,
    INTERNAL: 4500,
});

const CLS = Object.freeze(['stop', 'job', 'motion', 'monitor']);

const TTL_MAX = Object.freeze({ stop: 10000, job: 5000, monitor: 5000, motion: 500 });
const KEEPALIVE_TTL_MS = 300;

// §9.2.3: the relay checks `cls` against the command type so a mislabelled motion
// command can never pass the viewer ACL as "stop".
const COMMAND_TYPES = Object.freeze({
    'job.stop': 'stop',
    'jog.cont.stop': 'stop',
    'tier.dropMotion': 'stop',
    'spindle.off': 'stop',
    'job.pause': 'job',
    'job.resume': 'job',
    'feed.override': 'job',
    'job.load': 'motion',
    'job.start': 'motion',
    'jog.step': 'motion',
    'jog.cont.start': 'motion',
    'jog.cont.keepalive': 'motion',
    'zero': 'motion',
    'home': 'motion',
    'spindle.on': 'motion',
});

const TYPES = Object.freeze({
    link: ['hello', 'welcome', 'ping', 'pong', 'error'],
    subscription: ['subscribe', 'subscribed', 'presence', 'device.removed', 'viewers', 'client.gone'],
    telemetry: ['report.state', 'report.tier'],
    command: ['cmd', 'cmd.ack'],
    files: ['file.offer', 'file.result', 'file.status'],
    camera: ['camera.demand', 'camera.error'],
    rotation: ['cred.rotate', 'cred.rotated', 'cred.commit'],
    reserved: ['rtc.offer', 'rtc.answer', 'rtc.ice', 'rtc.close', 'e2e.hello', 'e2e.rekey'],
});

const KNOWN_TYPES = new Set([].concat(...Object.values(TYPES)));
const RESERVED_TYPES = new Set(TYPES.reserved);

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DEVICE_ID_RE = /^d_[a-z0-9]{12}$/;
const TOPIC_RE = /^device\/(d_[a-z0-9]{12})\/(report|request)$/;

function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function newMessageId(prefix = 'm_') {
    return prefix + randomBase36(12);
}

function parseTopic(topic) {
    const m = typeof topic === 'string' ? TOPIC_RE.exec(topic) : null;
    return m ? { deviceId: m[1], direction: m[2] } : null;
}

// Validates the §3.2 envelope only (never the body contents beyond "is an object"),
// so the relay can route E2E-encrypted bodies later without change.
function validateEnvelope(msg) {
    if (!isPlainObject(msg)) return { ok: false, code: 'BAD_ARGS', message: 'not an object' };
    if (msg.v !== PROTOCOL_VERSION) return { ok: false, code: 'BAD_VERSION', fatal: true, message: 'unsupported version' };
    if (typeof msg.t !== 'string' || !msg.t) return { ok: false, code: 'BAD_ARGS', message: 'missing t' };
    const refId = typeof msg.id === 'string' && ID_RE.test(msg.id) ? msg.id : null;
    if (!refId) return { ok: false, code: 'BAD_ARGS', message: 'bad id' };
    if (hasOwn(msg, 'ts') && msg.ts !== undefined && !Number.isInteger(msg.ts)) return { ok: false, code: 'BAD_ARGS', message: 'bad ts', refId };
    if (msg.topic !== undefined && msg.topic !== null && !parseTopic(msg.topic)) return { ok: false, code: 'BAD_ARGS', message: 'bad topic', refId };
    if (msg.cls !== undefined && msg.cls !== null && !CLS.includes(msg.cls)) return { ok: false, code: 'BAD_ARGS', message: 'bad cls', refId };
    if (msg.enc !== undefined && msg.enc !== 'none') return { ok: false, code: 'ENC_UNSUPPORTED', message: 'enc not supported', refId };
    if (msg.kid !== undefined && msg.kid !== null) return { ok: false, code: 'ENC_UNSUPPORTED', message: 'kid not supported', refId };
    if (msg.via !== undefined && msg.via !== null && !isPlainObject(msg.via)) return { ok: false, code: 'BAD_ARGS', message: 'bad via', refId };
    if (msg.body !== undefined && !isPlainObject(msg.body)) return { ok: false, code: 'BAD_ARGS', message: 'bad body', refId };
    if (RESERVED_TYPES.has(msg.t) || !KNOWN_TYPES.has(msg.t)) return { ok: false, code: 'UNKNOWN_COMMAND', message: 'unknown type', refId };
    return { ok: true, refId };
}

// Relay-side cmd body checks (§3.4.4 step 1). Argument schemas are the machine's job.
function validateCmdBody(msg) {
    const body = msg.body;
    if (!isPlainObject(body)) return { ok: false, code: 'BAD_ARGS', message: 'missing body' };
    const topic = parseTopic(msg.topic);
    if (!topic || topic.direction !== 'request') return { ok: false, code: 'BAD_ARGS', message: 'bad topic' };
    if (typeof body.type !== 'string') return { ok: false, code: 'BAD_ARGS', message: 'missing type' };
    if (!hasOwn(COMMAND_TYPES, body.type)) return { ok: false, code: 'UNKNOWN_COMMAND', message: 'unknown command' };
    if (!CLS.includes(msg.cls)) return { ok: false, code: 'BAD_ARGS', message: 'missing cls' };
    if (COMMAND_TYPES[body.type] !== msg.cls) return { ok: false, code: 'BAD_ARGS', message: 'cls mismatch' };
    if (!isPlainObject(body.args)) return { ok: false, code: 'BAD_ARGS', message: 'bad args' };
    if (!Number.isInteger(body.seq) || body.seq < 1) return { ok: false, code: 'BAD_ARGS', message: 'bad seq' };
    if (!Number.isInteger(body.issuedAt)) return { ok: false, code: 'BAD_ARGS', message: 'bad issuedAt' };
    if (!Number.isInteger(body.ttlMs)) return { ok: false, code: 'BAD_ARGS', message: 'bad ttlMs' };
    if (typeof body.idem !== 'string' || !ID_RE.test(body.idem)) return { ok: false, code: 'BAD_ARGS', message: 'bad idem' };
    if (hasOwn(body, 'unsynced') && body.unsynced !== undefined) {
        if (body.unsynced !== true || msg.cls !== 'stop') return { ok: false, code: 'BAD_ARGS', message: 'unsynced only allowed on stop' };
    }
    return { ok: true, deviceId: topic.deviceId, type: body.type, cls: msg.cls };
}

function clampTtl(cls, type, ttlMs) {
    if (type === 'jog.cont.keepalive') return KEEPALIVE_TTL_MS;
    const max = TTL_MAX[cls] || 5000;
    return Math.min(max, Math.max(1, ttlMs | 0));
}

function envelope(t, body, { topic = null, cls = null, via = null, id, ts } = {}) {
    return {
        v: PROTOCOL_VERSION, t, id: id || newMessageId('m_'), ts: ts != null ? ts : Date.now(),
        topic, cls, enc: 'none', kid: null, via, body: body || {},
    };
}

function reportTopic(deviceId) {
    return `device/${deviceId}/report`;
}

function requestTopic(deviceId) {
    return `device/${deviceId}/request`;
}

// §3.3 binary snapshot frame.
function parseSnapshotFrame(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 3 || buf[0] !== 0x01) return null;
    const h = buf.readUInt16BE(1);
    if (3 + h > buf.length) return null;
    let header;
    try {
        header = JSON.parse(buf.subarray(3, 3 + h).toString('utf8'));
    } catch (_) {
        return null;
    }
    if (!isPlainObject(header) || header.v !== 1) return null;
    const jpeg = buf.subarray(3 + h);
    if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
    return { header, jpeg };
}

function buildSnapshotFrame(header, jpeg) {
    const hb = Buffer.from(JSON.stringify(header), 'utf8');
    const prefix = Buffer.alloc(3);
    prefix[0] = 0x01;
    prefix.writeUInt16BE(hb.length, 1);
    return Buffer.concat([prefix, hb, jpeg]);
}

module.exports = {
    PROTOCOL_VERSION, LIMITS, ERROR_CODES, CLOSE, CLS, TTL_MAX, KEEPALIVE_TTL_MS, COMMAND_TYPES, TYPES,
    KNOWN_TYPES, RESERVED_TYPES, ID_RE, DEVICE_ID_RE,
    newMessageId, parseTopic, validateEnvelope, validateCmdBody, clampTtl, envelope, reportTopic, requestTopic,
    parseSnapshotFrame, buildSnapshotFrame, isPlainObject, hasOwn,
};
