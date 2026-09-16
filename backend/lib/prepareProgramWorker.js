'use strict';

// Worker-thread entry for prepareProgramAsync() (lib/prepareProgram.js).

const { parentPort, workerData } = require('worker_threads');
const { prepareProgram } = require('./prepareProgram');

try {
    const { gcode, spindleDelaySeconds, compileOptions } = workerData;
    const r = prepareProgram(gcode, spindleDelaySeconds, compileOptions);
    const limited = r.compiled.feedLimitedLines;
    // Copy into a buffer of its own so it can be transferred, not cloned.
    const feedLimited = limited ? limited.slice().buffer : null;
    parentPort.postMessage({
        ok: true,
        arcCount: r.arcCount,
        segmentCount: r.segmentCount,
        insertedCount: r.insertedCount,
        text: r.compiled.text,
        meta: r.compiled.meta,
        feedLimited,
    }, feedLimited ? [feedLimited] : []);
} catch (err) {
    parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
