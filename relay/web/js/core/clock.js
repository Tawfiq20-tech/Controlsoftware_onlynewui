// Browser <-> relay clock sync (SPEC §3.6). DOM-free.
//
// `now` must be step-free within the page lifetime (performance.timeOrigin +
// performance.now() in the browser), so the same clock serves both the RTT
// measurement and the wall-ish sentAt that the relay echoes back.

import { newId as defaultNewId } from '../protocol.js';

const MAX_SAMPLES = 5;
// Enough fresh samples to trust the median without waiting for the burst to end.
const QUORUM = 3;
const MAX_OUTSTANDING = 32;

function median(values) {
    if (values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function createClockSync({
    now,
    send,
    setTimeout: setTimeoutFn = globalThis.setTimeout,
    clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
    newId = defaultNewId,
    burstCount = 5,
    burstSpacingMs = 200,
    burstSettleMs = 2000,
    onChange = () => {},
} = {}) {
    if (typeof now !== 'function') throw new TypeError('createClockSync: now() required');
    if (typeof send !== 'function') throw new TypeError('createClockSync: send() required');

    const outstanding = new Map();   // nonce -> sentAt
    const offsets = [];
    const rtts = [];
    let synced = false;
    let burstTimers = [];
    let burstNonces = null;
    let burstAnswered = 0;

    function notify() {
        try { onChange(); } catch (_) { /* listener errors must not break sync */ }
    }

    function ping() {
        const nonce = newId('p_');
        const sentAt = now();
        outstanding.set(nonce, sentAt);
        while (outstanding.size > MAX_OUTSTANDING) {
            outstanding.delete(outstanding.keys().next().value);
        }
        let ok;
        try { ok = send({ t: 'ping', body: { nonce, sentAt } }); } catch (_) { ok = false; }
        if (ok === false) {
            outstanding.delete(nonce);
            return null;
        }
        return nonce;
    }

    function finishBurst() {
        cancelBurst();
        if (!synced && offsets.length > 0) {
            synced = true;
            notify();
        }
    }

    function cancelBurst() {
        for (const t of burstTimers) clearTimeoutFn(t);
        burstTimers = [];
        burstNonces = null;
    }

    function startBurst() {
        cancelBurst();
        burstNonces = new Set();
        burstAnswered = 0;
        const nonces = burstNonces;
        for (let i = 0; i < burstCount; i++) {
            const fire = () => {
                if (burstNonces !== nonces) return;
                const nonce = ping();
                if (nonce) nonces.add(nonce);
            };
            if (i === 0) fire();
            else burstTimers.push(setTimeoutFn(fire, i * burstSpacingMs));
        }
        burstTimers.push(setTimeoutFn(() => {
            if (burstNonces === nonces) finishBurst();
        }, (burstCount - 1) * burstSpacingMs + burstSettleMs));
    }

    function onPong(body) {
        if (!body || typeof body.nonce !== 'string') return null;
        const sentAt = outstanding.get(body.nonce);
        if (sentAt === undefined) return null;
        outstanding.delete(body.nonce);
        if (typeof body.recvAt !== 'number' || !Number.isFinite(body.recvAt)) return null;
        const rtt = Math.max(0, now() - sentAt);
        const offset = body.recvAt - (sentAt + rtt / 2);
        rtts.push(rtt);
        offsets.push(offset);
        if (rtts.length > MAX_SAMPLES) rtts.shift();
        if (offsets.length > MAX_SAMPLES) offsets.shift();

        if (burstNonces && burstNonces.has(body.nonce)) {
            burstNonces.delete(body.nonce);
            burstAnswered += 1;
            // All burst pings answered: no reason to wait for the settle timer.
            if (burstAnswered >= burstCount) finishBurst();
        }
        // A pong that lands after the settle window (slow cellular link) is still
        // a valid sample; do not keep controls disabled until the next burst.
        if (!synced && (burstNonces === null || offsets.length >= QUORUM)) synced = true;
        notify();
        return { rtt, offset };
    }

    function invalidate() {
        outstanding.clear();
        cancelBurst();
        offsets.length = 0;
        rtts.length = 0;
        if (synced) {
            synced = false;
            notify();
        }
    }

    return {
        ping,
        startBurst,
        cancelBurst,
        onPong,
        isSynced: () => synced,
        offsetMs: () => median(offsets),
        rttMs: () => median(rtts),
        lastRttMs: () => (rtts.length ? rtts[rtts.length - 1] : null),
        nowSynced: () => now() + (median(offsets) || 0),
        // performance.now() does not advance while a phone sleeps, so an offset
        // measured before a suspension (or on an earlier socket) can be off by the
        // sleep time. Forget it: stops go out unsynced (relay-stamped) and other
        // commands wait until fresh pongs arrive.
        invalidate,
        resetSocket: invalidate,
        dispose() {
            outstanding.clear();
            cancelBurst();
        },
    };
}
