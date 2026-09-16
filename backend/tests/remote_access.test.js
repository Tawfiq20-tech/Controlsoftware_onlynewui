'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { RemoteAccessService } = require('../services/remoteAccess/RemoteAccessService');

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

async function runTests() {
    console.log('=== Running RemoteAccessService Tests ===');

    const config = new MockConfigStore();
    const service = new RemoteAccessService({ configStore: config, port: 4000 });

    // Test 1: LAN discovery & Unified Info
    console.log('Test 1: LAN Discovery & Unified Info');
    const info = service.getInfo();
    assert(Array.isArray(info.ips), 'ips should be an array');
    assert.strictEqual(info.port, 4000, 'port should match configured port');
    assert.strictEqual(info.pinSet, false, 'initially no PIN should be set');
    assert(info.tunnel, 'tunnel info should be present');
    console.log('✓ Discovery info returned successfully');

    // Test 2: PIN Setup & Verification (scrypt hashing)
    console.log('Test 2: PIN Setup & scrypt Hashing');
    assert.throws(() => service.setPin('12'), /at least 4 characters/, 'Short PIN should throw');
    service.setPin('9876');
    assert.strictEqual(service.hasPin(), true, 'PIN should now be set');
    
    // Verify scrypt format salt:hash
    const stored = config.get('remoteAccess.pinHash');
    assert(stored && stored.includes(':'), 'Stored PIN must have salt:hash format');
    const [salt, hash] = stored.split(':');
    assert.strictEqual(salt.length, 32, 'Salt should be 16 bytes hex');
    assert.strictEqual(hash.length, 128, 'Hash should be 64 bytes hex');

    assert.strictEqual(service.verifyPinRaw('9876'), true, 'Valid PIN must match');
    assert.strictEqual(service.verifyPinRaw('0000'), false, 'Wrong PIN must fail');
    console.log('✓ PIN security and scrypt hashing passed');

    // Test 3: Rate Limiting & Lockout Defense
    console.log('Test 3: Rate Limiting & Lockout Defense (5 attempts -> 15 min lock)');
    const testIp = '192.168.1.105';
    
    // 4 failed attempts
    for (let i = 1; i <= 4; i++) {
        const res = service.verifyPinWithRateLimit('wrong', testIp);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.remainingAttempts, 5 - i, `Should have ${5 - i} attempts remaining`);
        assert.strictEqual(res.locked, undefined);
    }

    // 5th failed attempt triggers lockout
    const lockRes = service.verifyPinWithRateLimit('wrong', testIp);
    assert.strictEqual(lockRes.ok, false);
    assert.strictEqual(lockRes.locked, true, '5th failure must trigger lockout');
    assert.strictEqual(lockRes.remainingMinutes, 15, 'Lockout should be 15 minutes');

    // Even with the CORRECT PIN, locked IP must be rejected
    const blockedRes = service.verifyPinWithRateLimit('9876', testIp);
    assert.strictEqual(blockedRes.ok, false);
    assert.strictEqual(blockedRes.locked, true, 'Locked IP must remain blocked even with correct PIN');

    // Different IP must NOT be blocked
    const otherIp = '192.168.1.106';
    const otherRes = service.verifyPinWithRateLimit('9876', otherIp);
    assert.strictEqual(otherRes.ok, true, 'Unrelated IP must succeed with correct PIN');
    assert(typeof otherRes.token === 'string', 'Should return session token');
    console.log('✓ Rate limiting & lockout defense passed');

    // Test 4: Session Tokens & Revocation
    console.log('Test 4: Session Tokens & Revocation');
    const token = otherRes.token;
    assert.strictEqual(service.verifyToken(token), true, 'Valid token should be recognized');
    assert.strictEqual(service.verifyToken('invalid-token'), false, 'Fake token should be rejected');

    const activeSessions = service.getActiveSessions();
    assert.strictEqual(activeSessions.count, 1, 'Should have 1 active session');

    // Revoke all sessions
    service.revokeAllSessions();
    assert.strictEqual(service.verifyToken(token), false, 'Revoked token must be rejected');
    assert.strictEqual(service.getActiveSessions().count, 0, 'Active sessions should be 0');
    console.log('✓ Session token issuance & revocation passed');

    // Test 5: HTTP Gate Middleware
    console.log('Test 5: HTTP Gate Authorization Middleware');
    const gate = service.httpGate();

    // Loopback IP bypasses gate without token
    let passed = false;
    const reqLoopback = {
        path: '/api/command',
        ip: '127.0.0.1',
        headers: { host: 'localhost:4000' },
    };
    const resMock = {
        setHeader: () => {},
        status: (code) => ({
            json: (payload) => { resMock.lastCode = code; resMock.lastPayload = payload; }
        }),
    };
    gate(reqLoopback, resMock, () => { passed = true; });
    assert.strictEqual(passed, true, 'Loopback IP must bypass HTTP gate');

    // Whitelisted path bypasses gate
    passed = false;
    const reqWhitelisted = {
        path: '/api/remote/verify-pin',
        ip: '192.168.1.200',
        headers: { host: '192.168.1.50:4000' },
    };
    gate(reqWhitelisted, resMock, () => { passed = true; });
    assert.strictEqual(passed, true, 'Whitelisted /api/remote/verify-pin must bypass gate');

    // Remote IP with missing token gets 401
    passed = false;
    resMock.lastCode = null;
    const reqRemoteUnauthorized = {
        path: '/api/command',
        ip: '192.168.1.200',
        headers: { host: '192.168.1.50:4000' },
    };
    gate(reqRemoteUnauthorized, resMock, () => { passed = true; });
    assert.strictEqual(passed, false, 'Remote request without token must not pass');
    assert.strictEqual(resMock.lastCode, 401, 'Remote request without token must receive 401');

    // SEC-1: the internet tunnel pipes requests into 127.0.0.1 on this very
    // PC, so a loopback address is not proof the operator is at the machine.
    // A tunnelled request must still need the PIN.
    for (const headers of [
        { host: 'shy-cats-jam.loca.lt' },                        // tunnel hostname
        { host: 'localhost:4000', 'x-forwarded-for': '203.0.113.7' }, // proxied
        { host: 'localhost:4000', forwarded: 'for=203.0.113.7' },
        {},                                                       // no Host at all
    ]) {
        passed = false;
        resMock.lastCode = null;
        gate({ path: '/api/command', ip: '127.0.0.1', headers }, resMock, () => { passed = true; });
        assert.strictEqual(passed, false, `tunnelled/proxied request must not pass as local: ${JSON.stringify(headers)}`);
        assert.strictEqual(resMock.lastCode, 401, 'tunnelled request must receive 401');
    }

    // Remote IP with valid token passes
    passed = false;
    const freshToken = service.issueToken('192.168.1.200');
    const reqRemoteAuthorized = {
        path: '/api/command',
        ip: '192.168.1.200',
        headers: { host: '192.168.1.50:4000', 'x-remote-token': freshToken },
    };
    gate(reqRemoteAuthorized, resMock, () => { passed = true; });
    assert.strictEqual(passed, true, 'Remote request with valid token must pass');
    console.log('✓ HTTP gate authorization passed');

    // Test 6: Socket.IO Gate Middleware
    console.log('Test 6: Socket.IO Gate Middleware');
    const socketGate = service.socketGate();

    // Loopback socket handshake succeeds
    let socketAllowed = false;
    let socketErr = null;
    socketGate({ handshake: { address: '127.0.0.1', headers: { host: 'localhost:4000' } } }, (err) => {
        if (!err) socketAllowed = true;
        else socketErr = err;
    });
    assert.strictEqual(socketAllowed, true, 'Loopback socket handshake must succeed');

    // ... but a socket arriving through the tunnel does not count as local
    socketAllowed = false;
    socketGate({ handshake: { address: '127.0.0.1', headers: { host: 'shy-cats-jam.loca.lt' }, auth: {} } }, (err) => {
        if (!err) socketAllowed = true;
    });
    assert.strictEqual(socketAllowed, false, 'tunnelled socket must not pass as local');

    // Remote socket handshake without token fails
    socketAllowed = false;
    socketErr = null;
    socketGate({ handshake: { address: '192.168.1.200', headers: { host: '192.168.1.50:4000' }, auth: {} } }, (err) => {
        if (!err) socketAllowed = true;
        else socketErr = err;
    });
    assert.strictEqual(socketAllowed, false, 'Remote socket without token must fail');
    assert(socketErr instanceof Error, 'Error must be provided');

    // Remote socket handshake with valid token succeeds
    socketAllowed = false;
    socketErr = null;
    socketGate({ handshake: { address: '192.168.1.200', headers: { host: '192.168.1.50:4000' }, auth: { token: freshToken } } }, (err) => {
        if (!err) socketAllowed = true;
        else socketErr = err;
    });
    assert.strictEqual(socketAllowed, true, 'Remote socket with valid token must succeed');
    console.log('✓ Socket.IO gate authorization passed');

    // Test 6b: Origin policy (SEC-1) -- a website the operator visits must not
    // be able to drive the machine from their own browser.
    console.log('Test 6b: Web origin policy');
    assert.strictEqual(service.isAllowedOrigin(undefined), true, 'non-browser client (no Origin) allowed');
    assert.strictEqual(service.isAllowedOrigin('http://localhost:4000'), true, 'the UI itself');
    assert.strictEqual(service.isAllowedOrigin('http://127.0.0.1:4000'), true);
    assert.strictEqual(service.isAllowedOrigin('http://localhost:5173'), true, 'vite dev server');
    assert.strictEqual(service.isAllowedOrigin('https://evil.example.com'), false, 'any other site is refused');
    assert.strictEqual(service.isAllowedOrigin('http://evil.com:4000'), false, 'same port does not make it local');
    assert.strictEqual(service.isAllowedOrigin('null'), false, 'sandboxed iframe / file:// is refused');
    assert.strictEqual(service.isAllowedOrigin('not a url'), false);
    const lanIp = service.getLanIps()[0];
    if (lanIp) assert.strictEqual(service.isAllowedOrigin(`http://${lanIp}:4000`), true, 'this machine on the LAN');
    service.tunnelUrl = 'https://shy-cats-jam.loca.lt';
    assert.strictEqual(service.isAllowedOrigin('https://shy-cats-jam.loca.lt'), true, 'our own tunnel');
    assert.strictEqual(service.isAllowedOrigin('https://someone-else.loca.lt'), false, 'somebody else\'s tunnel');
    service.tunnelUrl = null;
    let corsErr = null;
    service.corsOrigin()('https://evil.example.com', (e) => { corsErr = e; });
    assert.ok(corsErr instanceof Error, 'cors callback rejects a foreign origin');
    console.log('✓ origin policy passed');

    // Test 7: QR Code Generation
    console.log('Test 7: QR Code Generation');
    const qrDataUrl = await service.getQrDataUrl('http://192.168.1.50:4000');
    assert(typeof qrDataUrl === 'string', 'QR code should be string');
    assert(qrDataUrl.startsWith('data:image/png;base64,'), 'QR code should be base64 PNG data URL');
    console.log('✓ QR code generation passed');

    console.log('All RemoteAccessService tests passed successfully!');
}

runTests().then(() => {
    console.log("ALL TESTS PASSED SUCCESSFULLY!");
}).catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
