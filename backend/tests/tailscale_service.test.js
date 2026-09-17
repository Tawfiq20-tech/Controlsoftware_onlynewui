'use strict';

const assert = require('assert');
const { TailscaleService, parseTailscaleStatus, buildWarnings, mapBackendState } = require('../services/remoteAccess/TailscaleService');

const DAY = 24 * 60 * 60 * 1000;

// Trimmed from real `tailscale status --json` output.
function runningStatus(overrides = {}) {
    return {
        Version: '1.76.1-t1234',
        BackendState: 'Running',
        AuthURL: '',
        TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234'],
        Self: {
            HostName: 'CNC-PC',
            DNSName: 'cnc-pc.tail1234.ts.net.',
            OS: 'windows',
            TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234'],
            Online: true,
            KeyExpiry: new Date(Date.now() + 120 * DAY).toISOString(),
        },
        Health: [],
        CurrentTailnet: { Name: 'shop@example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true },
        Peer: {
            'nodekey:aa': { HostName: 'pixel-8', DNSName: 'pixel-8.tail1234.ts.net.', OS: 'android', TailscaleIPs: ['100.90.1.2'], Online: true },
            'nodekey:bb': { HostName: 'laptop', DNSName: 'laptop.tail1234.ts.net.', OS: 'macOS', TailscaleIPs: ['100.90.1.3'], Online: false },
        },
        ...overrides,
    };
}

/** Fake child_process.execFile driven by a (file, args) → { code, stdout, stderr } table. */
function fakeExec(handler) {
    const calls = [];
    const execFile = (file, args, opts, cb) => {
        calls.push([file, ...args].join(' '));
        const r = handler(file, args) || { code: 1, stdout: '', stderr: 'not found' };
        const err = r.code === 0 ? null : Object.assign(new Error(r.stderr || 'failed'), { code: r.code });
        setImmediate(() => cb(err, r.stdout || '', r.stderr || ''));
    };
    return { execFile, calls };
}

async function runTests() {
    console.log('=== Running TailscaleService Tests ===');

    // Test 1: Parsing
    console.log('Test 1: parseTailscaleStatus');
    const parsed = parseTailscaleStatus(runningStatus(), 4000);
    assert.strictEqual(parsed.state, 'running');
    assert.strictEqual(parsed.ipv4, '100.101.102.103');
    assert.strictEqual(parsed.url, 'http://100.101.102.103:4000');
    assert.strictEqual(parsed.dnsName, 'cnc-pc.tail1234.ts.net');
    assert.strictEqual(parsed.dnsUrl, 'http://cnc-pc.tail1234.ts.net:4000');
    assert.strictEqual(parsed.tailnet, 'shop@example.com');
    assert.strictEqual(parsed.peers.length, 2);
    assert.deepStrictEqual(parsed.peers[0], { name: 'pixel-8', os: 'android', online: true, ip: '100.90.1.2' });
    const noExpiry = runningStatus();
    delete noExpiry.Self.KeyExpiry;
    assert.strictEqual(parseTailscaleStatus(noExpiry, 4000).keyExpiry, null, 'Missing KeyExpiry means expiry is disabled');
    const noMagic = runningStatus({ CurrentTailnet: { Name: 'x', MagicDNSEnabled: false } });
    assert.strictEqual(parseTailscaleStatus(noMagic, 4000).dnsUrl, null, 'No name URL without MagicDNS');
    assert.strictEqual(mapBackendState('NeedsLogin'), 'needs-login');
    assert.strictEqual(mapBackendState('Stopped'), 'stopped');
    assert.strictEqual(mapBackendState('Starting'), 'starting');
    assert.strictEqual(mapBackendState('Weird'), 'error');
    console.log('✓ Parsing passed');

    // Test 2: Warnings for things that silently break access
    console.log('Test 2: buildWarnings');
    const codes = (status, env) => buildWarnings(status, { port: 4000, ...env }).map((w) => w.code);
    const now = Date.now();
    assert.deepStrictEqual(codes({ ...parsed, keyExpiry: null }, { unattended: true, firewall: 'present' }), [], 'Healthy setup has no warnings');
    assert(codes({ ...parsed, keyExpiry: now + 10 * DAY }, {}).includes('key-expiring'));
    assert(codes({ ...parsed, keyExpiry: now - DAY }, {}).includes('key-expired'));
    assert(codes({ ...parsed, keyExpiry: now + 120 * DAY }, {}).includes('key-expiry-enabled'));
    assert(codes({ ...parsed, keyExpiry: null }, { unattended: false }).includes('not-unattended'));
    assert(codes({ ...parsed, keyExpiry: null }, { firewall: 'missing' }).includes('firewall'));
    assert(codes({ ...parsed, keyExpiry: null, peers: [] }, {}).includes('no-peers'));
    const login = buildWarnings({ state: 'needs-login', authUrl: 'https://login.tailscale.com/a/xyz', peers: [] }, { port: 4000 });
    assert.strictEqual(login[0].code, 'needs-login');
    assert.strictEqual(login[0].action.url, 'https://login.tailscale.com/a/xyz');
    const fw = buildWarnings({ state: 'running', peers: [{ online: true }], keyExpiry: null }, { port: 4000, firewall: 'missing' });
    assert.strictEqual(fw[0].action.fix, 'firewall');
    console.log('✓ Warnings passed');

    // Test 3: Not installed
    console.log('Test 3: Service — Tailscale not installed');
    {
        const { execFile } = fakeExec(() => null);
        const svc = new TailscaleService({ port: 4000, execFile, platform: 'linux', existsSync: () => false });
        const s = await svc.getStatus();
        assert.strictEqual(s.installed, false);
        assert.strictEqual(s.state, 'not-installed');
        assert.strictEqual(s.firewall, 'not-applicable');
        assert(s.downloadUrl);
    }
    console.log('✓ Not installed passed');

    // Test 4: Running on Windows (unattended + firewall checks)
    console.log('Test 4: Service — running on Windows');
    {
        const { execFile, calls } = fakeExec((file, args) => {
            if (file.endsWith('tailscale.exe') && args[0] === 'status') return { code: 0, stdout: JSON.stringify(runningStatus()) };
            if (file.endsWith('tailscale.exe') && args[0] === 'debug') return { code: 0, stdout: JSON.stringify({ ForceDaemon: false }) };
            if (file === 'netsh') return { code: 1, stdout: 'No rules match the specified criteria.' };
            return null;
        });
        const svc = new TailscaleService({
            port: 4000, execFile, platform: 'win32',
            existsSync: (p) => p.endsWith('tailscale.exe'),
            env: { ProgramFiles: 'C:\\Program Files' },
        });
        const s = await svc.getStatus();
        assert.strictEqual(s.state, 'running');
        assert.strictEqual(s.url, 'http://100.101.102.103:4000');
        assert.strictEqual(s.unattended, false);
        assert.strictEqual(s.firewall, 'missing');
        const warnCodes = s.warnings.map((w) => w.code);
        assert(warnCodes.includes('not-unattended'));
        assert(warnCodes.includes('firewall'));
        assert.deepStrictEqual(svc.getCachedHostnames(), ['cnc-pc.tail1234.ts.net', 'cnc-pc', 'CNC-PC']);

        const before = calls.length;
        await svc.getStatus();
        assert.strictEqual(calls.length, before, 'Second call within 5s is served from cache');
        await Promise.all([svc.getStatus({ force: true }), svc.getStatus({ force: true })]);
        assert(calls.length > before, 'force=true re-reads status');
    }
    console.log('✓ Running on Windows passed');

    // Test 5: Installed but daemon down / firewall rule present
    console.log('Test 5: Service — daemon not running');
    {
        const { execFile } = fakeExec((file, args) => {
            if (args[0] === 'status') return { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled; it doesn\'t appear to be running' };
            if (file === 'netsh') return { code: 0, stdout: 'Rule Name: CNC Control Software Port 4000' };
            return null;
        });
        const svc = new TailscaleService({ port: 4000, execFile, platform: 'win32', existsSync: () => true, env: {} });
        const s = await svc.getStatus();
        assert.strictEqual(s.installed, true);
        assert.strictEqual(s.state, 'service-stopped');
        assert.strictEqual(s.firewall, 'present');
        assert.strictEqual(s.warnings[0].code, 'service-stopped');
    }
    console.log('✓ Daemon not running passed');

    // Test 6: A throwing execFile never rejects getStatus
    console.log('Test 6: Service — never throws');
    {
        const svc = new TailscaleService({ port: 4000, execFile: () => { throw new Error('spawn EPERM'); }, platform: 'linux', existsSync: () => true });
        const s = await svc.getStatus();
        assert.ok(s.state, 'Resolves with a state even when spawning fails');
    }
    console.log('✓ Never throws passed');

    console.log('All TailscaleService tests passed successfully!');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

// tests/run-all.js treats a run as finished only when it prints this line.
// These suites came from the remote-access branch, which ran them directly;
// they signal failure with a non-zero exit, so a clean exit means pass.
process.on('exit', (code) => { if (code === 0) console.log('ALL TESTS PASSED SUCCESSFULLY!'); });
