'use strict';

/**
 * Turns a user's G-code file into the program the RSP controller streams:
 * arcs linearized, spindle spin-up dwells inserted, wire-compiled (and feed
 * limited when compileOptions.motionLimit asks for it).
 *
 * prepareProgram()      -- synchronous, same thread.
 * prepareProgramAsync() -- the same work on a worker thread.
 *
 * Why the worker: a large 3D finishing file (DRAGON FINISH, 14 MB, 328k
 * lines) takes ~3.7 s to compile. On the main thread that stalls the event
 * loop, so no RSP frame is read or sent, and the stream declares the link
 * lost after 3 s of silence (2026-09-16 19:32:42 "heartbeat timeout -- link
 * lost" while loading). The firmware stops a moving machine after 5 s
 * without a host byte, so a long enough stall at the wrong time would stop
 * it too. On a worker thread the link keeps being serviced throughout.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const linearizeArcs = require('./linearizeArcs');
const injectSpindleDelay = require('./injectSpindleDelay');
const { compileWire } = require('./wireCompiler');

/**
 * @returns {{ arcCount:number, segmentCount:number, insertedCount:number,
 *             compiled:{ lines:string[], text:string, feedLimitedLines:Uint8Array|null, meta:object } }}
 * @throws on input the steps cannot process
 */
function prepareProgram(gcode, spindleDelaySeconds, compileOptions) {
    // Firmware has no arc moves: linearize (in-memory copy only, never the file on disk).
    const { text: linearized, arcCount, segmentCount } = linearizeArcs(String(gcode || ''));
    // Spin-up dwell after every M3/M4 (preferences.spindleDelay, FIXFILE.html FIX-16).
    const { text, insertedCount } = injectSpindleDelay(linearized, spindleDelaySeconds);
    // BE-1: the exact wire lines the firmware reads correctly, or errors with line numbers.
    const compiled = compileWire(text, compileOptions || {});
    return { arcCount, segmentCount, insertedCount, compiled };
}

const WORKER_FILE = path.join(__dirname, 'prepareProgramWorker.js');

/**
 * Same result as prepareProgram(), computed on a worker thread. Falls back to
 * the synchronous path only if the worker cannot be started at all.
 */
function prepareProgramAsync(gcode, spindleDelaySeconds, compileOptions) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(WORKER_FILE, {
                workerData: { gcode: String(gcode || ''), spindleDelaySeconds, compileOptions: compileOptions || {} },
            });
        } catch (spawnErr) {
            try { resolve(prepareProgram(gcode, spindleDelaySeconds, compileOptions)); } catch (err) { reject(err); }
            return;
        }
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
            worker.terminate().catch(() => {});
        };
        worker.once('message', (msg) => {
            if (!msg || !msg.ok) {
                finish(reject, new Error((msg && msg.error) || 'program preparation failed'));
                return;
            }
            // Compiled lines never contain a newline: rebuilding them from the
            // joined text is exact and far cheaper to pass than 300k strings.
            const lines = msg.text.split('\n');
            finish(resolve, {
                arcCount: msg.arcCount,
                segmentCount: msg.segmentCount,
                insertedCount: msg.insertedCount,
                compiled: {
                    lines,
                    text: msg.text,
                    feedLimitedLines: msg.feedLimited ? new Uint8Array(msg.feedLimited) : null,
                    meta: msg.meta,
                },
            });
        });
        worker.once('error', (err) => finish(reject, err));
        worker.once('exit', (code) => {
            if (!settled) finish(reject, new Error(`program preparation worker exited (code ${code})`));
        });
    });
}

module.exports = { prepareProgram, prepareProgramAsync };
