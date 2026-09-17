/**
 * Two clocks (spec §3.8). Wall time steps (w32time, NTP, resume from sleep),
 * so every LOCAL interval or deadline uses mono(); wall() is only for values
 * that cross hosts or get displayed.
 */
'use strict';

const { performance } = require('perf_hooks');

function mono() {
    return performance.now();
}

function wall() {
    return Date.now();
}

module.exports = { mono, wall };
