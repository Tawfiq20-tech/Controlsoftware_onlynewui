'use strict';

/**
 * Turns a user's G-code file into the program the RSP controller streams:
 * arcs converted to chords, spindle spin-up dwells inserted, wire-compiled
 * (and feed limited when compileOptions.motionLimit asks for it) -- all in
 * one pass of lib/wireCompiler.js over the ORIGINAL text, so every line of
 * the result knows its file line (compiled.meta.sourceLines).
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
 *
 * Memory (2026-09-17, measured on Santa3D finishing, 32.8 MB / 1.1M lines:
 * 1647 MB peak RSS before): the file goes to the worker as UTF-8 bytes that
 * are MOVED, not copied, and the compiled program comes back the same way as
 * one byte buffer, instead of cloning a 33 MB string in and a 45 MB string
 * out. The worker never holds the file as one big string at all.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { compileWire, compileProgram } = require('./wireCompiler');

function compileOptionsFor(spindleDelaySeconds, compileOptions) {
    return { ...(compileOptions || {}), spindleDelaySeconds: Number(spindleDelaySeconds) || 0 };
}

/**
 * @param {string} gcode  the original file text
 * @returns {{ arcCount:number, segmentCount:number, insertedCount:number,
 *             compiled:{ lines:string[], text:string, feedLimitedLines:Uint8Array|null, meta:object } }}
 *   Refusals are compiled.meta.errors ({ line: FILE line or null, msg }).
 */
function prepareProgram(gcode, spindleDelaySeconds, compileOptions) {
    const compiled = compileWire(String(gcode || ''), compileOptionsFor(spindleDelaySeconds, compileOptions));
    const { meta } = compiled;
    return { arcCount: meta.arcCount, segmentCount: meta.arcSegmentCount, insertedCount: meta.spinUpDwellCount, compiled };
}

const WORKER_FILE = path.join(__dirname, 'prepareProgramWorker.js');

/** The compiled lines as one ASCII byte buffer ("line\nline..."), sized exactly so it can be transferred. */
function packLines(lines) {
    let total = lines.length ? lines.length - 1 : 0;
    for (let i = 0; i < lines.length; i++) total += lines[i].length;
    const buf = Buffer.allocUnsafeSlow(total);
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
        if (i) buf[off++] = 10;
        off += buf.latin1Write(lines[i], off);
    }
    return buf;
}

/** Worker side of prepareProgramAsync(): compile the transferred bytes, hand back transferable buffers. */
function prepareInWorker(source, spindleDelaySeconds, compileOptions) {
    const r = compileProgram(source, compileOptionsFor(spindleDelaySeconds, compileOptions));
    const lineCount = r.lines.length;
    const packed = packLines(r.lines);
    const { meta } = r;
    const feedLimited = r.feedLimitedLines;
    const message = {
        ok: true,
        lineCount,
        textBuffer: packed.buffer,
        textBytes: packed.length,
        feedLimited,
        meta,
    };
    const transfer = [packed.buffer, meta.sourceLines.buffer];
    if (feedLimited && feedLimited.byteLength === feedLimited.buffer.byteLength) transfer.push(feedLimited.buffer);
    return { message, transfer };
}

/**
 * Same result as prepareProgram(), computed on a worker thread. Falls back to
 * the synchronous path only if the worker cannot be started at all.
 */
function prepareProgramAsync(gcode, spindleDelaySeconds, compileOptions) {
    return new Promise((resolve, reject) => {
        const text = String(gcode || '');
        // TextEncoder gives a Uint8Array with a buffer of its own: safe to move.
        const bytes = new TextEncoder().encode(text);
        let worker;
        try {
            worker = new Worker(WORKER_FILE, {
                workerData: { source: bytes, spindleDelaySeconds, compileOptions: compileOptions || {} },
                transferList: [bytes.buffer],
            });
        } catch (spawnErr) {
            try { resolve(prepareProgram(text, spindleDelaySeconds, compileOptions)); } catch (err) { reject(err); }
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
            // Compiled lines never contain a newline: one decode of the packed
            // bytes gives the text, and the lines are slices of it.
            const joined = Buffer.from(msg.textBuffer, 0, msg.textBytes).latin1Slice(0, msg.textBytes);
            const lines = msg.lineCount ? joined.split('\n') : [];
            const { meta } = msg;
            finish(resolve, {
                arcCount: meta.arcCount,
                segmentCount: meta.arcSegmentCount,
                insertedCount: meta.spinUpDwellCount,
                compiled: {
                    lines,
                    text: joined,
                    feedLimitedLines: msg.feedLimited || null,
                    meta,
                },
            });
        });
        worker.once('error', (err) => finish(reject, err));
        worker.once('exit', (code) => {
            if (!settled) finish(reject, new Error(`program preparation worker exited (code ${code})`));
        });
    });
}

module.exports = { prepareProgram, prepareProgramAsync, prepareInWorker };
