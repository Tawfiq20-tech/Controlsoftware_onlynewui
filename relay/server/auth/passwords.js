'use strict';

const crypto = require('crypto');

const PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KEYLEN = 64;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function scryptAsync(password, salt, params) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEYLEN, params, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scryptAsync(String(password), salt, PARAMS);
    return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

// A fixed decoy hash so unknown emails cost the same scrypt run as real ones.
const DUMMY_HASH = `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${'00'.repeat(16)}$${'00'.repeat(KEYLEN)}`;

async function verifyPassword(password, stored) {
    const parts = String(stored || DUMMY_HASH).split('$');
    const valid = parts.length === 6 && parts[0] === 'scrypt';
    const use = valid ? parts : DUMMY_HASH.split('$');
    const N = Number(use[1]);
    const r = Number(use[2]);
    const p = Number(use[3]);
    const salt = Buffer.from(use[4], 'hex');
    const expected = Buffer.from(use[5], 'hex');
    const key = await scryptAsync(String(password), salt, { N, r, p, maxmem: PARAMS.maxmem });
    const ok = key.length === expected.length && crypto.timingSafeEqual(key, expected);
    return valid && stored !== DUMMY_HASH && ok;
}

function validatePassword(password) {
    return typeof password === 'string' && password.length >= 10 && password.length <= 200;
}

function normalizeEmail(email) {
    if (typeof email !== 'string') return null;
    const e = email.trim().toLowerCase();
    if (e.length === 0 || e.length > 254 || !EMAIL_RE.test(e)) return null;
    return e;
}

module.exports = { hashPassword, verifyPassword, validatePassword, normalizeEmail, DUMMY_HASH, PARAMS };
