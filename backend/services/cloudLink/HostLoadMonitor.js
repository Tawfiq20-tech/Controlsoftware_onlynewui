/**
 * 'host-busy' lock source (spec §5.5). A stalled event loop delays jog
 * keepalive handling, deadman ticks and serial writes alike, so remote motion
 * is refused (and running remote jogs cancelled) while the loop is lagging.
 */
'use strict';

const { EventEmitter } = require('events');
const { monitorEventLoopDelay } = require('perf_hooks');
const defaultClock = require('./clock');

const SAMPLE_MS = 100;
const BUSY_OVER_MS = 200;
const CALM_UNDER_MS = 50;
const CALM_FOR_MS = 2000;

class HostLoadMonitor extends EventEmitter {
    constructor({
        clock = defaultClock, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
        histogramFactory = () => monitorEventLoopDelay({ resolution: 10 }),
    } = {}) {
        super();
        this.clock = clock;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.histogramFactory = histogramFactory;
        this.busy = false;
        this._calmSince = null;
        this._timer = null;
        this._histogram = null;
    }

    start() {
        if (this._timer) return this;
        try {
            this._histogram = this.histogramFactory();
            if (this._histogram) this._histogram.enable();
        } catch (_) {
            this._histogram = null;
        }
        this._timer = this.setIntervalFn(() => {
            if (!this._histogram) return;
            const maxMs = this._histogram.max / 1e6;
            this._histogram.reset();
            this.sample(maxMs);
        }, SAMPLE_MS);
        if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
        return this;
    }

    stop() {
        if (this._timer) this.clearIntervalFn(this._timer);
        this._timer = null;
        if (this._histogram) {
            try { this._histogram.disable(); } catch (_) { /* already off */ }
        }
        this._histogram = null;
    }

    isBusy() {
        return this.busy;
    }

    /** Feed one 100 ms window's max loop delay (exposed for tests). */
    sample(maxDelayMs) {
        const now = this.clock.mono();
        if (maxDelayMs > BUSY_OVER_MS) {
            this._calmSince = null;
            if (!this.busy) {
                this.busy = true;
                this.emit('change', true);
            }
            return;
        }
        if (!this.busy) return;
        if (maxDelayMs >= CALM_UNDER_MS) {
            this._calmSince = null;
            return;
        }
        if (this._calmSince === null) this._calmSince = now;
        if (now - this._calmSince >= CALM_FOR_MS) {
            this.busy = false;
            this._calmSince = null;
            this.emit('change', false);
        }
    }
}

module.exports = { HostLoadMonitor };
