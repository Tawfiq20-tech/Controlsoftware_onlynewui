/**
 * MdnsResponder — answers multicast DNS A queries for onefinity-<shortid>.local
 * so phones on the same Wi-Fi can open http://onefinity-xxxxxx.local:4000.
 *
 * Deliberately minimal: one hostname, A records only, no service discovery.
 * It reveals nothing beyond the hostname and the LAN IPv4 addresses, and
 * never advertises Tailscale, loopback or link-local addresses.
 */
const os = require('os');
const net = require('net');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_ANY = 255;
const CLASS_IN = 0x0001;
const CLASS_IN_FLUSH = 0x8001;
const FLAGS_RESPONSE = 0x8400;
const MAX_PACKET = 512;
const MAX_ADDRESSES = 8;
const MAX_POINTER_JUMPS = 20;
const MAX_QUESTIONS = 32;
const MAX_RECORDS = 64;
const ANNOUNCE_GAP_MS = 1000;

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function isAdvertisable(addr) {
    if (typeof addr !== 'string' || !net.isIPv4(addr)) return false;
    const [o1, o2] = addr.split('.').map(Number);
    if (o1 === 127 || o1 === 0) return false;
    if (o1 === 169 && o2 === 254) return false;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return false;
    if (o1 >= 224) return false;
    return true;
}

function ipv4ToInt(addr) {
    return addr.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

const FALLBACK_NETMASK = '255.255.255.0';

/**
 * Subnets of the advertised addresses, from the OS netmask when the address
 * belongs to a local interface. An address the OS does not list (injected,
 * or an interface that vanished between polls) is assumed to be a /24.
 * @returns {{network:number, mask:number}[]}
 */
function subnetsFor(addresses, interfaces) {
    const out = [];
    for (const addr of addresses) {
        let netmask = null;
        for (const name of Object.keys(interfaces || {})) {
            for (const entry of interfaces[name] || []) {
                const family = entry && (entry.family === 'IPv4' || entry.family === 4);
                if (family && entry.address === addr && net.isIPv4(entry.netmask || '')) netmask = entry.netmask;
            }
        }
        const mask = ipv4ToInt(netmask || FALLBACK_NETMASK);
        out.push({ network: (ipv4ToInt(addr) & mask) >>> 0, mask });
    }
    return out;
}

/**
 * RFC 6762 §11: only answer queriers on the local link. A host reaching UDP
 * 5353 over Tailscale or a routed/VPN path must not learn the LAN addresses.
 */
function isOnLinkSource(addr, subnets) {
    const a = String(addr || '').replace(/^::ffff:/i, '');
    if (!net.isIPv4(a)) return false;
    const [o1, o2] = a.split('.').map(Number);
    if (o1 === 127) return true;                              // this host
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return false;    // Tailscale / CGNAT
    if (o1 === 169 && o2 === 254) return true;                // link-local by definition
    const n = ipv4ToInt(a);
    return subnets.some((s) => ((n & s.mask) >>> 0) === s.network);
}

function filterAddresses(list) {
    const out = [];
    for (const a of Array.isArray(list) ? list : []) {
        const addr = typeof a === 'string' ? a.trim() : '';
        if (isAdvertisable(addr) && !out.includes(addr)) out.push(addr);
        if (out.length >= MAX_ADDRESSES) break;
    }
    return out;
}

function normalizeName(name) {
    return String(name || '').trim().toLowerCase().replace(/\.$/, '');
}

function encodeName(name) {
    const labels = normalizeName(name).split('.').filter(Boolean);
    const parts = [];
    for (const label of labels) {
        const bytes = Buffer.from(label, 'utf8');
        if (bytes.length > 63) throw new Error('label too long');
        parts.push(Buffer.from([bytes.length]), bytes);
    }
    parts.push(Buffer.from([0]));
    const buf = Buffer.concat(parts);
    if (buf.length > 255) throw new Error('name too long');
    return buf;
}

/**
 * Reads a possibly compressed name. Throws on any out-of-bounds offset,
 * reserved label type, over-long name or pointer loop.
 * @returns {{name:string, next:number}}
 */
function readName(buf, offset) {
    const labels = [];
    let pos = offset;
    let next = -1;
    let jumps = 0;
    let length = 0;
    for (;;) {
        if (pos >= buf.length) throw new Error('name out of bounds');
        const len = buf[pos];
        if (len === 0) {
            if (next < 0) next = pos + 1;
            break;
        }
        const kind = len & 0xc0;
        if (kind === 0xc0) {
            if (pos + 1 >= buf.length) throw new Error('pointer out of bounds');
            if (++jumps > MAX_POINTER_JUMPS) throw new Error('pointer loop');
            if (next < 0) next = pos + 2;
            pos = ((len & 0x3f) << 8) | buf[pos + 1];
            continue;
        }
        if (kind !== 0) throw new Error('reserved label type');
        if (pos + 1 + len > buf.length) throw new Error('label out of bounds');
        length += len + 1;
        if (length > 255) throw new Error('name too long');
        labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
        pos += 1 + len;
    }
    return { name: labels.join('.').toLowerCase(), next };
}

/** @returns {{id, flags, qr, opcode, questions:[{name,type,cls,unicast}], answers:[{name,type,cls,data}]}} */
function parsePacket(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('short packet');
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6);
    const ns = buf.readUInt16BE(8);
    const ar = buf.readUInt16BE(10);
    if (qd > MAX_QUESTIONS || an + ns + ar > MAX_RECORDS) throw new Error('too many entries');
    let pos = 12;
    const questions = [];
    for (let i = 0; i < qd; i++) {
        const { name, next } = readName(buf, pos);
        if (next + 4 > buf.length) throw new Error('question out of bounds');
        const type = buf.readUInt16BE(next);
        const rawClass = buf.readUInt16BE(next + 2);
        questions.push({ name, type, cls: rawClass & 0x7fff, unicast: (rawClass & 0x8000) !== 0 });
        pos = next + 4;
    }
    const answers = [];
    const qr = (flags & 0x8000) !== 0;
    if (qr) {
        for (let i = 0; i < an + ns + ar; i++) {
            const { name, next } = readName(buf, pos);
            if (next + 10 > buf.length) throw new Error('record out of bounds');
            const type = buf.readUInt16BE(next);
            const rawClass = buf.readUInt16BE(next + 2);
            const ttl = buf.readUInt32BE(next + 4);
            const rdlen = buf.readUInt16BE(next + 8);
            const start = next + 10;
            if (start + rdlen > buf.length) throw new Error('rdata out of bounds');
            answers.push({ name, type, cls: rawClass & 0x7fff, flush: (rawClass & 0x8000) !== 0, ttl, data: buf.subarray(start, start + rdlen) });
            pos = start + rdlen;
        }
    }
    return { id, flags, qr, opcode: (flags >> 11) & 0x0f, questions, answers };
}

/**
 * @param {object} p
 * @param {string} p.hostname
 * @param {string[]} p.addresses
 * @param {number} p.ttl
 * @param {number} [p.id]
 * @param {boolean} [p.legacy]  echo the question and use class IN without cache-flush
 * @param {object} [p.question] {type, cls}
 */
function buildResponse({ hostname, addresses, ttl, id = 0, legacy = false, question = null }) {
    const nameBuf = encodeName(hostname);
    const questionBuf = legacy && question
        ? Buffer.concat([nameBuf, u16(question.type), u16(CLASS_IN)])
        : null;
    const recordLen = nameBuf.length + 10 + 4;
    const room = MAX_PACKET - 12 - (questionBuf ? questionBuf.length : 0);
    const count = Math.max(0, Math.min(addresses.length, MAX_ADDRESSES, Math.floor(room / recordLen)));

    const header = Buffer.alloc(12);
    header.writeUInt16BE(id & 0xffff, 0);
    header.writeUInt16BE(FLAGS_RESPONSE, 2);
    header.writeUInt16BE(questionBuf ? 1 : 0, 4);
    header.writeUInt16BE(count, 6);

    const parts = [header];
    if (questionBuf) parts.push(questionBuf);
    for (let i = 0; i < count; i++) {
        const rr = Buffer.alloc(10 + 4);
        rr.writeUInt16BE(TYPE_A, 0);
        rr.writeUInt16BE(legacy ? CLASS_IN : CLASS_IN_FLUSH, 2);
        rr.writeUInt32BE(ttl >>> 0, 4);
        rr.writeUInt16BE(4, 8);
        addresses[i].split('.').forEach((octet, j) => rr.writeUInt8(Number(octet), 10 + j));
        parts.push(nameBuf, rr);
    }
    return Buffer.concat(parts);
}

function u16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n, 0);
    return b;
}

class MdnsResponder {
    constructor({
        hostname,
        getAddresses,
        logger,
        dgram = require('dgram'),
        port = MDNS_PORT,
        bindAddress = undefined,
        group = MDNS_GROUP,
        ttlSec = 120,
        interfacesPollMs = 30000,
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        networkInterfaces = os.networkInterfaces,
    } = {}) {
        this.hostname = normalizeName(hostname);
        this.getAddressesFn = typeof getAddresses === 'function' ? getAddresses : () => [];
        this.logger = logger || noopLogger;
        this.dgram = dgram;
        this.port = port;
        this.bindAddress = bindAddress;
        this.group = group;
        this.ttlSec = ttlSec;
        this.interfacesPollMs = interfacesPollMs;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.networkInterfaces = networkInterfaces;

        this._socket = null;
        this._subnets = [];
        this._state = 'stopped';
        this._error = null;
        this._warned = false;
        this._addresses = [];
        this._pollTimer = null;
        this._announceTimer = null;
        this._active = false;   // between start() and stop()
    }

    start() {
        if (this._active) return this;
        this._active = true;
        this._warned = false;
        this._addresses = this._readAddresses();
        this._refreshSubnets();
        this._openSocket();
        try {
            this._pollTimer = this.setIntervalFn(() => this._pollInterfaces(), this.interfacesPollMs);
            if (this._pollTimer && typeof this._pollTimer.unref === 'function') this._pollTimer.unref();
        } catch (err) {
            this.logger.debug(`[mDNS] cannot schedule interface polling: ${err.message}`);
        }
        return this;
    }

    stop() {
        this._active = false;
        if (this._pollTimer) {
            this.clearIntervalFn(this._pollTimer);
            this._pollTimer = null;
        }
        this._cancelAnnounce();
        const socket = this._socket;
        const wasRunning = this._state === 'running' || this._state === 'conflict';
        this._socket = null;
        this._state = 'stopped';
        if (!socket) return Promise.resolve();
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                this._closeSocket(socket);
                resolve();
            };
            if (!wasRunning || this._addresses.length === 0) return finish();
            const goodbye = buildResponse({ hostname: this.hostname, addresses: this._addresses, ttl: 0 });
            this._send(socket, goodbye, MDNS_PORT, this.group, finish);
            // A send callback that never fires must not hang shutdown.
            const t = this.setTimeoutFn(finish, 500);
            if (t && typeof t.unref === 'function') t.unref();
        });
    }

    getStatus() {
        return {
            state: this._state,
            hostname: this.hostname,
            addresses: this._addresses.slice(),
            error: this._error,
        };
    }

    /** Port the socket is actually bound to (useful with port 0). */
    getLocalPort() {
        try {
            return this._socket ? this._socket.address().port : null;
        } catch (_) {
            return null;
        }
    }

    setHostname(hostname) {
        const next = normalizeName(hostname);
        if (!next || next === this.hostname) return;
        const running = this._socket && (this._state === 'running' || this._state === 'conflict');
        if (running && this._addresses.length) {
            this._send(this._socket, buildResponse({ hostname: this.hostname, addresses: this._addresses, ttl: 0 }), MDNS_PORT, this.group);
        }
        this.hostname = next;
        if (this._state === 'conflict') this._state = 'running';
        if (running) this._announce();
    }

    // ─── Socket lifecycle ───────────────────────────────────────────

    _openSocket() {
        let socket;
        try {
            socket = this.dgram.createSocket({ type: 'udp4', reuseAddr: true });
        } catch (err) {
            this._fail(err, null);
            return;
        }
        this._socket = socket;
        socket.on('error', (err) => this._fail(err, socket));
        socket.on('message', (msg, rinfo) => this._onMessage(socket, msg, rinfo));
        socket.on('listening', () => this._onListening(socket));
        try {
            socket.bind(this.port, this.bindAddress);
        } catch (err) {
            this._fail(err, socket);
        }
    }

    _onListening(socket) {
        if (socket !== this._socket) return;
        this._joinGroup(socket);
        try {
            socket.setMulticastTTL(255);
            socket.setMulticastLoopback(true);
        } catch (err) {
            this.logger.debug(`[mDNS] multicast options: ${err.code || err.message}`);
        }
        this._state = 'running';
        this._error = null;
        this.logger.info(`[mDNS] responding for ${this.hostname}`);
        this._announce();
    }

    _joinGroup(socket) {
        let joined = false;
        for (const addr of this._addresses) {
            try {
                socket.addMembership(this.group, addr);
                joined = true;
            } catch (err) {
                this.logger.debug(`[mDNS] addMembership ${addr}: ${err.code || err.message}`);
            }
        }
        if (!joined) {
            try {
                socket.addMembership(this.group);
            } catch (err) {
                this.logger.debug(`[mDNS] addMembership: ${err.code || err.message}`);
            }
        }
    }

    _fail(err, socket) {
        const code = (err && (err.code || err.message)) || 'unknown';
        if (!this._warned) {
            this._warned = true;
            this.logger.warn(`[mDNS] unavailable (${code}); ${this.hostname} will not resolve`);
        }
        this._error = code;
        this._cancelAnnounce();
        if (socket && socket === this._socket) this._socket = null;
        if (this._active) this._state = 'unavailable';
        if (socket) this._closeSocket(socket);
    }

    _closeSocket(socket) {
        try {
            socket.close();
        } catch (_) {
            // already closed
        }
    }

    _pollInterfaces() {
        if (!this._active) return;
        const next = this._readAddresses();
        const same = next.length === this._addresses.length && next.every((a) => this._addresses.includes(a));
        this._addresses = next;
        // Netmasks can change without the address set changing.
        this._refreshSubnets();
        if (same) return;
        if (this._state === 'unavailable' || !this._socket) {
            this._warned = false;
            this._openSocket();
            return;
        }
        if (this._state === 'conflict') this._state = 'running';
        this._joinGroup(this._socket);
        this._announce();
    }

    /** Cached per poll: os.networkInterfaces() is too costly for every multicast packet. */
    _refreshSubnets() {
        let interfaces = {};
        try {
            interfaces = this.networkInterfaces() || {};
        } catch (err) {
            this.logger.debug(`[mDNS] networkInterfaces failed: ${err.message}`);
        }
        this._subnets = subnetsFor(this._addresses, interfaces);
    }

    _readAddresses() {
        try {
            return filterAddresses(this.getAddressesFn());
        } catch (err) {
            this.logger.debug(`[mDNS] getAddresses failed: ${err.message}`);
            return [];
        }
    }

    // ─── Sending ────────────────────────────────────────────────────

    _announce() {
        this._cancelAnnounce();
        const send = () => {
            if (!this._socket || !this._addresses.length) return;
            const packet = buildResponse({ hostname: this.hostname, addresses: this._addresses, ttl: this.ttlSec });
            this._send(this._socket, packet, MDNS_PORT, this.group);
        };
        send();
        this._announceTimer = this.setTimeoutFn(() => {
            this._announceTimer = null;
            send();
        }, ANNOUNCE_GAP_MS);
        if (this._announceTimer && typeof this._announceTimer.unref === 'function') this._announceTimer.unref();
    }

    _cancelAnnounce() {
        if (this._announceTimer) {
            this.clearTimeoutFn(this._announceTimer);
            this._announceTimer = null;
        }
    }

    _send(socket, packet, port, address, cb) {
        try {
            socket.send(packet, 0, packet.length, port, address, (err) => {
                if (err) this.logger.debug(`[mDNS] send to ${address}:${port}: ${err.code || err.message}`);
                if (cb) cb();
            });
        } catch (err) {
            this.logger.debug(`[mDNS] send to ${address}:${port}: ${err.code || err.message}`);
            if (cb) cb();
        }
    }

    // ─── Receiving ──────────────────────────────────────────────────

    _onMessage(socket, msg, rinfo) {
        if (socket !== this._socket || !rinfo) return;
        // Off-link packets are neither answered nor trusted for conflict detection.
        if (!isOnLinkSource(rinfo.address, this._subnets)) return;
        let packet;
        try {
            packet = parsePacket(msg);
        } catch (err) {
            this.logger.debug(`[mDNS] dropped malformed packet from ${rinfo.address}: ${err.message}`);
            return;
        }
        if (packet.qr) {
            this._checkConflict(packet, rinfo);
            return;
        }
        if (packet.opcode !== 0) return;

        const matched = packet.questions.filter((q) => q.name === this.hostname
            && (q.cls === CLASS_IN || q.cls === TYPE_ANY)
            && (q.type === TYPE_A || q.type === TYPE_ANY || q.type === TYPE_AAAA));
        if (!matched.length) return;

        const wantsA = matched.some((q) => q.type === TYPE_A || q.type === TYPE_ANY);
        // AAAA gets an empty answer: we have no IPv6 records to offer.
        const addresses = wantsA ? this._addresses : [];
        if (wantsA && !addresses.length) return;

        if (rinfo.port !== MDNS_PORT) {
            const question = matched.find((q) => q.type === TYPE_A || q.type === TYPE_ANY) || matched[0];
            const reply = buildResponse({
                hostname: this.hostname, addresses, ttl: this.ttlSec,
                id: packet.id, legacy: true, question,
            });
            this._send(socket, reply, rinfo.port, rinfo.address);
            return;
        }
        const reply = buildResponse({ hostname: this.hostname, addresses, ttl: this.ttlSec });
        if (matched.some((q) => q.unicast)) {
            this._send(socket, reply, MDNS_PORT, rinfo.address);
        } else {
            this._send(socket, reply, MDNS_PORT, this.group);
        }
    }

    _checkConflict(packet, rinfo) {
        for (const rr of packet.answers) {
            if (rr.type !== TYPE_A || rr.data.length !== 4 || rr.name !== this.hostname) continue;
            const addr = Array.from(rr.data).join('.');
            if (this._addresses.includes(addr)) continue;
            if (this._state !== 'conflict') {
                this._state = 'conflict';
                this.logger.warn(`[mDNS] another host (${rinfo.address}) claims ${this.hostname} as ${addr}`);
            }
        }
    }
}

module.exports = {
    MdnsResponder,
    // exported for tests
    parsePacket,
    readName,
    encodeName,
    buildResponse,
    filterAddresses,
    isOnLinkSource,
    subnetsFor,
    MDNS_GROUP,
    MDNS_PORT,
};
