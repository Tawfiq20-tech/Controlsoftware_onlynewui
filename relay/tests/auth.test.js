'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const {
    runTests, startRelay, stopRelay, request, createUser, login, userWithSession, sessionFromResponse, waitUntil,
} = require('./helpers/harness');
const { createFakeClock } = require('./helpers/fakeClock');
const { pairDevice, connectDevice, connectClient, openWs, wsUrl, sha256 } = require('./helpers/peers');
const { LoginGuard } = require('../server/http/routes/auth');
const { createInvites } = require('../server/http/routes/admin');

function xff(ip) {
    return { 'X-Forwarded-For': ip };
}

async function tryLogin(relay, email, password, headers = {}, extraCookie) {
    return request(relay, 'POST', '/api/auth/login', { json: { email, password }, headers: Object.assign({}, headers, extraCookie ? { Cookie: extraCookie } : {}) });
}

// Opens a client socket, pairs a device and makes the client command it, so a later
// revocation must both close the socket and tell the device (client.gone).
async function liveCommandingClient(relay, session) {
    const dev = await pairDevice(relay, session);
    const { peer: device } = await connectDevice(relay, dev.credential);
    const { peer: client } = await connectClient(relay, session);
    await client.subscribe([dev.deviceId]);
    const env = client.cmd(dev.deviceId, 'job.stop', {});
    await device.waitFor((m) => m.t === 'cmd' && m.id === env.id);
    return { dev, device, client };
}

async function assertRevoked(relay, session, { device, client }, reason) {
    const info = await Promise.race([client.closed, new Promise((_, rej) => setTimeout(() => rej(new Error('client not closed')), 4000))]);
    assert.strictEqual(info.code, 4401);
    const gone = await device.waitFor('client.gone', 2000);
    assert.strictEqual(gone.body.connId, client.welcome.body.connId);
    assert.strictEqual(gone.body.reason, reason);
    const again = await openWs(wsUrl(relay, '/ws/client'), { Cookie: session.cookie, Origin: relay.url });
    assert.strictEqual(again.status, 401, 'revoked cookie cannot open a new socket, so no further cmd is forwarded');
    await device.close();
}

runTests('Relay Auth', [
    ['register: closed mode refuses', async () => {
        const relay = await startRelay({ signup: 'closed' });
        try {
            const r = await request(relay, 'POST', '/api/auth/register', { json: { email: 'a@example.com', password: 'longpassword1', displayName: 'A' } });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json.error, 'signup_closed');
            const cfg = await request(relay, 'GET', '/api/config');
            assert.strictEqual(cfg.json.signup, 'closed');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['register: invite mode needs a valid unused invite, checked before the email', async () => {
        const relay = await startRelay({ signup: 'invite' });
        try {
            const body = { email: 'b@example.com', password: 'longpassword1', displayName: 'B' };
            let r = await request(relay, 'POST', '/api/auth/register', { json: body });
            assert.strictEqual(r.status, 400);
            assert.strictEqual(r.json.error, 'invite_invalid');
            const [code] = createInvites(relay.db, relay.app.clock, { count: 1, expiresInDays: 1 });
            assert.ok(/^[A-Z2-7]{12}$/.test(code));
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM invites WHERE code_hash = ?', sha256(code)).n, 1);
            r = await request(relay, 'POST', '/api/auth/register', { json: Object.assign({ inviteCode: code.toLowerCase() }, body) });
            assert.strictEqual(r.status, 201, r.text);
            assert.ok(r.json.csrfToken);
            r = await request(relay, 'POST', '/api/auth/register', { json: Object.assign({}, body, { email: 'c@example.com', inviteCode: code }) });
            assert.strictEqual(r.status, 400);
            assert.strictEqual(r.json.error, 'invite_invalid');
            const [code2] = createInvites(relay.db, relay.app.clock, { count: 1, expiresInDays: 1 });
            r = await request(relay, 'POST', '/api/auth/register', { json: Object.assign({}, body, { inviteCode: code2 }) });
            assert.strictEqual(r.status, 400, 'no email_taken disclosure outside open mode');
            assert.notStrictEqual(r.json.error, 'email_taken');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['register: open mode, scrypt format, email_taken', async () => {
        const relay = await startRelay({ signup: 'open' });
        try {
            const body = { email: ' Sam@Example.com ', password: 'longpassword1', displayName: 'Sam' };
            let r = await request(relay, 'POST', '/api/auth/register', { json: body });
            assert.strictEqual(r.status, 201, r.text);
            assert.deepStrictEqual(Object.keys(r.json.user).sort(), ['displayName', 'email', 'id', 'isAdmin']);
            assert.strictEqual(r.json.user.email, 'sam@example.com');
            const row = relay.db.get('SELECT password_hash FROM users WHERE email = ?', 'sam@example.com');
            assert.ok(/^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(row.password_hash), row.password_hash);
            r = await request(relay, 'POST', '/api/auth/register', { json: body });
            assert.strictEqual(r.status, 409);
            assert.strictEqual(r.json.error, 'email_taken');
            r = await request(relay, 'POST', '/api/auth/register', { json: { email: 'x@example.com', password: 'short', displayName: 'X' } });
            assert.strictEqual(r.status, 400);
            r = await request(relay, 'POST', '/api/auth/register', { json: { email: 'not-an-email', password: 'longpassword1', displayName: 'X' } });
            assert.strictEqual(r.status, 400);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['register rate limit: 5 per IP per hour', async () => {
        const relay = await startRelay({ signup: 'open', trustProxy: true });
        try {
            for (let i = 0; i < 5; i++) {
                const r = await request(relay, 'POST', '/api/auth/register', { json: { email: 'x', password: 'p', displayName: 'X' }, headers: xff('10.9.9.9') });
                assert.strictEqual(r.status, 400);
            }
            const r = await request(relay, 'POST', '/api/auth/register', { json: { email: 'x', password: 'p', displayName: 'X' }, headers: xff('10.9.9.9') });
            assert.strictEqual(r.status, 429);
            const other = await request(relay, 'POST', '/api/auth/register', { json: { email: 'x', password: 'p', displayName: 'X' }, headers: xff('10.9.9.10') });
            assert.strictEqual(other.status, 400);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['login success, failure, cookie attributes (insecure dev) and hash-only session storage', async () => {
        const relay = await startRelay();
        try {
            const user = await createUser(relay, { email: 'l@example.com', password: 'longpassword1', name: 'L' });
            let r = await tryLogin(relay, user.email, 'wrong-password');
            assert.strictEqual(r.status, 401);
            assert.strictEqual(r.json.error, 'invalid_credentials');
            r = await tryLogin(relay, 'nobody@example.com', 'wrong-password');
            assert.strictEqual(r.status, 401);
            assert.strictEqual(r.json.error, 'invalid_credentials');
            r = await tryLogin(relay, user.email, user.password);
            assert.strictEqual(r.status, 200);
            const s = sessionFromResponse(r, user);
            const sc = s.setCookies.find((c) => c.startsWith('ors='));
            assert.ok(/; HttpOnly/.test(sc) && /; SameSite=Strict/.test(sc) && /; Path=\//.test(sc), sc);
            assert.ok(!/Secure/.test(sc), 'no Secure flag in loopback insecure mode');
            assert.ok(s.token.startsWith('ors_'));
            for (const row of relay.db.all('SELECT * FROM sessions')) {
                for (const v of Object.values(row)) if (typeof v === 'string') assert.ok(!v.includes(s.token));
            }
            assert.strictEqual(relay.db.get('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?', sha256(s.token)).n, 1);
            const me = await request(relay, 'GET', '/api/auth/me', { session: s });
            assert.strictEqual(me.status, 200);
            assert.strictEqual(me.json.csrfToken, s.csrfToken);
            assert.strictEqual(r.headers['strict-transport-security'], undefined);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['secure mode cookie has __Host- prefix, Secure and Max-Age; HSTS header set', async () => {
        const relay = await startRelay({ allowInsecure: false, publicUrl: 'https://relay.example.com' });
        try {
            const user = await createUser(relay, { password: 'longpassword1' });
            const r = await tryLogin(relay, user.email, user.password);
            assert.strictEqual(r.status, 200);
            const sc = [].concat(r.headers['set-cookie']).find((c) => c.startsWith('__Host-ors='));
            assert.ok(sc, 'secure session cookie');
            for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=1209600']) assert.ok(sc.includes(attr), attr);
            assert.strictEqual(r.headers['strict-transport-security'], 'max-age=31536000');
            const bad = await request(relay, 'POST', '/api/auth/login', { json: { email: user.email, password: user.password }, headers: { Origin: 'https://evil.example' } });
            assert.strictEqual(bad.status, 403);
            assert.strictEqual(bad.json.error, 'origin');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['CSRF: missing or wrong token -> 403; logout invalidates the session', async () => {
        const relay = await startRelay();
        try {
            const s = await userWithSession(relay, { password: 'longpassword1' });
            let r = await request(relay, 'POST', '/api/auth/password', { session: s, csrf: false, json: { currentPassword: 'longpassword1', newPassword: 'longpassword2' } });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json.error, 'csrf');
            r = await request(relay, 'POST', '/api/auth/password', { session: s, csrfToken: 'nope', json: { currentPassword: 'longpassword1', newPassword: 'longpassword2' } });
            assert.strictEqual(r.status, 403);
            r = await request(relay, 'POST', '/api/auth/logout', { session: s, json: {} });
            assert.strictEqual(r.status, 204);
            r = await request(relay, 'GET', '/api/auth/me', { session: s });
            assert.strictEqual(r.status, 401);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['password change revokes other sessions only', async () => {
        const relay = await startRelay();
        try {
            const user = await createUser(relay, { password: 'longpassword1' });
            const s1 = await login(relay, user);
            const s2 = await login(relay, user);
            const r = await request(relay, 'POST', '/api/auth/password', { session: s1, json: { currentPassword: 'longpassword1', newPassword: 'longpassword2' } });
            assert.strictEqual(r.status, 204, r.text);
            assert.strictEqual((await request(relay, 'GET', '/api/auth/me', { session: s1 })).status, 200);
            assert.strictEqual((await request(relay, 'GET', '/api/auth/me', { session: s2 })).status, 401);
            const list = await request(relay, 'GET', '/api/auth/sessions', { session: s1 });
            assert.strictEqual(list.json.length, 1);
            assert.strictEqual(list.json[0].current, true);
            assert.ok(/^[0-9a-f]{12}$/.test(list.json[0].id));
        } finally {
            await stopRelay(relay);
        }
    }],
    ['(email, IP) lockout after 5 failures; other IPs and known-device cookie are unaffected', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock, trustProxy: true });
        try {
            const user = await createUser(relay, { email: 'lock@example.com', password: 'longpassword1' });
            const good = await tryLogin(relay, user.email, user.password, xff('10.0.0.3'));
            const kd = sessionFromResponse(good, user).knownDeviceCookie;
            assert.ok(kd && kd.startsWith('ord='));
            for (let i = 0; i < 5; i++) {
                const r = await tryLogin(relay, user.email, 'wrong-password', xff('10.0.0.1'));
                assert.strictEqual(r.status, 401);
            }
            let r = await tryLogin(relay, user.email, user.password, xff('10.0.0.1'));
            assert.strictEqual(r.status, 429);
            assert.strictEqual(r.json.error, 'locked');
            assert.ok(r.json.retryAfterSec > 0 && r.json.retryAfterSec <= 900);
            r = await tryLogin(relay, user.email, user.password, xff('10.0.0.2'));
            assert.strictEqual(r.status, 200, 'IP B is not locked');
            r = await tryLogin(relay, user.email, user.password, xff('10.0.0.1'), kd);
            assert.strictEqual(r.status, 200, 'known-device cookie skips the pair lock');
            clock.advance(15 * 60000 + 1000);
            r = await tryLogin(relay, user.email, user.password, xff('10.0.0.1'));
            assert.strictEqual(r.status, 200, 'lock expires after 15 min (monotonic)');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['parallel wrong-password burst: at most 5 attempts reach the password check before 429', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock, trustProxy: true });
        try {
            const user = await createUser(relay, { email: 'burst@example.com', password: 'longpassword1' });
            const results = await Promise.all(Array.from({ length: 30 }, () => tryLogin(relay, user.email, 'wrong-password', xff('10.9.0.1'))));
            const statuses = results.map((r) => r.status);
            const verified = statuses.filter((x) => x === 401).length;
            assert.ok(verified >= 1 && verified <= 5, `${verified} attempts reached scrypt`);
            assert.strictEqual(statuses.filter((x) => x === 429).length, 30 - verified);
            relay.app.audit.flush();
            assert.ok(relay.db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'auth.login_failed'").n <= 5);
            const r = await tryLogin(relay, user.email, user.password, xff('10.9.0.1'));
            assert.strictEqual(r.status, verified === 5 ? 429 : 200, 'the pair locks once 5 failures are recorded');
            assert.strictEqual((await tryLogin(relay, user.email, user.password, xff('10.9.0.2'))).status, 200, 'owner on another IP unaffected');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['LoginGuard counts in-flight attempts toward the pair lock and releases them', () => {
        let t = 0;
        const g = new LoginGuard({ mono: () => t });
        const held = [];
        for (let i = 0; i < 5; i++) {
            const v = g.begin('a@example.com', '10.8.0.1', false);
            assert.strictEqual(v.blocked, null);
            held.push(v);
        }
        assert.ok(g.begin('a@example.com', '10.8.0.1', false).blocked, 'sixth concurrent attempt refused');
        const kd = g.begin('a@example.com', '10.8.0.1', true);
        assert.strictEqual(kd.blocked, null, 'known device is exempt');
        kd.release();
        held[0].release();
        held[0].release();
        const v = g.begin('a@example.com', '10.8.0.1', false);
        assert.strictEqual(v.blocked, null, 'a released slot is reusable');
        v.release();
        for (const h of held) h.release();
        assert.strictEqual(g.inflight.pair.size + g.inflight.email.size + g.inflight.ip.size, 0);
    }],
    ['per-email progressive delay is capped at 2 s and skipped with a known-device cookie', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock, trustProxy: true });
        try {
            const user = await createUser(relay, { email: 'slow@example.com', password: 'longpassword1' });
            const kd = sessionFromResponse(await tryLogin(relay, user.email, user.password, xff('10.1.0.99')), user).knownDeviceCookie;
            clock.sleeps.length = 0;
            for (let i = 0; i < 10; i++) {
                const r = await tryLogin(relay, user.email, 'wrong-password', xff(`10.1.0.${i % 3}`) );
                assert.strictEqual(r.status, 401);
            }
            assert.deepStrictEqual(clock.sleeps, [250, 500, 1000, 2000, 2000]);
            clock.sleeps.length = 0;
            const r = await tryLogin(relay, user.email, user.password, xff('10.1.0.50'), kd);
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(clock.sleeps, []);
        } finally {
            await stopRelay(relay);
        }
    }],
    ['per-IP progressive delay and hard limit; global delay only for failing IPs', () => {
        let t = 0;
        const g = new LoginGuard({ mono: () => t });
        for (let i = 0; i < 199; i++) g.recordFailure(`u${i}@example.com`, '10.2.0.1');
        assert.strictEqual(g.check('fresh@example.com', '10.2.0.1', false).delayMs, 0);
        g.recordFailure('u199@example.com', '10.2.0.1');
        assert.strictEqual(g.delayFor('fresh@example.com', '10.2.0.9', false), 0, 'other IP unaffected');
        const d200 = g.check('fresh@example.com', '10.2.0.1', false).delayMs;
        assert.ok(d200 >= 250, `delay at 200 failures: ${d200}`);
        for (let i = 200; i < 999; i++) g.recordFailure(`u${i}@example.com`, '10.2.0.1');
        assert.strictEqual(g.check('fresh@example.com', '10.2.0.1', false).blocked, null);
        assert.ok(g.delayFor('fresh@example.com', '10.2.0.1', false) <= 3000);
        g.recordFailure('u999@example.com', '10.2.0.1');
        const blocked = g.check('fresh@example.com', '10.2.0.1', false).blocked;
        assert.ok(blocked && blocked.retryAfterSec > 0, 'hard limit at 1000 failures');
        t += 15 * 60000 + 1;
        assert.strictEqual(g.check('fresh@example.com', '10.2.0.1', false).blocked, null);

        let t2 = 0;
        const g2 = new LoginGuard({ mono: () => t2 });
        for (let i = 0; i < 201; i++) g2.recordFailure(`v${i}@example.com`, `10.3.${Math.floor(i / 50)}.${i % 50}`);
        assert.strictEqual(g2.delayFor('clean@example.com', '10.4.0.1', false), 0, 'IP with no own failures gets no global delay');
        assert.strictEqual(g2.delayFor('clean@example.com', '10.3.0.1', false), 1000, 'failing IP gets the 1 s global delay');
        t2 += 5 * 60000 + 1;
        assert.strictEqual(g2.delayFor('clean@example.com', '10.3.0.1', false), 0);
    }],
    ['sliding (14 d) and absolute (30 d) session expiry', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock });
        try {
            const s = await userWithSession(relay);
            for (let i = 0; i < 2; i++) {
                clock.advance(13 * 86400000);
                assert.strictEqual((await request(relay, 'GET', '/api/auth/me', { session: s })).status, 200, `slide ${i}`);
            }
            clock.advance(4 * 86400000 + 60000);
            assert.strictEqual((await request(relay, 'GET', '/api/auth/me', { session: s })).status, 401, 'absolute cap');
            const s2 = await userWithSession(relay);
            clock.advance(14 * 86400000 + 1000);
            assert.strictEqual((await request(relay, 'GET', '/api/auth/me', { session: s2 })).status, 401, 'idle expiry');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['revocation via DELETE /api/auth/sessions/:id closes the live socket (4401) and sends client.gone', async () => {
        const relay = await startRelay();
        try {
            const user = await createUser(relay);
            const s1 = await login(relay, user);
            const s2 = await login(relay, user);
            const live = await liveCommandingClient(relay, s1);
            const list = await request(relay, 'GET', '/api/auth/sessions', { session: s2 });
            const target = list.json.find((x) => !x.current);
            const r = await request(relay, 'DELETE', `/api/auth/sessions/${target.id}`, { session: s2 });
            assert.strictEqual(r.status, 204);
            await assertRevoked(relay, s1, live, 'session-revoked');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['revocation via logout and password change closes live sockets', async () => {
        const relay = await startRelay();
        try {
            const user = await createUser(relay, { password: 'longpassword1' });
            const s1 = await login(relay, user);
            let live = await liveCommandingClient(relay, s1);
            assert.strictEqual((await request(relay, 'POST', '/api/auth/logout', { session: s1, json: {} })).status, 204);
            await assertRevoked(relay, s1, live, 'session-revoked');

            const s2 = await login(relay, user);
            const s3 = await login(relay, user);
            live = await liveCommandingClient(relay, s2);
            const r = await request(relay, 'POST', '/api/auth/password', { session: s3, json: { currentPassword: 'longpassword1', newPassword: 'longpassword2' } });
            assert.strictEqual(r.status, 204);
            await assertRevoked(relay, s2, live, 'session-revoked');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['revocation via expiry sweep and via user disable closes live sockets', async () => {
        const clock = createFakeClock();
        const relay = await startRelay({ clock });
        try {
            const s1 = await userWithSession(relay);
            let live = await liveCommandingClient(relay, s1);
            clock.advance(31 * 86400000);
            await relay.__test.runSweeps(['minute']);
            await assertRevoked(relay, s1, live, 'session-revoked');
        } finally {
            await stopRelay(relay);
        }
        const relay2 = await startRelay();
        try {
            const admin = await userWithSession(relay2, { admin: true });
            const s = await userWithSession(relay2);
            const live = await liveCommandingClient(relay2, s);
            const r = await request(relay2, 'POST', `/api/admin/users/${s.userId}/disable`, { session: admin, json: { disabled: true } });
            assert.strictEqual(r.status, 204);
            await assertRevoked(relay2, s, live, 'user-disabled');
            assert.strictEqual((await request(relay2, 'POST', '/api/auth/login', { json: { email: s.userRecord.email, password: s.userRecord.password } })).status, 401);
        } finally {
            await stopRelay(relay2);
        }
    }],
    ['revocation via CLI disable-user reaches live sockets with reason user-disabled', async () => {
        const relay = await startRelay();
        try {
            const s = await userWithSession(relay, { email: 'cli-disable@example.com' });
            const live = await liveCommandingClient(relay, s);
            const code = await new Promise((resolve, reject) => {
                const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'cli.js'), 'disable-user', '--email', 'cli-disable@example.com'], {
                    env: Object.assign({}, process.env, { RELAY_DATA_DIR: relay.dataDir }), stdio: ['ignore', 'pipe', 'pipe'],
                });
                let err = '';
                child.stderr.on('data', (d) => { err += d; });
                child.on('error', reject);
                child.on('close', (c) => (c === 0 ? resolve(c) : reject(new Error('cli failed: ' + err))));
            });
            assert.strictEqual(code, 0);
            await assertRevoked(relay, s, live, 'user-disabled');
        } finally {
            await stopRelay(relay);
        }
    }],
    ['revocation via CLI reset-password reaches the running server through session_revocations', async () => {
        const relay = await startRelay();
        try {
            const s = await userWithSession(relay, { email: 'cli@example.com' });
            const live = await liveCommandingClient(relay, s);
            const code = await new Promise((resolve, reject) => {
                const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'cli.js'), 'reset-password', '--email', 'cli@example.com', '--password-stdin'], {
                    env: Object.assign({}, process.env, { RELAY_DATA_DIR: relay.dataDir }), stdio: ['pipe', 'pipe', 'pipe'],
                });
                let err = '';
                child.stderr.on('data', (d) => { err += d; });
                child.on('error', reject);
                child.on('close', (c) => (c === 0 ? resolve(c) : reject(new Error('cli failed: ' + err))));
                child.stdin.end('brand-new-password\n');
            });
            assert.strictEqual(code, 0);
            await assertRevoked(relay, s, live, 'session-revoked');
            await waitUntil(() => relay.db.get('SELECT COUNT(*) AS n FROM session_revocations').n === 0, 2000, 'revocation rows consumed');
            const ok = await request(relay, 'POST', '/api/auth/login', { json: { email: 'cli@example.com', password: 'brand-new-password' } });
            assert.strictEqual(ok.status, 200);
        } finally {
            await stopRelay(relay);
        }
    }],
]);
