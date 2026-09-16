'use strict';

/**
 * Wire compiler (plan item BE-1): turns a user's G-code file into the exact
 * lines streamed to the RSP firmware.
 *
 * Why this exists -- three defects proven against machine telemetry on the
 * 2026-09 sessions, all in how fw 0.1.x (easycnc_protocol.c) reads text:
 *
 *  1. Hex floats. parse_gcode_text() reads numbers with strtof(), which
 *     accepts C99 hex floats. "G0X11.1000" (Vectric/RTSX posts write no
 *     spaces) parses as G = 0x11.1 and the X word disappears -- the machine
 *     cut 271.7 mm from the wrong X at Z -2.79 on 2026-09-13 15:47:54.
 *     Every compiled line is single-space separated, so no number is ever
 *     directly followed by a letter.
 *
 *  2. Feed lag. A line without F takes last_feed at PARSE time, but
 *     last_feed only updates when a queued move is POPPED, up to 8 lines
 *     later -- DRAGON's F150 raster rows ran at 2540/3810/5000 mm/min.
 *     Every compiled motion line carries an explicit F in mm/min.
 *
 *  3. Drift. Each leg is rounded to whole steps from float32 deltas, so a
 *     position that is not on the 1/200 mm grid accumulates rounding error
 *     (Halloween Finishing ends 4.5 mm deep). Every target is rounded to the
 *     0.005 mm step grid before it is written.
 *
 * Output rules (one output line per cleaned input line, so line numbers in
 * the UI, resume points and Start From Line stay 1:1 with the program):
 *   motion   -> "G21 G90 G0|G1 [X..] [Y..] [Z..] F.. [M3 S..]"  (absolute mm, grid)
 *   other    -> harmless no-motion text the firmware ignores ("M3 S18000",
 *               "T1 M6", "M0", "G17"). Units/distance words are consumed
 *               here and never streamed, so they cannot change firmware
 *               modal state behind the compiled coordinates.
 *
 * Anything the firmware cannot execute correctly is refused at load with the
 * line number (errors), instead of being silently mis-cut.
 */

const { cleanGcodeLines, splitComment } = require('./resumeFromLine');
const { limitFeeds } = require('./firmwareMotionLimit');

const STEPS_PER_MM = 200;
const GRID_MM = 1 / STEPS_PER_MM;
const MAX_WIRE_LEN = 63; // codec.js MAX_GCODE_LEN / firmware text[64]
const MM_PER_INCH = 25.4;

const DEFAULTS = {
    rapidFeed: 3000,                        // mm/min for G0 (firmware has no rapid rate)
    maxFeed: 10000,                         // firmware accepts up to this
    maxRate: { x: 5000, y: 5000, z: 3000 }, // per-axis mm/min clamp
    safeHeight: 10,                         // mm above work zero for G53 Z rewrites
    zHeadroom: null,                        // mm above work zero the machine can travel (null = unknown)
    maxErrors: 20,
};

// Accepted without effect on this machine (verified harmless on the RSP path).
const G_NOOP = new Set([17, 40, 49, 54, 61, 61.1, 64, 80, 94, 98, 99]);
const M_NOOP = new Set([7, 8, 9]);

function roundGrid(mm) {
    const v = Math.round(mm * STEPS_PER_MM) / STEPS_PER_MM;
    return Object.is(v, -0) ? 0 : v;
}

function fmtMm(mm) {
    // grid values have at most 3 decimals; toFixed(3) never produces exponent form here
    const s = roundGrid(mm).toFixed(3);
    return s === '-0.000' ? '0.000' : s;
}

function fmtFeed(f) {
    return String(Math.round(f * 10) / 10);
}

function fmtNum(v) {
    return String(Math.round(v * 10000) / 10000);
}

const WORD_RE = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

function parseWords(code) {
    const words = [];
    let leftover = '';
    WORD_RE.lastIndex = 0;
    let m;
    let last = 0;
    while ((m = WORD_RE.exec(code)) !== null) {
        leftover += code.slice(last, m.index);
        words.push({ letter: m[1].toUpperCase(), value: parseFloat(m[2]), raw: m[0] });
        last = WORD_RE.lastIndex;
    }
    leftover += code.slice(last);
    return { words, leftover: leftover.replace(/\s+/g, '') };
}

/** Parses one cleaned line into a structured block. Pure; no modal state. */
function parseBlock(code, comment) {
    const { words, leftover } = parseWords(code);
    const b = {
        code, comment, leftover,
        g: [], m: [], axis: {}, f: null, s: null, t: null, p: null,
        bad: [], // [message]
    };
    for (const w of words) {
        switch (w.letter) {
            case 'G': b.g.push(w.value); break;
            case 'M': b.m.push(w.value); break;
            case 'X': case 'Y': case 'Z': b.axis[w.letter.toLowerCase()] = w.value; break;
            case 'F': b.f = w.value; break;
            case 'S': b.s = w.value; break;
            case 'T': b.t = w.value; break;
            case 'N': case 'O': break; // line / program numbers
            case 'P': b.p = w.value; break; // G4 dwell seconds (also G64 tolerance, ignored)
            case 'H': case 'Q': case 'L': case 'D': break; // parameters of G43/G64/cycles
            case 'I': case 'J': case 'K': case 'R':
                b.bad.push(`arc word ${w.raw} left after arc conversion -- unsupported arc form`);
                break;
            case 'A': case 'B': case 'C': case 'U': case 'V': case 'W':
                b.bad.push(`rotary/extra axis word ${w.raw} is not supported on this 3-axis machine`);
                break;
            default:
                b.bad.push(`unknown word ${w.raw}`);
        }
    }
    return b;
}

/**
 * One compile pass over parsed blocks.
 * @param {object[]} blocks
 * @param {object} opts
 * @param {number} retractZ  mm used for G53 Z moves in this pass
 */
function compilePass(blocks, opts, rapidFeed, retractZ) {
    const errors = [];
    const warnings = [];
    const pauses = [];
    const dwells = [];
    const tools = [];
    const err = (line, msg) => { errors.push({ line, msg }); };
    const warnOnce = new Set();
    const warn = (line, msg, key) => {
        if (key && warnOnce.has(key)) return;
        if (key) warnOnce.add(key);
        warnings.push({ line, msg });
    };

    let unitScale = 1;
    let absolute = true;
    let motion = null; // 0 | 1
    let feedMm = null;
    const pos = { x: null, y: null, z: null }; // absolute mm, grid-rounded
    let cutting = false;
    let programEnded = false;
    let g53Count = 0;

    const ext = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    const out = new Array(blocks.length);
    let motionCount = 0;
    let rapidCount = 0;
    let clampedCount = 0;

    for (let i = 0; i < blocks.length; i++) {
        const lineNo = i + 1;
        const b = blocks[i];

        if (b.leftover) {
            err(lineNo, `cannot read "${b.code}" (unexpected "${b.leftover.slice(0, 12)}")`);
            out[i] = 'G17';
            continue;
        }
        let lineBlocked = b.bad.length > 0;
        for (const msg of b.bad) err(lineNo, msg);

        // --- G words -----------------------------------------------------
        let g53 = false;
        let g28 = 0;
        let dwell = false;
        for (const g of b.g) {
            if (g === 0 || g === 1) { motion = g; continue; }
            if (g === 2 || g === 3) { err(lineNo, `G${g} arc was not converted -- unsupported arc form`); lineBlocked = true; continue; }
            if (g === 20) { unitScale = MM_PER_INCH; continue; }
            if (g === 21) { unitScale = 1; continue; }
            if (g === 90) { absolute = true; continue; }
            if (g === 91) { absolute = false; continue; }
            if (g === 53) { g53 = true; continue; }
            // G28/G30 "go to the reference position" -- almost always the
            // end-of-program (or pre-tool-change) retract: "G28 G91 Z0",
            // "G28 Z0", sometimes with X/Y to park. This machine has no
            // reference position, and refusing the line refused the whole
            // FILE, which is how a perfectly good toolpath became unrunnable.
            // Treated exactly like the G53 Z retract below: lift to the safe
            // height, never move X/Y to an unknown "home".
            if (g === 28 || g === 30) { g28 = g; g53 = true; continue; }
            if (g === 4) { dwell = true; continue; }
            if (g === 43) { warn(lineNo, 'G43 tool length offset is ignored (no tool offsets on this machine)', 'g43'); continue; }
            if (g === 18 || g === 19) { warn(lineNo, `G${g} plane select ignored (only XY-plane arcs are converted)`, `g${g}`); continue; }
            if (G_NOOP.has(g)) continue;
            if (g >= 55 && g <= 59) { err(lineNo, `G${g} work offset is not supported (this machine has a single work zero)`); lineBlocked = true; continue; }
            if (g === 92) { err(lineNo, 'G92 (coordinate offset) is not supported'); lineBlocked = true; continue; }
            if (g === 93) { err(lineNo, 'G93 inverse-time feed is not supported'); lineBlocked = true; continue; }
            if (g >= 38 && g < 39) { err(lineNo, `G${fmtNum(g)} probing inside a job is not supported`); lineBlocked = true; continue; }
            if (g === 41 || g === 42) { err(lineNo, `G${g} cutter compensation is not supported`); lineBlocked = true; continue; }
            if (g >= 81 && g <= 89) { err(lineNo, `G${g} canned cycle is not supported`); lineBlocked = true; continue; }
            err(lineNo, `G${fmtNum(g)} is not supported`);
            lineBlocked = true;
        }

        // --- M / T / S -------------------------------------------------------
        const spindleWords = [];
        const otherM = [];
        for (const mv of b.m) {
            if (mv === 0 || mv === 1) {
                // "(MSG, Click 'Continue' when ...)" -> "Click 'Continue' when ..."
                pauses.push({ line: lineNo, optional: mv === 1, message: String(b.comment || '').replace(/^\s*MSG\s*,?\s*/i, '') });
                otherM.push(`M${mv}`);
            } else if (mv === 3 || mv === 4 || mv === 5) {
                spindleWords.push(`M${mv}`);
            } else if (mv === 6) {
                tools.push({ line: lineNo, tool: b.t, afterCutting: cutting, comment: b.comment });
                if (cutting) {
                    err(lineNo, `tool change M6${b.t !== null ? ` (T${fmtNum(b.t)})` : ''} after cutting has started is not supported -- split the job into one file per tool`);
                    lineBlocked = true;
                }
                otherM.push('M6');
            } else if (mv === 2 || mv === 30) {
                programEnded = true;
                otherM.push(`M${mv}`);
            } else if (M_NOOP.has(mv)) {
                // coolant / mist: no output on this machine
            } else if (mv === 98 || mv === 99) {
                err(lineNo, `M${mv} subprogram calls are not supported`);
                lineBlocked = true;
            } else {
                warn(lineNo, `M${fmtNum(mv)} has no effect on this machine`, `m${mv}`);
            }
        }
        if (b.s !== null) spindleWords.push(`S${fmtNum(b.s)}`);
        if (b.t !== null && !b.m.includes(6)) tools.push({ line: lineNo, tool: b.t, afterCutting: cutting, comment: b.comment, selectOnly: true });

        if (b.f !== null) {
            if (!(b.f > 0)) { err(lineNo, `invalid feed F${fmtNum(b.f)}`); lineBlocked = true; }
            else feedMm = b.f * unitScale;
        }
        const hasAxis = b.axis.x !== undefined || b.axis.y !== undefined || b.axis.z !== undefined;

        if (dwell) {
            // A G4 line is a dwell, never a move. Its time is P seconds, or on
            // Fanuc/Haas posts X seconds -- and X on a dwell line is NOT a
            // coordinate. Reading it as one turned "G4 X2.5" (wait 2.5 s) into
            // a cutting move to X2.5, ploughing across the work at depth.
            // The firmware has no G4; the job streamer waits on the host once
            // every move before this line has run.
            let seconds = null;
            if (b.p !== null && b.p >= 0) seconds = b.p;
            else if (b.axis.x !== undefined && b.axis.x >= 0) {
                seconds = b.axis.x;
                warn(lineNo, `G4 X${fmtNum(b.axis.x)} read as a ${fmtNum(b.axis.x)} second dwell (X is the dwell time on a G4 line, not a position)`, 'g4-x');
            }
            if (seconds === null) {
                warn(lineNo, 'G4 dwell without a time (P or X) is ignored', 'g4-nop');
            } else if (seconds > 3600) {
                err(lineNo, `G4 dwell of ${fmtNum(seconds)} is longer than an hour -- the dwell time is in seconds on this machine`);
                lineBlocked = true;
            } else if (seconds > 0) {
                // Dialects disagree: grbl/LinuxCNC (what this machine speaks,
                // and what Vectric/Buildbotics posts write) read P as SECONDS;
                // some Fanuc/Marlin posts write milliseconds. A whole number of
                // 60 or more is far more likely to be milliseconds than a real
                // minute-long pause, so say so instead of silently parking the
                // machine for eight minutes.
                if (seconds >= 60 && Number.isInteger(seconds)) {
                    warn(lineNo, `G4 dwell of ${fmtNum(seconds)} is read as ${fmtNum(seconds)} SECONDS (${(seconds / 60).toFixed(1)} min). If your post writes milliseconds, this pause is 1000x longer than intended -- you can skip it from the pause banner`, 'g4-ms');
                }
                dwells.push({ line: lineNo, seconds });
            }
            if (!lineBlocked) {
                // never motion, and the axis words do not move `pos`
                const parts = [...otherM, ...spindleWords];
                out[i] = parts.length ? parts.join(' ') : 'G17';
                continue;
            }
        }

        if (lineBlocked) { out[i] = 'G17'; continue; }

        // A bare G28/G30 ("retract to the reference position") carries no axis
        // word at all, so it has to be handled before the no-axis shortcut.
        if (!hasAxis && !g28) {
            const parts = [];
            if (b.t !== null) parts.push(`T${fmtNum(b.t)}`);
            parts.push(...otherM, ...spindleWords);
            out[i] = parts.length ? parts.join(' ') : 'G17';
            continue;
        }
        if (programEnded) warn(lineNo, 'motion after M2/M30 program end', 'after-end');

        // --- G53 / G28 / G30: no machine coordinates here -> safe Z retract
        if (g53) {
            const what = g28 ? `G${g28}` : 'G53';
            if (b.axis.x !== undefined || b.axis.y !== undefined) {
                warn(lineNo, `${what} X/Y move ignored -- this machine has no reference position, only a safe Z retract is performed`, 'g53xy');
            }
            if (g28) {
                // Its axis words are the intermediate point, not a target, and
                // the destination is a machine home this machine does not have.
                warn(lineNo, `${what} retracts Z to the safe height instead of a machine home position`, `g${g28}`);
            } else if (b.axis.z === undefined) {
                const parts = [...otherM, ...spindleWords];
                out[i] = parts.length ? parts.join(' ') : 'G17';
                continue;
            }
            g53Count++;
            pos.z = retractZ; // subsequent XY-only lines must carry the retract height, never an old depth
            const zRate = opts.maxRate.z > 0 ? Math.min(rapidFeed, opts.maxRate.z) : rapidFeed;
            const parts = ['G21 G90 G0'];
            if (pos.x !== null) parts.push(`X${fmtMm(pos.x)}`);
            if (pos.y !== null) parts.push(`Y${fmtMm(pos.y)}`);
            parts.push(`Z${fmtMm(pos.z)}`, `F${fmtFeed(zRate)}`, ...spindleWords);
            out[i] = parts.join(' ');
            motionCount++;
            rapidCount++;
            continue;
        }

        let m = motion;
        if (m === null) {
            m = feedMm !== null ? 1 : 0;
            warn(lineNo, `move without G0/G1 before it -- treated as G${m}`, 'nomotionmode');
        }

        const prev = { x: pos.x, y: pos.y, z: pos.z };
        let unknownAxis = null;
        for (const k of ['x', 'y', 'z']) {
            if (b.axis[k] === undefined) continue;
            const vMm = b.axis[k] * unitScale;
            if (absolute) pos[k] = roundGrid(vMm);
            else if (pos[k] === null) unknownAxis = k;
            else pos[k] = roundGrid(pos[k] + vMm);
        }
        if (unknownAxis) {
            err(lineNo, `incremental (G91) move on ${unknownAxis.toUpperCase()} before its absolute position is known`);
            out[i] = 'G17';
            continue;
        }

        let f;
        if (m === 0) {
            f = rapidFeed;
        } else {
            if (feedMm === null) {
                err(lineNo, 'cutting move (G1) before any feed rate F is set');
                out[i] = 'G17';
                continue;
            }
            f = feedMm;
        }
        f = Math.min(f, opts.maxFeed);

        // per-axis rate clamp: no single axis faster than its max rate
        let len2 = 0;
        const d = { x: 0, y: 0, z: 0 };
        for (const k of ['x', 'y', 'z']) {
            if (pos[k] !== null && prev[k] !== null) d[k] = pos[k] - prev[k];
            len2 += d[k] * d[k];
        }
        const len = Math.sqrt(len2);
        let limit = Infinity;
        if (len > 0) {
            for (const k of ['x', 'y', 'z']) {
                if (Math.abs(d[k]) > 1e-9 && opts.maxRate[k] > 0) {
                    limit = Math.min(limit, (opts.maxRate[k] * len) / Math.abs(d[k]));
                }
            }
        }
        // An axis moving from an unknown start (first move on that axis) could be
        // travelling alone at full feed -- cap to that axis's own max rate.
        for (const k of ['x', 'y', 'z']) {
            if (b.axis[k] !== undefined && prev[k] === null && opts.maxRate[k] > 0) {
                limit = Math.min(limit, opts.maxRate[k]);
            }
        }
        if (limit < f) { f = limit; clampedCount++; }
        f = Math.max(f, 1);

        const parts = [`G21 G90 G${m}`];
        if (pos.x !== null) parts.push(`X${fmtMm(pos.x)}`);
        if (pos.y !== null) parts.push(`Y${fmtMm(pos.y)}`);
        if (pos.z !== null) parts.push(`Z${fmtMm(pos.z)}`);
        parts.push(`F${fmtFeed(f)}`, ...spindleWords);
        out[i] = parts.join(' ');

        for (const k of ['x', 'y', 'z']) {
            if (b.axis[k] === undefined || pos[k] === null) continue;
            if (pos[k] < ext.min[k]) ext.min[k] = pos[k];
            if (pos[k] > ext.max[k]) ext.max[k] = pos[k];
        }
        motionCount++;
        if (m === 0) rapidCount++;
        else if (len > 0) cutting = true;

        if (otherM.length) {
            // M0/M6/M2 sharing a line with motion: firmware ignores them there; host acts after the move
            warn(lineNo, `${otherM.join(' ')} on a motion line is handled after the move`, `mixedm-${otherM.join('')}`);
        }
    }

    return { out, errors, warnings, pauses, dwells, tools, ext, motionCount, rapidCount, clampedCount, g53Count };
}

/**
 * @param {string} text  program text AFTER arc linearization (G2/G3 already expanded)
 * @param {object} [options] see DEFAULTS
 * @returns {{ lines: string[], text: string, meta: object }}
 */
function compileWire(text, options = {}) {
    const opts = { ...DEFAULTS, ...options, maxRate: { ...DEFAULTS.maxRate, ...(options.maxRate || {}) } };
    const rapidFeed = Math.min(Number(opts.rapidFeed) || DEFAULTS.rapidFeed, opts.maxFeed);

    const rawLines = String(text || '').split(/\r?\n/);
    const blocks = [];
    for (const raw of rawLines) {
        const { code, comment } = splitComment(raw);
        if (!code || code.startsWith('%')) continue;
        blocks.push(parseBlock(code, comment));
    }
    const expectedCount = cleanGcodeLines(text).length;

    // Pass 1 finds the program's own highest Z; the G53 retract goes at least that high.
    const safeHeight = Number(opts.safeHeight) || 0;
    let pass = compilePass(blocks, opts, rapidFeed, roundGrid(safeHeight));
    const fileMaxZ = pass.ext.max.z === -Infinity ? 0 : pass.ext.max.z;
    const headroom = (opts.zHeadroom !== null && opts.zHeadroom !== undefined && Number.isFinite(Number(opts.zHeadroom)))
        ? Number(opts.zHeadroom) : null;
    let retractZ = Math.max(fileMaxZ, safeHeight);
    if (headroom !== null) retractZ = Math.min(retractZ, headroom - 2);
    retractZ = roundGrid(retractZ);
    if (pass.g53Count > 0 && retractZ !== roundGrid(safeHeight)) {
        pass = compilePass(blocks, opts, rapidFeed, retractZ);
    }

    const errors = pass.errors;
    const warnings = pass.warnings;
    if (headroom !== null && fileMaxZ > headroom) {
        errors.push({ line: null, msg: `program goes up to Z ${fileMaxZ.toFixed(2)} mm but the machine only has ${headroom.toFixed(2)} mm of Z travel above work zero` });
    }
    if (pass.g53Count > 0) {
        warnings.push({ line: null, msg: `${pass.g53Count} G53 machine-coordinate Z move(s) will retract to Z ${retractZ.toFixed(2)} mm above work zero` });
    }

    // Firmware motion limit (lib/firmwareMotionLimit.js): lower F only where
    // the firmware's per-line start/stop would jerk the machine past its
    // limits -- fine 3D detail was rounded off otherwise. Off unless asked.
    let out = pass.out;
    let feedLimitedLines = null;
    let motionLimitedCount = 0;
    const ml = opts.motionLimit;
    if (ml && ml.enabled !== false) {
        const r = limitFeeds(out, ml);
        out = r.lines;
        feedLimitedLines = r.limited;
        motionLimitedCount = r.limitedCount;
    }
    for (let i = 0; i < out.length; i++) {
        const l = out[i];
        if (l.length > MAX_WIRE_LEN) errors.push({ line: i + 1, msg: `compiled line is ${l.length} bytes, over the ${MAX_WIRE_LEN}-byte firmware limit: ${l}` });
        if (/0[xX]/.test(l)) errors.push({ line: i + 1, msg: `compiled line contains a hex-like pattern: ${l}` });
        if (/G0*[23](?![0-9])/i.test(l)) errors.push({ line: i + 1, msg: `compiled line still contains an arc: ${l}` });
    }
    if (out.length !== expectedCount) {
        errors.push({ line: null, msg: `internal: compiled ${out.length} lines but the job cleaner sees ${expectedCount}` });
    }
    if (pass.motionCount === 0) errors.push({ line: null, msg: 'program contains no motion' });

    const ext = pass.ext;
    const fin = (v) => (Number.isFinite(v) ? v : null);
    const hasExtents = [ext.max.x, ext.max.y, ext.max.z].some(Number.isFinite);
    const errorCount = errors.length;
    return {
        lines: out,
        text: out.join('\n'),
        // [i] = 1 when line i+1's feed was lowered by the motion limit; the
        // feed override must not raise those lines again (job.js)
        feedLimitedLines,
        meta: {
            lineCount: out.length,
            motionCount: pass.motionCount,
            rapidCount: pass.rapidCount,
            clampedCount: pass.clampedCount,
            motionLimitedCount,
            errorCount,
            errors: errors.slice(0, opts.maxErrors),
            warnings,
            pauses: pass.pauses,
            dwells: pass.dwells,
            tools: pass.tools,
            usesSpindle: out.some((l) => /\bM[34]\b/.test(l)),
            extents: hasExtents ? {
                min: { x: fin(ext.min.x), y: fin(ext.min.y), z: fin(ext.min.z) },
                max: { x: fin(ext.max.x), y: fin(ext.max.y), z: fin(ext.max.z) },
            } : null,
            retractZ: pass.g53Count > 0 ? retractZ : null,
            options: { rapidFeed, maxFeed: opts.maxFeed, maxRate: opts.maxRate, safeHeight, zHeadroom: headroom, motionLimit: ml || null },
        },
    };
}

module.exports = { compileWire, roundGrid, parseBlock, GRID_MM, STEPS_PER_MM, MAX_WIRE_LEN, DEFAULTS };
