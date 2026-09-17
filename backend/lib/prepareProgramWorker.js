'use strict';

// Worker-thread entry for prepareProgramAsync() (lib/prepareProgram.js).
// The file arrives as transferred UTF-8 bytes; the compiled program, its
// file-line map and the motion-limit flags go back as transferred buffers.

const { parentPort, workerData } = require('worker_threads');
const { prepareInWorker } = require('./prepareProgram');

try {
    const { source, spindleDelaySeconds, compileOptions } = workerData;
    const { message, transfer } = prepareInWorker(source, spindleDelaySeconds, compileOptions);
    parentPort.postMessage(message, transfer);
} catch (err) {
    parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
