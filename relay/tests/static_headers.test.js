'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runTests, startRelay, stopRelay, request, rawHttp, tmpDir, removeDir } = require('./helpers/harness');

const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// A fixture web root keeps this test independent of the real relay/web app.
function makeWebDir() {
    const dir = tmpDir('relay-web-');
    fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Onefinity</title><script type="module" src="js/main.js"></script>');
    fs.writeFileSync(path.join(dir, 'js', 'main.js'), 'export const ok = true;\n');
    fs.writeFileSync(path.join(dir, 'app.css'), 'body{}');
    return dir;
}

function assertSecurityHeaders(res, { hsts }) {
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.strictEqual(res.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
    if (hsts) assert.strictEqual(res.headers['strict-transport-security'], 'max-age=31536000');
    else assert.strictEqual(res.headers['strict-transport-security'], undefined);
}

runTests('Relay Static + Headers', [
    ['CSP and security headers on HTML, assets and API responses', async () => {
        const webDir = makeWebDir();
        const relay = await startRelay({ webDir });
        try {
            const html = await request(relay, 'GET', '/');
            assert.strictEqual(html.status, 200);
            assert.ok(html.headers['content-type'].startsWith('text/html'));
            assert.strictEqual(html.headers['content-security-policy'], CSP);
            assertSecurityHeaders(html, { hsts: false });
            const js = await request(relay, 'GET', '/js/main.js');
            assert.strictEqual(js.status, 200);
            assert.ok(js.headers['content-type'].startsWith('text/javascript'));
            assert.strictEqual(js.headers['content-security-policy'], CSP);
            assertSecurityHeaders(js, { hsts: false });
            const api = await request(relay, 'GET', '/api/health');
            assertSecurityHeaders(api, { hsts: false });
            const head = await request(relay, 'HEAD', '/app.css');
            assert.strictEqual(head.status, 200);
            assert.strictEqual(head.body.length, 0);
        } finally {
            await stopRelay(relay);
            removeDir(webDir);
        }
    }],
    ['HSTS is sent when not in insecure mode', async () => {
        const webDir = makeWebDir();
        const relay = await startRelay({ webDir, allowInsecure: false, publicUrl: 'https://relay.example.com' });
        try {
            assertSecurityHeaders(await request(relay, 'GET', '/'), { hsts: true });
            assertSecurityHeaders(await request(relay, 'GET', '/api/health'), { hsts: true });
        } finally {
            await stopRelay(relay);
            removeDir(webDir);
        }
    }],
    ['path traversal is refused with 404 (raw and percent-encoded)', async () => {
        const webDir = makeWebDir();
        const relay = await startRelay({ webDir: path.join(__dirname, '..', 'web-does-not-matter-' + Date.now()) });
        const relay2 = await startRelay({ webDir });
        try {
            for (const r of [relay, relay2]) {
                for (const p of ['/../server/relay.js', '/%2e%2e/server/relay.js', '/%2E%2E/%2E%2E/package.json', '/js/..%2f..%2fserver%2frelay.js', '/..%5cserver%5crelay.js', '/js/%2e%2e/%2e%2e/tests/run-all.js', '/%00index.html']) {
                    const res = await rawHttp(r, `GET ${p} HTTP/1.1\nHost: x\nConnection: close`);
                    assert.strictEqual(res.status, 404, `${p} -> ${res.status}`);
                    assert.ok(!res.body.includes('createRelay') && !res.body.includes('onefinity-relay'), `${p} leaked content`);
                }
            }
        } finally {
            await stopRelay(relay);
            await stopRelay(relay2);
            removeDir(webDir);
        }
    }],
    ['SPA fallback for app routes; unknown assets and API paths are real 404s; no directory listing', async () => {
        const webDir = makeWebDir();
        const relay = await startRelay({ webDir });
        try {
            for (const p of ['/devices', '/d/d_abcdefabcdef/files', '/js']) {
                const res = await request(relay, 'GET', p);
                assert.strictEqual(res.status, 200, p);
                assert.ok(res.text.includes('<title>Onefinity</title>'), `${p} serves index.html`);
                assert.strictEqual(res.headers['content-security-policy'], CSP);
            }
            const missing = await request(relay, 'GET', '/js/missing.js');
            assert.strictEqual(missing.status, 404);
            const api = await request(relay, 'GET', '/api/does-not-exist');
            assert.deepStrictEqual([api.status, api.json], [404, { error: 'not_found' }]);
            const post = await request(relay, 'POST', '/index.html', { json: {} });
            assert.strictEqual(post.status, 405);
        } finally {
            await stopRelay(relay);
            removeDir(webDir);
        }
    }],
]);
