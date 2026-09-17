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
 * One interpreter (2026-09-17 dialect audit). Arcs used to be expanded by a
 * separate text pass (lib/linearizeArcs.js) with its own idea of units,
 * distance mode and position, and it threw away every other word on an arc
 * line. This compiler now reads the ORIGINAL file, in one pass, and owns all
 * of it: modal state, arcs (IJ, R, G17/18/19, helical, G90.1/G91.1), spin-up
 * dwells, tool changes and the refusals. Every construct is either executed
 * exactly as written or refused before Start, and every error, warning,
 * pause, dwell and tool entry names the line of the FILE.
 *
 * Output rules:
 *   motion   -> "G21 G90 G0|G1 [X..] [Y..] [Z..] F.. [M3 S..]"  (absolute mm, grid;
 *               with a spin-up delay the M3 S.. goes on its own line, then the wait, then the move)
 *   other    -> harmless no-motion text the firmware ignores ("M3 S18000",
 *               "T1 M6", "M0", "G17"). Units/distance words are consumed
 *               here and never streamed, so they cannot change firmware
 *               modal state behind the compiled coordinates.
 * Every line with code gives at least one output line; an arc gives one per
 * chord. meta.sourceLines[i] is the file line of output line i+1.
 *
 * Memory: the source is read line by line (a string, or UTF-8 bytes handed
 * over by the worker thread) and no per-line block objects are kept -- the
 * old block array alone held ~500 MB for the 32.8 MB Santa3D finishing file.
 */

const { splitComment } = require('./resumeFromLine');
const { limitFeeds } = require('./firmwareMotionLimit');
const { tessellateArcAround, arcCentreFromRadius } = require('./linearizeArcs');

const STEPS_PER_MM = 200;
const GRID_MM = 1 / STEPS_PER_MM;
const MAX_WIRE_LEN = 63; // codec.js MAX_GCODE_LEN / firmware text[64]
const MM_PER_INCH = 25.4;
const AXES = ['x', 'y', 'z'];

const DEFAULTS = {
    rapidFeed: 3000,                        // mm/min for G0 (firmware has no rapid rate)
    maxFeed: 10000,                         // firmware accepts up to this
    maxRate: { x: 5000, y: 5000, z: 3000 }, // per-axis mm/min clamp
    safeHeight: 10,                         // mm above work zero for G53 Z rewrites
    zHeadroom: null,                        // mm above work zero the machine can travel (null = unknown)
    maxErrors: 20,
    // true only when the controller holds the job at every meta.toolChanges
    // entry. Without it a tool change after cutting has started is refused.
    toolChangeHolds: false,
    // G4 P unit: 'auto' (seconds, the longer wait; warns when a ":1234"/"O1234"
    // program number suggests Fanuc/Haas milliseconds), 'seconds' or 'milliseconds'
    dwellUnits: 'auto',
    spindleDelaySeconds: 0,                 // spin-up dwell after M3/M4 (preferences.spindleDelay)
};

const ERRORS_KEPT = 200;       // errorCount still counts all of them
const R_SLACK_MM = 0.005;      // an R arc's chord may exceed its diameter by one step (rounding)
const MAX_ARC_RADIUS_MM = 100000;

// Accepted without effect on this machine (verified harmless on the RSP path).
const G_NOOP = new Set([40, 49, 54, 61, 61.1, 64, 80, 94, 98, 99]);
const M_NOOP = new Set([7, 8, 9]);
const TOOL_WORDS_RE = /\b(?:tool|bit|cutter|end ?mill)\b/i;

const PLANES = {
    17: { a: 'x', b: 'y', c: 'z', oa: 'I', ob: 'J', on: 'K', name: 'XY' },
    18: { a: 'z', b: 'x', c: 'y', oa: 'K', ob: 'I', on: 'J', name: 'XZ' },
    19: { a: 'y', b: 'z', c: 'x', oa: 'J', ob: 'K', on: 'I', name: 'YZ' },
};

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
// Letters a line may give only once (RS274NGC). A repeat is how two lines
// folded into one show up, so it must never silently keep the last value.
const ONCE = new Set(['X', 'Y', 'Z', 'I', 'J', 'K', 'R', 'F', 'S', 'T', 'P', 'Q', 'H', 'D', 'L']);

/** Parses one comment-free line into a structured block. Pure; no modal state. */
function parseBlock(code, comment) {
    const b = {
        code, comment, leftover: '',
        g: [], m: [], axis: {}, arc: {}, f: null, s: null, t: null, p: null, pText: null, o: null,
        bad: [], // [message]
    };
    let leftover = '';
    let seen = null;
    WORD_RE.lastIndex = 0;
    let m;
    let last = 0;
    while ((m = WORD_RE.exec(code)) !== null) {
        leftover += code.slice(last, m.index);
        last = WORD_RE.lastIndex;
        const letter = m[1].toUpperCase();
        const value = parseFloat(m[2]);
        if (ONCE.has(letter)) {
            if (!seen) seen = {};
            if (seen[letter] !== undefined) {
                b.bad.push(`${letter} is given twice on this line (${seen[letter]} and ${letter}${m[2]}) -- a line can give each word only once`);
                continue;
            }
            seen[letter] = `${letter}${m[2]}`;
        }
        switch (letter) {
            case 'G': b.g.push(value); break;
            case 'M': b.m.push(value); break;
            case 'X': case 'Y': case 'Z': b.axis[letter.toLowerCase()] = value; break;
            case 'I': case 'J': case 'K': case 'R': b.arc[letter] = value; break;
            case 'F': b.f = value; break;
            case 'S': b.s = value; break;
            case 'T': b.t = value; break;
            case 'P': b.p = value; b.pText = m[2]; break; // G4 dwell (also G64 tolerance, ignored)
            case 'N': break; // line number
            case 'O': b.o = value; break; // program number
            case 'H': case 'Q': case 'L': case 'D': break; // parameters of G43/G64/cycles
            case 'A': case 'B': case 'C': case 'U': case 'V': case 'W':
                b.bad.push(`rotary/extra axis word ${m[0]} is not supported on this 3-axis machine`);
                break;
            default:
                b.bad.push(`word ${m[0]} is not G-code this machine understands (a 3D-printer word, or a number written with an exponent)`);
        }
    }
    leftover += code.slice(last);
    b.leftover = leftover.trim() ? leftover.replace(/\s+/g, '') : '';
    return b;
}

/** Modal group of a G code (RS274NGC), for "two from one group on a line". */
function gGroup(g) {
    if (g === 0 || g === 1 || g === 2 || g === 3 || (g >= 38 && g < 39) || g === 73 || g === 74 || g === 76 || (g >= 81 && g <= 89)) return 'motion';
    if (g === 17 || g === 18 || g === 19) return 'plane';
    if (g === 20 || g === 21) return 'units';
    if (g === 90 || g === 91) return 'distance';
    if (g === 90.1 || g === 91.1) return 'arc distance';
    if (g === 93 || g === 94 || g === 95) return 'feed mode';
    if (g >= 40 && g < 43) return 'cutter compensation';
    if (g === 43 || g === 43.1 || g === 49) return 'tool length';
    if (g >= 54 && g <= 59.3) return 'work offset';
    if (g === 61 || g === 61.1 || g === 64) return 'path control';
    if (g === 98 || g === 99) return 'retract mode';
    if (g === 4 || g === 10 || g === 28 || g === 30 || g === 53 || (g >= 92 && g < 93)) return 'non-modal';
    return null;
}

function mGroup(v) {
    if (v === 0 || v === 1 || v === 2 || v === 30 || v === 60) return 'stop';
    if (v === 3 || v === 4 || v === 5) return 'spindle';
    if (v === 6) return 'tool change';
    return null;
}

/**
 * Calls fn(lineText, fileLine) for every line of `source` (a string or UTF-8
 * bytes). LF, CRLF and a lone CR all end a line; a leading BOM is skipped.
 * Numbering matches text.split(/\r\n|\r|\n/). Returns the number of lines.
 */
function forEachLine(source, fn) {
    if (typeof source === 'string') {
        const s = source;
        const n = s.length;
        let start = n && s.charCodeAt(0) === 0xFEFF ? 1 : 0;
        let lf = s.indexOf('\n', start);
        let cr = s.indexOf('\r', start);
        let lineNo = 0;
        for (;;) {
            if (lf !== -1 && lf < start) lf = s.indexOf('\n', start);
            if (cr !== -1 && cr < start) cr = s.indexOf('\r', start);
            let end;
            let next;
            if (lf === -1 && cr === -1) { end = n; next = -1; } else if (cr === -1 || (lf !== -1 && lf < cr)) { end = lf; next = lf + 1; } else { end = cr; next = lf === cr + 1 ? cr + 2 : cr + 1; }
            lineNo++;
            fn(s.slice(start, end), lineNo);
            if (next === -1) return lineNo;
            start = next;
        }
    }
    const buf = Buffer.isBuffer(source) ? source : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    const n = buf.length;
    let start = n >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? 3 : 0;
    let lf = buf.indexOf(10, start);
    let cr = buf.indexOf(13, start);
    let lineNo = 0;
    for (;;) {
        if (lf !== -1 && lf < start) lf = buf.indexOf(10, start);
        if (cr !== -1 && cr < start) cr = buf.indexOf(13, start);
        let end;
        let next;
        if (lf === -1 && cr === -1) { end = n; next = -1; } else if (cr === -1 || (lf !== -1 && lf < cr)) { end = lf; next = lf + 1; } else { end = cr; next = lf === cr + 1 ? cr + 2 : cr + 1; }
        lineNo++;
        fn(buf.utf8Slice(start, end), lineNo);
        if (next === -1) return lineNo;
        start = next;
    }
}

/** Index of the checksum '*' outside comments, or -1. */
function checksumStar(raw) {
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (depth > 0) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            continue;
        }
        if (ch === '(') depth = 1;
        else if (ch === ';') return -1;
        else if (ch === '*') return i;
    }
    return -1;
}

function newExtents() {
    return { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
}

/**
 * One compile pass over the source.
 * @param {string|Uint8Array} source
 * @param {object} opts  merged options
 * @param {number} rapidFeed
 * @param {number} retractZ  mm used for G53/G28/G30 Z moves in this pass
 */
function compilePass(source, opts, rapidFeed, retractZ) {
    const errors = [];
    let errorCount = 0;
    const warnings = [];
    const pauses = [];
    const dwells = [];
    const tools = [];
    const toolChanges = [];
    const err = (line, msg) => { errorCount++; if (errors.length < ERRORS_KEPT) errors.push({ line, msg }); };
    // The same refusal on thousands of lines (a file with no F at all) is one
    // problem: report its first line and how many more lines have it.
    const errRepeats = new Map();
    const errOnce = (key, line, msg) => {
        const seen = errRepeats.get(key);
        if (seen) { seen.more++; return; }
        const entry = { line, msg };
        errRepeats.set(key, { entry, more: 0 });
        errorCount++;
        if (errors.length < ERRORS_KEPT) errors.push(entry);
    };
    const warnOnce = new Set();
    const warn = (line, msg, key) => {
        if (key && warnOnce.has(key)) return;
        if (key) warnOnce.add(key);
        warnings.push({ line, msg });
    };

    let unitScale = 1;
    let absolute = true;
    let arcAbsolute = false; // G90.1: I/J/K are absolute centre coordinates
    let plane = 17;
    let motion = null; // 0 | 1 | 2 | 3
    let feedMm = null;
    const pos = { x: null, y: null, z: null }; // absolute mm, grid-rounded (what the machine is told)
    const cur = { x: null, y: null, z: null }; // file units, unrounded (where the program says the tool is)
    let cutting = false;
    let programEnd = null;
    let percentOpened = false; // a % line before any code
    let strayPercent = null;   // a % after code in a file that did not open with %
    let g53Count = 0;
    let currentTool = null;
    let pendingSelect = null; // a T word that changed the tool after cutting, not yet confirmed by M6
    let toolChangeSinceCut = false;
    const dwellMs = opts.dwellUnits === 'milliseconds';
    const dwellAuto = !opts.dwellUnits || opts.dwellUnits === 'auto';
    // A ":1234"/"O1234" program number before the first move: the file looks
    // Fanuc/Haas-style, where an integer G4 P is milliseconds. It is only a
    // hint -- Mach3 and LinuxCNC files carry O numbers too, with P in seconds --
    // so 'auto' keeps the longer (seconds) reading and says so.
    let programNumber = null;
    let motionSeen = false;
    let unitsDeclared = null;
    let unitSwitches = 0;
    let movedMm = false;
    let movedInch = false;
    let codeLines = 0;
    const spinUp = Number(opts.spindleDelaySeconds) || 0;
    let pendingSpinUp = 0; // file line of an M3/M4 still waiting for its spin-up dwell

    const ext = newExtents();
    const cutExt = newExtents();
    let motionCount = 0;
    let rapidCount = 0;
    let clampedCount = 0;
    let arcCount = 0;
    let arcSegmentCount = 0;
    let spinUpDwellCount = 0;

    const out = [];
    let map = new Uint32Array(4096);
    let outCount = 0;
    const push = (text, fileLine) => {
        out.push(text);
        if (outCount === map.length) {
            const bigger = new Uint32Array(map.length * 2);
            bigger.set(map);
            map = bigger;
        }
        map[outCount] = fileLine;
        outCount++;
    };

    const emitSpinUp = (fileLine) => {
        // what the inserted "G4 P<delay>" always compiled to: a no-op line the host waits on
        push('G17', fileLine);
        dwells.push({ line: outCount, fileLine, seconds: spinUp, spinUp: true });
        spinUpDwellCount++;
    };
    /** Before the first output of a line: the spin-up dwell of the M3/M4 before it, unless this line dwells itself. */
    const flushSpinUp = (lineDwells) => {
        if (!pendingSpinUp) return;
        if (!lineDwells) emitSpinUp(pendingSpinUp);
        pendingSpinUp = 0;
    };

    function setUnits(g) {
        const s = g === 20 ? MM_PER_INCH : 1;
        if (!motionSeen && unitsDeclared === null) unitsDeclared = `G${g}`;
        if (s === unitScale) return;
        // the program's own position stays the same point, in the new units
        for (const k of AXES) if (cur[k] !== null) cur[k] = (cur[k] * unitScale) / s;
        if (motionSeen) unitSwitches++;
        unitScale = s;
    }

    function noteCut() {
        if (pendingSelect) {
            const p = pendingSelect;
            pendingSelect = null;
            if (opts.toolChangeHolds) {
                toolChanges.push({ line: p.line, fileLine: p.fileLine, tool: p.tool, previousTool: p.previousTool, kind: 'T', message: p.message });
            } else {
                err(p.fileLine, `tool change to T${fmtNum(p.tool)} after cutting has started (a T word with no M6: a manual tool change) is not supported -- split the job into one file per tool`);
            }
        }
        toolChangeSinceCut = false;
    }

    /**
     * One straight move. `words` are file-unit targets per axis (undefined =
     * axis not on the line). Returns false when the move was refused.
     */
    function linearMove(m, words, isAbs, fileLine, spindleWords, trackCur) {
        const prev = { x: pos.x, y: pos.y, z: pos.z };
        const next = { x: pos.x, y: pos.y, z: pos.z };
        let unknownAxis = null;
        for (const k of AXES) {
            const v = words[k];
            if (v === undefined) continue;
            if (isAbs) next[k] = roundGrid(v * unitScale);
            else if (cur[k] === null) unknownAxis = k;
            // G91: from where the PROGRAM says the tool is (unrounded), never
            // from the last grid-rounded target -- rounding each step from the
            // previous rounded one adds the error up (2026-09-17 review:
            // 1000 x "G91 G1 X0.0024" left the machine at X0, 2.4 mm short).
            else next[k] = roundGrid((cur[k] + v) * unitScale);
        }
        if (unknownAxis) {
            err(fileLine, `incremental (G91) move on ${unknownAxis.toUpperCase()} before its absolute position is known`);
            push('G17', fileLine);
            return false;
        }

        let f;
        if (m === 0) {
            f = rapidFeed;
        } else {
            if (feedMm === null) {
                errOnce('no-feed', fileLine, 'cutting move (G1) before any feed rate F is set');
                push('G17', fileLine);
                return false;
            }
            f = feedMm;
        }
        f = Math.min(f, opts.maxFeed);

        // per-axis rate clamp: no single axis faster than its max rate
        let len2 = 0;
        const d = { x: 0, y: 0, z: 0 };
        for (const k of AXES) {
            if (next[k] !== null && prev[k] !== null) d[k] = next[k] - prev[k];
            len2 += d[k] * d[k];
        }
        const len = Math.sqrt(len2);
        let limit = Infinity;
        if (len > 0) {
            for (const k of AXES) {
                if (Math.abs(d[k]) > 1e-9 && opts.maxRate[k] > 0) {
                    limit = Math.min(limit, (opts.maxRate[k] * len) / Math.abs(d[k]));
                }
            }
        }
        // An axis moving from an unknown start (first move on that axis) could be
        // travelling alone at full feed -- cap to that axis's own max rate.
        for (const k of AXES) {
            if (words[k] !== undefined && prev[k] === null && opts.maxRate[k] > 0) {
                limit = Math.min(limit, opts.maxRate[k]);
            }
        }
        if (limit < f) { f = limit; clampedCount++; }
        f = Math.max(f, 1);

        pos.x = next.x;
        pos.y = next.y;
        pos.z = next.z;
        // join(), not +=: a string built with += is a rope of small pieces
        // (~300 B per line instead of ~60), and a million of them held
        // 250 MB while a large file compiled.
        const parts = [m === 0 ? 'G21 G90 G0' : 'G21 G90 G1'];
        if (pos.x !== null) parts.push(`X${fmtMm(pos.x)}`);
        if (pos.y !== null) parts.push(`Y${fmtMm(pos.y)}`);
        if (pos.z !== null) parts.push(`Z${fmtMm(pos.z)}`);
        parts.push(`F${fmtFeed(f)}`);
        for (const w of spindleWords) parts.push(w);
        push(parts.join(' '), fileLine);
        if (trackCur) {
            for (const k of AXES) {
                const v = words[k];
                if (v === undefined) continue;
                cur[k] = isAbs ? v : (cur[k] === null ? null : cur[k] + v);
            }
        }

        for (const k of AXES) {
            if (words[k] === undefined || pos[k] === null) continue;
            if (pos[k] < ext.min[k]) ext.min[k] = pos[k];
            if (pos[k] > ext.max[k]) ext.max[k] = pos[k];
        }
        if (m === 1) {
            for (const k of AXES) {
                if (pos[k] === null) continue;
                if (pos[k] < cutExt.min[k]) cutExt.min[k] = pos[k];
                if (pos[k] > cutExt.max[k]) cutExt.max[k] = pos[k];
            }
        }
        motionCount++;
        motionSeen = true;
        if (unitScale === 1) movedMm = true; else movedInch = true;
        if (m === 0) rapidCount++;
        else if (len > 0) { cutting = true; noteCut(); }
        return true;
    }

    /** G2/G3 in the current plane, as chords through linearMove(). */
    function arcMove(b, fileLine, spindleWords) {
        const P = PLANES[plane];
        const cw = motion === 2;
        const label = `G${motion}`;
        const A = P.a.toUpperCase();
        const B = P.b.toUpperCase();
        const off = b.arc;
        const refuse = (msg) => { err(fileLine, msg); push('G17', fileLine); return false; };
        if (b.p !== null) return refuse(`${label} with P (extra full turns) is not supported`);
        if (off[P.on] !== undefined && off[P.on] !== 0) return refuse(`${P.on}${fmtNum(off[P.on])} on an arc in the ${P.name} plane (G${plane}): ${P.on} is not a centre offset in this plane`);
        const inPlane = b.axis[P.a] !== undefined || b.axis[P.b] !== undefined;
        const hasCentre = off[P.oa] !== undefined || off[P.ob] !== undefined || off.R !== undefined;
        if (!inPlane && !hasCentre) {
            return refuse(`straight move while ${label} arc mode is active: an arc needs ${A}/${B} and ${P.oa}/${P.ob} or R -- write G0 or G1 before a straight move`);
        }
        if (!hasCentre) return refuse(`${label} arc without a centre (${P.oa}/${P.ob}) or a radius (R)`);
        if (cur[P.a] === null || cur[P.b] === null) {
            return refuse(`${label} arc before the tool's ${A}/${B} position is known -- the file must move to ${A} and ${B} (G0/G1) before its first arc`);
        }
        const t = {};
        for (const k of [P.a, P.b, P.c]) {
            const v = b.axis[k];
            if (v === undefined) t[k] = cur[k];
            else if (absolute) t[k] = v;
            else if (cur[k] === null) return refuse(`incremental (G91) arc on ${k.toUpperCase()} before its absolute position is known`);
            else t[k] = cur[k] + v;
        }
        const helical = b.axis[P.c] !== undefined && t[P.c] !== cur[P.c];
        if (helical && cur[P.c] === null) return refuse(`${label} arc changes ${P.c.toUpperCase()} before the ${P.c.toUpperCase()} position is known`);
        const sa = cur[P.a];
        const sb = cur[P.b];
        const ea = t[P.a];
        const eb = t[P.b];
        let ca;
        let cb;
        if (off.R !== undefined) {
            if (off[P.oa] !== undefined || off[P.ob] !== undefined) return refuse(`${label} arc gives both R and ${P.oa}/${P.ob} -- use one or the other`);
            const c = arcCentreFromRadius(sa, sb, ea, eb, off.R, cw, R_SLACK_MM / unitScale);
            if (c.error) return refuse(`${label} ${c.error}`);
            ca = c.cx;
            cb = c.cy;
        } else if (arcAbsolute) {
            if (off[P.oa] === undefined || off[P.ob] === undefined) return refuse(`${label} arc in absolute centre mode (G90.1) needs both ${P.oa} and ${P.ob}`);
            ca = off[P.oa];
            cb = off[P.ob];
        } else {
            ca = sa + (off[P.oa] || 0);
            cb = sb + (off[P.ob] || 0);
        }
        const r0 = Math.hypot(sa - ca, sb - cb);
        const r1 = Math.hypot(ea - ca, eb - cb);
        if (r0 * unitScale < 0.001) return refuse(`${label} arc has no radius (its centre is its start point)`);
        if (r0 * unitScale > MAX_ARC_RADIUS_MM) return refuse(`${label} arc radius ${(r0 * unitScale).toFixed(0)} mm is not a real arc`);
        // grbl/LinuxCNC refuse this too: a centre that is not the same distance
        // from both ends is a damaged file, or absolute I/J written without
        // G90.1 -- sweeping the radius across it cut a spiral far from the design.
        const diffMm = Math.abs(r0 - r1) * unitScale;
        if (diffMm > Math.min(0.5, Math.max(0.05, 0.001 * r0 * unitScale))) {
            return refuse(`${label} arc is not a circle: its start is ${(r0 * unitScale).toFixed(3)} mm from the centre and its end ${(r1 * unitScale).toFixed(3)} mm (radius mismatch). If the post writes ${P.oa}/${P.ob} as absolute centre coordinates the file must say G90.1; otherwise re-export the file`);
        }
        const pts = tessellateArcAround(sa, sb, ea, eb, ca, cb, cw, unitScale);
        const n = pts.length;
        const c0 = cur[P.c];
        const c1 = t[P.c];
        const none = [];
        for (let k = 0; k < n; k++) {
            const w = {};
            // same text the separate arc pass wrote ("G1 X1.2345 Y..."), so
            // existing programs compile to the same wire lines
            w[P.a] = Number(pts[k][0].toFixed(4));
            w[P.b] = Number(pts[k][1].toFixed(4));
            if (helical) w[P.c] = Number((k === n - 1 ? c1 : c0 + ((c1 - c0) * (k + 1)) / n).toFixed(4));
            if (!linearMove(1, w, true, fileLine, k === 0 ? spindleWords : none, false)) return false;
        }
        cur[P.a] = ea;
        cur[P.b] = eb;
        if (b.axis[P.c] !== undefined) cur[P.c] = c1;
        arcCount++;
        arcSegmentCount += n;
        return true;
    }

    function noteProgramNumber(fileLine, code) {
        if (!motionSeen && !programNumber) programNumber = { fileLine, text: code };
    }

    /** Does this block do anything the machine would act on (used after the program end)? */
    function acts(b) {
        if (b.axis.x !== undefined || b.axis.y !== undefined || b.axis.z !== undefined) return true;
        if (b.arc.I !== undefined || b.arc.J !== undefined || b.arc.K !== undefined || b.arc.R !== undefined) return true;
        if (b.t !== null) return true;
        for (const v of b.m) if (v === 0 || v === 1 || v === 3 || v === 4 || v === 6 || v === 98 || v === 99) return true;
        for (const g of b.g) if (g === 4 || g === 10 || g === 28 || g === 30 || g === 53 || (g >= 92 && g < 93)) return true;
        return false;
    }

    function compileLine(raw, code0, comment, fileLine) {
        let code = code0;
        const refuseLine = (msg) => { err(fileLine, msg); flushSpinUp(false); push('G17', fileLine); };

        if (code.charCodeAt(0) === 47) { // '/'
            refuseLine('starts with "/" (block delete). This machine has no block-delete switch, so it cannot tell whether you want this line cut -- remove the "/" to cut it, or delete the line');
            return;
        }
        if (code.indexOf('*') !== -1) {
            const star = code.indexOf('*');
            const cm = /^\*\s*(\d+)$/.exec(code.slice(star));
            const rawStar = checksumStar(raw);
            if (!cm || rawStar === -1) {
                refuseLine(`cannot read "${code}" ("*" is only allowed as a line checksum at the end of a line)`);
                return;
            }
            let cs = 0;
            for (let i = 0; i < rawStar; i++) cs ^= raw.charCodeAt(i) & 0xFF;
            if (cs !== Number(cm[1])) {
                refuseLine(`line checksum *${cm[1]} does not match the line (it should be *${cs}) -- the file is damaged; export or copy it again`);
                return;
            }
            code = code.slice(0, star).trim();
            if (!code) { flushSpinUp(false); push('G17', fileLine); return; }
        }
        if (code.charCodeAt(0) === 58 && /^:\s*\d+$/.test(code)) { // ':'
            // Fanuc/Haas program number (":1248"), a label like "O1248"
            noteProgramNumber(fileLine, code);
            flushSpinUp(false);
            push('G17', fileLine);
            return;
        }
        if (code.indexOf('#') !== -1 || code.indexOf('[') !== -1) {
            refuseLine('#variables and [expressions] are not supported -- post the program with plain numbers');
            return;
        }
        if (/^(?:N\s*\d+\s*)?O\s*(?:\d+|<[^>]*>)/i.test(code) && /\b(?:sub|endsub|call|do|while|endwhile|if|elseif|else|endif|repeat|endrepeat|break|continue|return)\b/i.test(code)) {
            refuseLine('O-word subroutines and program flow (sub/call/if/while/repeat) are not supported -- post the program without subroutines');
            return;
        }

        const b = parseBlock(code, comment);
        if (b.leftover) {
            refuseLine(`cannot read "${code}" (unexpected "${b.leftover.slice(0, 12)}")`);
            return;
        }
        if (b.o !== null && /^(?:N\s*\d+\s*)?O\s*\d+$/i.test(code)) noteProgramNumber(fileLine, code);

        const cutBefore = cutting;
        let lineBlocked = b.bad.length > 0;
        for (const msg of b.bad) err(fileLine, msg);

        if (programEnd && acts(b)) {
            errOnce('after-end', fileLine, `comes after the program end (${programEnd.word} on line ${programEnd.fileLine}). A G-code program stops at ${programEnd.word}, so this is never meant to run -- delete what follows ${programEnd.word}, or remove the ${programEnd.word} if the rest should be cut`);
            flushSpinUp(false);
            push('G17', fileLine);
            return;
        }

        if (b.g.length > 1) {
            const gSeen = new Map();
            for (const g of b.g) {
                const grp = gGroup(g);
                if (!grp) continue;
                if (gSeen.has(grp)) {
                    err(fileLine, `G${fmtNum(gSeen.get(grp))} and G${fmtNum(g)} are in the same group (${grp}) -- one line can only ask for one of them`);
                    lineBlocked = true;
                } else gSeen.set(grp, g);
            }
        }
        if (b.m.length > 1) {
            const mSeen = new Map();
            for (const v of b.m) {
                const grp = mGroup(v);
                if (!grp) continue;
                if (mSeen.has(grp)) {
                    err(fileLine, `M${fmtNum(mSeen.get(grp))} and M${fmtNum(v)} are in the same group (${grp}) -- one line can only ask for one of them`);
                    lineBlocked = true;
                } else mSeen.set(grp, v);
            }
        }

        // --- G words -----------------------------------------------------
        let g53 = false;
        let g28 = 0;
        let dwell = false;
        let blockMotion = null;
        let cycle = false;
        for (const g of b.g) {
            if (g === 0 || g === 1 || g === 2 || g === 3) { motion = g; blockMotion = g; continue; }
            if (g === 20 || g === 21) { setUnits(g); continue; }
            if (g === 90) { absolute = true; continue; }
            if (g === 91) { absolute = false; continue; }
            if (g === 90.1) { arcAbsolute = true; continue; }
            if (g === 91.1) { arcAbsolute = false; continue; }
            if (g === 17 || g === 18 || g === 19) { plane = g; continue; }
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
            if (g === 43) { warn(fileLine, 'G43 tool length offset is ignored (no tool offsets on this machine)', 'g43'); continue; }
            if (G_NOOP.has(g)) continue;
            lineBlocked = true;
            if (g >= 55 && g <= 59.3) { err(fileLine, `G${fmtNum(g)} work offset is not supported (this machine has a single work zero)`); continue; }
            if (g >= 92 && g < 93) { err(fileLine, `G${fmtNum(g)} (coordinate offset) is not supported`); continue; }
            if (g === 10) { err(fileLine, 'G10 (setting work offsets or tool data from the program) is not supported'); continue; }
            if (g === 93) { err(fileLine, 'G93 inverse-time feed is not supported'); continue; }
            if (g === 95) { err(fileLine, 'G95 feed per spindle revolution is not supported'); continue; }
            if (g >= 38 && g < 39) { err(fileLine, `G${fmtNum(g)} probing inside a job is not supported`); continue; }
            if (g >= 41 && g < 43) { err(fileLine, `G${fmtNum(g)} cutter compensation is not supported`); continue; }
            if (g === 73 || g === 74 || g === 76 || (g >= 81 && g <= 89)) { cycle = true; err(fileLine, `G${fmtNum(g)} canned cycle is not supported -- post the drilling as plain G0/G1 moves`); continue; }
            err(fileLine, `G${fmtNum(g)} is not supported`);
        }

        // --- M / S / F --------------------------------------------------------
        const spindleWords = [];
        const otherM = [];
        let pauseM = null;
        let endM = null;
        let hasM6 = false;
        let spindleOn = false;
        for (const mv of b.m) {
            if (mv === 0 || mv === 1) {
                pauseM = mv;
                otherM.push(`M${mv}`);
            } else if (mv === 3 || mv === 4 || mv === 5) {
                spindleWords.push(`M${mv}`);
                if (mv !== 5) spindleOn = true;
            } else if (mv === 6) {
                hasM6 = true;
                otherM.push('M6');
            } else if (mv === 2 || mv === 30) {
                endM = mv;
                otherM.push(`M${mv}`);
            } else if (M_NOOP.has(mv)) {
                // coolant / mist: no output on this machine
            } else if (mv === 98 || mv === 99) {
                err(fileLine, `M${mv} subprogram calls are not supported`);
                lineBlocked = true;
            } else {
                warn(fileLine, `M${fmtNum(mv)} has no effect on this machine`, `m${mv}`);
            }
        }
        if (b.s !== null) spindleWords.push(`S${fmtNum(b.s)}`);

        if (b.f !== null) {
            if (!(b.f > 0)) { err(fileLine, `invalid feed F${fmtNum(b.f)}`); lineBlocked = true; } else feedMm = b.f * unitScale;
        }
        const hasAxis = b.axis.x !== undefined || b.axis.y !== undefined || b.axis.z !== undefined;
        const arcWords = b.arc.I !== undefined || b.arc.J !== undefined || b.arc.K !== undefined || b.arc.R !== undefined;
        const isArc = (motion === 2 || motion === 3) && (hasAxis || arcWords) && !g53 && !(dwell && blockMotion === null);
        if (g53 && (blockMotion === 2 || blockMotion === 3)) {
            err(fileLine, `G${g28 || 53} cannot be combined with an arc on the same line`);
            lineBlocked = true;
        }
        if (arcWords && !isArc && !cycle) {
            const w = ['I', 'J', 'K', 'R'].filter((k) => b.arc[k] !== undefined).map((k) => `${k}${fmtNum(b.arc[k])}`).join(' ');
            err(fileLine, `${w} belongs to an arc, but this line is not a G2/G3 arc`);
            lineBlocked = true;
        }

        // --- tools ------------------------------------------------------------
        let toolChange = null; // after cutting: { kind, tool, previousTool }
        let selectAfterCut = false;
        let m6Tool = null; // the tool an M6 loads: its own T, else the last T selected
        if (hasM6) {
            const selected = b.t !== null ? b.t : (pendingSelect ? pendingSelect.tool : currentTool);
            m6Tool = selected;
            const previous = pendingSelect ? pendingSelect.previousTool : currentTool;
            pendingSelect = null;
            if (cutting) {
                toolChangeSinceCut = true;
                if (opts.toolChangeHolds) {
                    toolChange = { kind: 'M6', tool: selected, previousTool: previous };
                } else {
                    err(fileLine, `tool change M6${b.t !== null ? ` (T${fmtNum(b.t)})` : ''} after cutting has started is not supported -- split the job into one file per tool`);
                    lineBlocked = true;
                }
            }
            if (selected !== null) currentTool = selected;
        } else if (b.t !== null) {
            if (cutting && b.t !== currentTool) {
                selectAfterCut = true;
                toolChangeSinceCut = true;
                pendingSelect = { line: 0, fileLine, tool: b.t, previousTool: currentTool, message: comment ? String(comment).replace(/^\s*MSG\s*,?\s*/i, '') : '' };
            }
            currentTool = b.t;
        }

        // --- G4 dwell -----------------------------------------------------------
        let seconds = null;
        if (dwell) {
            const pDecimal = b.pText !== null && b.pText.indexOf('.') !== -1;
            if (b.p !== null) {
                if (hasAxis && blockMotion === null) {
                    err(fileLine, 'G4 dwell with X/Y/Z words besides P -- put the dwell and the move on separate lines');
                    lineBlocked = true;
                } else if (b.p < 0) {
                    err(fileLine, `G4 dwell time P${b.pText} is negative`);
                    lineBlocked = true;
                } else if (dwellMs && !pDecimal) {
                    seconds = b.p / 1000;
                    warn(fileLine, `G4 P${b.pText} read as ${b.pText} milliseconds (${fmtNum(seconds)} s): dwell units are set to milliseconds`, 'g4-ms-dialect');
                } else {
                    seconds = b.p;
                    // Dialects disagree: grbl/LinuxCNC (what this machine speaks,
                    // and what Vectric/Buildbotics posts write) read P as SECONDS;
                    // Fanuc/Mach3-style posts write milliseconds. A whole number
                    // of 10 or more is far more likely to be milliseconds than a
                    // real pause that long, so say so instead of silently parking
                    // the machine with the spindle running. Guessing milliseconds
                    // instead would cut a spin-up wait 1000x short and plunge
                    // into the stock before the spindle is at speed.
                    if (!pDecimal && dwellAuto && programNumber) {
                        warn(fileLine, `G4 P${b.pText} is read as ${b.pText} SECONDS. This file looks Fanuc/Haas-style (program number "${programNumber.text}" on line ${programNumber.fileLine}), where it would mean ${b.pText} milliseconds (${fmtNum(b.p / 1000)} s). The longer wait is used so the spindle is never rushed -- press Resume to skip a wait while it runs, or post the dwell in seconds (G4 P${fmtNum(b.p / 1000)})`, 'g4-fanuc');
                    } else if (!pDecimal && seconds >= 10) {
                        warn(fileLine, `G4 dwell of ${fmtNum(seconds)} is read as ${fmtNum(seconds)} SECONDS (${(seconds / 60).toFixed(1)} min). If your post writes milliseconds, this pause is 1000x longer than intended -- you can skip it from the pause banner`, 'g4-ms');
                    }
                }
            } else if (b.axis.x !== undefined && b.axis.y === undefined && b.axis.z === undefined && blockMotion === null) {
                // A G4 line is a dwell, never a move. Its time is P seconds, or on
                // Fanuc/Haas posts X seconds -- and X on a dwell line is NOT a
                // coordinate. Reading it as one turned "G4 X2.5" (wait 2.5 s) into
                // a cutting move to X2.5, ploughing across the work at depth.
                if (b.axis.x < 0) {
                    err(fileLine, `G4 dwell time X${fmtNum(b.axis.x)} is negative`);
                    lineBlocked = true;
                } else {
                    seconds = b.axis.x;
                    warn(fileLine, `G4 X${fmtNum(b.axis.x)} read as a ${fmtNum(b.axis.x)} second dwell (X is the dwell time on a G4 line, not a position)`, 'g4-x');
                }
            } else if (b.s !== null && !hasAxis) {
                err(fileLine, `G4 S${fmtNum(b.s)}: S is a dwell time only in 3D-printer G-code; on a CNC it is the spindle speed -- write the dwell as G4 P<seconds>`);
                lineBlocked = true;
            } else if (hasAxis) {
                err(fileLine, 'G4 dwell and a move on the same line -- put the dwell and the move on separate lines');
                lineBlocked = true;
            } else {
                warn(fileLine, 'G4 dwell without a time (P or X) is ignored', 'g4-nop');
            }
            if (seconds !== null && seconds > 3600) {
                err(fileLine, `G4 dwell of ${fmtNum(seconds)} s is longer than an hour -- the dwell time is in seconds on this machine. If the post wrote milliseconds, post the dwell in seconds (G4 P${fmtNum(seconds / 1000)})`);
                lineBlocked = true;
            }
        }
        if (spindleOn && spinUp > 3600) {
            err(fileLine, `the spindle spin-up delay of ${fmtNum(spinUp)} s is longer than an hour`);
            lineBlocked = true;
        }

        if (lineBlocked) {
            flushSpinUp(dwell);
            push('G17', fileLine);
            return;
        }

        const firstOut = () => outCount + 1;
        let holdLine = 0;
        // RS274NGC starts the spindle before the motion of its line, so the
        // spin-up wait goes between the two. Emitted after the line's motion
        // it let "G1 Z-1 F300 M3 S10000" plunge into the stock and wait there.
        let spinUpDone = false;
        const spinUpBeforeMotion = () => {
            if (!spindleOn || !(spinUp > 0) || spinUpDone) return;
            push(spindleWords.join(' '), fileLine);
            emitSpinUp(fileLine);
            spindleWords.length = 0;
            spinUpDone = true;
        };
        const recordToolsAndPauses = (toolLine) => {
            const lastLine = outCount;
            if (hasM6) {
                tools.push({ line: toolLine, fileLine, tool: m6Tool, afterCutting: cutBefore, comment });
                if (toolChange) toolChanges.push({ line: toolLine, fileLine, ...toolChange, message: comment ? String(comment).replace(/^\s*MSG\s*,?\s*/i, '') : '' });
            } else if (b.t !== null) {
                tools.push({ line: toolLine, fileLine, tool: b.t, afterCutting: cutBefore, comment, selectOnly: true });
                if (selectAfterCut && pendingSelect && pendingSelect.fileLine === fileLine) pendingSelect.line = toolLine;
            }
            if (pauseM !== null) {
                // "(MSG, Click 'Continue' when ...)" -> "Click 'Continue' when ..."
                const message = String(comment || '').replace(/^\s*MSG\s*,?\s*/i, '');
                pauses.push({
                    line: lastLine, fileLine, optional: pauseM === 1, message,
                    afterCutting: cutting, toolChange: TOOL_WORDS_RE.test(message) || (cutting && toolChangeSinceCut),
                });
            }
            if (endM !== null && !programEnd) programEnd = { line: lastLine, fileLine, word: `M${endM}` };
            // a line without motion: the wait comes before the next line (skipped when that line dwells)
            if (spindleOn && spinUp > 0 && !spinUpDone) pendingSpinUp = fileLine;
        };

        // --- dwell line (and "G4 P1 G1 X10": the dwell first, then the move) ----
        if (dwell) {
            flushSpinUp(true);
            if (blockMotion === null) {
                const parts = [...otherM, ...spindleWords];
                push(parts.length ? parts.join(' ') : 'G17', fileLine);
                if (seconds > 0) dwells.push({ line: outCount, fileLine, seconds });
                recordToolsAndPauses(outCount);
                return;
            }
            push(spindleWords.length ? spindleWords.join(' ') : 'G17', fileLine);
            if (seconds > 0) dwells.push({ line: outCount, fileLine, seconds });
            spindleWords.length = 0;
            // the spindle words went out on the dwell line; its spin-up wait still precedes the move
            if (spindleOn && spinUp > 0) { emitSpinUp(fileLine); spinUpDone = true; }
        }

        // A bare G28/G30 ("retract to the reference position") carries no axis
        // word at all, so it has to be handled before the no-axis shortcut.
        if (!hasAxis && !arcWords && !g28) {
            flushSpinUp(false);
            const parts = [];
            if (b.t !== null) parts.push(`T${fmtNum(b.t)}`);
            parts.push(...otherM, ...spindleWords);
            push(parts.length ? parts.join(' ') : 'G17', fileLine);
            recordToolsAndPauses(outCount);
            return;
        }

        flushSpinUp(dwell);
        const first = firstOut();
        // A tool change the controller holds at must come BEFORE the move on its line.
        if ((toolChange || selectAfterCut) && opts.toolChangeHolds) {
            push(`${b.t !== null ? `T${fmtNum(b.t)}` : ''}${b.t !== null && hasM6 ? ' ' : ''}${hasM6 ? 'M6' : ''}`, fileLine);
            holdLine = outCount;
            if (selectAfterCut && pendingSelect && pendingSelect.fileLine === fileLine) pendingSelect.line = holdLine;
            const i6 = otherM.indexOf('M6');
            if (i6 !== -1) otherM.splice(i6, 1);
        }

        // --- G53 / G28 / G30: no machine coordinates here -> safe Z retract
        if (g53) {
            const what = g28 ? `G${g28}` : 'G53';
            if (b.axis.x !== undefined || b.axis.y !== undefined) {
                warn(fileLine, `${what} X/Y move ignored -- this machine has no reference position, only a safe Z retract is performed`, 'g53xy');
            }
            if (g28) {
                // Its axis words are the intermediate point, not a target, and
                // the destination is a machine home this machine does not have.
                warn(fileLine, `${what} retracts Z to the safe height instead of a machine home position`, `g${g28}`);
            } else if (b.axis.z === undefined) {
                const parts = [...otherM, ...spindleWords];
                push(parts.length ? parts.join(' ') : 'G17', fileLine);
                recordToolsAndPauses(holdLine || outCount);
                return;
            }
            // tool change, then spindle start and its wait, then the motion (RS274NGC order)
            spinUpBeforeMotion();
            g53Count++;
            pos.z = retractZ; // subsequent XY-only lines must carry the retract height, never an old depth
            cur.z = retractZ / unitScale;
            const zRate = opts.maxRate.z > 0 ? Math.min(rapidFeed, opts.maxRate.z) : rapidFeed;
            const parts = ['G21 G90 G0'];
            if (pos.x !== null) parts.push(`X${fmtMm(pos.x)}`);
            if (pos.y !== null) parts.push(`Y${fmtMm(pos.y)}`);
            parts.push(`Z${fmtMm(pos.z)}`, `F${fmtFeed(zRate)}`, ...spindleWords);
            push(parts.join(' '), fileLine);
            motionCount++;
            rapidCount++;
            motionSeen = true;
            if (unitScale === 1) movedMm = true; else movedInch = true;
            recordToolsAndPauses(holdLine || outCount);
            return;
        }

        spinUpBeforeMotion();
        let ok;
        if (isArc) {
            ok = arcMove(b, fileLine, spindleWords);
        } else {
            let m = motion;
            if (m === null) {
                m = feedMm !== null ? 1 : 0;
                warn(fileLine, `move without G0/G1 before it -- treated as G${m}`, 'nomotionmode');
            }
            ok = linearMove(m, b.axis, absolute, fileLine, spindleWords, true);
        }
        if (!ok) return;
        if (otherM.length) {
            // M0/M6/M2 sharing a line with motion: firmware ignores them there; host acts after the move
            warn(fileLine, `${otherM.join(' ')} on a motion line is handled after the move`, `mixedm-${otherM.join('')}`);
        }
        recordToolsAndPauses(holdLine || first);
    }

    const fileLineCount = forEachLine(source, (raw, fileLine) => {
        let code;
        let comment;
        if (raw.indexOf('(') === -1 && raw.indexOf(';') === -1 && raw.indexOf(')') === -1) {
            code = raw.trim();
            comment = '';
        } else {
            ({ code, comment } = splitComment(raw));
        }
        if (!code) return;
        if (code.charCodeAt(0) === 37) { // '%'
            // A % before any code opens the program and the next one closes it.
            // In a file that did not open with %, a % after code ends the
            // program only when no code follows it ("G21" above an opening %
            // must not turn the whole program into "after the end").
            if (codeLines === 0) percentOpened = true;
            else if (!programEnd) {
                if (percentOpened) programEnd = { line: outCount, fileLine, word: '%' };
                else if (!strayPercent) strayPercent = { line: outCount, fileLine, word: '%' };
            }
            return;
        }
        if (strayPercent) {
            warn(strayPercent.fileLine, `"%" after code is ignored: the file does not start with "%" and the program goes on at line ${fileLine}`, 'stray-percent');
            strayPercent = null;
        }
        codeLines++;
        compileLine(raw, code, comment, fileLine);
    });
    if (strayPercent && !programEnd) programEnd = strayPercent;
    if (pendingSpinUp) emitSpinUp(pendingSpinUp);
    for (const { entry, more } of errRepeats.values()) {
        if (more > 0) entry.msg += ` (and ${more} more line${more === 1 ? '' : 's'} like it)`;
    }

    return {
        out, map: map.slice(0, outCount), lineCount: outCount, fileLineCount,
        errors, errorCount, warnings, pauses, dwells, tools, toolChanges, programEnd,
        ext, cutExt, motionCount, rapidCount, clampedCount, g53Count, arcCount, arcSegmentCount, spinUpDwellCount,
        units: { declared: unitsDeclared, program: movedMm && movedInch ? 'mixed' : (movedInch ? 'inch' : (movedMm ? 'mm' : (unitsDeclared === 'G20' ? 'inch' : 'mm'))), switches: unitSwitches },
        dialect: {
            dwellP: dwellMs ? 'milliseconds' : 'seconds',
            reason: dwellMs ? 'dwell units set to milliseconds' : (programNumber && dwellAuto
                ? `grbl/LinuxCNC seconds (the longer wait), although program number "${programNumber.text}" on line ${programNumber.fileLine} looks Fanuc/Haas-style`
                : 'grbl/LinuxCNC default'),
            programNumber,
        },
    };
}

function finiteExtents(e) {
    const fin = (v) => (Number.isFinite(v) ? v : null);
    if (![e.max.x, e.max.y, e.max.z].some(Number.isFinite)) return null;
    return {
        min: { x: fin(e.min.x), y: fin(e.min.y), z: fin(e.min.z) },
        max: { x: fin(e.max.x), y: fin(e.max.y), z: fin(e.max.z) },
    };
}

/**
 * Where the design's zero sits, from its cutting moves (all moves when it has
 * none): per axis 'min' (zero at the left/front edge), 'max', 'center' or
 * 'other'; xy combines them ('lower-left', 'center', ...); z is 'top' when
 * the cuts go below zero (zero on the stock top), 'bottom' when they never do.
 */
function originHints(cutExtents, extents) {
    const e = cutExtents || extents;
    if (!e) return null;
    const axis = (k) => {
        const lo = e.min[k];
        const hi = e.max[k];
        if (lo === null || hi === null) return null;
        const size = hi - lo;
        const tol = Math.max(1, 0.05 * size);
        if (Math.abs(lo) <= tol && hi > tol) return 'min';
        if (Math.abs(hi) <= tol && lo < -tol) return 'max';
        if (lo < 0 && hi > 0 && Math.abs(lo + hi) <= 0.1 * size) return 'center';
        return 'other';
    };
    const x = axis('x');
    const y = axis('y');
    const names = { 'min,min': 'lower-left', 'max,min': 'lower-right', 'min,max': 'upper-left', 'max,max': 'upper-right', 'center,center': 'center' };
    const xy = x && y ? (names[`${x},${y}`] || 'other') : null;
    const z = e.min.z === null ? null : (e.min.z < -0.05 ? 'top' : 'bottom');
    return { x, y, xy, z, from: e === cutExtents ? 'cutting moves' : 'all moves' };
}

/**
 * @param {string|Uint8Array} source  the ORIGINAL program (G2/G3 included), as text or UTF-8 bytes
 * @param {object} [options] see DEFAULTS
 * @returns {{ lines: string[], feedLimitedLines: Uint8Array|null, meta: object }}
 */
function compileProgram(source, options = {}) {
    const opts = { ...DEFAULTS, ...options, maxRate: { ...DEFAULTS.maxRate, ...(options.maxRate || {}) } };
    const rapidFeed = Math.min(Number(opts.rapidFeed) || DEFAULTS.rapidFeed, opts.maxFeed);
    const safeHeight = Number(opts.safeHeight) || 0;
    const headroom = (opts.zHeadroom !== null && opts.zHeadroom !== undefined && Number.isFinite(Number(opts.zHeadroom)))
        ? Number(opts.zHeadroom) : null;

    // Pass 1 finds the program's own highest Z; the G53/G28/G30 retract goes
    // at least that high. Only a program that retracts AND reaches above the
    // safe height is compiled a second time (pass 1's output is dropped first).
    let pass = compilePass(source, opts, rapidFeed, roundGrid(safeHeight));
    const fileMaxZ = pass.ext.max.z === -Infinity ? 0 : pass.ext.max.z;
    let retractZ = Math.max(fileMaxZ, safeHeight);
    if (headroom !== null) retractZ = Math.min(retractZ, headroom - 2);
    retractZ = roundGrid(retractZ);
    if (pass.g53Count > 0 && retractZ !== roundGrid(safeHeight)) {
        pass = null;
        pass = compilePass(source, opts, rapidFeed, retractZ);
    }

    const errors = pass.errors;
    let errorCount = pass.errorCount;
    const addError = (line, msg) => { errorCount++; if (errors.length < ERRORS_KEPT) errors.push({ line, msg }); };
    const warnings = pass.warnings;
    if (headroom !== null && fileMaxZ > headroom) {
        addError(null, `program goes up to Z ${fileMaxZ.toFixed(2)} mm but the machine only has ${headroom.toFixed(2)} mm of Z travel above work zero`);
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
    const map = pass.map;
    for (let i = 0; i < out.length; i++) {
        const l = out[i];
        if (l.length > MAX_WIRE_LEN) addError(map[i], `compiled line is ${l.length} bytes, over the ${MAX_WIRE_LEN}-byte firmware limit: ${l}`);
        if (/0[xX]|G0*[23](?![0-9])/i.test(l)) addError(map[i], `compiled line contains a hex-like pattern or an arc: ${l}`);
        // job.js re-cleans the lines it streams (cleanGcodeLines): none may vanish there
        if (!l || l.charCodeAt(0) === 37 || l.indexOf('(') !== -1 || l.indexOf(';') !== -1) addError(map[i], `internal: compiled line would be dropped by the job cleaner: "${l}"`);
    }
    if (pass.motionCount === 0) addError(null, 'program contains no motion');

    const extents = finiteExtents(pass.ext);
    const cutExtents = finiteExtents(pass.cutExt);
    return {
        lines: out,
        // [i] = 1 when line i+1's feed was lowered by the motion limit; the
        // feed override must not raise those lines again (job.js)
        feedLimitedLines,
        meta: {
            lineCount: out.length,
            fileLineCount: pass.fileLineCount,
            // [i] = file line (1-based) of compiled line i+1
            sourceLines: map,
            motionCount: pass.motionCount,
            rapidCount: pass.rapidCount,
            clampedCount: pass.clampedCount,
            motionLimitedCount,
            arcCount: pass.arcCount,
            arcSegmentCount: pass.arcSegmentCount,
            spinUpDwellCount: pass.spinUpDwellCount,
            errorCount,
            errors: errors.slice(0, opts.maxErrors),
            warnings,
            pauses: pass.pauses,
            dwells: pass.dwells,
            tools: pass.tools,
            toolChanges: pass.toolChanges,
            programEnd: pass.programEnd,
            usesSpindle: out.some((l) => /\bM[34]\b/.test(l)),
            extents,
            cutExtents,
            units: pass.units,
            origin: originHints(cutExtents, extents),
            dialect: pass.dialect,
            retractZ: pass.g53Count > 0 ? retractZ : null,
            options: {
                rapidFeed, maxFeed: opts.maxFeed, maxRate: opts.maxRate, safeHeight, zHeadroom: headroom, motionLimit: ml || null,
                toolChangeHolds: !!opts.toolChangeHolds, dwellUnits: opts.dwellUnits || 'auto', spindleDelaySeconds: Number(opts.spindleDelaySeconds) || 0,
            },
        },
    };
}

/**
 * @param {string} text  the program (arcs included -- they are converted here)
 * @param {object} [options] see DEFAULTS
 * @returns {{ lines: string[], text: string, feedLimitedLines: Uint8Array|null, meta: object }}
 */
function compileWire(text, options = {}) {
    const src = (typeof text === 'string' || text instanceof Uint8Array) ? text : String(text || '');
    const r = compileProgram(src, options);
    const joined = r.lines.join('\n');
    // The caller keeps both. Lines re-cut from the one flat text are slices of
    // it (~32 B each); the feed limiter's rewritten lines are ropes of pieces
    // (~250 B each) -- 250 MB kept for a 1M-line file whose feeds were limited.
    const lines = r.lines.length ? joined.split('\n') : [];
    return { lines, text: joined, feedLimitedLines: r.feedLimitedLines, meta: r.meta };
}

module.exports = { compileWire, compileProgram, forEachLine, roundGrid, parseBlock, GRID_MM, STEPS_PER_MM, MAX_WIRE_LEN, DEFAULTS };
