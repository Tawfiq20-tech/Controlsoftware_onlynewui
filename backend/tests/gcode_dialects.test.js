'use strict';

/**
 * Dialect gate: every G-code construct is either executed exactly as written
 * or refused before Start with a message that names the line of the ORIGINAL
 * file. Nothing is silently dropped, reordered, rescaled or reinterpreted.
 *
 * Why: the 2026-09 dialect audit found arc lines that lost their other words
 * (a G90 or G21 sharing a line with G2 was thrown away -- the machine then cut
 * out to X390 at depth while the preview looked right), arcs that started from
 * a position only the arc converter believed in (after "G4 X1" or a G20
 * switch), old-Mac line endings that folded a whole program into one move,
 * motion after M30 that still ran, and errors that pointed at line numbers
 * that do not exist in the file.
 *
 * How: each case is a tiny program compiled through prepareProgram() with the
 * options CNCEngine uses when config.json has no machine section. The compiled
 * wire lines are replayed the way the firmware reads them (absolute mm), and
 * the result is compared, file line by file line (meta.sourceLines), with the
 * REFERENCE INTERPRETER below. The reference is written independently of the
 * compiler (own comment stripping, word scanner, arc centre and sweep maths)
 * and reads the original text. A case that should be refused must be refused
 * with an error whose `line` is the file line.
 */

const assert = require('assert');
const { prepareProgram } = require('../lib/prepareProgram');

// CNCEngine._handleFileLoad with an empty machine config.
const ENGINE = {
    rapidFeed: 3000,
    maxRate: { x: 5000, y: 5000, z: 3000 },
    zHeadroom: null,
    safeHeight: 10,
    honorProgramPauses: false,
    motionLimit: { enabled: true },
};

// ---------------------------------------------------------------------------
// Independent reference interpreter (RS274NGC as documented for this machine)
// ---------------------------------------------------------------------------

const INCH = 25.4;

/** Removes () comments (nested) and ; comments. Returns code + the comment text. */
function decomment(line) {
    let code = '';
    let note = '';
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (depth > 0) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (depth > 0) note += ch;
            else note += ' ';
            continue;
        }
        if (ch === '(') { depth = 1; code += ' '; continue; }
        if (ch === ';') { note += ' ' + line.slice(i + 1); break; }
        code += ch;
    }
    return { code: code.trim(), note: note.replace(/\s+/g, ' ').trim() };
}

/** Letter + number scanner. Returns null when something is not a word. */
function scan(code) {
    const words = [];
    let i = 0;
    const isDigit = (c) => c >= '0' && c <= '9';
    while (i < code.length) {
        const c = code[i];
        if (c === ' ' || c === '\t') { i++; continue; }
        if (!/[A-Za-z]/.test(c)) return null;
        let j = i + 1;
        while (code[j] === ' ' || code[j] === '\t') j++;
        let k = j;
        if (code[k] === '+' || code[k] === '-') k++;
        let digits = 0;
        while (k < code.length && isDigit(code[k])) { k++; digits++; }
        if (code[k] === '.') { k++; while (k < code.length && isDigit(code[k])) { k++; digits++; } }
        if (!digits) return null;
        words.push({ L: c.toUpperCase(), v: Number(code.slice(j, k)), txt: code.slice(j, k) });
        i = k;
    }
    return words;
}

function normAngle(a) {
    while (a <= -Math.PI) a += 2 * Math.PI;
    while (a > Math.PI) a -= 2 * Math.PI;
    return a;
}

/** Signed sweep from angle a0 to a1: negative clockwise, positive counter-clockwise. */
function sweepOf(a0, a1, cw, full) {
    if (full) return cw ? -2 * Math.PI : 2 * Math.PI;
    let d = a1 - a0;
    if (cw) { while (d >= 0) d -= 2 * Math.PI; while (d < -2 * Math.PI) d += 2 * Math.PI; } else { while (d <= 0) d += 2 * Math.PI; while (d > 2 * Math.PI) d -= 2 * Math.PI; }
    return d;
}

const PLANES = {
    17: { u: 'x', v: 'y', w: 'z', ou: 'I', ov: 'J' },
    18: { u: 'z', v: 'x', w: 'y', ou: 'K', ov: 'I' },
    19: { u: 'y', v: 'z', w: 'x', ou: 'J', ov: 'K' },
};

/**
 * Reads the ORIGINAL text. Returns one record per file line that has code:
 * { fileLine, kind: 'none'|'move'|'arc'|'retract', end: {x,y,z} in mm (null =
 * never commanded), arc?, dwell? (seconds), pause?, note }.
 * G53 Z / G28 / G30 follow this machine's documented rewrite: Z goes to the
 * retract height (max of the file's own highest Z and the safe height), X/Y held.
 */
function reference(text, { safeHeight = 10, dwellMs = false } = {}) {
    let src = String(text);
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    const lines = src.split(/\r\n|\r|\n/);
    const run = (retractZ) => {
        const st = { scale: 1, abs: true, arcAbs: false, plane: 17, motion: null };
        const pos = { x: null, y: null, z: null };
        const recs = [];
        let maxZ = -Infinity;
        let seen = false;
        for (let li = 0; li < lines.length; li++) {
            const { code: code0, note } = decomment(lines[li]);
            if (!code0) continue;
            if (code0[0] === '%') continue;
            seen = true;
            let code = code0.replace(/\*\d+$/, '').trim();
            const rec = { fileLine: li + 1, kind: 'none', note };
            recs.push(rec);
            if (/^:\d+$/.test(code)) { rec.end = { ...pos }; continue; }
            const words = scan(code);
            if (!words) throw new Error(`reference cannot read line ${li + 1}: ${code}`);
            const get = (L) => { const w = words.find((x) => x.L === L); return w; };
            const gs = words.filter((w) => w.L === 'G').map((w) => w.v);
            for (const g of gs) {
                if (g === 20) st.scale = INCH;
                else if (g === 21) st.scale = 1;
                else if (g === 90) st.abs = true;
                else if (g === 91) st.abs = false;
                else if (g === 90.1) st.arcAbs = true;
                else if (g === 91.1) st.arcAbs = false;
                else if (g === 17 || g === 18 || g === 19) st.plane = g;
                else if (g === 0 || g === 1 || g === 2 || g === 3) st.motion = g;
            }
            const ms = words.filter((w) => w.L === 'M').map((w) => w.v);
            if (ms.includes(0) || ms.includes(1)) rec.pause = { optional: ms.includes(1), note };
            const hasAxis = ['X', 'Y', 'Z'].some((L) => get(L));
            if (gs.includes(4)) {
                const P = get('P');
                const X = get('X');
                if (P) rec.dwell = (dwellMs && !P.txt.includes('.')) ? P.v / 1000 : P.v;
                else if (X) rec.dwell = X.v;
                const motionWord = gs.some((g) => g >= 0 && g <= 3);
                if (!(motionWord && P)) { rec.end = { ...pos }; continue; }
            }
            if (gs.includes(53) || gs.includes(28) || gs.includes(30)) {
                if (!gs.includes(53) || get('Z')) { pos.z = retractZ; rec.kind = 'retract'; }
                rec.end = { ...pos };
                continue;
            }
            const P = PLANES[st.plane];
            const hasOffsets = [P.ou, P.ov, 'R'].some((L) => get(L));
            if (!hasAxis && !hasOffsets) { rec.end = { ...pos }; continue; }
            const target = { ...pos };
            for (const L of ['X', 'Y', 'Z']) {
                const w = get(L);
                if (!w) continue;
                const k = L.toLowerCase();
                target[k] = st.abs ? w.v * st.scale : pos[k] + w.v * st.scale;
            }
            if (st.motion === 2 || st.motion === 3) {
                const cw = st.motion === 2;
                const s = { u: pos[P.u], v: pos[P.v] };
                const e = { u: target[P.u], v: target[P.v] };
                let c;
                const R = get('R');
                if (R) {
                    const r = Math.abs(R.v * st.scale);
                    const mx = (s.u + e.u) / 2; const my = (s.v + e.v) / 2;
                    const dx = e.u - s.u; const dy = e.v - s.v; const d = Math.hypot(dx, dy);
                    const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
                    const cands = [{ u: mx + (h * -dy) / d, v: my + (h * dx) / d }, { u: mx - (h * -dy) / d, v: my - (h * dx) / d }];
                    // R > 0 asks for the arc of at most half a turn, R < 0 for the longer one
                    const want = (cand) => {
                        const sw = sweepOf(Math.atan2(s.v - cand.v, s.u - cand.u), Math.atan2(e.v - cand.v, e.u - cand.u), cw, false);
                        return R.v > 0 ? Math.abs(sw) <= Math.PI + 1e-9 : Math.abs(sw) >= Math.PI - 1e-9;
                    };
                    c = want(cands[0]) ? cands[0] : cands[1];
                } else {
                    const ou = get(P.ou); const ov = get(P.ov);
                    c = st.arcAbs
                        ? { u: ou.v * st.scale, v: ov.v * st.scale }
                        : { u: s.u + (ou ? ou.v : 0) * st.scale, v: s.v + (ov ? ov.v : 0) * st.scale };
                }
                const a0 = Math.atan2(s.v - c.v, s.u - c.u);
                const a1 = Math.atan2(e.v - c.v, e.u - c.u);
                const full = Math.abs(s.u - e.u) < 1e-9 && Math.abs(s.v - e.v) < 1e-9;
                rec.kind = 'arc';
                rec.arc = {
                    ...P, cu: c.u, cv: c.v, a0, r: Math.hypot(s.u - c.u, s.v - c.v), rEnd: Math.hypot(e.u - c.u, e.v - c.v),
                    sweep: sweepOf(a0, a1, cw, full), w0: pos[P.w], w1: target[P.w],
                };
            } else {
                rec.kind = 'move';
            }
            Object.assign(pos, target);
            if (get('Z') && pos.z > maxZ) maxZ = pos.z;
            rec.end = { ...pos };
        }
        void seen;
        return { recs, maxZ };
    };
    const first = run(safeHeight);
    const retractZ = Math.max(first.maxZ === -Infinity ? 0 : first.maxZ, safeHeight);
    return { ...run(retractZ), retractZ };
}

// ---------------------------------------------------------------------------
// Firmware-side replay of the compiled wire lines
// ---------------------------------------------------------------------------

const MOTION_LINE = /^G21 G90 G([01])((?: [XYZ]-?\d+\.\d{3})+) F(\d+(?:\.\d)?)(?: (.*))?$/;

function replay(lines) {
    const pos = { x: null, y: null, z: null };
    const states = new Array(lines.length);
    const motion = new Uint8Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        assert.ok(l.length <= 63, `wire line ${i + 1} is ${l.length} bytes: ${l}`);
        assert.ok(!/0[xX]/.test(l), `wire line ${i + 1} has a hex-like pattern: ${l}`);
        const m = MOTION_LINE.exec(l);
        if (m) {
            for (const a of m[2].trim().split(' ')) {
                const v = Number(a.slice(1));
                assert.ok(Math.abs(v * 200 - Math.round(v * 200)) < 1e-6, `wire line ${i + 1}: ${a} is off the 0.005 mm grid`);
                pos[a[0].toLowerCase()] = v;
            }
            assert.ok(Number(m[3]) > 0, `wire line ${i + 1}: feed must be positive`);
            if (m[4]) assert.ok(!/[XYZF]-?\d/.test(m[4]) && !/G/.test(m[4]), `wire line ${i + 1}: extra motion words "${m[4]}"`);
            motion[i] = 1;
        } else {
            assert.ok(!/[XYZFIJKR][-+]?\.?\d/.test(l), `wire line ${i + 1} is not a motion line but carries axis/feed words: ${l}`);
            assert.ok(!/G\s*0*(?:2|3|20|91|53|28|30|92|4)(?![0-9])/.test(l), `wire line ${i + 1} streams a modal/arc word: ${l}`);
        }
        states[i] = { ...pos };
    }
    return { states, motion };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function compile(text, { spindleDelay = 0, options = {} } = {}) {
    return prepareProgram(text, spindleDelay, { ...ENGINE, ...options });
}

function errorsOf(meta) {
    return (meta.errors || []).map((e) => `L${e.line}: ${e.msg}`).join(' | ');
}

function segDist(p, a, b) {
    const ab = [b.x - a.x, b.y - a.y, b.z - a.z];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let t = l2 ? ((p.x - a.x) * ab[0] + (p.y - a.y) * ab[1] + (p.z - a.z) * ab[2]) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * ab[0]), p.y - (a.y + t * ab[1]), p.z - (a.z + t * ab[2]));
}

/** Reference path as points in mm (arcs sampled finely); never-commanded axes read as 0. */
function referencePath(ref) {
    const z0 = (p) => ({ x: p.x === null ? 0 : p.x, y: p.y === null ? 0 : p.y, z: p.z === null ? 0 : p.z });
    const pts = [{ x: 0, y: 0, z: 0 }];
    for (const rec of ref.recs) {
        if (rec.kind === 'arc') {
            const a = rec.arc;
            const n = Math.max(16, Math.ceil(Math.abs(a.sweep) * Math.max(a.r, 1) / 0.05));
            const prev = pts[pts.length - 1];
            for (let k = 1; k <= n; k++) {
                const ang = a.a0 + (a.sweep * k) / n;
                const p = { ...prev };
                p[a.u] = a.cu + a.r * Math.cos(ang);
                p[a.v] = a.cv + a.r * Math.sin(ang);
                if (a.w0 !== null && a.w1 !== null) p[a.w] = a.w0 + ((a.w1 - a.w0) * k) / n;
                pts.push(p);
            }
            pts.push(z0(rec.end));
        } else if (rec.kind !== 'none') {
            pts.push(z0(rec.end));
        }
    }
    return pts;
}

/** Every machine vertex lies on the reference path and vice versa, and both end at the same point. */
function comparePaths(rep, ref) {
    const z0 = (p) => ({ x: p.x === null ? 0 : p.x, y: p.y === null ? 0 : p.y, z: p.z === null ? 0 : p.z });
    const mach = [{ x: 0, y: 0, z: 0 }];
    rep.states.forEach((s, i) => { if (rep.motion[i]) mach.push(z0(s)); });
    const refPts = referencePath(ref);
    const far = (p, poly) => {
        if (poly.length === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y, p.z - poly[0].z);
        let best = Infinity;
        for (let k = 1; k < poly.length; k++) best = Math.min(best, segDist(p, poly[k - 1], poly[k]));
        return best;
    };
    for (const p of mach) {
        const d = far(p, refPts);
        assert.ok(d <= 0.02, `machine goes to ${JSON.stringify(p)}, ${d.toFixed(3)} mm away from the path the file describes`);
    }
    for (const p of refPts) {
        const d = far(p, mach);
        assert.ok(d <= 0.02, `the file's path passes ${JSON.stringify(p)}, the machine never comes within ${d.toFixed(3)} mm`);
    }
    const a = mach[mach.length - 1];
    const b = refPts[refPts.length - 1];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 0.01, `machine ends at ${JSON.stringify(a)}, the file ends at ${JSON.stringify(b)}`);
}

const GRID_TOL = 0.0026; // one half step of the 0.005 mm grid, plus float noise
const ARC_TOL = 0.009;   // grid rounding + 4-decimal chord text in inch files

/** Compiles `text`, requires 0 errors, and checks the machine path file line by file line. */
function expectRuns(text, opts = {}) {
    const r = compile(text, opts);
    const meta = r.compiled.meta;
    assert.strictEqual(meta.errorCount, 0, `refused: ${errorsOf(meta)}`);
    const lines = r.compiled.lines;
    const map = meta.sourceLines;
    const rep = replay(lines);
    const ref = reference(text, { safeHeight: (opts.options && opts.options.safeHeight) || ENGINE.safeHeight, dwellMs: opts.dwellMs });
    // Whole-path comparison first: it needs no line map, so it names a wrong
    // cut as a wrong cut even on a compiler that has no map to offer.
    comparePaths(rep, ref);
    // Case checks that need no line map (dwell times, pause messages, tool
    // numbers, spindle words) come next, so an old compiler fails a case for
    // its defect rather than for the map it does not have.
    if (opts.check) opts.check(meta, lines);
    assert.ok(map && map.length === lines.length, 'meta.sourceLines maps every compiled line to a file line');

    const groups = new Map();
    let prevFile = 0;
    for (let i = 0; i < map.length; i++) {
        assert.ok(map[i] >= prevFile && map[i] >= 1, `compiled line ${i + 1} maps to file line ${map[i]} after ${prevFile}`);
        prevFile = map[i];
        if (!groups.has(map[i])) groups.set(map[i], []);
        groups.get(map[i]).push(i);
    }
    const byLine = new Map(ref.recs.map((x) => [x.fileLine, x]));
    for (let i = 0; i < lines.length; i++) {
        if (!rep.motion[i]) continue;
        const rec = byLine.get(map[i]);
        assert.ok(rec && rec.kind !== 'none', `compiled line ${i + 1} "${lines[i]}" moves, but file line ${map[i]} does not`);
    }
    for (const rec of ref.recs) {
        const idx = (groups.get(rec.fileLine) || []).filter((i) => rep.motion[i]);
        const label = `file line ${rec.fileLine}`;
        if (rec.kind === 'none') { assert.strictEqual(idx.length, 0, `${label} must not move`); continue; }
        if (rec.kind === 'move' || rec.kind === 'retract') assert.strictEqual(idx.length, 1, `${label} is one move, compiled into ${idx.length}`);
        if (rec.kind === 'arc') {
            assert.ok(idx.length >= 1, `${label} arc produced no motion`);
            const a = rec.arc;
            assert.ok(Math.abs(a.r - a.rEnd) < 0.05, `${label}: test case arc is inconsistent`);
            let prevAng = a.a0;
            let swept = 0;
            for (const i of idx) {
                const p = rep.states[i];
                const du = p[a.u] - a.cu;
                const dv = p[a.v] - a.cv;
                assert.ok(Math.abs(Math.hypot(du, dv) - a.r) <= ARC_TOL, `${label}: chord point ${JSON.stringify(p)} is ${Math.hypot(du, dv) - a.r} mm off the arc`);
                const ang = Math.atan2(dv, du);
                const d = normAngle(ang - prevAng);
                if (Math.abs(d) > 1e-6) assert.ok(Math.sign(d) === Math.sign(a.sweep), `${label}: arc turns the wrong way`);
                assert.ok(a.r * (1 - Math.cos(Math.abs(d) / 2)) <= 0.012, `${label}: chord bows ${a.r * (1 - Math.cos(Math.abs(d) / 2))} mm off the arc`);
                swept += d;
                prevAng = ang;
                if (a.w0 !== null && a.w1 !== null) {
                    const expW = a.w0 + (a.w1 - a.w0) * (swept / a.sweep);
                    assert.ok(Math.abs(p[a.w] - expW) <= ARC_TOL + Math.abs(a.w1 - a.w0) * 0.02, `${label}: helical ${a.w} ${p[a.w]} vs ${expW}`);
                }
            }
            assert.ok(Math.abs(swept - a.sweep) <= Math.max(0.01, 0.03 / Math.max(a.r, 0.1)), `${label}: arc swept ${swept.toFixed(4)} rad, file asks ${a.sweep.toFixed(4)}`);
        }
        const last = rep.states[idx[idx.length - 1]];
        for (const k of ['x', 'y', 'z']) {
            if (rec.end[k] === null) { assert.strictEqual(last[k], null, `${label}: ${k} commanded before the file sets it`); continue; }
            assert.ok(last[k] !== null && Math.abs(last[k] - rec.end[k]) <= GRID_TOL, `${label}: machine ends at ${k}=${last[k]}, file means ${rec.end[k]}`);
        }
    }
    return { r, meta, lines, ref, rep, groups };
}

/** Compiles `text` and requires a refusal whose error names file line `line`. */
function expectRefused(text, line, re, opts = {}) {
    const r = compile(text, opts);
    const meta = r.compiled.meta;
    assert.ok(meta.errorCount > 0, `accepted, but must be refused at file line ${line} (${re})`);
    assert.ok(meta.errors.some((e) => e.line === line && re.test(e.msg) && e.msg.length >= 20),
        `refused, but not with ${re} at file line ${line}: ${errorsOf(meta)}`);
    return meta;
}

const L = (...a) => a.join('\n') + '\n';

/** Output line indices (0-based) that map to file line `f`. */
function linesOf(meta, f) {
    const out = [];
    for (let i = 0; i < meta.sourceLines.length; i++) if (meta.sourceLines[i] === f) out.push(i);
    return out;
}

function checksum(s) {
    let cs = 0;
    for (const ch of s) cs ^= ch.charCodeAt(0);
    return cs & 0xFF;
}

// ---------------------------------------------------------------------------
// Cases: one per construct
// ---------------------------------------------------------------------------

const CASES = [
    // ---- arcs and the words that share their line -------------------------
    ['arc line: G90 after a G91 section is honoured', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G91', 'G1 X5', 'G90 G2 X15 Y0 I5 J0', 'G1 X30 Y10', 'G0 Z5'))],
    ['arc line: G21 inside an inch file is honoured', () => expectRuns(L('G20 G90', 'G0 X0 Y0 Z0.2', 'G1 Z-0.04 F20', 'G1 X1', 'G21 G2 X45.4 Y0 I10 J0 F500', 'G1 X50 Y20', 'G0 Z5'))],
    ['arc line: G90.1 absolute centre is honoured', () => expectRuns(L('G21 G90', 'G0 X30 Y20 Z5', 'G1 Z-1 F300', 'G90.1 G2 X20 Y30 I20 J20 F600', 'G91.1', 'G2 X10 Y20 I-10 J0', 'G0 Z5'))],
    ['arc line: Fusion header with G91.1 runs', () => expectRuns(L('G90 G94 G91.1 G40 G49 G17', 'G21', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G3 X0 Y10 I-10 J0', 'G0 Z5'))],
    ['arc line: G41 is refused on its own line and on an arc line', () => {
        expectRefused(L('G21 G90', 'G0 X30 Y20 Z5', 'G1 Z-1 F300', 'G41 D1 G3 X20 Y30 I-10 J0 F600', 'G40 G0 Z5'), 4, /cutter compensation/);
        expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G42 D1 G1 X10 F300'), 3, /cutter compensation/);
    }],
    ['arc line: G93 is refused', () => expectRefused(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G93 G2 X-10 Y0 I-10 J0 F2', 'G94 G0 Z5'), 4, /inverse-time/)],
    ['arc line: T2 M6 after cutting is refused', () => expectRefused(L('G21 G90', 'T1 M6', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G1 X10 Y1', 'G1 X10 Y0', 'T2 M6 G2 X-10 Y0 I-10 J0', 'G0 Z5'), 7, /tool change/)],
    ['arc line: M0 pauses after the whole arc', () => {
        const { meta } = expectRuns(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0 M0 (MSG, look)', 'G0 Z5'), {
            check: (m) => {
                assert.strictEqual(m.pauses.length, 1, `the M0 on the arc line is kept: pauses ${JSON.stringify(m.pauses)}`);
                assert.strictEqual(m.pauses[0].message, 'look');
                assert.strictEqual(m.pauses[0].fileLine, 4);
            },
        });
        const arcLines = linesOf(meta, 4);
        assert.strictEqual(meta.pauses[0].line, arcLines[arcLines.length - 1] + 1, 'pause holds after the last chord');
    }],
    ['arc line: S and M8 are not dropped', () => {
        const { meta, lines } = expectRuns(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0 S9000 M3 M8', 'G0 Z5'), {
            check: (m, ls) => assert.ok(ls.some((l) => / M3 S9000$/.test(l)), `M3 S9000 of the arc line reaches the wire: ${JSON.stringify(ls)}`),
        });
        assert.ok(/ M3 S9000$/.test(lines[linesOf(meta, 4)[0]]), `spindle words ride on the first chord: ${lines[linesOf(meta, 4)[0]]}`);
    }],
    ['arc line: F sets the feed of every chord', () => {
        const { meta, lines } = expectRuns(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0 F777'), {
            check: (m, ls) => assert.ok(ls.some((l) => / F777(?: |$)/.test(l)), `the arc runs at F777: ${JSON.stringify(ls)}`),
        });
        // the motion limit may lower single chords; it never raises one above the file's feed
        for (const i of linesOf(meta, 4)) assert.ok(Number(/ F(\d+(?:\.\d)?)/.exec(lines[i])[1]) <= 777, lines[i]);
        assert.ok(linesOf(meta, 4).some((i) => / F777(?: |$)/.test(lines[i])), 'chords run at the arc line feed');
    }],
    ['arc: modal continuation lines', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G2 X10 Y10 I10 J0 F600', 'X20 Y0 I0 J-10', 'G0 Z5'))],
    ['arc: full circles in both IJ forms', () => expectRuns(L('G21 G90', 'G0 Z5', 'G0 X10 Y0', 'G1 Z-1 F300', 'G2 X10 Y0 I-10 J0 F600', 'G3 I-10', 'G0 Z5'))],
    ['arc: R format, positive R (short way)', () => expectRuns(L('G21 G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G2 X10 Y10 R10 F600', 'G3 X20 Y0 R10', 'G0 Z5'))],
    ['arc: R format, negative R (long way)', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G3 X10 Y10 R-10 F600', 'G2 X20 Y0 R-10.0', 'G0 Z5'))],
    ['arc: R format in inches', () => expectRuns(L('G20 G90', 'G0 X0 Y0 Z0.2', 'G1 Z-0.05 F20', 'G2 X1 Y1 R1', 'G0 Z0.2'))],
    ['arc: R full circle is refused', () => expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G2 X0 Y0 R5'), 4, /R/)],
    ['arc: R too small for its endpoints is refused', () => expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G2 X30 Y0 R5'), 4, /radius/)],
    ['arc: radius mismatch (absolute IJ without G90.1) is refused', () => {
        expectRefused(L('G21 G90', 'G0 X30 Y20 Z5', 'G1 Z-1 F300', '(absolute centre written without G90.1)', 'G2 X20 Y30 I20 J20 F600', 'G0 Z5'), 5, /radius/);
        expectRefused(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X0 Y-3 I-10 J0', 'G0 Z5'), 4, /radius/);
    }],
    ['arc: G18 (XZ plane)', () => expectRuns(L('G21 G90 G18', 'G0 X0 Y0 Z0', 'G1 Z-1 F300', 'G2 X10 Z-1 I5 K0 F600', 'G17', 'G0 Z5'))],
    ['arc: G19 (YZ plane)', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z0', 'G19', 'G1 Z-1 F300', 'G3 Y10 Z-1 J5 K0 F600', 'G17 G0 Z5'))],
    ['arc: helical XY arc with a Z ramp', () => expectRuns(L('G21 G90', 'G0 X10 Y0 Z0', 'G1 Z0 F300', 'G2 X10 Y0 Z-2 I-10 J0 F600', 'G3 X0 Y10 Z-3 I-10 J0', 'G0 Z5'))],
    ['arc: Z word equal to the current Z is a plain arc', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G2 X10 Y0 Z-1 I5 J0', 'G0 Z5'))],
    ['arc: incremental (G91) arc', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G91', 'G2 X10 Y0 I5 J0', 'G3 X-5 Y5 I0 J5', 'G90', 'G0 Z5'))],
    ['arc: starts at the real position after "G4 X1"', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10 Y0', 'G4 X1', 'G2 X0 Y-10 I-10 J0', 'G0 Z5'))],
    ['arc: starts at the real position after a G20 switch', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X25.4 Y0', 'G20', 'G2 X0 Y1 I-1 J0 F20', 'G0 Z0.2'))],
    ['arc: "G28 X0 Y0", "G4 X1" after an arc are not arc continuations', () => {
        expectRuns(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0', 'G28 X0 Y0', 'G0 X0 Y0'));
        expectRuns(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0', 'G4 X1', 'G0 Z5'));
    }],
    ['arc: before any X/Y position is refused', () => expectRefused(L('G21 G90', 'G0 Z5', 'G1 Z-1 F300', 'G2 X10 Y0 I5 J0', 'G0 Z5'), 4, /position/)],
    ['arc: "G2.0" is G2', () => expectRuns(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2.0 X-10 Y0 I-10 J0', 'G0 Z5'))],
    ['arc: I/J without an arc is refused', () => expectRefused(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 X20 I5 F300'), 3, /arc/)],

    // ---- units and distance modes ------------------------------------------
    ['units: G20/G21 switch mid-file', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X25.4', 'G20', 'G1 X2 F20', 'G21', 'G1 X60', 'G0 Z5'))],
    ['distance: G91 incremental section', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G91', 'G1 Z-6 F300', 'X10', 'Y10', 'X-10', 'G90', 'G0 Z5'))],
    // Each G91 step must land on the grid point nearest the file's own
    // position. Rounding from the previous ROUNDED target adds the error up:
    // 200 x "X0.0126" ran 0.48 mm long, 1000 x "X0.0024" never moved at all.
    ['distance: G91 steps that are not whole grid steps do not drift (mm)', () => {
        const rows = ['G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G91'];
        for (let i = 0; i < 200; i++) rows.push('G1 X0.0126');
        rows.push('G90', 'G0 Z5');
        expectRuns(L(...rows));
    }],
    ['distance: G91 steps that are not whole grid steps do not drift (inch)', () => {
        const rows = ['G20 G90', 'G0 X0 Y0 Z0.2', 'G1 Z-0.04 F20', 'G91'];
        for (let i = 0; i < 200; i++) rows.push('G1 X0.0123 Y0.0007');
        rows.push('G90', 'G0 Z0.2');
        expectRuns(L(...rows));
    }],
    ['distance: G91 arc after moves smaller than one step starts where the file is', () => {
        expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G91', 'G1 X0.0024', 'G1 X0.0024', 'G1 X0.0024', 'G2 X10 Y0 I5 J0', 'G1 X0.0024 Y0.0024', 'G90', 'G0 Z5'));
    }],
    ['distance: G91 move before the position is known is refused', () => expectRefused(L('G21 G91', 'G1 X10 F300', 'G90'), 2, /incremental/)],
    ['units: feed-only line in an inch file', () => expectRuns(L('G20 G90', 'F40', 'G0 X0 Y0 Z0.2', 'G1 Z-0.05', 'G1 X1', 'G0 Z0.2'))],
    ['units: file that ends in G20 G91', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', 'G20 G91'))],

    // ---- machine coordinates, offsets ----------------------------------------
    ['G53: Z retract to the safe height, later XY at that height', () => {
        expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G53 G0 Z0', 'G0 X20 Y20', 'G1 Z-1', 'G0 Z5'), {
            check: (m) => assert.ok(m.warnings.some((w) => /G53/.test(w.msg)), 'the retract is announced'),
        });
    }],
    ['G28/G30: retract, X/Y held', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G91 G28 Z0', 'G90', 'G0 X20', 'G28 X0 Y0', 'G30', 'G0 Z5'))],
    ['G92 is refused', () => expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G92 X0 Y0 Z0', 'G0 X10'), 3, /G92/)],
    ['G10 and G55 are refused', () => {
        const meta = expectRefused(L('G21 G90', 'G10 L20 P1 X0 Y0', 'G55', 'G0 X10 Y10 Z5'), 2, /G10/);
        assert.ok(meta.errors.some((e) => e.line === 3 && /G55/.test(e.msg)));
    }],
    ['G54 is accepted (the single work zero)', () => expectRuns(L('G21 G90 G54', 'G0 X1 Y1 Z5', 'G1 Z-1 F100'))],
    ['G59.1 is refused', () => expectRefused(L('G21 G90', 'G59.1', 'G0 X1 Y1 Z5'), 2, /G59\.1/)],

    // ---- tool length, cutter compensation, cycles, feed modes --------------
    ['G43/G49: accepted, no offset applied (warned)', () => {
        expectRuns(L('G21 G90', 'G43 H1 Z10', 'G0 X10 Y10', 'G1 Z-1 F300', 'G49', 'G0 Z5'), {
            check: (m) => assert.ok(m.warnings.some((w) => w.line === 2 && /G43/.test(w.msg)), `G43 warned at file line 2: ${JSON.stringify(m.warnings)}`),
        });
    }],
    ['G40 is accepted', () => expectRuns(L('G21 G90 G40', 'G0 X1 Y1 Z5', 'G1 Z-1 F100'))],
    ['canned cycles are refused with a clear message', () => {
        const meta = expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G81 X10 Y10 Z-3 R2 F200', 'G73 X20 Y10 Z-3 R2 Q1 F200', 'G80'), 3, /canned cycle/);
        assert.ok(meta.errors.some((e) => e.line === 4 && /canned cycle/.test(e.msg)));
        assert.ok(!meta.errors.some((e) => /arc/.test(e.msg)), `R of a cycle is not an arc word: ${errorsOf(meta)}`);
    }],
    ['G80 is accepted', () => expectRuns(L('G21 G90 G80', 'G0 X1 Y1 Z5', 'G1 Z-1 F100'))],
    ['G93 is refused, G94 accepted', () => {
        expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G93', 'G1 X10 F2', 'G94'), 3, /inverse-time/);
        expectRuns(L('G21 G90 G94', 'G0 X1 Y1 Z5', 'G1 Z-1 F100'));
    }],
    ['G95 is refused', () => expectRefused(L('G21 G90 G95', 'G0 X1 Y1 Z5', 'G1 Z-1 F0.1'), 1, /G95/)],

    // ---- dwells --------------------------------------------------------------
    ['G4 P with a decimal point is seconds', () => {
        expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G4 P2.5', 'G1 Z-1 F300'), {
            check: (m) => {
                assert.deepStrictEqual(m.dwells.map((d) => d.seconds), [2.5]);
                assert.deepStrictEqual(m.dwells.map((d) => [d.fileLine, d.seconds]), [[3, 2.5]]);
            },
        });
    }],
    ['G4 P integer is seconds in grbl/LinuxCNC files', () => {
        expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'M3 S10000', 'G4 P1', 'G1 Z-1 F300'), {
            check: (m) => {
                assert.deepStrictEqual(m.dwells.map((d) => d.seconds), [1]);
                assert.deepStrictEqual(m.dwells.map((d) => [d.fileLine, d.seconds]), [[4, 1]]);
            },
        });
    }],
    // A ":1248"/"O1000" line only hints at Fanuc/Haas (P in milliseconds);
    // Mach3/LinuxCNC files carry O numbers too, with P in seconds. Guessing
    // milliseconds turned a 3 s spin-up wait into 3 ms, so the tool plunged
    // before the spindle was at speed. The longer reading is used and warned.
    ['G4 P integer with a Fanuc-style program number: the longer (seconds) reading, warned; milliseconds only when set', () => {
        expectRuns(L('O1000', 'G21 G90', 'G0 X10 Y10 Z5', 'M3 S12000', 'G4 P3', 'G1 Z-1 F300'), {
            check: (m) => assert.deepStrictEqual(m.dwells.map((d) => d.seconds), [3], 'the 3 s spin-up wait of an O-numbered file is not cut to 3 ms'),
        });
        const fanuc = L('%', ':1248', 'N10 G21 G90', 'N20 G0 X10 Y10 Z5', 'N30 G04 P1500', 'N40 G4 P0.5', 'N50 G1 Z-1 F300', 'N60 M30', '%');
        const { meta } = expectRuns(fanuc, {
            check: (m) => {
                assert.deepStrictEqual(m.dwells.map((d) => d.seconds), [1500, 0.5]);
                assert.ok(m.warnings.some((w) => w.line === 5 && /millisecond/.test(w.msg) && /1\.5 s/.test(w.msg)), `says how P1500 was read and what it may mean: ${JSON.stringify(m.warnings)}`);
            },
        });
        assert.deepStrictEqual(meta.dwells.map((d) => [d.fileLine, d.seconds]), [[5, 1500], [6, 0.5]]);
        assert.deepStrictEqual([meta.dialect.dwellP, meta.dialect.programNumber && meta.dialect.programNumber.fileLine], ['seconds', 2]);
        const ms = expectRuns(fanuc, { dwellMs: true, options: { dwellUnits: 'milliseconds' } }).meta;
        assert.deepStrictEqual(ms.dwells.map((d) => [d.fileLine, d.seconds]), [[5, 1.5], [6, 0.5]]);
        assert.ok(ms.warnings.some((w) => /millisecond/.test(w.msg)), 'says it read milliseconds');
        expectRefused(L('O1000', 'G21 G90', 'G0 X10 Y10 Z5', 'G4 P5000', 'G1 Z-1 F300'), 4, /longer than an hour.*milliseconds/);
    }],
    ['G4 X is a dwell in seconds, never a move', () => {
        expectRuns(L('G21 G90', 'G0 X10 Y10', 'G1 Z-1 F300', 'G04 X1.5', 'G1 X20'), {
            check: (m) => {
                assert.deepStrictEqual(m.dwells.map((d) => d.seconds), [1.5]);
                assert.deepStrictEqual(m.dwells.map((d) => [d.fileLine, d.seconds]), [[4, 1.5]]);
            },
        });
    }],
    ['G4 S (3D-printer seconds) is refused', () => expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G4 S2', 'G1 Z-1 F300'), 3, /S/)],
    ['G4 P with a move on the same line: dwell, then the move', () => {
        const { meta, lines } = expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'G4 P1 G1 X10 F300', 'G0 Z6'), {
            check: (m, ls) => {
                assert.deepStrictEqual(m.dwells.map((d) => d.seconds), [1]);
                const move = ls.findIndex((l) => /^G21 G90 G1 X10\.000/.test(l));
                assert.ok(move >= 0 && m.dwells[0].line - 1 < move, `the dwell comes before the move: ${JSON.stringify(ls)}`);
            },
        });
        const own = linesOf(meta, 3);
        assert.strictEqual(own.length, 2, 'a dwell line and a move line');
        assert.deepStrictEqual(meta.dwells.map((d) => [d.line, d.fileLine, d.seconds]), [[own[0] + 1, 3, 1]]);
        assert.ok(/^G21 G90 G1 X10\.000/.test(lines[own[1]]));
    }],
    ['G4 without a time does nothing (warned)', () => {
        expectRuns(L('G21 G90', 'G0 X1 Y1 Z5', 'G4', 'G1 Z-1 F100'), {
            check: (m) => {
                assert.deepStrictEqual(m.dwells, []);
                assert.ok(m.warnings.some((w) => w.line === 3), `warned at file line 3: ${JSON.stringify(m.warnings)}`);
            },
        });
    }],
    ['negative dwell is refused', () => expectRefused(L('G21 G90', 'G0 X1 Y1 Z5', 'G4 P-1'), 3, /dwell/)],

    // ---- program flow, M codes, tools ----------------------------------------
    ['M0/M1: pauses carry the message, the file line and whether cutting started', () => {
        const { meta } = expectRuns(L('G21 G90', 'M0 (MSG, spindle up to speed?)', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', 'M5', 'M1 (MSG, Flip the board / change to the 1/8 bit, then Continue)', 'G0 X20 Y20'), {
            check: (m) => {
                assert.deepStrictEqual(m.pauses.map((p) => [p.optional, p.message]), [[false, 'spindle up to speed?'], [true, 'Flip the board / change to the 1/8 bit, then Continue']]);
                assert.deepStrictEqual(m.pauses.map((p) => [p.fileLine, p.optional, p.afterCutting, p.toolChange]), [[2, false, false, false], [8, true, true, true]]);
            },
        });
        assert.strictEqual(meta.pauses[0].line, linesOf(meta, 2)[0] + 1);
    }],
    ['M30 followed by motion is refused', () => expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', 'M30', 'G0 X50 Y50', 'G1 Z-3 F300', '%'), 7, /M30/)],
    ['M2 followed by % and blank lines runs; programEnd is reported', () => {
        expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'm02 (end of program)', '', '%', ''), {
            check: (m) => assert.deepStrictEqual(m.programEnd && [m.programEnd.fileLine, m.programEnd.word], [3, 'M2']),
        });
    }],
    ['M30 followed by harmless M5/M9 runs', () => expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'M30', 'M5 M9'))],
    ['motion after a closing % is refused', () => expectRefused(L('%', 'G21 G90', 'G0 X0 Y0 Z5', '%', 'G0 X9'), 5, /%/)],
    // A "%" is the tape start/end mark. In a file that does not open with one,
    // a "%" below some code is not the end while more code follows it.
    ['a "%" below the first code line of a file that does not open with "%" is not the program end', () => {
        expectRuns(L('G21', '%', 'G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', '%'), {
            check: (m) => {
                assert.ok(m.warnings.some((w) => w.line === 2 && /%/.test(w.msg)), `the ignored % is named: ${JSON.stringify(m.warnings)}`);
                assert.deepStrictEqual(m.programEnd && [m.programEnd.fileLine, m.programEnd.word], [8, '%']);
            },
        });
    }],
    ['M6 after cutting is refused; before cutting it is listed with its file line', () => {
        expectRefused(L('G21 G90', 'T1 M6', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', 'T2 M6', 'G0 X20', 'G1 Z-1', 'G0 Z5'), 7, /tool change/);
        expectRuns(L('(tool header)', 'G21 G90', 'N20 T4 M06', 'G0 X0 Y0 Z5', 'G1 Z-1 F300'), {
            check: (m) => {
                assert.deepStrictEqual(m.tools.map((t) => [t.tool, t.afterCutting]), [[4, false]]);
                assert.deepStrictEqual(m.tools.map((t) => [t.fileLine, t.tool, t.afterCutting]), [[3, 4, false]]);
            },
        });
        // "T3" then a bare "M6": the M6 entry names the tool it loads
        expectRuns(L('G21 G90', 'T3 (select)', 'M6', 'G0 X0 Y0 Z5', 'G1 Z-1 F300'), {
            check: (m) => {
                assert.deepStrictEqual(m.tools.map((t) => [t.tool, !!t.selectOnly]), [[3, true], [3, false]], `a bare M6 loads the selected T3: ${JSON.stringify(m.tools)}`);
                assert.deepStrictEqual(m.tools.map((t) => t.fileLine), [2, 3]);
            },
        });
    }],
    ['a T word that changes the tool after cutting (Buildbotics MSG + M0 style) is refused', () => {
        const text = L('%', 'T1 (MSG, Insert Tool 1)', 'G0 G17 G20 G90 G40 G49 G64', 'G0 Z0.250', 'G0 X0.000 Y0.000 M03 S15000', "M0(MSG, Click 'Continue' when the spindle is up to speed)", 'G1 Z-0.1 F50', 'G1 X1', 'G0 Z0.25', 'M05', 'T2 (MSG, Insert Tool 2)', "M0(MSG, Click 'Continue' when the new bit is zeroed)", 'G0 X0.000 Y0.000 M03 S15000', 'G1 Z-0.2 F50', 'G1 Y1', 'G0 Z0.25', 'M02');
        expectRefused(text, 11, /tool/);
        // with a controller that holds at tool changes, the same file runs and says where
        const { meta } = expectRuns(text, {
            options: { toolChangeHolds: true },
            check: (m) => {
                assert.deepStrictEqual((m.toolChanges || []).map((t) => [t.fileLine, t.tool, t.previousTool, t.kind]), [[11, 2, 1, 'T']]);
                assert.deepStrictEqual(m.pauses.map((p) => [p.fileLine, p.toolChange]), [[6, false], [12, true]]);
            },
        });
        assert.strictEqual(meta.sourceLines[meta.toolChanges[0].line - 1], 11, 'hold line maps to the T line');
    }],
    ['T2 M6 on a motion line after cutting with tool-change holds: hold first, then the move', () => {
        const { meta, lines } = expectRuns(L('G21 G90', 'T1 M6', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', 'T2 M6 G0 X20 Y20'), {
            options: { toolChangeHolds: true },
            check: (m, ls) => {
                const hold = ls.indexOf('T2 M6');
                const move = ls.findIndex((l) => /^G21 G90 G0 X20\.000 Y20\.000/.test(l));
                assert.ok(hold >= 0 && hold < move, `the hold line comes before the move: ${JSON.stringify(ls)}`);
                assert.deepStrictEqual((m.toolChanges || []).map((t) => [t.line, t.fileLine, t.tool, t.previousTool, t.kind]), [[hold + 1, 7, 2, 1, 'M6']]);
            },
        });
        const own = linesOf(meta, 7);
        assert.strictEqual(own.length, 2);
        assert.strictEqual(lines[own[0]], 'T2 M6');
    }],
    ['M3/M4/M5 and S ride on the wire; M7/M8/M9 are no-ops', () => {
        const { meta, lines } = expectRuns(L('G21', 'G0 X1 Y1 M3 S15000', 'M8', 'M4 S100', 'M9', 'M5'), {
            check: (m, ls) => {
                assert.ok(ls.includes('G21 G90 G0 X1.000 Y1.000 F3000 M3 S15000') && ls.includes('M4 S100'), JSON.stringify(ls));
                assert.strictEqual(m.usesSpindle, true);
            },
        });
        assert.strictEqual(lines[linesOf(meta, 2)[0]], 'G21 G90 G0 X1.000 Y1.000 F3000 M3 S15000');
        assert.strictEqual(lines[linesOf(meta, 4)[0]], 'M4 S100');
    }],
    ['spin-up delay follows M3/M4 in every post style, and respects an existing G4', () => {
        for (const form of ['S15000 M3', 'G0 X0.000 Y0.000 M03 S15000', 'N22 S22000 M03', 'M3S18000', 'M3 S12000']) {
            expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', form, 'G1 Z-1 F300'), {
                spindleDelay: 2,
                check: (m) => {
                    assert.deepStrictEqual(m.dwells.map((d) => d.seconds), [2], `a spin-up wait after "${form}"`);
                    assert.strictEqual(m.spinUpDwellCount, 1);
                    assert.deepStrictEqual(m.dwells.map((d) => [d.fileLine, d.seconds]), [[3, 2]], `spin-up dwell after "${form}" names its file line`);
                },
            });
        }
        expectRuns(L('G21 G90', 'G0 X0 Y0 Z5', 'M3 S1000', '(wait for it)', 'G4 P3', 'G1 Z-1 F300'), {
            spindleDelay: 2,
            check: (m) => assert.deepStrictEqual(m.dwells.map((d) => [d.fileLine, d.seconds]), [[5, 3]], 'the file already waits'),
        });
    }],
    // RS274NGC turns the spindle on before the motion of its line; the wait
    // for it to reach speed belongs there too, never after a plunge.
    ['spin-up wait comes before the motion of its own line (M3 on a plunge, on an arc, on a dwell-and-move line)', () => {
        const forms = [
            ['plunge', L('G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300 M3 S10000', 'G1 X10', 'G0 Z5')],
            ['helical arc', L('G21 G90', 'G0 X10 Y0 Z0', 'G2 X-10 Y0 Z-1 I-10 J0 F300 M3 S10000', 'G0 Z5')],
            ['dwell and move', L('G21 G90', 'G0 X0 Y0 Z5', 'G4 P0.5 G1 Z-1 F300 M3 S10000', 'G0 Z5')],
        ];
        for (const [name, text] of forms) {
            const { meta } = expectRuns(text, {
                spindleDelay: 2,
                check: (m, ls) => {
                    const spinUp = m.dwells.filter((d) => d.seconds === 2);
                    assert.strictEqual(spinUp.length, 1, `${name}: one 2 s spin-up wait: ${JSON.stringify(m.dwells)}`);
                    const start = ls.findIndex((l) => /\bM3 S10000\b/.test(l));
                    const wait = spinUp[0].line - 1;
                    const cut = ls.findIndex((l) => /^G21 G90 G1 /.test(l));
                    assert.ok(start >= 0 && start <= wait && wait < cut, `${name}: spindle start (line ${start + 1}), wait (line ${wait + 1}), then the first cut (line ${cut + 1}): ${JSON.stringify(ls)}`);
                    assert.ok(!ls.slice(cut).some((l) => /\bM3\b/.test(l)), `${name}: no spindle start after the wait`);
                },
            });
            assert.strictEqual(meta.sourceLines[meta.dwells.find((d) => d.seconds === 2).line - 1], 3, `${name}: the wait maps to the M3 line`);
        }
    }],

    // ---- syntax -----------------------------------------------------------------
    ['N words (Masso style)', () => expectRuns(L('N14 G00', 'N15 G20', 'N17 G90', 'N20 T4 M06', 'N21 G00 Z0.8000', 'N26 X0.0000 Y0.0000 F100.0', 'N29 G1 X1 Y1 Z-0.25 F100.0', 'N30 G2 X1.25 Y1.25 I0.25 J0'))],
    ['"*" checksums: valid ones are read, a bad one is refused', () => {
        const a = 'N10 G21 G90';
        const b = 'N20 G0 X10 Y10 Z5';
        expectRuns(`${a}*${checksum(a)}\n${b}*${checksum(b)}\n`);
        expectRefused(`${a}*${checksum(a)}\n${b}*${(checksum(b) + 1) & 0xFF}\n`, 2, /checksum/);
    }],
    ['comments: nested (), ; and % lines', () => expectRuns(L('%', '(header (nested) comment)', '', ';semicolon comment', 'G21 G90 (inline) ; tail', '   ', 'G0 X1 Y1 Z5', '(G1 X99 inside comment)', 'G1 Z-1 F100', 'G0 Z5', '%'))],
    ['block delete "/" is refused', () => expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', '/G1 Z-1 F300', 'G0 X10'), 3, /block delete/)],
    ['lowercase, no spaces, tabs, + and .5 / 5. numbers', () => expectRuns(L('g21 g90', 'g0x+10.y.5z5.', 'G1Z-.5F300', 'G1\tX+20\tY-0.5', 'G0 Z5'))],
    ['exponent numbers are refused', () => expectRefused(L('G21 G90', 'G0 X1e1 Y0 Z5'), 2, /e1/i)],
    ['long lines', () => expectRuns(L('G21 G90', 'G0 X10 Y10 Z5 (' + 'x'.repeat(4000) + ')', 'G1 Z-1 F300', 'G0 Z5'))],
    ['#variables and [expressions] are refused', () => expectRefused(L('G21 G90', '#1=5', 'G0 X#1 Y[2*3] Z5'), 2, /variable/)],
    ['O-word subroutines and M98 are refused; an O program number runs', () => {
        expectRefused(L('G21 G90', 'M98 P100', 'M30', 'O100', 'G0 X10 Y10 Z5', 'M99'), 2, /M98/);
        expectRefused(L('G21 G90', 'O100 sub', 'G0 X10 Y10 Z5', 'O100 endsub', 'O100 call'), 2, /subroutine/);
        expectRuns(L('O1000', 'G21 G90', 'G0 X10 Y10 Z5', 'G1 Z-1 F100'));
    }],
    ['Fanuc ":1248" program number runs', () => expectRuns(L('%', ':1248', 'N10G21G90', 'N20G0X10Y10Z5', 'N30G1Z-1F300', 'N40M30', '%'))],
    ['line endings: LF, CRLF, lone CR and mixed compile to the same program', () => {
        const base = ['G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X10', 'G1 Y10', 'G1 X0', 'G1 Y0', 'G0 Z5'];
        const variants = [['CR', base.join('\r') + '\r'], ['mixed', base.slice(0, 4).join('\n') + '\r' + base.slice(4, 6).join('\r\n') + '\r' + base.slice(6).join('\r') + '\n'], ['CRLF', base.join('\r\n') + '\r\n']];
        for (const [name, text] of variants) {
            try { expectRuns(text); } catch (e) { throw new Error(`${name} line endings: ${e.message}`); }
        }
        const lf = expectRuns(base.join('\n') + '\n');
        for (const [name, text] of variants) {
            const r = expectRuns(text);
            assert.deepStrictEqual(r.lines, lf.lines, `${name} line endings`);
            assert.deepStrictEqual(Array.from(r.meta.sourceLines), Array.from(lf.meta.sourceLines), `${name} file line numbers`);
        }
    }],
    ['UTF-8 BOM', () => expectRuns('﻿G21 G90\nG0 X10 Y10 Z5\nG1 Z-1 F300\nG1 X20\nG0 Z5\n')],
    ['non-ASCII comments and messages', () => {
        expectRuns(L('G21 G90 (Fräser Ø6mm — 深さ)', 'G0 X10 Y10 Z5 ; °', 'M0 (MSG, Wechsle das Werkzeug — Ø3)', 'G1 Z-1 F300', 'G0 Z5'), {
            check: (m) => assert.strictEqual(m.pauses[0].message, 'Wechsle das Werkzeug — Ø3'),
        });
    }],
    ['more than 65,535 lines: file line numbers stay exact', () => {
        const rows = ['G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-1 F300'];
        for (let i = 0; rows.length < 70000; i++) rows.push(`G1 X${(i % 100) / 10} Y${Math.floor(i / 100) / 10}`);
        const r = compile(rows.join('\n') + '\n');
        assert.strictEqual(r.compiled.meta.errorCount, 0, errorsOf(r.compiled.meta));
        const map = r.compiled.meta.sourceLines;
        assert.strictEqual(map[map.length - 1], 70000);
        assert.strictEqual(map[69000], 69001);
        rows[69989] = 'G92 X0';
        expectRefused(rows.join('\n') + '\n', 69990, /G92/);
    }],
    ['zero-length and Z-only moves', () => expectRuns(L('G21 G90', 'G0 X10 Y10 Z5', 'G0 X10 Y10 Z5', 'G1 Z-1 F300', 'G1 Z-1', 'G1 X10', 'G0 Z5'))],
    ['a repeated word or two motion words on one line is refused', () => {
        expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 X1 X2 F100'), 3, /X/);
        expectRefused(L('G21 G90', 'G0 G1 X1 Y1 Z5 F100'), 2, /G0.*G1|same group/);
        expectRefused(L('G20 G21 G90', 'G0 X1 Y1 Z5'), 1, /G20.*G21|same group/);
    }],
    ['rotary axes and 3D-printer E words are refused', () => {
        expectRefused(L('G21', 'G0 X0 A10'), 2, /rotary/);
        expectRefused(L('G21 G90', 'G0 X0 Y0 Z5', 'G1 X10 E0.5 F300'), 3, /E0\.5/);
    }],
    ['Z-only move while arc mode is active is refused', () => expectRefused(L('G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0', 'Z5'), 5, /arc/)],

    // ---- load result meta --------------------------------------------------------
    ['sourceLines maps comments-and-arcs programs to file lines', () => {
        const text = L('(header 1)', '(header 2)', 'G21 G90', 'G0 X10 Y0 Z5', '', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0', '(mid)', 'G1 X-20 Y0', 'G0 Z5');
        const { meta, lines } = expectRuns(text);
        const files = Array.from(meta.sourceLines);
        assert.deepStrictEqual([...new Set(files)], [3, 4, 6, 7, 9, 10]);
        assert.strictEqual(files.filter((f) => f === 7).length, lines.length - 5, 'every chord maps to the arc line');
        assert.strictEqual(meta.fileLineCount, 11);
    }],
    ['errors and warnings name FILE lines (header comments + an arc before the problem)', () => {
        const meta = expectRefused(L('(a)', '(b)', 'G21 G90', 'T1 M6', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0', 'G1 X0', 'T2 M6', 'G0 Z5'), 9, /tool change/);
        assert.ok(meta.errors.every((e) => e.line === null || e.line <= 11));
        const w = compile(L('(a)', '(b)', 'G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'G2 X-10 Y0 I-10 J0', 'G43 H1')).compiled.meta;
        assert.ok(w.warnings.some((x) => x.line === 7 && /G43/.test(x.msg)), JSON.stringify(w.warnings));
    }],
    ['extents in mm, units detected, origin hints', () => {
        expectRuns(L('G20 G90', 'G0 X0 Y0 Z0.2', 'G1 Z-0.1 F30', 'G1 X2', 'G1 Y1', 'G0 Z0.2'), {
            check: (meta) => {
                assert.ok(Math.abs(meta.extents.max.x - 50.8) < 1e-9 && Math.abs(meta.extents.min.z + 2.54) < 1e-9, JSON.stringify(meta.extents));
                assert.deepStrictEqual(meta.units, { declared: 'G20', program: 'inch', switches: 0 });
                assert.ok(meta.cutExtents && Math.abs(meta.cutExtents.max.y - 25.4) < 1e-9 && Math.abs(meta.cutExtents.max.z + 2.54) < 1e-9, JSON.stringify(meta.cutExtents));
                assert.deepStrictEqual([meta.origin.x, meta.origin.y, meta.origin.xy, meta.origin.z], ['min', 'min', 'lower-left', 'top']);
            },
        });
        expectRuns(L('G21 G90', 'G0 X-50 Y-40 Z5', 'G1 Z-3 F300', 'G1 X50', 'G1 Y40', 'G1 X-50', 'G0 Z5'), {
            check: (meta) => assert.deepStrictEqual([meta.origin.xy, meta.origin.z, meta.units.declared, meta.units.program], ['center', 'top', 'G21', 'mm']),
        });
        expectRuns(L('G0 X0 Y0 Z25', 'G1 Z12 F300', 'G1 X100 Y60', 'G0 Z25'), {
            check: (meta) => assert.deepStrictEqual([meta.origin.z, meta.units.declared, meta.units.program], ['bottom', null, 'mm']),
        });
        expectRuns(L('G21', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G20', 'G1 X1'), {
            check: (meta) => assert.deepStrictEqual(meta.units, { declared: 'G21', program: 'mixed', switches: 1 }),
        });
    }],
];

(function main() {
    console.log('Testing G-code dialect gate (every construct runs exactly or is refused at its file line)...');
    let failed = 0;
    for (const [name, fn] of CASES) {
        try {
            fn();
            console.log(`  ok    ${name}`);
        } catch (e) {
            failed++;
            // one line, but with the actual/expected values of a deepStrictEqual
            console.log(`  FAIL  ${name}\n        ${String(e && e.message).replace(/\s*\n\s*/g, ' ').slice(0, 400)}`);
        }
    }
    if (failed) {
        console.log(`\n${failed} of ${CASES.length} dialect cases failed`);
        process.exit(1);
    }
    console.log(`  ${CASES.length} dialect cases pass`);
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
})();
