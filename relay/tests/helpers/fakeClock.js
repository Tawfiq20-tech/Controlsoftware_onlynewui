'use strict';

const { performance } = require('perf_hooks');

// Real time plus a jump offset: timers keep running normally, and advance() moves both
// the monotonic and wall clocks forward so windows and sweeps can be tested without sleeping.
function createFakeClock({ realSleep = false } = {}) {
    let offset = 0;
    const sleeps = [];
    const clock = {
        mono: () => performance.now() + offset,
        now: () => Math.round(Date.now() + offset),
        wall: () => Math.round(Date.now() + offset),
        advance(ms) {
            offset += ms;
        },
        sleeps,
        sleep(ms) {
            sleeps.push(ms);
            if (realSleep) return new Promise((r) => setTimeout(r, ms));
            return Promise.resolve();
        },
    };
    clock.relayNow = clock.now;
    return clock;
}

module.exports = { createFakeClock };
