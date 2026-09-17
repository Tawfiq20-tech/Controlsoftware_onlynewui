'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const { request, sleep } = require('./harness');
const { newMessageId } = require('../../server/protocol/envelope');

function genCredential() {
    return 'odc_' + crypto.randomBytes(32).toString('base64url');
}

function sha256(s) {
    return crypto.createHash('sha256').update(s).digest('hex');
}

function wsUrl(relay, p) {
    return relay.url.replace(/^http/, 'ws') + p;
}

// A WebSocket wrapper that records every inbound message so tests can wait for one
// that already arrived as well as future ones.
class Peer {
    constructor(ws, { autoPong = true } = {}) {
        this.ws = ws;
        this.messages = [];
        this.binary = [];
        this.waiters = [];
        this.autoPong = autoPong;
        this.closeInfo = null;
        this.closed = new Promise((resolve) => {
            ws.on('close', (code, reason) => {
                this.closeInfo = { code, reason: reason.toString() };
                resolve(this.closeInfo);
            });
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                this.binary.push(data);
                return;
            }
            let msg;
            try { msg = JSON.parse(data.toString()); } catch (_) { return; }
            msg._rxAt = Date.now();
            this.messages.push(msg);
            if (this.autoPong && msg.t === 'ping') {
                this.send('pong', { nonce: msg.body.nonce, sentAt: msg.body.sentAt, recvAt: Date.now() });
            }
            for (const w of [...this.waiters]) {
                if (w.pred(msg)) {
                    this.waiters.splice(this.waiters.indexOf(w), 1);
                    clearTimeout(w.timer);
                    w.resolve(msg);
                }
            }
        });
        ws.on('error', () => {});
    }

    find(pred) {
        return this.messages.find(pred) || null;
    }

    all(pred) {
        return this.messages.filter(pred);
    }

    waitFor(pred, timeoutMs = 2000, label = 'message') {
        const p = typeof pred === 'string' ? ((m) => m.t === pred) : pred;
        const existing = this.messages.find((m) => p(m) && !m._consumed);
        if (existing) {
            existing._consumed = true;
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const w = {
                pred: (m) => {
                    if (m._consumed || !p(m)) return false;
                    m._consumed = true;
                    return true;
                },
                resolve,
                timer: setTimeout(() => {
                    this.waiters.splice(this.waiters.indexOf(w), 1);
                    reject(new Error(`timeout waiting for ${typeof pred === 'string' ? pred : label}`));
                }, timeoutMs),
            };
            this.waiters.push(w);
        });
    }

    async expectNone(pred, ms = 300) {
        const p = typeof pred === 'string' ? ((m) => m.t === pred) : pred;
        const start = this.messages.length;
        await sleep(ms);
        const hit = this.messages.slice(start).find(p);
        if (hit) throw new Error(`unexpected message ${JSON.stringify(hit).slice(0, 300)}`);
    }

    send(t, body, extra = {}) {
        const env = Object.assign({ v: 1, t, id: newMessageId('m_'), ts: Date.now(), topic: null, cls: null, enc: 'none', kid: null, via: null, body: body || {} }, extra);
        this.ws.send(JSON.stringify(env));
        return env;
    }

    sendRaw(data, opts) {
        this.ws.send(data, opts);
    }

    close(code = 1000) {
        try { this.ws.close(code); } catch (_) { /* ignore */ }
        return this.closed;
    }

    terminate() {
        this.ws.terminate();
        return this.closed;
    }
}

// Resolves {status, body, headers} on an HTTP upgrade refusal, or {peer} once open.
function openWs(url, headers) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 5000 });
        let settled = false;
        ws.on('unexpected-response', (req, res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                settled = true;
                let body = null;
                try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { /* ignore */ }
                resolve({ status: res.statusCode, body, headers: res.headers });
                ws.terminate();
            });
        });
        const peer = new Peer(ws);
        ws.on('open', () => {
            settled = true;
            resolve({ peer });
        });
        ws.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        });
    });
}

async function pairDevice(relay, ownerSession, { name = 'Machine', credential = genCredential(), hardwareId, controllerType = 'RSP', confirm = true } = {}) {
    const hw = hardwareId || crypto.randomBytes(6).toString('hex');
    const p = await request(relay, 'POST', '/api/device/pairing', {
        json: { hardwareId: hw, name, appVersion: '0.1.0', controllerType, credentialHash: sha256(credential) },
    });
    if (p.status !== 201) throw new Error(`pairing failed ${p.status} ${p.text}`);
    const claim = await request(relay, 'POST', '/api/devices/claim', { session: ownerSession, json: { code: p.json.code } });
    if (claim.status !== 201) throw new Error(`claim failed ${claim.status} ${claim.text}`);
    if (confirm) {
        const c = await request(relay, 'POST', `/api/device/pairing/${p.json.pairingId}/confirm`, { bearer: p.json.pollSecret, json: {} });
        if (c.status !== 204) throw new Error(`confirm failed ${c.status} ${c.text}`);
    }
    return { deviceId: claim.json.device.id, credential, pairingId: p.json.pairingId, pollSecret: p.json.pollSecret, code: p.json.code, hardwareId: hw };
}

async function connectDevice(relay, credential, { hello = true, controllerType = 'RSP', cameras = [{ id: 'cam1', name: 'USB camera' }], headers } = {}) {
    const h = headers || { Authorization: 'Bearer ' + credential, 'X-Onefinity-Protocol': '1' };
    const r = await openWs(wsUrl(relay, '/ws/device'), h);
    if (!r.peer) return r;
    const peer = r.peer;
    peer.autoPong = false;
    if (hello) {
        peer.send('hello', {
            protocol: { min: 1, max: 1 }, hardwareId: '3f9a1c07b2e4', appVersion: '0.1.0', controllerType,
            capabilities: { snapshot: true, webrtc: false, e2e: false, files: true }, cameras,
        });
        peer.welcome = await peer.waitFor('welcome', 2000);
    }
    return { peer };
}

function deviceReport(peer, deviceId, t, body) {
    return peer.send(t, body, { topic: `device/${deviceId}/report` });
}

async function connectClient(relay, session, { origin, headers } = {}) {
    const h = headers || { Cookie: session.cookie, Origin: origin || relay.url };
    const r = await openWs(wsUrl(relay, '/ws/client'), h);
    if (!r.peer) return r;
    const peer = r.peer;
    peer.seq = 0;
    peer.welcome = await peer.waitFor('welcome', 2000);
    peer.subscribe = async (deviceIds) => {
        peer.send('subscribe', { deviceIds });
        return peer.waitFor('subscribed', 2000);
    };
    peer.cmd = (deviceId, type, args = {}, opts = {}) => {
        const cls = opts.cls || require('../../server/protocol/envelope').COMMAND_TYPES[type] || 'monitor';
        const id = opts.id || newMessageId(type.startsWith('jog') ? 'j_' : 'c_');
        const seq = opts.seq != null ? opts.seq : ++peer.seq;
        if (opts.seq != null) peer.seq = Math.max(peer.seq, opts.seq);
        const body = Object.assign({
            type, args, seq, issuedAt: opts.issuedAt != null ? opts.issuedAt : Date.now(),
            ttlMs: opts.ttlMs != null ? opts.ttlMs : (cls === 'motion' ? 500 : 5000),
            idem: opts.idem || id,
        }, opts.bodyExtra || {});
        return peer.send('cmd', body, Object.assign({ id, topic: `device/${deviceId}/request`, cls }, opts.envExtra || {}));
    };
    peer.ack = (refId, timeoutMs = 2000) => peer.waitFor((m) => m.t === 'cmd.ack' && m.body.refId === refId, timeoutMs, 'ack ' + refId);
    return { peer };
}

// Replies to every forwarded cmd with an accepted ack (like a well-behaved machine).
function autoAck(devicePeer, deviceId, { status = 'accepted', code = 'OK', filter } = {}) {
    const handler = (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        if (msg.t !== 'cmd') return;
        if (filter && !filter(msg)) return;
        if (msg.body.type === 'jog.cont.keepalive' && status === 'accepted') return;
        devicePeer.send('cmd.ack', {
            refId: msg.id, idem: msg.body.idem, type: msg.body.type, status, code, message: null, duplicate: false, at: Date.now(),
        }, { topic: `device/${deviceId}/report` });
    };
    devicePeer.ws.on('message', handler);
    return () => devicePeer.ws.removeListener('message', handler);
}

module.exports = {
    Peer, openWs, genCredential, sha256, wsUrl, pairDevice, connectDevice, connectClient, deviceReport, autoAck,
};
