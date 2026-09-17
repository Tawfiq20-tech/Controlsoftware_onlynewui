'use strict';

// In-memory limiters. All windows use the monotonic clock so a wall-clock step can
// neither unlock an attacker nor lock out a user (§3.8).

class TokenBuckets {
    constructor({ ratePerSec, burst, mono, maxKeys = 100000 }) {
        this.rate = ratePerSec;
        this.burst = burst;
        this.mono = mono;
        this.maxKeys = maxKeys;
        this.buckets = new Map();
    }

    take(key, n = 1) {
        const now = this.mono();
        let b = this.buckets.get(key);
        if (!b) {
            if (this.buckets.size >= this.maxKeys) this.prune(now);
            b = { tokens: this.burst, at: now };
            this.buckets.set(key, b);
        } else {
            b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate);
            b.at = now;
        }
        if (b.tokens >= n) {
            b.tokens -= n;
            return true;
        }
        return false;
    }

    retryAfterSec(key) {
        const b = this.buckets.get(key);
        if (!b || b.tokens >= 1) return 0;
        return Math.max(1, Math.ceil((1 - b.tokens) / this.rate));
    }

    delete(key) {
        this.buckets.delete(key);
    }

    prune(now = this.mono()) {
        const fullAfterMs = (this.burst / this.rate) * 1000;
        for (const [k, b] of this.buckets) {
            if (now - b.at > fullAfterMs) this.buckets.delete(k);
        }
    }
}

class SlidingWindow {
    constructor({ windowMs, mono, cap = 2000, maxKeys = 100000 }) {
        this.windowMs = windowMs;
        this.mono = mono;
        this.cap = cap;
        this.maxKeys = maxKeys;
        this.hits = new Map();
    }

    _list(key, now) {
        const list = this.hits.get(key);
        if (!list) return null;
        const cutoff = now - this.windowMs;
        let i = 0;
        while (i < list.length && list[i] <= cutoff) i++;
        if (i > 0) list.splice(0, i);
        if (list.length === 0) {
            this.hits.delete(key);
            return null;
        }
        return list;
    }

    hit(key) {
        const now = this.mono();
        let list = this._list(key, now);
        if (!list) {
            if (this.hits.size >= this.maxKeys) this.prune(now);
            list = [];
            this.hits.set(key, list);
        }
        list.push(now);
        if (list.length > this.cap) list.splice(0, list.length - this.cap);
        return list.length;
    }

    count(key) {
        const list = this._list(key, this.mono());
        return list ? list.length : 0;
    }

    oldest(key) {
        const list = this._list(key, this.mono());
        return list ? list[0] : null;
    }

    reset(key) {
        this.hits.delete(key);
    }

    totalCount() {
        let n = 0;
        const now = this.mono();
        for (const key of [...this.hits.keys()]) {
            const list = this._list(key, now);
            if (list) n += list.length;
        }
        return n;
    }

    prune(now = this.mono()) {
        for (const key of [...this.hits.keys()]) this._list(key, now);
    }
}

// Fixed-limit helper: allow at most `limit` events per window per key.
class WindowLimiter {
    constructor({ limit, windowMs, mono }) {
        this.limit = limit;
        this.win = new SlidingWindow({ windowMs, mono, cap: limit + 1 });
        this.mono = mono;
    }

    tryHit(key) {
        if (this.win.count(key) >= this.limit) return false;
        this.win.hit(key);
        return true;
    }

    retryAfterSec(key) {
        const oldest = this.win.oldest(key);
        if (oldest == null) return 0;
        return Math.max(1, Math.ceil((oldest + this.win.windowMs - this.mono()) / 1000));
    }
}

module.exports = { TokenBuckets, SlidingWindow, WindowLimiter };
