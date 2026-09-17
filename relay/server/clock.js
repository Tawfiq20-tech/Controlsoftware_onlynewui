'use strict';

const { performance } = require('perf_hooks');

// Captured once so relayNow() never steps when the host wall clock is adjusted (§3.8).
const bootWall = Date.now();
const bootMono = performance.now();

function mono() {
    return performance.now();
}

function now() {
    return Math.round(bootWall + (performance.now() - bootMono));
}

function wall() {
    return Date.now();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { mono, now, relayNow: now, wall, sleep };
