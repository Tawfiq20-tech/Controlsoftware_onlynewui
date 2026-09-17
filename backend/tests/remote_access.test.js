'use strict';

const assert = require('assert');
const os = require('os');
const {
    RemoteAccessService,
    isLoopbackAddress,
    isTailscaleAddress,
    isProxied,
    hostnameOf,
    parseCookies,
    SESSION_COOKIE,
} = require('../services/remoteAccess/RemoteAccessService');

class MockConfigStore {
    constructor() {
        this.store = {};
    }
    get(key, defaultValue) {
        return this.store[key] !== undefined ? this.store[key] : defaultValue;
    }
    set(key, value) {
        this.store[key] = value;
    }
    delete(key) {
        delete this.store[key];
    }
}

function mockRes() {
    const res = {
        lastCode: null,
        lastPayload: null,
        setHeader: () => {},
        status: (code) => ({
            json: (payload) => { res.lastCode = code; res.lastPayload = payload; },
        }),
    };
    return res;
}

/** Runs an Express-style middleware; resolves to true when next() was called. */
function passes(middleware, req, res = mockRes()) {
    let called = false;
    middleware(req, res, () => { called = true; });
    return called;
}

function socketResult(gate, handshake) {
    let result = null;
    gate({ handshake }, (err) => { result = err || 'ok'; });
    return result;
}

async function runTests() {
    console.log('=== Running RemoteAccessService Tests ===');

    const config = new MockConfigStore();
    const service = new RemoteAccessService({ configStore: config, port: 4000 });

    // Test 1: Address helpers
    console.log('Test 1: Address helpers');
    assert.strictEqual(isLoopbackAddress('127.0.0.1'), true);
    assert.strictEqual(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.strictEqual(isLoopbackAddress('::1'), true);
    assert.strictEqual(isLoopbackAddress('192.168.1.5'), false);
    assert.strictEqual(isTailscaleAddress('100.101.102.103'), true);
    assert.strictEqual(isTailscaleAddress('100.63.0.1'), false, '100.63 is outside 100.64.0.0/10');
    assert.strictEqual(isTailscaleAddress('192.168.1.5'), false);
    assert.strictEqual(hostnameOf('localhost:4000'), 'localhost');
    assert.strictEqual(hostnameOf('[::1]:4000'), '::1');
    assert.strictEqual(hostnameOf('Cnc-PC.tail1234.ts.net.'), 'cnc-pc.tail1234.ts.net');
    assert.deepStrictEqual(parseCookies('a=1; cnc_remote_session=abc'), { a: '1', cnc_remote_session: 'abc' });
    console.log('✓ Address helpers passed');

    // Test 2: Info exposure
    console.log('Test 2: Info exposure');
    const info = service.getInfo({ authorized: true, operator: true });
    assert(Array.isArray(info.ips), 'ips should be an array');
    assert.strictEqual(info.port, 4000);
    assert.strictEqual(info.pinSet, false);
    assert.strictEqual(typeof info.unifiedUrl, 'string');
    assert(!info.ips.some(isTailscaleAddress), 'Tailscale addresses are not listed as LAN');
    const publicInfo = service.getInfo({ authorized: false });
    assert.deepStrictEqual(Object.keys(publicInfo).sort(), ['authorized', 'minPinLength', 'operator', 'pinSet']);
    console.log('✓ Unauthorized clients only learn whether a PIN is required');

    // Test 3: PIN hashing
    console.log('Test 3: PIN setup & scrypt hashing');
    assert.throws(() => service.setPin('1234'), /at least 6 characters/, 'Short PIN should throw');
    service.setPin('987654');
    assert.strictEqual(service.hasPin(), true);
    const stored = config.get('remoteAccess.pinHash');
    const [salt, hash] = stored.split(':');
    assert.strictEqual(salt.length, 32, 'Salt should be 16 bytes hex');
    assert.strictEqual(hash.length, 128, 'Hash should be 64 bytes hex');
    assert.strictEqual(service.verifyPinRaw('987654'), true);
    assert.strictEqual(service.verifyPinRaw('000000'), false);
    // A 4-character PIN hashed by an older version must keep working.
    const legacy = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000 });
    const crypto = require('crypto');
    const legacySalt = crypto.randomBytes(16).toString('hex');
    legacy.config.set('remoteAccess.pinHash', `${legacySalt}:${crypto.scryptSync('1234', legacySalt, 64).toString('hex')}`);
    assert.strictEqual(legacy.verifyPinRaw('1234'), true, 'Existing 4-digit PINs stay valid');
    console.log('✓ PIN hashing passed');

    // Test 4: Per-IP lockout
    console.log('Test 4: Per-IP lockout (5 attempts -> 15 min)');
    const testIp = '192.168.1.105';
    for (let i = 1; i <= 4; i++) {
        const res = service.verifyPinWithRateLimit('wrong', testIp);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.remainingAttempts, 5 - i);
    }
    const lockRes = service.verifyPinWithRateLimit('wrong', testIp);
    assert.strictEqual(lockRes.locked, true, '5th failure must trigger lockout');
    assert.strictEqual(lockRes.remainingMinutes, 15);
    assert.strictEqual(service.verifyPinWithRateLimit('987654', testIp).locked, true, 'Locked IP rejected even with correct PIN');
    const otherRes = service.verifyPinWithRateLimit('987654', '192.168.1.106', { userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1' });
    assert.strictEqual(otherRes.ok, true, 'Unrelated IP succeeds');
    // After the lockout is served the count starts over (one typo must not re-lock).
    service.failedAttempts.get(testIp).lockedUntil = Date.now() - 1;
    const afterLock = service.verifyPinWithRateLimit('wrong', testIp);
    assert.strictEqual(afterLock.locked, undefined, 'First failure after lockout must not re-lock');
    assert.strictEqual(afterLock.remainingAttempts, 4);
    console.log('✓ Per-IP lockout passed');

    // Test 5: Global cooldown against guesses from many addresses
    console.log('Test 5: Global cooldown');
    const spray = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000 });
    spray.setPin('555555');
    let lastRes = null;
    for (let i = 0; i < 30; i++) lastRes = spray.verifyPinWithRateLimit('000000', `10.0.${Math.floor(i / 250)}.${i % 250 + 1}`);
    const sprayed = spray.verifyPinWithRateLimit('555555', '10.9.9.9');
    assert.strictEqual(sprayed.ok, false, 'Correct PIN refused during global cooldown');
    assert.strictEqual(sprayed.global, true);
    assert(lastRes && lastRes.ok === false);
    console.log('✓ Global cooldown passed');

    // Test 6: Sessions (hashed, persisted, sliding, revocable)
    console.log('Test 6: Sessions');
    const token = otherRes.token;
    assert.strictEqual(service.verifyToken(token), true);
    assert.strictEqual(service.verifyToken('invalid-token'), false);
    assert(!JSON.stringify(config.get('remoteAccess.sessions')).includes(token), 'Raw token must never be stored');
    const listed = service.getActiveSessions();
    assert.strictEqual(listed.count, 1);
    assert.strictEqual(listed.sessions[0].device, 'Safari on iPhone');
    const restarted = new RemoteAccessService({ configStore: config, port: 4000 });
    assert.strictEqual(restarted.verifyToken(token), true, 'Session survives a backend restart');
    assert.strictEqual(restarted.revokeSession(listed.sessions[0].id), true);
    assert.strictEqual(restarted.verifyToken(token), false, 'Revoked session rejected');
    const t2 = service.issueToken('192.168.1.7');
    service.revokeAllSessions();
    assert.strictEqual(service.verifyToken(t2), false);
    const t3 = service.issueToken('192.168.1.7');
    service.setPin('123456');
    assert.strictEqual(service.verifyToken(t3), false, 'Changing the PIN signs everyone out');
    service.setPin('987654');
    console.log('✓ Sessions passed');

    // Test 7: Loopback detection ignores proxied traffic
    console.log('Test 7: Loopback vs proxied');
    const lo = (headers = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
    assert.strictEqual(service.isLoopback(lo()), true, 'Plain loopback is the operator');
    assert.strictEqual(service.isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }), true);
    assert.strictEqual(service.isLoopback(lo({ 'x-forwarded-for': '127.0.0.1' })), true, 'Same-PC dev proxy is still the operator');
    assert.strictEqual(service.isLoopback(lo({ 'x-forwarded-for': '192.168.1.50' })), false, 'Proxied LAN client is remote');
    assert.strictEqual(service.isLoopback(lo({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' })), false, 'Spoofed hop is remote');
    assert.strictEqual(service.isLoopback(lo({ 'tailscale-user-login': 'a@b.c' })), false, 'tailscale serve is remote');
    assert.strictEqual(service.isLoopback(lo({ 'cf-connecting-ip': '203.0.113.9' })), false, 'cloudflared is remote');
    assert.strictEqual(service.isLoopback({ socket: { remoteAddress: '100.100.1.2' }, headers: {} }), false);
    assert.strictEqual(isProxied({}), false);
    console.log('✓ Loopback detection passed');

    // Test 8: HTTP gate
    console.log('Test 8: HTTP gate');
    const gate = service.httpGate();
    assert.strictEqual(passes(gate, { path: '/api/command', ...lo() }), true, 'Operator bypasses gate');
    const proxiedRes = mockRes();
    assert.strictEqual(passes(gate, { path: '/api/command', ...lo({ 'x-forwarded-for': '203.0.113.9' }) }, proxiedRes), false,
        'REGRESSION: proxied request from localhost must not skip the PIN');
    assert.strictEqual(proxiedRes.lastCode, 401);
    assert.strictEqual(passes(gate, { path: '/api/remote/verify-pin', socket: { remoteAddress: '192.168.1.200' }, headers: {} }), true);
    const remoteRes = mockRes();
    assert.strictEqual(passes(gate, { path: '/api/command', socket: { remoteAddress: '192.168.1.200' }, headers: {} }, remoteRes), false);
    assert.strictEqual(remoteRes.lastCode, 401);
    const fresh = service.issueToken('192.168.1.200');
    assert.strictEqual(passes(gate, { path: '/api/command', socket: { remoteAddress: '192.168.1.200' }, headers: { 'x-remote-token': fresh } }), true);
    assert.strictEqual(passes(gate, { path: '/api/webcam/stream/cam1', socket: { remoteAddress: '192.168.1.200' }, headers: { cookie: `${SESSION_COOKIE}=${fresh}` } }), true,
        'Session cookie authorizes <img> streams');
    assert.strictEqual(passes(gate, { path: '/index.html', socket: { remoteAddress: '192.168.1.200' }, headers: {} }), true, 'Static files are not gated');
    // Legacy test shape (req.ip only) still works.
    assert.strictEqual(passes(gate, { path: '/api/command', ip: '127.0.0.1', headers: {} }), true);
    console.log('✓ HTTP gate passed');

    // Test 9: Socket.IO gate
    console.log('Test 9: Socket.IO gate');
    const socketGate = service.socketGate();
    assert.strictEqual(socketResult(socketGate, { address: '127.0.0.1', headers: {} }), 'ok');
    assert(socketResult(socketGate, { address: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } }) instanceof Error,
        'REGRESSION: proxied socket from localhost must need a session');
    assert(socketResult(socketGate, { address: '192.168.1.200', auth: {}, headers: {} }) instanceof Error);
    assert.strictEqual(socketResult(socketGate, { address: '192.168.1.200', auth: { token: fresh }, headers: {} }), 'ok');
    assert.strictEqual(socketResult(socketGate, { address: '100.90.1.2', headers: { cookie: `${SESSION_COOKIE}=${fresh}` } }), 'ok');
    console.log('✓ Socket.IO gate passed');

    // Test 10: Browser guard (drive-by pages, DNS rebinding)
    console.log('Test 10: Browser guard');
    assert.strictEqual(service.isAllowedHost('localhost:4000'), true);
    assert.strictEqual(service.isAllowedHost('192.168.1.20:4000'), true);
    assert.strictEqual(service.isAllowedHost('100.101.102.103:4000'), true);
    assert.strictEqual(service.isAllowedHost('cnc-pc:4000'), true);
    assert.strictEqual(service.isAllowedHost('cnc-pc.tail1234.ts.net'), true);
    assert.strictEqual(service.isAllowedHost(`${os.hostname()}.local`), true);
    assert.strictEqual(service.isAllowedHost('rebind.attacker.example:4000'), false, 'Public names are refused (DNS rebinding)');
    assert.strictEqual(service.isAllowedOrigin(undefined), true, 'Non-browser clients send no Origin');
    assert.strictEqual(service.isAllowedOrigin('http://localhost:3000', 'localhost:4000'), true, 'Vite dev server');
    assert.strictEqual(service.isAllowedOrigin('http://192.168.1.20:4000', '192.168.1.20:4000'), true, 'Same-origin phone page');
    assert.strictEqual(service.isAllowedOrigin('https://evil.example', 'localhost:4000'), false, 'Drive-by page refused');
    assert.strictEqual(service.isAllowedOrigin('null', 'localhost:4000'), false);
    assert.strictEqual(service.checkBrowserRequest({ host: 'localhost:4000', 'sec-fetch-site': 'cross-site' }), 'Cross-site request refused');
    assert.strictEqual(service.checkBrowserRequest({ host: 'localhost:4000', 'sec-fetch-site': 'same-origin' }), null);
    const guardRes = mockRes();
    assert.strictEqual(passes(service.requestGuard(), { path: '/api/jog', headers: { host: 'localhost:4000', origin: 'https://evil.example' } }, guardRes), false);
    assert.strictEqual(guardRes.lastCode, 403);
    let allowVerdict = null;
    service.socketAllowRequest()({ headers: { host: 'localhost:4000', origin: 'https://evil.example' } }, (err, ok) => { allowVerdict = { err, ok }; });
    assert.strictEqual(allowVerdict.ok, false, 'WebSocket handshake from a foreign page refused');
    const withTailnetName = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000, getTrustedHostnames: () => ['cnc-pc.tail1234.ts.net'] });
    assert.strictEqual(withTailnetName.isAllowedOrigin('http://cnc-pc.tail1234.ts.net:4000', '100.101.102.103:4000'), true);
    let corsOpts = null;
    service.corsOptionsDelegate()({ headers: { origin: 'https://evil.example', host: 'localhost:4000' } }, (e, o) => { corsOpts = o; });
    assert.strictEqual(corsOpts.origin, false, 'No CORS headers for foreign origins');
    console.log('✓ Browser guard passed');

    // Test 11: QR code
    console.log('Test 11: QR code generation');
    const qrDataUrl = await service.getQrDataUrl('http://192.168.1.50:4000');
    assert(qrDataUrl.startsWith('data:image/png;base64,'));
    console.log('✓ QR code generation passed');

    // Test 12: PIN source
    console.log('Test 12: PIN source');
    const srcConfig = new MockConfigStore();
    const src = new RemoteAccessService({ configStore: srcConfig, port: 4000 });
    assert.strictEqual(src.getPinSource(), null, 'No PIN, no source');
    src.setPin('246810');
    assert.strictEqual(src.getPinSource(), 'custom', 'Default source is custom');
    assert.strictEqual(srcConfig.get('remoteAccess.pinSource'), 'custom');
    src.setPin('04817362', { source: 'access-code' });
    assert.strictEqual(src.getPinSource(), 'access-code');
    assert.strictEqual(src.getInfo({ authorized: true, operator: true }).pinSource, 'access-code');
    assert.strictEqual(src.getInfo({ authorized: false }).pinSource, undefined, 'Unauthorized info unchanged');
    src.setPin('246810', { source: 'bogus' });
    assert.strictEqual(src.getPinSource(), 'custom', 'Unknown source falls back to custom');
    src.clearPin();
    assert.strictEqual(src.getPinSource(), null);
    assert.strictEqual(srcConfig.get('remoteAccess.pinSource'), undefined, 'clearPin deletes pinSource');
    // A PIN stored before sources existed reads as custom.
    srcConfig.set('remoteAccess.pinHash', 'aa:bb');
    assert.strictEqual(src.getPinSource(), 'custom');
    console.log('✓ PIN source passed');

    // Test 13: resolveSession
    console.log('Test 13: resolveSession');
    const rs = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000 });
    rs.setPin('135790');
    const rsToken = rs.issueToken('192.168.1.40', 'Mozilla/5.0 (Android) Chrome/120');
    const hashKey = Array.from(rs.sessions.keys())[0];
    rs.sessions.get(hashKey).expiresAt = Date.now() + 1000;
    rs.sessions.get(hashKey).lastSeen = Date.now() - 5000;
    const resolved = rs.resolveSession(rsToken);
    assert(resolved, 'Valid token resolves');
    assert.deepStrictEqual(Object.keys(resolved).sort(), ['createdAt', 'device', 'expiresAt', 'id', 'ip', 'lastSeen', 'via']);
    assert.strictEqual(resolved.ip, '192.168.1.40');
    assert.strictEqual(resolved.via, 'lan');
    assert.strictEqual(resolved.device, 'Chrome on Android');
    assert(resolved.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000, 'Sliding expiry renewed');
    assert(Date.now() - resolved.lastSeen < 1000, 'lastSeen touched');
    resolved.id = 'tampered';
    assert.notStrictEqual(rs.resolveSession(rsToken).id, 'tampered', 'Returned session is a copy');
    assert.strictEqual(rs.resolveSession('nope'), null);
    assert.strictEqual(rs.resolveSession(null), null);
    rs.sessions.get(hashKey).expiresAt = Date.now() - 1;
    assert.strictEqual(rs.resolveSession(rsToken), null, 'Expired session is null');
    assert.strictEqual(rs.sessions.size, 0, 'Expired session removed');
    assert.strictEqual(rs.verifyToken(rsToken), false);
    console.log('✓ resolveSession passed');

    // Test 14: identify without operatorToken (legacy: loopback = operator)
    console.log('Test 14: identify (no operatorToken)');
    const idSvc = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000 });
    const remote = (headers = {}) => ({ socket: { remoteAddress: '192.168.1.77' }, headers });
    assert.deepStrictEqual(idSvc.identify(lo()), { kind: 'operator' }, 'Loopback is operator without operatorToken');
    assert.strictEqual(idSvc.isOperator(lo()), true);
    assert.deepStrictEqual(idSvc.identify(remote()), { kind: 'lan', sessionId: null, ip: '192.168.1.77', via: 'no-pin' });
    const proxiedNoPin = idSvc.identify(lo({ 'x-forwarded-for': '203.0.113.9' }));
    assert.strictEqual(proxiedNoPin.kind, 'lan', 'Proxied loopback is never operator or local');
    idSvc.setPin('112358');
    assert.strictEqual(idSvc.identify(remote()), null, 'Unauthorized remote is null');
    assert.strictEqual(idSvc.identify(lo({ 'x-forwarded-for': '203.0.113.9' })), null,
        'REGRESSION: proxied loopback with a PIN set is unauthorized');
    assert.strictEqual(idSvc.isOperator(lo({ 'cf-connecting-ip': '203.0.113.9' })), false);
    const idToken = idSvc.issueToken('192.168.1.77');
    const lanId = idSvc.identify(remote({ 'x-remote-token': idToken }));
    assert.strictEqual(lanId.kind, 'lan');
    assert.strictEqual(lanId.sessionId, idSvc.getActiveSessions().sessions[0].id);
    assert.strictEqual(lanId.ip, '192.168.1.77');
    assert.strictEqual(lanId.via, 'lan');
    assert.strictEqual(idSvc.identify(remote({ cookie: `${SESSION_COOKIE}=${idToken}` })).kind, 'lan', 'Cookie session identifies');
    assert.strictEqual(idSvc.isAuthorized(remote()), false);
    assert.strictEqual(idSvc.isAuthorized(remote({ 'x-remote-token': idToken })), true);
    assert.strictEqual(idSvc.identify(null), null);

    const idSock = (handshake) => {
        const socket = { handshake, joined: [], join(room) { this.joined.push(room); } };
        let err = 'pending';
        idSvc.socketGate()(socket, (e) => { err = e || null; });
        return { socket, err };
    };
    const opSock = idSock({ address: '127.0.0.1', headers: {} });
    assert.strictEqual(opSock.err, null);
    assert.deepStrictEqual(opSock.socket.data.identity, { kind: 'operator' });
    assert.deepStrictEqual(opSock.socket.joined, ['local', 'operator'], 'Loopback socket joins operator room without operatorToken');
    const lanSock = idSock({ address: '192.168.1.77', auth: { token: idToken }, headers: {} });
    assert.strictEqual(lanSock.err, null);
    assert.strictEqual(lanSock.socket.data.identity.kind, 'lan');
    assert.deepStrictEqual(lanSock.socket.joined, [], 'LAN socket never joins operator');
    const deniedSock = idSock({ address: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert(deniedSock.err instanceof Error, 'REGRESSION: proxied loopback socket needs a session');
    assert.deepStrictEqual(deniedSock.socket.joined, []);
    assert.deepStrictEqual(idSvc.identifyHandshake({ address: '::1', headers: {} }), { kind: 'operator' });
    console.log('✓ identify (no operatorToken) passed');

    // Test 15: identify with operatorToken (kiosk cookie is the second factor)
    console.log('Test 15: identify (with operatorToken)');
    const fs = require('fs');
    const path = require('path');
    const { OperatorToken, OPERATOR_COOKIE } = require('../services/remoteAccess/OperatorToken');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-op-'));
    try {
        const opToken = new OperatorToken({ file: path.join(tmpDir, 'operator-token'), platform: 'linux' }).load();
        const opSvc = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000, operatorToken: opToken });
        const opCookie = `${OPERATOR_COOKIE}=${opToken.cookieValue()}`;
        const loop = (headers = {}) => ({ path: '/api/command', socket: { remoteAddress: '127.0.0.1' }, headers });
        const lanReq = (headers = {}) => ({ path: '/api/command', socket: { remoteAddress: '192.168.1.88' }, headers });

        // No PIN set.
        assert.deepStrictEqual(opSvc.identify(loop()), { kind: 'local' }, 'Loopback without cookie is local (D1)');
        assert.strictEqual(opSvc.isOperator(loop()), false, 'Loopback alone is NOT operator');
        assert.deepStrictEqual(opSvc.identify(loop({ cookie: opCookie })), { kind: 'operator' });
        assert.strictEqual(opSvc.isOperator(loop({ cookie: `a=1; ${opCookie}` })), true);
        assert.strictEqual(opSvc.identify(loop({ cookie: `${OPERATOR_COOKIE}=forged` })).kind, 'local', 'Forged cookie is not operator');

        opSvc.setPin('314159');
        // Local: full local control (passes the gate with no PIN session) but not operator.
        const localGateReq = loop();
        assert.strictEqual(passes(opSvc.httpGate(), localGateReq), true, 'Local identity needs no PIN (D1)');
        assert.deepStrictEqual(localGateReq.remoteIdentity, { kind: 'local' });
        assert.strictEqual(opSvc.isAuthorized(loop()), true);
        assert.strictEqual(opSvc.isOperator(loop()), false, 'REGRESSION: header-less TCP forwarder is not operator');
        const opGateReq = loop({ cookie: opCookie });
        assert.strictEqual(passes(opSvc.httpGate(), opGateReq), true);
        assert.deepStrictEqual(opGateReq.remoteIdentity, { kind: 'operator' });

        // The cookie does not make a remote client the operator.
        assert.strictEqual(opSvc.identify(lanReq({ cookie: opCookie })), null, 'Cookie on a LAN request is not operator');
        assert.strictEqual(opSvc.isOperator(lanReq({ cookie: opCookie })), false);
        const lanRes = mockRes();
        assert.strictEqual(passes(opSvc.httpGate(), lanReq({ cookie: opCookie }), lanRes), false);
        assert.strictEqual(lanRes.lastCode, 401);

        // Proxied loopback with the cookie is neither operator nor local.
        const proxiedWithCookie = loop({ cookie: opCookie, 'x-forwarded-for': '203.0.113.9' });
        assert.strictEqual(opSvc.identify(proxiedWithCookie), null, 'REGRESSION: proxied loopback + cookie is not operator/local');
        assert.strictEqual(opSvc.isOperator(proxiedWithCookie), false);
        const proxRes = mockRes();
        assert.strictEqual(passes(opSvc.httpGate(), proxiedWithCookie, proxRes), false, 'Proxied loopback needs a PIN session');
        assert.strictEqual(proxRes.lastCode, 401);
        const proxToken = opSvc.issueToken('127.0.0.1');
        const proxWithSession = opSvc.identify(loop({ cookie: opCookie, 'tailscale-user-login': 'a@b.c', 'x-remote-token': proxToken }));
        assert.strictEqual(proxWithSession.kind, 'lan', 'Proxied loopback with a session is lan, never operator');

        // Open routes: identity is set (possibly null) and verify-pin works for a remote identity.
        const openReq = { path: '/api/remote/verify-pin', socket: { remoteAddress: '192.168.1.88' }, headers: {} };
        assert.strictEqual(passes(opSvc.httpGate(), openReq), true, 'verify-pin reachable from a remote identity with a PIN set');
        assert(Object.prototype.hasOwnProperty.call(openReq, 'remoteIdentity'), 'remoteIdentity set on open routes');
        assert.strictEqual(openReq.remoteIdentity, null);
        const verified = opSvc.verifyPinWithRateLimit('314159', '192.168.1.88');
        assert.strictEqual(verified.ok, true);
        const staticReq = { path: '/index.html', socket: { remoteAddress: '192.168.1.88' }, headers: {} };
        assert.strictEqual(passes(opSvc.httpGate(), staticReq), true);
        assert(Object.prototype.hasOwnProperty.call(staticReq, 'remoteIdentity'), 'remoteIdentity set on non-/api/ paths');
        const sessionReq = lanReq({ 'x-remote-token': verified.token });
        assert.strictEqual(passes(opSvc.httpGate(), sessionReq), true);
        assert.strictEqual(sessionReq.remoteIdentity.kind, 'lan');
        assert.strictEqual(typeof sessionReq.remoteIdentity.sessionId, 'string');

        // Socket gate.
        const gateSocket = (handshake) => {
            const socket = { handshake, joined: [], join(room) { this.joined.push(room); } };
            let err = 'pending';
            opSvc.socketGate()(socket, (e) => { err = e || null; });
            return { socket, err };
        };
        const kiosk = gateSocket({ address: '127.0.0.1', headers: { cookie: opCookie } });
        assert.strictEqual(kiosk.err, null);
        assert.deepStrictEqual(kiosk.socket.data.identity, { kind: 'operator' });
        assert.deepStrictEqual(kiosk.socket.joined, ['local', 'operator'], 'Loopback + valid cookie joins operator');
        const localSock = gateSocket({ address: '127.0.0.1', headers: {} });
        assert.strictEqual(localSock.err, null, 'Local socket connects without a PIN session');
        assert.deepStrictEqual(localSock.socket.data.identity, { kind: 'local' });
        assert.deepStrictEqual(localSock.socket.joined, ['local'], 'Local socket joins the local room, not operator');
        const proxSock = gateSocket({ address: '127.0.0.1', headers: { cookie: opCookie, 'x-forwarded-for': '203.0.113.9' } });
        assert(proxSock.err instanceof Error, 'Proxied loopback socket with cookie needs a session');
        assert.deepStrictEqual(proxSock.socket.joined, []);
        const lanCookieSock = gateSocket({ address: '192.168.1.88', auth: { token: verified.token }, headers: { cookie: opCookie } });
        assert.strictEqual(lanCookieSock.err, null);
        assert.strictEqual(lanCookieSock.socket.data.identity.kind, 'lan');
        assert.deepStrictEqual(lanCookieSock.socket.joined, [], 'Cookie from a LAN socket never joins operator');
        assert.strictEqual(opSvc.isOperatorHandshake({ address: '127.0.0.1', headers: { cookie: opCookie } }), true);
        assert.strictEqual(opSvc.isOperatorHandshake({ address: '127.0.0.1', headers: {} }), false);

        // Rotation invalidates the cookie everywhere.
        opToken.rotate();
        assert.deepStrictEqual(opSvc.identify(loop({ cookie: opCookie })), { kind: 'local' }, 'Rotated-out cookie is no longer operator');

        // Operator claim failures feed the global cooldown.
        assert.strictEqual(opSvc.isOperatorClaimBlocked(), false);
        for (let i = 0; i < 30; i++) opSvc.noteFailedOperatorClaim();
        assert.strictEqual(opSvc.isOperatorClaimBlocked(), true, 'Repeated bad claims trigger the global cooldown');

        // Remote PIN failures must never block the kiosk's operator claim.
        const claimSvc = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000, operatorToken: opToken });
        claimSvc.setPin('314159');
        for (let i = 0; i < 40; i++) claimSvc.verifyPinWithRateLimit('000000', `192.168.1.${10 + (i % 10)}`);
        assert(claimSvc.globalCooldownUntil > Date.now(), 'LAN guesses tripped the global PIN cooldown');
        assert.strictEqual(claimSvc.isOperatorClaimBlocked(), false, 'global PIN cooldown does not block a loopback operator claim');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    {
        // Test 15b: revocation reaches live sockets (spec A2)
        console.log('Test 15b: revoking sessions / changing the PIN disconnects live sockets');
        const svc = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000 });
        const admit = (handshake) => {
            const socket = {
                id: `s${Math.random()}`, handshake, joined: [], disconnected: 0, listeners: {},
                join(room) { this.joined.push(room); },
                once(ev, fn) { this.listeners[ev] = fn; },
                disconnect() { this.disconnected += 1; if (this.listeners.disconnect) this.listeners.disconnect(); },
            };
            let err = 'pending';
            svc.socketGate()(socket, (e) => { err = e || null; });
            assert.strictEqual(err, null);
            return socket;
        };
        // No PIN yet: a LAN socket is admitted as no-pin.
        const noPin = admit({ address: '192.168.1.40', headers: {} });
        const local = admit({ address: '127.0.0.1', headers: {} });
        assert.strictEqual(svc.isLanIdentityCurrent(noPin.data.identity), true);
        svc.setPin('271828');
        assert.strictEqual(noPin.disconnected, 1, 'setting a PIN disconnects no-PIN LAN sockets');
        assert.strictEqual(svc.isLanIdentityCurrent(noPin.data.identity), false);
        assert.strictEqual(local.disconnected, 0, 'local sockets are untouched');

        const tA = svc.issueToken('192.168.1.41');
        const tB = svc.issueToken('192.168.1.42');
        const a = admit({ address: '192.168.1.41', auth: { token: tA }, headers: {} });
        const b = admit({ address: '192.168.1.42', auth: { token: tB }, headers: {} });
        assert.strictEqual(svc.isLanIdentityCurrent(a.data.identity), true);
        assert.strictEqual(svc.revokeSession(a.data.identity.sessionId), true);
        assert.strictEqual(a.disconnected, 1, 'revokeSession disconnects that session\'s socket');
        assert.strictEqual(b.disconnected, 0, 'other sessions keep their socket');
        assert.strictEqual(svc.isLanIdentityCurrent(a.data.identity), false);

        assert.strictEqual(svc.revokeToken(tB), true);
        assert.strictEqual(b.disconnected, 1, 'logout (revokeToken) disconnects the socket');

        const tC = svc.issueToken('192.168.1.43');
        const c = admit({ address: '192.168.1.43', auth: { token: tC }, headers: {} });
        svc.revokeAllSessions();
        assert.strictEqual(c.disconnected, 1, 'revokeAllSessions disconnects every session socket');

        const tD = svc.issueToken('192.168.1.44');
        const d = admit({ address: '192.168.1.44', auth: { token: tD }, headers: {} });
        svc.setPin('141421');
        assert.strictEqual(d.disconnected, 1, 'changing the PIN disconnects session sockets');

        const tE = svc.issueToken('192.168.1.45');
        const e = admit({ address: '192.168.1.45', auth: { token: tE }, headers: {} });
        svc.clearPin();
        assert.strictEqual(e.disconnected, 1, 'clearing the PIN disconnects session sockets');

        // Expired sessions are not current and are dropped on cleanup.
        svc.setPin('161803');
        const tF = svc.issueToken('192.168.1.46');
        const f = admit({ address: '192.168.1.46', auth: { token: tF }, headers: {} });
        for (const s of svc.sessions.values()) s.expiresAt = Date.now() - 1;
        assert.strictEqual(svc.isLanIdentityCurrent(f.data.identity), false, 'expired session is not current');
        svc.cleanupExpiredTokens();
        assert.strictEqual(f.disconnected, 1, 'expiry disconnects the socket');
        assert.strictEqual(svc.isLanIdentityCurrent({ kind: 'local' }), false);
        assert.strictEqual(svc.isLanIdentityCurrent(null), false);

        // Operator token rotation: operator sockets are closed, others kept.
        // (Without an operatorToken every loopback socket is the operator,
        // including the earlier one.)
        const op = admit({ address: '127.0.0.1', headers: {} });
        assert.strictEqual(op.data.identity.kind, 'operator');
        assert.strictEqual(svc.disconnectOperatorSockets(), 2);
        assert.strictEqual(op.disconnected, 1);
        assert.strictEqual(local.disconnected, 1);
        assert.strictEqual(svc._sockets.size, 0, 'disconnected sockets are forgotten');
        console.log('✓ socket revocation passed');
    }
    const { IDENTITY_KINDS } = require('../services/remoteAccess/RemoteAccessService');
    assert.deepStrictEqual(IDENTITY_KINDS, ['operator', 'local', 'lan', 'cloud']);
    assert(Object.isFrozen(IDENTITY_KINDS));
    console.log('✓ identify (with operatorToken) passed');

    // Test 16: one predicate for local control (D1 safety: local must feed the activity tap)
    console.log('Test 16: hasLocalControl / isOperatorIdentity');
    {
        const { hasLocalControl, isOperatorIdentity } = require('../services/remoteAccess/RemoteAccessService');
        assert.strictEqual(hasLocalControl({ kind: 'operator' }), true);
        assert.strictEqual(hasLocalControl({ kind: 'local' }), true, 'local drives the machine like the operator');
        assert.strictEqual(hasLocalControl({ kind: 'lan', sessionId: 's', ip: '192.168.1.5', via: 'pin' }), false);
        assert.strictEqual(hasLocalControl({ kind: 'lan', sessionId: null, ip: '192.168.1.5', via: 'no-pin' }), false);
        assert.strictEqual(hasLocalControl({ kind: 'cloud' }), false);
        assert.strictEqual(hasLocalControl(null), false);
        assert.strictEqual(hasLocalControl(undefined), false);
        assert.strictEqual(isOperatorIdentity({ kind: 'operator' }), true);
        assert.strictEqual(isOperatorIdentity({ kind: 'local' }), false, 'local has no operator powers');
        assert.strictEqual(isOperatorIdentity(null), false);
        const svc = new RemoteAccessService({ configStore: new MockConfigStore(), port: 4000 });
        svc.setPin('161803');
        const proxied = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } };
        assert.strictEqual(hasLocalControl(svc.identify(proxied)), false, 'proxied loopback never has local control');
    }
    console.log('✓ hasLocalControl / isOperatorIdentity passed');

    console.log('All RemoteAccessService tests passed successfully!');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
