'use strict';

const assert = require('assert');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { MdnsResponder, parsePacket, readName, filterAddresses, buildResponse } = require('../services/remoteAccess/MdnsResponder');

const HOST = 'onefinity-3f9a1c.local';

function spyLogger() {
    const lines = [];
    const log = (level) => (msg) => lines.push(`${level}: ${msg}`);
    return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

function encodeLabels(name) {
    const parts = [];
    for (const label of name.split('.')) parts.push(Buffer.from([label.length]), Buffer.from(label));
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

function header({ id = 0, flags = 0, qd = 1, an = 0 } = {}) {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(id, 0);
    h.writeUInt16BE(flags, 2);
    h.writeUInt16BE(qd, 4);
    h.writeUInt16BE(an, 6);
    return h;
}

function tail(type, cls) {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(type, 0);
    b.writeUInt16BE(cls, 2);
    return b;
}

function query(name, { id = 0x1234, type = 1, cls = 1 } = {}) {
    return Buffer.concat([header({ id }), encodeLabels(name), tail(type, cls)]);
}

/** Real dgram, except that nothing is ever sent to the multicast group. */
function loopbackDgram(sent) {
    return {
        createSocket(opts) {
            const socket = dgram.createSocket(opts);
            const realSend = socket.send.bind(socket);
            socket.send = (buf, offset, length, port, address, cb) => {
                sent.push({ buf: Buffer.from(buf), port, address });
                if (address === '224.0.0.251') {
                    if (cb) setImmediate(cb, null);
                    return;
                }
                realSend(buf, offset, length, port, address, cb);
            };
            return socket;
        },
    };
}

/** Fully fake dgram: records every call, never touches the network. */
function fakeDgram({ bindError = null } = {}) {
    const sockets = [];
    return {
        sockets,
        createSocket(opts) {
            const s = new EventEmitter();
            s.opts = opts;
            s.sends = [];
            s.memberships = [];
            s.closed = false;
            s.bind = (port, address) => {
                s.bound = { port, address };
                setImmediate(() => (bindError ? s.emit('error', Object.assign(new Error(bindError), { code: bindError })) : s.emit('listening')));
            };
            s.addMembership = (group, iface) => {
                s.memberships.push([group, iface]);
                if (iface) throw Object.assign(new Error('EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' });
            };
            s.setMulticastTTL = () => {};
            s.setMulticastLoopback = () => {};
            s.send = (buf, offset, length, port, address, cb) => {
                s.sends.push({ buf: Buffer.from(buf), port, address });
                if (cb) setImmediate(cb, null);
            };
            s.address = () => ({ address: '0.0.0.0', port: 5353 });
            s.close = () => { s.closed = true; };
            sockets.push(s);
            return s;
        },
    };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 1000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (pred()) return;
        await wait(5);
    }
    throw new Error('condition not met in time');
}

function aRecords(packet) {
    return packet.answers.filter((a) => a.type === 1).map((a) => ({ name: a.name, ttl: a.ttl, addr: Array.from(a.data).join('.'), flush: a.flush }));
}

async function runTests() {
    console.log('=== MdnsResponder Tests ===');

    // Real loopback socket on an ephemeral port.
    const sent = [];
    const logger = spyLogger();
    const mdns = new MdnsResponder({
        hostname: HOST,
        getAddresses: () => ['192.168.1.50', '100.101.1.1', '169.254.1.1', '127.0.0.1'],
        logger,
        dgram: loopbackDgram(sent),
        port: 0,
        bindAddress: '127.0.0.1',
    });
    assert.strictEqual(mdns.start(), mdns, 'start() returns this');
    await waitFor(() => mdns.getStatus().state === 'running');
    const port = mdns.getLocalPort();
    assert(port > 0 && port !== 5353, 'bound to an ephemeral port');

    const client = dgram.createSocket('udp4');
    await new Promise((r) => client.bind(0, '127.0.0.1', r));
    const replies = [];
    client.on('message', (msg) => replies.push(msg));
    const ask = async (buf, ms = 300) => {
        replies.length = 0;
        client.send(buf, port, '127.0.0.1');
        const end = Date.now() + ms;
        while (Date.now() < end && !replies.length) await wait(5);
        return replies.slice();
    };

    try {
        // Basic A query
        const r1 = await ask(query(HOST));
        assert.strictEqual(r1.length, 1, 'unicast reply received');
        const p1 = parsePacket(r1[0]);
        assert.strictEqual(p1.id, 0x1234, 'legacy unicast echoes the query ID');
        assert.strictEqual(p1.qr, true);
        assert.strictEqual(r1[0].readUInt16BE(2), 0x8400);
        assert.strictEqual(p1.questions.length, 1, 'legacy unicast includes the question');
        assert.strictEqual(p1.questions[0].name, HOST);
        const recs = aRecords(p1);
        assert.deepStrictEqual(recs.map((r) => r.addr), ['192.168.1.50'], 'only the LAN address');
        assert.strictEqual(recs[0].ttl, 120);
        assert.strictEqual(recs[0].name, HOST);
        assert.strictEqual(recs[0].flush, false, 'legacy unicast uses class IN without cache-flush');
        assert(r1[0].length <= 512);
        console.log('✓ unicast A reply echoes ID 0x1234 with 192.168.1.50 TTL 120');

        // Case-insensitive and ANY
        const r2 = await ask(query('OneFinity-3F9A1C.LOCAL', { type: 255 }));
        assert.strictEqual(r2.length, 1, 'case-insensitive ANY query answered');
        console.log('✓ case-insensitive ANY query answered');

        // Wrong name
        const r3 = await ask(query('onefinity-000000.local'));
        assert.strictEqual(r3.length, 0, 'wrong name → no reply within 300 ms');
        const r3b = await ask(query(HOST, { type: 16 }));
        assert.strictEqual(r3b.length, 0, 'TXT query → no reply');
        console.log('✓ wrong name → no reply within 300 ms');

        // Compressed name: q1 "foo.local", q2 "onefinity-3f9a1c" + pointer to "local" in q1.
        const q1 = Buffer.concat([encodeLabels('foo.local'), tail(1, 1)]);
        const localOffset = 12 + 4; // 3 'foo' + len byte
        const q2 = Buffer.concat([Buffer.from([16]), Buffer.from('onefinity-3f9a1c'), Buffer.from([0xc0, localOffset]), tail(1, 1)]);
        const compressed = Buffer.concat([header({ id: 0x4321, qd: 2 }), q1, q2]);
        assert.strictEqual(readName(compressed, 12 + q1.length).name, HOST);
        const r4 = await ask(compressed);
        assert.strictEqual(r4.length, 1, 'compressed-name query → reply');
        assert.strictEqual(parsePacket(r4[0]).id, 0x4321);
        assert.deepStrictEqual(aRecords(parsePacket(r4[0])).map((r) => r.addr), ['192.168.1.50']);
        console.log('✓ compressed-name query → reply');

        // Malformed packets
        const loop = Buffer.concat([header(), Buffer.from([0xc0, 12]), tail(1, 1)]);
        assert.throws(() => parsePacket(loop), /pointer loop/);
        const mutual = Buffer.concat([header(), Buffer.from([0xc0, 14, 0xc0, 12]), tail(1, 1)]);
        assert.throws(() => parsePacket(mutual), /pointer loop/);
        const outOfBounds = Buffer.concat([header(), Buffer.from([0xc0, 0xff]), tail(1, 1)]);
        assert.throws(() => parsePacket(outOfBounds));
        const truncated = query(HOST).subarray(0, 20);
        assert.throws(() => parsePacket(truncated));
        const malformed = [
            Buffer.alloc(0), Buffer.from([1, 2, 3]), header({ qd: 1 }), truncated, loop, mutual, outOfBounds,
            Buffer.concat([header({ qd: 65535 }), encodeLabels(HOST), tail(1, 1)]),
            Buffer.concat([header(), Buffer.from([0x80, 1]), tail(1, 1)]),
            Buffer.concat([header(), Buffer.from([63]), Buffer.alloc(10, 97)]),
        ];
        for (const m of malformed) {
            const r = await ask(m, 60);
            assert.strictEqual(r.length, 0, 'malformed packet → no reply');
        }
        assert.strictEqual(mdns.getStatus().state, 'running', 'still running after malformed packets');
        assert.strictEqual((await ask(query(HOST))).length, 1, 'still answering after malformed packets');
        console.log('✓ malformed packets (truncated, pointer loop) → no crash');

        // Response packets are ignored (no reply to a response).
        const response = buildResponse({ hostname: HOST, addresses: ['192.168.1.50'], ttl: 120 });
        assert.strictEqual((await ask(response, 100)).length, 0, 'responses are not answered');

        // Nothing was ever sent to the group from the real socket except announcements.
        assert(sent.some((s) => s.address === '224.0.0.251' && s.port === 5353), 'announced to the group');
        const announce = parsePacket(sent.find((s) => s.address === '224.0.0.251').buf);
        assert.deepStrictEqual(aRecords(announce).map((r) => [r.addr, r.ttl, r.flush]), [['192.168.1.50', 120, true]], 'announcement uses cache-flush class');
        assert.strictEqual(announce.id, 0);

        const stopped = mdns.stop();
        assert(stopped instanceof Promise);
        await stopped;
        assert.strictEqual(mdns.getStatus().state, 'stopped');
        assert(!logger.lines.some((l) => l.startsWith('warn')), 'no warnings in the happy path');
    } finally {
        client.close();
        await mdns.stop();
    }

    // Goodbye through a fake dgram.
    {
        const fake = fakeDgram();
        const intervals = [];
        const m = new MdnsResponder({
            hostname: HOST, getAddresses: () => ['192.168.1.50', '10.0.0.7'], dgram: fake, networkInterfaces: () => ({}),
            setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
            clearIntervalFn: () => {},
        });
        m.start();
        await waitFor(() => m.getStatus().state === 'running');
        const s = fake.sockets[0];
        assert.deepStrictEqual(s.opts, { type: 'udp4', reuseAddr: true });
        assert.deepStrictEqual(s.bound, { port: 5353, address: undefined }, 'defaults: port 5353, all interfaces');
        assert.deepStrictEqual(s.memberships.slice(-1)[0], ['224.0.0.251', undefined], 'falls back to addMembership(group)');
        assert.strictEqual(intervals[0].ms, 30000, 'interfaces polled every 30 s');
        await waitFor(() => s.sends.length >= 2, 1500);
        assert(s.sends.slice(0, 2).every((x) => x.address === '224.0.0.251' && x.port === 5353), 'announced twice to the group');
        assert.deepStrictEqual(m.getStatus().addresses, ['192.168.1.50', '10.0.0.7']);

        // QU bit → unicast to rinfo on 5353; plain multicast query → group.
        s.sends.length = 0;
        s.emit('message', query(HOST, { id: 0, cls: 0x8001 }), { address: '192.168.1.99', port: 5353 });
        assert.strictEqual(s.sends.length, 1);
        assert.deepStrictEqual([s.sends[0].address, s.sends[0].port], ['192.168.1.99', 5353], 'QU → unicast to 5353');
        const qu = parsePacket(s.sends[0].buf);
        assert.strictEqual(qu.questions.length, 0, 'mDNS response carries no question');
        assert.deepStrictEqual(aRecords(qu).map((r) => r.addr), ['192.168.1.50', '10.0.0.7']);
        s.emit('message', query(HOST, { id: 0 }), { address: '192.168.1.99', port: 5353 });
        assert.deepStrictEqual([s.sends[1].address, s.sends[1].port], ['224.0.0.251', 5353], 'QM → multicast');
        // AAAA → a response with no records.
        s.emit('message', query(HOST, { type: 28 }), { address: '192.168.1.99', port: 5353 });
        assert.strictEqual(parsePacket(s.sends[2].buf).answers.length, 0, 'AAAA → no records');

        // Conflict: another host answers for our name with a foreign address.
        const warnLog = spyLogger();
        m.logger = warnLog;
        s.emit('message', buildResponse({ hostname: HOST, addresses: ['192.168.1.50'], ttl: 120 }), { address: '192.168.1.50', port: 5353 });
        assert.strictEqual(m.getStatus().state, 'running', 'our own address is not a conflict');
        s.emit('message', buildResponse({ hostname: HOST, addresses: ['192.168.1.123'], ttl: 120 }), { address: '192.168.1.123', port: 5353 });
        assert.strictEqual(m.getStatus().state, 'conflict');
        assert.strictEqual(warnLog.lines.filter((l) => l.startsWith('warn')).length, 1);
        const before = s.sends.length;
        s.emit('message', query(HOST, { id: 7 }), { address: '192.168.1.99', port: 40000 });
        assert.strictEqual(s.sends.length, before + 1, 'keeps answering during a conflict');

        // Interface change → re-join and re-announce.
        m.getAddressesFn = () => ['192.168.1.51'];
        const beforePoll = s.sends.length;
        intervals[0].fn();
        assert.deepStrictEqual(m.getStatus().addresses, ['192.168.1.51']);
        assert(s.memberships.some(([g, i]) => g === '224.0.0.251' && i === '192.168.1.51'), 're-joined on the new address');
        assert(s.sends.length > beforePoll, 're-announced');

        s.sends.length = 0;
        await m.stop();
        const goodbye = s.sends.filter((x) => x.address === '224.0.0.251' && x.port === 5353);
        assert.strictEqual(goodbye.length, 1, 'goodbye sent to 224.0.0.251:5353');
        const gp = parsePacket(goodbye[0].buf);
        assert(gp.answers.length > 0 && gp.answers.every((a) => a.ttl === 0), 'goodbye has TTL 0');
        assert.strictEqual(s.closed, true, 'socket closed after goodbye');
        assert.strictEqual(m.getStatus().state, 'stopped');
    }
    console.log('✓ stop() sends a TTL 0 goodbye to 224.0.0.251:5353 (fake dgram)');

    // EADDRINUSE → unavailable, no throw, warn once.
    {
        const fake = fakeDgram({ bindError: 'EADDRINUSE' });
        const logs = spyLogger();
        let pollFn = null;
        const m = new MdnsResponder({
            hostname: HOST, getAddresses: () => ['192.168.1.50'], dgram: fake, logger: logs,
            setIntervalFn: (fn) => { pollFn = fn; return 1; }, clearIntervalFn: () => {},
        });
        assert.doesNotThrow(() => m.start());
        await waitFor(() => m.getStatus().state === 'unavailable');
        assert.strictEqual(m.getStatus().error, 'EADDRINUSE');
        assert.strictEqual(fake.sockets[0].closed, true, 'socket closed on error');
        pollFn();
        assert.strictEqual(fake.sockets.length, 1, 'no retry while the interface set is unchanged');
        m.getAddressesFn = () => ['192.168.1.60'];
        pollFn();
        assert.strictEqual(fake.sockets.length, 2, 'retries when the interface set changes');
        await waitFor(() => fake.sockets[1].closed);
        assert.strictEqual(logs.lines.filter((l) => l.startsWith('warn')).length, 2, 'one warning per attempt');
        await m.stop();

        const throwing = new MdnsResponder({
            hostname: HOST, getAddresses: () => { throw new Error('boom'); }, logger: spyLogger(),
            dgram: { createSocket() { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
            setIntervalFn: () => 1, clearIntervalFn: () => {},
        });
        assert.doesNotThrow(() => throwing.start());
        assert.strictEqual(throwing.getStatus().state, 'unavailable');
        assert.strictEqual(throwing.getStatus().error, 'EACCES');
        await throwing.stop();
    }
    console.log('✓ EADDRINUSE via fake dgram → state unavailable, no throw');

    // Address filtering
    assert.deepStrictEqual(filterAddresses(['100.101.1.1', '169.254.1.1', '127.0.0.1', '192.168.1.50', '::1', 'fe80::1', '192.168.1.50', 'junk', null, '100.63.0.1']),
        ['192.168.1.50', '100.63.0.1'], 'Tailscale, link-local, loopback, IPv6 and duplicates removed');
    assert.strictEqual(filterAddresses(Array.from({ length: 12 }, (_, i) => `10.0.0.${i + 1}`)).length, 8, 'capped at 8');
    const big = buildResponse({ hostname: HOST, addresses: Array.from({ length: 8 }, (_, i) => `10.0.0.${i + 1}`), ttl: 120, legacy: true, question: { type: 1 } });
    assert(big.length <= 512, 'response within 512 bytes');
    assert.strictEqual(parsePacket(big).answers.length, 8);
    {
        const fake = fakeDgram();
        const m = new MdnsResponder({ hostname: HOST, getAddresses: () => ['100.101.1.1', '169.254.1.1'], dgram: fake, setIntervalFn: () => 1, clearIntervalFn: () => {} });
        m.start();
        await waitFor(() => m.getStatus().state === 'running');
        assert.deepStrictEqual(m.getStatus().addresses, []);
        const s = fake.sockets[0];
        s.emit('message', query(HOST), { address: '192.168.1.99', port: 40000 });
        assert.strictEqual(s.sends.length, 0, 'nothing to advertise → no reply, no announcement');

        m.getAddressesFn = () => ['192.168.1.50'];
        m.setHostname('onefinity-abcdef.local');
        assert.strictEqual(m.getStatus().hostname, 'onefinity-abcdef.local');
        await m.stop();
    }
    console.log('✓ addresses 100.101.1.1 and 169.254.1.1 are filtered out');

    // Off-link queriers get nothing (RFC 6762 §11).
    {
        const fake = fakeDgram();
        const m = new MdnsResponder({
            hostname: HOST, getAddresses: () => ['10.1.2.3'], dgram: fake,
            networkInterfaces: () => ({
                Ethernet: [{ address: '10.1.2.3', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
                Tailscale: [{ address: '100.90.1.2', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
            }),
            setIntervalFn: () => 1, clearIntervalFn: () => {},
        });
        m.start();
        await waitFor(() => m.getStatus().state === 'running');
        const s = fake.sockets[0];
        await waitFor(() => s.sends.length >= 2, 1500);
        s.sends.length = 0;
        const legacyFrom = (address) => {
            const before = s.sends.length;
            s.emit('message', query(HOST, { id: 9 }), { address, port: 40000 });
            return s.sends.length - before;
        };
        assert.strictEqual(legacyFrom('100.101.1.1'), 0, 'query from a Tailscale address → no reply');
        assert.strictEqual(legacyFrom('203.0.113.5'), 0, 'query from a routed address → no reply');
        assert.strictEqual(legacyFrom('10.2.0.1'), 0, 'outside the interface netmask → no reply');
        s.emit('message', query(HOST, { id: 0, cls: 0x8001 }), { address: '100.101.1.1', port: 5353 });
        assert.strictEqual(s.sends.length, 0, 'QU query from Tailscale → no reply');
        assert.strictEqual(legacyFrom('10.1.200.5'), 1, 'same /16 subnet (OS netmask) → reply');
        assert.strictEqual(s.sends[0].address, '10.1.200.5');
        assert.strictEqual(legacyFrom('127.0.0.1'), 1, 'this host → reply');
        assert.strictEqual(legacyFrom('169.254.7.7'), 1, 'link-local querier is on-link');
        s.emit('message', buildResponse({ hostname: HOST, addresses: ['10.9.9.9'], ttl: 120 }), { address: '100.101.1.1', port: 5353 });
        assert.strictEqual(m.getStatus().state, 'running', 'off-link responses cannot raise a conflict');
        await m.stop();

        // Without an OS entry for the advertised address a /24 is assumed.
        const fake2 = fakeDgram();
        const m2 = new MdnsResponder({
            hostname: HOST, getAddresses: () => ['192.168.1.50'], dgram: fake2, networkInterfaces: () => ({}),
            setIntervalFn: () => 1, clearIntervalFn: () => {},
        });
        m2.start();
        await waitFor(() => m2.getStatus().state === 'running');
        const s2 = fake2.sockets[0];
        await waitFor(() => s2.sends.length >= 2, 1500);
        s2.sends.length = 0;
        s2.emit('message', query(HOST, { id: 1 }), { address: '192.168.2.9', port: 40000 });
        assert.strictEqual(s2.sends.length, 0, 'outside the assumed /24 → no reply');
        s2.emit('message', query(HOST, { id: 1 }), { address: '192.168.1.200', port: 40000 });
        assert.strictEqual(s2.sends.length, 1, 'inside the assumed /24 → reply');
        await m2.stop();
    }
    console.log('✓ queries from off-link sources (e.g. 100.101.1.1) get no reply');

    console.log('All MdnsResponder tests passed');
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
