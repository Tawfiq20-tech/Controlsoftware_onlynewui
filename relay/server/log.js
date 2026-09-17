'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SECRET_KEY = /pass(word)?|token|secret|credential|cookie|authorization|pairingcode|invitecode/i;
const SECRET_VALUE = /\b(ors|odc|ops)_[A-Za-z0-9_-]+/g;

// Redaction is defence in depth: callers already avoid passing secrets, but a stray
// error message or header dump must never put a bearer token into the journal.
function scrub(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') return value.replace(SECRET_VALUE, '$1_[redacted]');
    if (typeof value !== 'object') return value;
    if (depth > 4) return '[deep]';
    if (value instanceof Error) {
        return { name: value.name, message: scrub(value.message, depth + 1), code: value.code };
    }
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) {
        out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrub(value[key], depth + 1);
    }
    return out;
}

function createLogger({ level = 'info', write = (line) => process.stdout.write(line + '\n'), clock } = {}) {
    const threshold = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;
    const nowFn = clock && clock.now ? clock.now : Date.now;
    function emit(lvl, msg, fields) {
        if (LEVELS[lvl] < threshold) return;
        const entry = { ts: new Date(nowFn()).toISOString(), level: lvl, msg: scrub(String(msg)) };
        if (fields !== undefined) entry.data = scrub(fields);
        try {
            write(JSON.stringify(entry));
        } catch (_) { /* a broken stdout must not take the relay down */ }
    }
    return {
        debug: (msg, fields) => emit('debug', msg, fields),
        info: (msg, fields) => emit('info', msg, fields),
        warn: (msg, fields) => emit('warn', msg, fields),
        error: (msg, fields) => emit('error', msg, fields),
    };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

module.exports = { createLogger, silentLogger, scrub, LEVELS };
