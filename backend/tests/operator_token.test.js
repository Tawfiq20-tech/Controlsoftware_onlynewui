'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { OperatorToken, OPERATOR_COOKIE, IDENTITY_KINDS, constantTimeEqual } = require('../services/remoteAccess/OperatorToken');
const { RemoteAccessService } = require('../services/remoteAccess/RemoteAccessService');

class MockConfigStore {
    constructor() { this.store = {}; }
    get(key, def) { return this.store[key] !== undefined ? this.store[key] : def; }
    set(key, value) { this.store[key] = value; }
    delete(key) { delete this.store[key]; }
}

function spyLogger() {
    const lines = [];
    const log = (level) => (msg) => lines.push(`${level}: ${msg}`);
    return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/** Mirrors the POST /api/remote/operator/claim contract (§6.5) that index.js implements. */
function claim(ras, token, req) {
    // Non-loopback claims are refused before any rate-limit accounting.
    if (!ras.isLoopback(req)) return { status: 403 };
    if (ras.isOperatorClaimBlocked()) return { status: 403 };
    if (!token.verifyLaunchSecret(req.body && req.body.secret)) {
        ras.noteFailedOperatorClaim();
        return { status: 403 };
    }
    return { status: 200, setCookie: token.cookieHeader(), body: { operator: true } };
}

async function runTests() {
    console.log('=== OperatorToken Tests ===');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-token-'));
    const file = path.join(tmp, 'data', 'operator-token');
    try {
        // File creation and reuse
        const logger = spyLogger();
        const a = new OperatorToken({ file, logger, platform: 'linux' }).load();
        assert(fs.existsSync(file), 'token file created on first run');
        const secret = a.getLaunchSecret();
        assert(/^[0-9a-f]{64}$/.test(secret), '32 random bytes as hex');
        assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), secret);
        assert(!fs.existsSync(`${file}.tmp`), 'no tmp file left behind');
        const mtime = fs.statSync(file).mtimeMs;
        const b = new OperatorToken({ file, platform: 'linux' }).load();
        assert.strictEqual(b.getLaunchSecret(), secret, 'same secret across instances (restart)');
        assert.strictEqual(b.cookieValue(), a.cookieValue());
        assert.strictEqual(fs.statSync(file).mtimeMs, mtime, 'existing file is not rewritten');
        assert(!logger.lines.some((l) => l.includes(secret)), 'secret never logged');
        console.log('✓ file is created once and reused across instances');

        // Cookie derivation
        const expected = crypto.createHmac('sha256', secret).update('onefinity-operator-cookie-v1').digest('base64url');
        assert.strictEqual(a.cookieValue(), expected, 'cookie = HMAC-SHA256(secret, context) base64url');
        assert.notStrictEqual(a.cookieValue(), secret, 'cookie differs from the secret');
        assert(!a.cookieValue().includes(secret));
        assert.strictEqual(OPERATOR_COOKIE, 'onefinity_op');
        const header = a.cookieHeader();
        assert(header.startsWith(`onefinity_op=${expected};`));
        for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=31536000']) assert(header.includes(attr), `cookie has ${attr}`);
        console.log('✓ cookieValue differs from the secret');

        // Verification
        assert.strictEqual(a.verifyLaunchSecret(secret), true);
        assert.strictEqual(a.verifyLaunchSecret(secret.toUpperCase()), true, 'hex case-insensitive');
        assert.strictEqual(a.verifyLaunchSecret(secret.slice(0, 63)), false, 'shorter secret rejected without throwing');
        assert.strictEqual(a.verifyLaunchSecret(`${secret}0`), false, 'longer secret rejected without throwing');
        assert.strictEqual(a.verifyLaunchSecret(''), false);
        assert.strictEqual(a.verifyLaunchSecret(undefined), false);
        assert.strictEqual(a.verifyLaunchSecret({ secret }), false);
        assert.strictEqual(a.verifyLaunchSecret(a.cookieValue()), false, 'cookie is not a launch secret');
        assert.strictEqual(a.verifyCookie(a.cookieValue()), true);
        assert.strictEqual(a.verifyCookie(secret), false, 'secret is not a cookie');
        assert.strictEqual(a.verifyCookie(`${a.cookieValue()}x`), false);
        assert.strictEqual(a.verifyCookie(undefined), false);
        assert.strictEqual(a.verifyCookie(null), false);
        assert.strictEqual(constantTimeEqual('abc', 'abc'), true);
        assert.strictEqual(constantTimeEqual('abc', 'abd'), false);
        assert.strictEqual(constantTimeEqual('abc', 'abcd'), false);
        // Constant-time compare goes through crypto.timingSafeEqual.
        const realTse = crypto.timingSafeEqual;
        let tseCalls = 0;
        crypto.timingSafeEqual = (x, y) => { tseCalls++; return realTse(x, y); };
        try {
            a.verifyCookie('wrong');
            a.verifyLaunchSecret('wrong');
        } finally {
            crypto.timingSafeEqual = realTse;
        }
        assert.strictEqual(tseCalls, 2, 'both verifications use timingSafeEqual');
        console.log('✓ constant-time verification');

        // Rotation
        const oldCookie = a.cookieValue();
        a.rotate();
        assert.notStrictEqual(a.getLaunchSecret(), secret);
        assert.strictEqual(a.verifyCookie(oldCookie), false, 'rotate() invalidates old cookies');
        assert.strictEqual(a.verifyLaunchSecret(secret), false, 'rotate() invalidates the old launch secret');
        assert.strictEqual(a.verifyCookie(a.cookieValue()), true);
        assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), a.getLaunchSecret(), 'rotated secret persisted');
        const c = new OperatorToken({ file, platform: 'linux' }).load();
        assert.strictEqual(c.getLaunchSecret(), a.getLaunchSecret(), 'launcher picks up the rotated file');
        console.log('✓ rotate() invalidates old cookies');

        // Malformed file is replaced
        fs.writeFileSync(file, 'not-a-secret');
        const warnLog = spyLogger();
        const d = new OperatorToken({ file, logger: warnLog, platform: 'linux' }).load();
        assert(/^[0-9a-f]{64}$/.test(d.getLaunchSecret()));
        assert(warnLog.lines.some((l) => l.startsWith('warn')), 'malformed file logged');
        console.log('✓ malformed token file regenerated');

        // An existing but unreadable file is never rotated.
        {
            const realRead = fs.readFileSync;
            const realOpen = fs.openSync;
            const ioError = (code) => Object.assign(new Error(code), { code });
            const good = new OperatorToken({ file, platform: 'linux' }).load();
            const onDisk = fs.readFileSync(file, 'utf8');
            const goodCookie = good.cookieValue();
            try {
                fs.readFileSync = function (p, ...rest) {
                    if (p === file) throw ioError('EACCES');
                    return realRead.call(fs, p, ...rest);
                };
                const errLog = spyLogger();
                const locked = new OperatorToken({ file, logger: errLog, platform: 'linux' });
                assert.doesNotThrow(() => locked.load(), 'unreadable file does not crash boot');
                assert.strictEqual(locked.isLoaded(), false);
                assert.strictEqual(locked.getLoadError(), 'EACCES');
                assert(errLog.lines.some((l) => l.startsWith('error')), 'logged loudly');
                fs.readFileSync = realRead;
                assert.strictEqual(fs.readFileSync(file, 'utf8'), onDisk, 'file not overwritten');
                fs.readFileSync = function (p, ...rest) {
                    if (p === file) throw ioError('EACCES');
                    return realRead.call(fs, p, ...rest);
                };
                assert.strictEqual(locked.verifyCookie(goodCookie), false, 'nobody is operator while unloaded');
                assert.strictEqual(locked.verifyLaunchSecret(good.getLaunchSecret()), false);
                assert.throws(() => locked.getLaunchSecret(), /operator_token_unreadable/);
                assert.throws(() => locked.rotate(), /operator_token_unreadable/);
                // A persistent lock: the throttled reload on the cookie path makes a
                // single read and never sleeps the event loop (was ~500 ms of Atomics.wait).
                let reads = 0;
                fs.readFileSync = function (p, ...rest) {
                    if (p === file) { reads += 1; throw ioError('EBUSY'); }
                    return realRead.call(fs, p, ...rest);
                };
                locked._lastReloadAt = 0;
                const t0 = process.hrtime.bigint();
                assert.strictEqual(locked.verifyCookie(goodCookie), false);
                const stalledMs = Number(process.hrtime.bigint() - t0) / 1e6;
                assert.strictEqual(reads, 1, 'reload on the request path does not retry');
                assert(stalledMs < 40, `cookie check blocked ${stalledMs.toFixed(1)} ms`);
                assert.strictEqual(locked.verifyCookie(goodCookie), false);
                assert.strictEqual(reads, 1, 'throttled: no second read within 30 s');
                reads = 0;
                assert.throws(() => locked.cookieHeader(), /operator_token_unreadable/);
                assert.strictEqual(reads, 1, 'request-path _ensureLoaded does not retry either');
                fs.readFileSync = realRead;
                assert.strictEqual(fs.readFileSync(file, 'utf8'), onDisk, 'rotate did not overwrite the file');
                // Lock clears → the next (throttled) verification reloads the same secret.
                locked._lastReloadAt = 0;
                assert.strictEqual(locked.verifyCookie(goodCookie), true, 'reloads once the file is readable');
                assert.strictEqual(locked.getLaunchSecret(), good.getLaunchSecret());

                // Transient lock → retried, same secret.
                let failures = 2;
                fs.readFileSync = function (p, ...rest) {
                    if (p === file && failures-- > 0) throw ioError('EBUSY');
                    return realRead.call(fs, p, ...rest);
                };
                assert.strictEqual(new OperatorToken({ file, platform: 'linux' }).load().getLaunchSecret(), good.getLaunchSecret(), 'transient lock retried');
                fs.readFileSync = realRead;

                // Rotate whose write fails keeps the old secret (the launcher still has it).
                fs.openSync = function (p, ...rest) {
                    if (String(p).startsWith(file)) throw ioError('EROFS');
                    return realOpen.call(fs, p, ...rest);
                };
                const r = new OperatorToken({ file, logger: spyLogger(), platform: 'linux' }).load();
                assert.throws(() => r.rotate(), (err) => err.code === 'EROFS');
                assert.strictEqual(r.verifyCookie(goodCookie), true, 'failed rotate leaves the working secret in place');
                assert.strictEqual(r.getLaunchSecret(), good.getLaunchSecret());
            } finally {
                fs.readFileSync = realRead;
                fs.openSync = realOpen;
            }
        }
        console.log('✓ unreadable token file is not rotated');

        // Windows ACL (injected execFile, best effort, logged once)
        const calls = [];
        const winLog = spyLogger();
        const winFile = path.join(tmp, 'win', 'operator-token');
        const win = new OperatorToken({
            file: winFile, logger: winLog, platform: 'win32', env: { USERNAME: 'cnc' },
            execFile: (cmd, args, opts, cb) => { calls.push([cmd, ...args]); setImmediate(() => cb(new Error('denied'))); },
        }).load();
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(calls[0], ['icacls', winFile, '/inheritance:r', '/grant:r', 'cnc:F']);
        win.rotate();
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(calls.length, 2, 'ACL re-applied after rotate');
        assert.strictEqual(winLog.lines.filter((l) => l.startsWith('warn')).length, 1, 'ACL failure logged once');
        console.log('✓ Windows ACL is best effort');

        // §6.5 identity list
        const ras = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000, operatorToken: a });
        const cookie = `${OPERATOR_COOKIE}=${a.cookieValue()}`;
        const loop = (headers = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
        const lan = (headers = {}) => ({ socket: { remoteAddress: '192.168.1.60' }, headers });

        const noPinId = ras.identify(loop());
        assert.notStrictEqual(noPinId && noPinId.kind, 'operator', 'loopback without cookie is never operator');
        ras.setPin('271828');
        const bare = ras.identify(loop());
        assert(bare === null || bare.kind === 'lan' || bare.kind === 'local', 'loopback without cookie: lan/local/null');
        assert.strictEqual(bare.kind, 'local', 'D1: unverified loopback is local');
        assert.deepStrictEqual(ras.identify(loop({ cookie })), { kind: 'operator' }, 'with the cookie → operator');
        const lanWithCookie = ras.identify(lan({ cookie }));
        assert(!lanWithCookie || lanWithCookie.kind !== 'operator', 'cookie on a non-loopback request → not operator');
        const proxied = ras.identify(loop({ cookie, 'x-forwarded-for': '198.51.100.7' }));
        assert(!proxied || (proxied.kind !== 'operator' && proxied.kind !== 'local'), 'proxied loopback + cookie → not operator');
        assert.strictEqual(ras.isOperator(loop({ cookie, forwarded: 'for=198.51.100.7' })), false);

        // Claim contract
        const good = claim(ras, a, { ...loop(), body: { secret: a.getLaunchSecret() } });
        assert.strictEqual(good.status, 200);
        assert.deepStrictEqual(good.body, { operator: true });
        assert(good.setCookie.startsWith(`${OPERATOR_COOKIE}=${a.cookieValue()};`));
        assert.strictEqual(claim(ras, a, { ...lan(), body: { secret: a.getLaunchSecret() } }).status, 403, 'claim from non-loopback → 403');
        assert.strictEqual(claim(ras, a, { ...loop({ 'x-forwarded-for': '198.51.100.7' }), body: { secret: a.getLaunchSecret() } }).status, 403,
            'claim through a proxy → 403');
        assert.strictEqual(claim(ras, a, { ...loop(), body: { secret: 'guess' } }).status, 403, 'wrong secret → 403');

        // Rotate invalidates the cookie for identity too
        a.rotate();
        assert.strictEqual(ras.identify(loop({ cookie })).kind, 'local', 'rotate invalidates the old cookie');
        assert.deepStrictEqual(ras.identify(loop({ cookie: `${OPERATOR_COOKIE}=${a.cookieValue()}` })), { kind: 'operator' });
        console.log('✓ identity rules (§6.5)');

        assert.deepStrictEqual(IDENTITY_KINDS, ['operator', 'local', 'lan', 'cloud']);
        assert(Object.isFrozen(IDENTITY_KINDS));
        console.log('✓ IDENTITY_KINDS exported and frozen');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('All OperatorToken tests passed');
}

const timeout = setTimeout(() => {
    console.error('Test timed out');
    process.exit(1);
}, 30000);
timeout.unref();

runTests().then(() => process.exit(0)).catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
