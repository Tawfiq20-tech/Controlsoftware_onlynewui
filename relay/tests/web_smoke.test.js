'use strict';

// Phone web app smoke test (SPEC §10.3 item 1): every file under relay/web is
// served with the right headers, every JS file parses as an ES module, and the
// source obeys the CSP-driven rules (no eval, no dynamic HTML, no external URLs).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const RELAY_DIR = path.resolve(process.env.RELAY_DIR || path.join(__dirname, '..'));
const WEB_DIR = path.resolve(process.env.RELAY_WEB_DIR || path.join(RELAY_DIR, 'web'));
const RELAY_JS = path.join(RELAY_DIR, 'server', 'relay.js');

// The only absolute URL allowed anywhere: the SVG XML namespace (not fetched).
const ALLOWED_URLS = new Set(['http://www.w3.org/2000/svg']);

const CONTENT_TYPES = {
    '.html': /^text\/html/,
    '.js': /^(text|application)\/javascript/,
    '.css': /^text\/css/,
    '.svg': /^image\/svg\+xml/,
    '.json': /^application\/json/,
    '.webmanifest': /^application\/(manifest\+json|json)/,
};

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

const files = walk(WEB_DIR);
const rel = (f) => path.relative(WEB_DIR, f).split(path.sep).join('/');
const jsFiles = files.filter((f) => f.endsWith('.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('expected files exist', () => {
    const names = new Set(files.map(rel));
    for (const required of [
        'package.json', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg',
        'js/core/jog.js', 'js/core/clock.js', 'js/core/link.js',
        'js/main.js', 'js/api.js', 'js/ws.js', 'js/protocol.js', 'js/store.js', 'js/ui.js',
        'js/views/login.js', 'js/views/register.js', 'js/views/devices.js', 'js/views/pair.js',
        'js/views/device.js', 'js/views/jogpad.js', 'js/views/files.js', 'js/views/audit.js',
        'js/views/sharing.js', 'js/views/account.js',
    ]) {
        assert.ok(names.has(required), 'missing relay/web/' + required);
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8')).type, 'module');
});

test('every JS file parses (node --check, ESM via package.json type)', () => {
    for (const f of jsFiles) {
        const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, rel(f) + ': ' + r.stderr);
    }
});

test('no eval or Function constructor', () => {
    for (const f of jsFiles) {
        const src = fs.readFileSync(f, 'utf8');
        assert.ok(!/\beval\s*\(/.test(src), rel(f) + ' uses eval');
        assert.ok(!/\bnew\s+Function\s*\(/.test(src), rel(f) + ' uses new Function');
        assert.ok(!/\bsetTimeout\s*\(\s*['"`]/.test(src) && !/\bsetInterval\s*\(\s*['"`]/.test(src), rel(f) + ' passes a string to a timer');
    }
});

test('HTML sinks only with static strings', () => {
    const sink = /(innerHTML|outerHTML)\s*\+?=\s*([^;\n]*)/g;
    const forbidden = [
        [/\[\s*['"`](?:inner|outer)HTML['"`]\s*\]/, 'bracketed innerHTML/outerHTML'],
        [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
        [/\bdocument\s*\.\s*write(?:ln)?\b/, 'document.write'],
        [/\bsrcdoc\b/, 'srcdoc'],
        [/\bcreateContextualFragment\b/, 'createContextualFragment'],
        [/\bDOMParser\b/, 'DOMParser'],
        [/\b(?:setHTMLUnsafe|parseHTMLUnsafe)\b/, 'setHTMLUnsafe/parseHTMLUnsafe'],
    ];
    for (const f of jsFiles) {
        const src = fs.readFileSync(f, 'utf8');
        for (const [re, what] of forbidden) assert.ok(!re.test(src), rel(f) + ': ' + what + ' is not allowed');
        let m;
        while ((m = sink.exec(src)) !== null) {
            const rhs = m[2].trim();
            assert.ok(/^(['"])[^'"`$+]*\1$/.test(rhs), rel(f) + ': ' + m[1] + ' assigned a non-static value: ' + rhs);
        }
    }
});

test('no external URLs', () => {
    for (const f of files) {
        if (!/\.(js|html|css|svg|webmanifest|json)$/.test(f)) continue;
        const src = fs.readFileSync(f, 'utf8');
        const urls = src.match(/\b(?:https?|wss?|ftp):\/\/[^\s'"`)<>]+/g) || [];
        for (const u of urls) assert.ok(ALLOWED_URLS.has(u), rel(f) + ' references external URL ' + u);
        assert.ok(!/(?:src|href)\s*=\s*["']\/\//.test(src), rel(f) + ' uses a protocol-relative URL');
        assert.ok(!/@import\s+url\(\s*["']?(?:https?:)?\/\//.test(src), rel(f) + ' imports remote CSS');
        assert.ok(!/\bimport\s*\(?\s*['"](?:https?:)?\/\//.test(src), rel(f) + ' imports a remote module');
    }
});

test('index.html is CSP-clean', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    assert.ok(/<script type="module" src="\/?js\/main\.js"><\/script>/.test(html), 'loads js/main.js as a module');
    assert.ok(/<link rel="stylesheet" href="\/?app\.css">/.test(html), 'loads app.css');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline <script>');
    assert.ok(!/<style[\s>]/i.test(html), 'no <style>');
    assert.ok(!/\sstyle\s*=/i.test(html), 'no style attributes');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers');
    assert.ok(/viewport-fit=cover/.test(html), 'viewport-fit=cover');
});

test('relay serves every web file with security headers', async () => {
    assert.ok(fs.existsSync(RELAY_JS), 'relay/server/relay.js is required: this test starts the relay (SPEC 10.3)');
    const { createRelay } = require(RELAY_JS);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-web-smoke-'));
    const relay = await createRelay({ host: '127.0.0.1', port: 0, dataDir, dbPath: ':memory:', allowInsecure: true, log: { info() {}, warn() {}, error() {}, debug() {} } });
    try {
        const get = (p) => fetch(relay.url + p, { redirect: 'manual' });

        const root = await get('/');
        assert.strictEqual(root.status, 200);
        const csp = root.headers.get('content-security-policy') || '';
        for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "img-src 'self' blob: data:", "object-src 'none'", "frame-ancestors 'none'"]) {
            assert.ok(csp.includes(part), 'CSP missing ' + part + ': ' + csp);
        }
        assert.strictEqual(root.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(root.headers.get('x-frame-options'), 'DENY');
        assert.ok((await root.text()).includes('js/main.js'));

        const main = await get('/js/main.js');
        assert.strictEqual(main.status, 200);
        assert.match(main.headers.get('content-type') || '', CONTENT_TYPES['.js']);

        for (const f of files) {
            const urlPath = '/' + rel(f);
            const res = await get(urlPath);
            assert.strictEqual(res.status, 200, urlPath);
            const ext = path.extname(f);
            if (CONTENT_TYPES[ext]) assert.match(res.headers.get('content-type') || '', CONTENT_TYPES[ext], urlPath);
            assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff', urlPath);
            // Every static response carries the same full policy, not only HTML.
            assert.strictEqual(res.headers.get('content-security-policy'), csp, urlPath + ' CSP');
            const body = Buffer.from(await res.arrayBuffer());
            assert.ok(body.equals(fs.readFileSync(f)), urlPath + ' body differs from disk');
        }

        const spa = await get('/d/d_abcdefabcdef');
        assert.strictEqual(spa.status, 200);
        assert.match(spa.headers.get('content-type') || '', /^text\/html/);
        assert.ok(spa.headers.get('content-security-policy'));
    } finally {
        await relay.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

(async () => {
    console.log('=== Web Smoke Tests ===');
    const timer = setTimeout(() => { console.log('timeout'); process.exit(1); }, 30000);
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log('✓ ' + t.name);
        } catch (err) {
            failed++;
            console.log('✗ ' + t.name);
            console.log(err && err.stack ? err.stack : err);
        }
    }
    clearTimeout(timer);
    process.exit(failed ? 1 : 0);
})();
