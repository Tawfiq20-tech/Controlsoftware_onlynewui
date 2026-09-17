/**
 * Machine<->relay heartbeat bookkeeping (spec §3.4.1, §5.1.4).
 *
 * RTT is measured on the monotonic clock; the relay offset uses wall-clock
 * sentAt/recvAt because it is a cross-host quantity by definition.
 */
'use strict';

const defaultClock = require('./clock');
const { makeId } = require('./protocol');

const SAMPLE_COUNT = 5;
const NORMAL_INTERVAL_MS = 5000;
const FAST_INTERVAL_MS = 1000;
const FRESH_MS = 10000;

function median(values) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

class LatencyTracker {
    constructor({ clock = defaultClock } = {}) {
        this.clock = clock;
        this.reset();
    }

    reset() {
        this._outstanding = new Map(); // nonce -> {mono, sentAt}
        this._rtt = [];
        this._offset = [];
        this.lastPongAt = null;
    }

    static intervalMs(fast) {
        return fast ? FAST_INTERVAL_MS : NORMAL_INTERVAL_MS;
    }

    static deadlineMs(intervalMs) {
        return Math.max(3 * intervalMs, 3000);
    }

    /** Builds a ping body and remembers it. */
    makePing() {
        const nonce = makeId('p_');
        const sentAt = this.clock.wall();
        this._outstanding.set(nonce, { mono: this.clock.mono(), sentAt });
        // A dead link never answers; don't let the map grow without bound.
        if (this._outstanding.size > 64) this._outstanding.delete(this._outstanding.keys().next().value);
        return { nonce, sentAt };
    }

    /** mono() time of the oldest ping still waiting for its pong, or null. */
    oldestOutstanding() {
        let oldest = null;
        for (const p of this._outstanding.values()) {
            if (oldest === null || p.mono < oldest) oldest = p.mono;
        }
        return oldest;
    }

    /** Returns the RTT sample in ms, or null for an unknown/duplicate nonce. */
    onPong(body) {
        if (!body || typeof body.nonce !== 'string') return null;
        const entry = this._outstanding.get(body.nonce);
        if (!entry) return null;
        // A pong proves every older ping was delivered too (ordered stream).
        for (const [nonce, p] of this._outstanding) {
            if (p.mono <= entry.mono) this._outstanding.delete(nonce);
        }
        const now = this.clock.mono();
        const rtt = Math.max(0, now - entry.mono);
        this._rtt.push(rtt);
        if (this._rtt.length > SAMPLE_COUNT) this._rtt.shift();
        const recvAt = Number(body.recvAt);
        if (Number.isFinite(recvAt)) {
            this._offset.push(recvAt - (entry.sentAt + rtt / 2));
            if (this._offset.length > SAMPLE_COUNT) this._offset.shift();
        }
        this.lastPongAt = now;
        return rtt;
    }

    get rttMs() {
        const m = median(this._rtt);
        return m === null ? null : Math.round(m);
    }

    get relayOffsetMs() {
        const m = median(this._offset);
        return m === null ? null : Math.round(m);
    }

    maxRecent(n) {
        const recent = this._rtt.slice(-n);
        return recent.length ? Math.max(...recent) : null;
    }

    effectiveRtt(via) {
        if (!via || via.clientRttMs === null || via.clientRttMs === undefined) return Infinity;
        const client = Number(via.clientRttMs);
        const machine = this.maxRecent(3);
        if (!Number.isFinite(client) || machine === null) return Infinity;
        return machine + client;
    }

    isFresh() {
        return this.lastPongAt !== null
            && this.clock.mono() - this.lastPongAt <= FRESH_MS
            && this.relayOffsetMs !== null;
    }
}

module.exports = { LatencyTracker, median, NORMAL_INTERVAL_MS, FAST_INTERVAL_MS };
