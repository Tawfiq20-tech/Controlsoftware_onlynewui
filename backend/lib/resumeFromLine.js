'use strict';

/**
 * Builds a safe "start from line N" program for the RSP firmware.
 *
 * The old frontend version (StartFromLine.tsx) prepended
 * `G53 G0 Z-<safe>` BEFORE the units line, so on a machine still in G20 from
 * the previous run it became a 10 inch (254 mm) plunge (Tawfiq's 2026-09-15
 * DRAGON ROUGH log: Z went to -254.000 on restart). RSP firmware has no G53 /
 * machine coordinates and no WCS -- every axis word is just a move in the
 * current units -- so this rebuilds the modal state and the start position
 * exactly the way easycnc_protocol.c parse_gcode_text() tracks them:
 *   - G20/G21 scale every X/Y/Z/F word on that line (whole line, any order)
 *   - G90/G91 decide absolute vs incremental
 *   - every line with an X/Y/Z word is a move (G53/G28/G92 are NOT special)
 *   - F only takes effect when it rides on a motion line (last_feed is
 *     updated from the executed move, a bare "F500" line is dropped)
 *
 * Program shape (all in the file's own units, work coordinates):
 *   <units> G90            restore units + absolute mode first
 *   G0 Z<retract>          lift to safe height ABOVE the work zero
 *   G0 X<sx> Y<sy>         travel to where line N starts
 *   M3 S<rpm>              if the spindle was on at line N
 *   G1 Z<sz> F<plunge>     plunge back to line N's start depth, slowly
 *   G1 Z<sz> F<feed>       zero-length move -- re-arms the cutting feed
 *   ...line N onwards
 *
 * When the tool already stands at line N's X/Y (after a Stop it is exactly
 * there), the lift and the travel are left out: it goes straight down to <sz>
 * with the same slow plunge, rises straight to it, or stays where it is.
 */

const MM_PER_INCH = 25.4;
// How close the current X/Y (and Z) must be to line N's start to count as "there".
const AT_START_TOL_MM = 0.01;

/**
 * Splits one raw line into executable code and comment text.
 * Parenthesised comments may nest -- Vectric writes "(Onefinity Redline (inch))";
 * a flat /\([^)]*\)/ strip left a stray ")" that was streamed as a job line.
 * An unclosed "(" comments out the rest of the line; ";" starts a comment
 * outside parentheses.
 */
function splitComment(line) {
    let code = '';
    let comment = '';
    let depth = 0;
    const s = String(line);
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (depth === 0) {
            if (ch === '(') { depth = 1; code += ' '; continue; }
            if (ch === ';') { comment += (comment ? ' ' : '') + s.slice(i + 1).trim(); break; }
            if (ch === ')') { code += ' '; continue; } // stray closer: ignore
            code += ch;
        } else {
            if (ch === '(') { depth++; comment += ch; continue; }
            if (ch === ')') {
                depth--;
                comment += depth === 0 ? ' ' : ch;
                continue;
            }
            comment += ch;
        }
    }
    return { code: code.trim(), comment: comment.replace(/\s+/g, ' ').trim() };
}

/**
 * Same cleaning JobStream.upload() applies, so line numbers match exactly.
 * Any line ending counts -- LF, CRLF or a lone CR (old Mac editors). When this
 * split on LF only, a CR-only program was one line and the whole job ran as a
 * single move (2026-09-17 dialect audit D4-5).
 */
function cleanGcodeLines(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r\n|\r|\n/)) {
        const { code } = splitComment(raw);
        if (code && !code.startsWith('%')) out.push(code);
    }
    return out;
}

function words(line) {
    const out = [];
    const re = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
    let m;
    while ((m = re.exec(line)) !== null) {
        out.push({ letter: m[1].toUpperCase(), value: parseFloat(m[2]) });
    }
    return out;
}

function fmt(v) {
    return Number(v.toFixed(4)).toString();
}

/** Round to the 1/200 mm step grid (see lib/wireCompiler.js). */
function grid(v) {
    const r = Math.round(v * 200) / 200;
    return Object.is(r, -0) ? 0 : r;
}

/** Grid-rounded millimetres as wire text, e.g. "-3.100". */
function mm(v) {
    const s = grid(v).toFixed(3);
    return s === '-0.000' ? '0.000' : s;
}

/**
 * Replays lines[0 .. targetLine-2] and returns the machine's modal state and
 * position (in mm, or null for an axis never commanded) right before line
 * `targetLine` (1-based) runs.
 */
function scanModalState(lines, targetLine) {
    const st = {
        unitScale: 1,          // mm per file unit (25.4 in G20)
        absolute: true,
        pos: { x: null, y: null, z: null }, // mm
        feedMm: null,          // mm/min of the last executed motion line
        spindle: 'M5',
        spindleSpeed: null,
    };
    const end = Math.min(targetLine - 1, lines.length);
    for (let i = 0; i < end; i++) {
        const ws = words(lines[i]);
        for (const w of ws) {
            if (w.letter === 'G') {
                if (w.value === 20) st.unitScale = MM_PER_INCH;
                else if (w.value === 21) st.unitScale = 1;
                else if (w.value === 90) st.absolute = true;
                else if (w.value === 91) st.absolute = false;
            } else if (w.letter === 'M') {
                if (w.value === 3) st.spindle = 'M3';
                else if (w.value === 4) st.spindle = 'M4';
                else if (w.value === 5) st.spindle = 'M5';
            } else if (w.letter === 'S') {
                st.spindleSpeed = w.value;
            }
        }
        let sawAxis = false;
        let feed = null;
        for (const w of ws) {
            const mm = w.value * st.unitScale;
            if (w.letter === 'X' || w.letter === 'Y' || w.letter === 'Z') {
                const k = w.letter.toLowerCase();
                if (st.absolute) st.pos[k] = mm;
                else st.pos[k] = (st.pos[k] === null ? null : st.pos[k] + mm);
                sawAxis = true;
            } else if (w.letter === 'F') {
                feed = mm;
            }
        }
        if (sawAxis && feed !== null && feed > 0) st.feedMm = feed;
    }
    return st;
}

function finiteOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {string[]} lines  cleaned job lines (cleanGcodeLines)
 * @param {number} targetLine 1-based line to resume at
 * @param {{safeZMm?: number, plungeFeedMm?: number, currentXMm?: number,
 *          currentYMm?: number, currentZMm?: number}} [opts]
 *   currentX/Y/ZMm: where the tool is now, in the same work coordinates.
 *   Pass X/Y only when that position is exact and the machine is still.
 * @returns {{ok: true, preamble: string[], program: string[], lineOffset: number,
 *            units: string, startMm: {x:number,y:number,z:number|null},
 *            retractMm: number, inPlace: boolean, inPlaceZ: 'lower'|'raise'|'none'|null,
 *            warnings: string[]} | {ok: false, error: string}}
 *   inPlace: the tool is already at line N's X/Y -- no lift, no travel;
 *   inPlaceZ says what Z does then, and retractMm is the current Z.
 */
function buildResumeProgram(lines, targetLine, opts = {}) {
    const total = lines.length;
    const line = Math.floor(Number(targetLine));
    if (!total) return { ok: false, error: 'No G-code is loaded.' };
    if (!(line >= 1 && line <= total)) {
        return { ok: false, error: `Line ${targetLine} is outside the file (1-${total}).` };
    }

    const st = scanModalState(lines, line);
    const warnings = [];

    if (!st.absolute) {
        return { ok: false, error: `Line ${line} runs in incremental mode (G91) -- the start position can't be recomputed safely. Pick a line in absolute (G90) mode.` };
    }
    if (st.pos.x === null || st.pos.y === null) {
        return { ok: false, error: `No X/Y move happens before line ${line}, so its start position is unknown. Start from an earlier line.` };
    }

    const safeZMm = Math.min(Math.max(Number(opts.safeZMm) || 5, 1), 100);
    let retractMm = Math.max(safeZMm, st.pos.z === null ? safeZMm : st.pos.z);
    // Travel at least as high as the file's OWN clearance plane. The safe
    // height is a setting (10 mm by default) and says nothing about this job:
    // on 20 mm stock, or with the file rapiding at Z+15 between passes, a
    // traverse at 10 mm goes straight through the workpiece. The file never
    // goes above its own maximum Z, so that height is always clear.
    const fileMaxZ = Number(opts.fileMaxZMm);
    if (Number.isFinite(fileMaxZ)) retractMm = Math.max(retractMm, fileMaxZ);
    const headroom = Number(opts.zHeadroomMm);
    if (Number.isFinite(headroom) && headroom > 2) retractMm = Math.min(retractMm, headroom - 2);
    retractMm = grid(retractMm);
    // The first move of a resume must never go DOWN. If the tool is parked
    // higher than the safe height (after a stop the operator jogged up, or the
    // file's own retract is higher), dropping it to the safe height first is a
    // blind descent over whatever is on the table -- clamps, the workpiece, a
    // vice. Stay where it is and travel from there.
    const curZ = Number(opts.currentZMm);
    if (Number.isFinite(curZ) && curZ > retractMm) retractMm = grid(curZ);
    const rapid = Math.max(Number(opts.rapidFeedMm) || 3000, 1);
    const zRate = Math.max(Math.min(rapid, Number(opts.zRateMm) || 3000), 1);
    // The XY traverse gets the same per-axis limit every compiled line gets.
    // It was the one move in the program written at the raw rapid feed, so on
    // a machine whose X or Y maximum is below that, the resume asked for a
    // speed the machine cannot do -- exactly the kind of command that trips a
    // driver.
    const xyRate = Math.max(1, Math.min(
        rapid,
        Number(opts.xRateMm) > 0 ? Number(opts.xRateMm) : rapid,
        Number(opts.yRateMm) > 0 ? Number(opts.yRateMm) : rapid,
    ));

    // Preamble is always absolute G21 on the 0.005 mm step grid with an explicit
    // F on every move (same wire rules as lib/wireCompiler.js): the firmware's
    // own parse-time feed and hex-float handling can never change what it does.
    const x = mm(st.pos.x);
    const y = mm(st.pos.y);

    // Already standing on line N's start: the lift to the clearance height
    // (38 mm on the 2026-09-17 SHIP roughing file) and the travel back to
    // the same X/Y were pure extra Z motion followed by a slow plunge. Only
    // with a known resume depth -- without one the old program lifts to safe
    // height, which is still the right call.
    const cur = { x: finiteOrNull(opts.currentXMm), y: finiteOrNull(opts.currentYMm), z: finiteOrNull(opts.currentZMm) };
    const inPlace = st.pos.z !== null && cur.x !== null && cur.y !== null && cur.z !== null &&
        Math.abs(cur.x - grid(st.pos.x)) <= AT_START_TOL_MM && Math.abs(cur.y - grid(st.pos.y)) <= AT_START_TOL_MM;
    let inPlaceZ = null;
    if (inPlace) {
        const dz = cur.z - grid(st.pos.z);
        inPlaceZ = dz > AT_START_TOL_MM ? 'lower' : (dz < -AT_START_TOL_MM ? 'raise' : 'none');
        retractMm = grid(cur.z);
    }

    const preamble = ['G21 G90'];
    if (!inPlace) {
        preamble.push(
            `G21 G90 G0 Z${mm(retractMm)} F${fmt(zRate)}`, // Z first, wherever X/Y are now
            `G21 G90 G0 X${x} Y${y} Z${mm(retractMm)} F${fmt(xyRate)}`,
        );
    } else if (inPlaceZ === 'raise') {
        // Below line N's start (stopped part-way down a plunge): straight up
        // the way it came, at the lift's rate -- the first part of the lift
        // the full program would make, no further.
        preamble.push(`G21 G90 G0 X${x} Y${y} Z${mm(st.pos.z)} F${fmt(zRate)}`);
    }
    if (st.spindle === 'M3' || st.spindle === 'M4') {
        preamble.push(st.spindleSpeed !== null ? `${st.spindle} S${fmt(st.spindleSpeed)}` : st.spindle);
    }
    if (st.pos.z !== null) {
        const cutFeedMm = st.feedMm !== null ? st.feedMm : 300;
        const plungeMm = Math.min(Math.max(Number(opts.plungeFeedMm) || Math.min(cutFeedMm, 300), 10), 10000);
        const plunges = !inPlace || inPlaceZ === 'lower';
        if (plunges) {
            preamble.push(`G21 G90 G1 X${x} Y${y} Z${mm(st.pos.z)} F${fmt(Math.min(plungeMm, zRate))}`);
        }
        if (st.feedMm !== null) preamble.push(`G21 G90 G1 X${x} Y${y} Z${mm(st.pos.z)} F${fmt(st.feedMm)}`);
        else warnings.push(`No feed rate was set before this line -- the machine keeps ${plunges ? 'the plunge feed' : 'its last feed'} until the file sets F again.`);
    } else {
        warnings.push('No Z move happens before this line -- Z stays at safe height until the file moves it.');
    }
    const units = 'G21';

    const program = preamble.concat(lines.slice(line - 1));
    return {
        ok: true,
        preamble,
        program,
        // job line L (1-based, in `program`) is file line L + lineOffset
        lineOffset: (line - 1) - preamble.length,
        units,
        startMm: { x: st.pos.x, y: st.pos.y, z: st.pos.z },
        retractMm,
        inPlace,
        inPlaceZ,
        warnings,
    };
}

module.exports = { cleanGcodeLines, splitComment, scanModalState, buildResumeProgram };
