'use strict';

const crypto = require('crypto');

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function base64url(buf) {
    return Buffer.from(buf).toString('base64url');
}

function randomToken(prefix, bytes = 32) {
    return prefix + base64url(crypto.randomBytes(bytes));
}

function sha256hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// 12 base36 chars from crypto.randomBytes; rejection sampling keeps it unbiased.
function randomBase36(len = 12) {
    let out = '';
    while (out.length < len) {
        const bytes = crypto.randomBytes(len * 2);
        for (const b of bytes) {
            if (b >= 252) continue;
            out += BASE36[b % 36];
            if (out.length === len) break;
        }
    }
    return out;
}

function newId(prefix) {
    return prefix + randomBase36(12);
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
        crypto.timingSafeEqual(ba, ba);
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}

function hmac(secret, value) {
    return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url');
}

module.exports = { randomToken, sha256hex, randomBase36, newId, safeEqual, hmac, base64url };
