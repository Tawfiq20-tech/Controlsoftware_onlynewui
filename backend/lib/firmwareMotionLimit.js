'use strict';

/**
 * Feed limiting for the RSP firmware's motion shape (fw 0.1.x / 0.2.0,
 * stepper.c jogeng_begin_leg + TIM2_IRQHandler).
 *
 * Why: the firmware runs every line as its own leg with no look-ahead. A leg
 * starts at 25% of its feed instantly (step delay 4x cruise, capped at
 * 3 ms), ramps to cruise over the first quarter of its steps (at most 200),
 * ramps back down over the last quarter, and the next leg starts from its
 * own 25% in whatever direction it points. On 3D relief finishing (DRAGON
 * FINISH: 0.15-1.4 mm legs at 3175-6350 mm/min, Z reversing every leg) that
 * asks ~9,000 mm/s^2 of X and ~20 mm/s instantaneous Z reversals -- far past
 * what the machine can follow, so the smallest features (teeth, eyes) were
 * rounded off although every line was sent exactly.
 *
 * What: lower F on exactly the legs whose firmware motion would exceed a
 * per-axis acceleration (inside the ramp) or an instantaneous speed change
 * (between legs). Long and gently-sloped legs keep their programmed feed.
 * Positions are never touched; only the F word of a motion line changes.
 */

const STEPS_PER_MM = 200;
const MIN_DELAY_S = 60e-6;     // stepper.c floor
const MAX_START_DELAY_S = 3000e-6;
const MAX_RAMP_STEPS = 200;
const MIN_FEED_MM_S = 0.5;     // never slower than 30 mm/min
const AXES = ['x', 'y', 'z'];

const DEFAULT_LIMITS = {
    maxAccel: { x: 3000, y: 3000, z: 3000 }, // mm/s^2 inside a leg's ramp
    maxJump: { x: 15, y: 15, z: 15 },       // mm/s instantaneous change between legs
};

const MOTION_RE = /^G21 G90 G([01])((?: [XYZ]-?\d+\.\d+)+) F(\d+(?:\.\d+)?)(.*)$/;
const AXIS_RE = /([XYZ])(-?\d+\.\d+)/g;

/** Firmware motion of one leg at path speed v (mm/s). */
function legShape(leg, v) {
    const { len, steps } = leg;
    let delay = len / (v * steps);
    if (delay < MIN_DELAY_S) delay = MIN_DELAY_S;
    const cruise = len / (steps * delay);
    let startDelay = Math.min(MAX_START_DELAY_S, delay * 4);
    if (startDelay < delay) startDelay = delay;
    const rampSteps = Math.min(MAX_RAMP_STEPS, Math.floor(steps / 4));
    const ramps = rampSteps > 0 && startDelay > delay;
    const edge = ramps ? len / (steps * startDelay) : cruise; // speed at both ends of the leg
    let accel = 0;
    if (ramps) {
        const rampLen = (rampSteps / steps) * len;
        accel = (cruise * cruise - edge * edge) / (2 * rampLen);
    }
    return { cruise, edge, accel };
}

function accelOk(leg, v, lim) {
    const s = legShape(leg, v);
    for (const k of AXES) {
        if (s.accel * Math.abs(leg.u[k]) > lim.maxAccel[k] + 1e-9) return false;
    }
    return true;
}

/** Each leg's own speed at its ends is at most half the allowed change, per axis. */
function halfEdgeOk(leg, v, lim) {
    const e = legShape(leg, v).edge;
    for (const k of AXES) {
        if (e * Math.abs(leg.u[k]) > lim.maxJump[k] / 2 + 1e-9) return false;
    }
    return true;
}

function jumpOk(prev, vPrev, leg, v, lim) {
    if (!prev) return true;
    const ep = legShape(prev, vPrev).edge;
    const sn = legShape(leg, v).edge;
    for (const k of AXES) {
        if (Math.abs(sn * leg.u[k] - ep * prev.u[k]) > lim.maxJump[k] + 1e-9) return false;
    }
    return true;
}

/**
 * Largest v in [lo, hi] with ok(v) true, assuming ok turns false once as v
 * rises. If even lo fails, lowering this leg cannot help (e.g. it is already
 * slower than a same-direction neighbour): return hi unchanged and let the
 * other pass lower the neighbour instead.
 */
function searchMax(lo, hi, ok) {
    if (ok(hi)) return hi;
    if (!ok(lo)) return hi;
    for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (ok(mid)) lo = mid; else hi = mid;
    }
    return lo;
}

function normLimits(limits) {
    const l = limits || {};
    const pick = (src, def) => {
        const out = {};
        for (const k of AXES) {
            const v = src && Number(src[k]);
            out[k] = Number.isFinite(v) && v > 0 ? v : def[k];
        }
        return out;
    };
    return {
        maxAccel: pick(l.maxAccel, DEFAULT_LIMITS.maxAccel),
        maxJump: pick(l.maxJump, DEFAULT_LIMITS.maxJump),
    };
}

function fmtFeed(mmMin) {
    return String(Math.max(1, Math.round(mmMin * 10) / 10));
}

/**
 * @param {string[]} lines compiled wire lines (lib/wireCompiler.js output)
 * @param {{maxAccel?:{x,y,z}, maxJump?:{x,y,z}}} [limits]
 * @returns {{ lines: string[], limited: Uint8Array, limitedCount: number }}
 *   limited[i] = 1 when line i+1 had its feed lowered
 */
function limitFeeds(lines, limits) {
    const lim = normLimits(limits);
    const legs = []; // {idx, len, steps, u, v, vOrig, head, axes, tail}
    const pos = { x: null, y: null, z: null };

    for (let i = 0; i < lines.length; i++) {
        const m = MOTION_RE.exec(lines[i]);
        if (!m) continue;
        const to = { ...pos };
        AXIS_RE.lastIndex = 0;
        let a;
        while ((a = AXIS_RE.exec(m[2])) !== null) to[a[1].toLowerCase()] = parseFloat(a[2]);
        const d = {};
        let len2 = 0;
        let steps = 0;
        for (const k of AXES) {
            d[k] = (pos[k] !== null && to[k] !== null) ? to[k] - pos[k] : 0;
            len2 += d[k] * d[k];
            steps = Math.max(steps, Math.round(Math.abs(d[k]) * STEPS_PER_MM));
        }
        Object.assign(pos, to);
        const len = Math.sqrt(len2);
        if (steps === 0 || len === 0) {
            legs.push(null); // no motion: the machine is stopped before the next leg
            continue;
        }
        const u = { x: d.x / len, y: d.y / len, z: d.z / len };
        const vOrig = parseFloat(m[3]) / 60;
        legs.push({ idx: i, len, steps, u, vOrig, v: vOrig, m });
    }

    // 1. acceleration inside each leg (independent of neighbours)
    for (const leg of legs) {
        if (!leg || leg.vOrig <= MIN_FEED_MM_S) continue;
        leg.v = searchMax(MIN_FEED_MM_S, leg.vOrig, (v) => accelOk(leg, v, lim));
    }

    // 2. speed change between consecutive legs: forward lowers the later leg,
    //    backward lowers the earlier one (a reversal needs both slow).
    for (let iter = 0; iter < 8; iter++) {
        let changed = false;
        for (let i = 1; i < legs.length; i++) {
            const prev = legs[i - 1], leg = legs[i];
            if (!prev || !leg || jumpOk(prev, prev.v, leg, leg.v, lim)) continue;
            const v = searchMax(MIN_FEED_MM_S, leg.v, (x) => jumpOk(prev, prev.v, leg, x, lim));
            if (v < leg.v) { leg.v = v; changed = true; }
        }
        for (let i = legs.length - 1; i >= 1; i--) {
            const prev = legs[i - 1], leg = legs[i];
            if (!prev || !leg || jumpOk(prev, prev.v, leg, leg.v, lim)) continue;
            const v = searchMax(MIN_FEED_MM_S, prev.v, (x) => jumpOk(prev, x, leg, leg.v, lim));
            if (v < prev.v) { prev.v = v; changed = true; }
        }
        // Neither leg alone can fix it (e.g. a Z plunge straight into an X
        // move: each is too fast on its own axis). Slow both until each
        // contributes at most half the allowed change -- always satisfiable.
        for (let i = 1; i < legs.length; i++) {
            const prev = legs[i - 1], leg = legs[i];
            if (!prev || !leg || jumpOk(prev, prev.v, leg, leg.v, lim)) continue;
            for (const l of [prev, leg]) {
                const v = searchMax(MIN_FEED_MM_S, l.v, (x) => halfEdgeOk(l, x, lim));
                if (v < l.v) { l.v = v; changed = true; }
            }
        }
        if (!changed) break;
    }

    const out = lines.slice();
    const limited = new Uint8Array(lines.length);
    let limitedCount = 0;
    for (const leg of legs) {
        if (!leg || leg.v >= leg.vOrig - 1e-6) continue;
        const f = fmtFeed(leg.v * 60);
        if (f === leg.m[3]) continue;
        out[leg.idx] = `G21 G90 G${leg.m[1]}${leg.m[2]} F${f}${leg.m[4]}`;
        limited[leg.idx] = 1;
        limitedCount++;
    }
    return { lines: out, limited, limitedCount };
}

/**
 * Worst motor demand and run time of compiled lines under the firmware's
 * motion shape -- for reports and tests.
 */
function analyze(lines) {
    const pos = { x: null, y: null, z: null };
    let prev = null, prevV = 0, seconds = 0;
    const worst = { accel: { x: 0, y: 0, z: 0 }, jump: { x: 0, y: 0, z: 0 } };
    for (const line of lines) {
        const m = MOTION_RE.exec(line);
        if (!m) continue;
        const to = { ...pos };
        AXIS_RE.lastIndex = 0;
        let a;
        while ((a = AXIS_RE.exec(m[2])) !== null) to[a[1].toLowerCase()] = parseFloat(a[2]);
        const d = {};
        let len2 = 0, steps = 0;
        for (const k of AXES) {
            d[k] = (pos[k] !== null && to[k] !== null) ? to[k] - pos[k] : 0;
            len2 += d[k] * d[k];
            steps = Math.max(steps, Math.round(Math.abs(d[k]) * STEPS_PER_MM));
        }
        Object.assign(pos, to);
        const len = Math.sqrt(len2);
        if (!steps || !len) { prev = null; continue; }
        const leg = { len, steps, u: { x: d.x / len, y: d.y / len, z: d.z / len } };
        const v = parseFloat(m[3]) / 60;
        const s = legShape(leg, v);
        const pe = prev ? legShape(prev, prevV).edge : 0;
        for (const k of AXES) {
            worst.accel[k] = Math.max(worst.accel[k], s.accel * Math.abs(leg.u[k]));
            const from = prev ? pe * prev.u[k] : 0;
            // the very first leg starting from rest is the firmware's own choice, not a jump between legs
            if (prev) worst.jump[k] = Math.max(worst.jump[k], Math.abs(s.edge * leg.u[k] - from));
        }
        const rampSteps = Math.min(MAX_RAMP_STEPS, Math.floor(steps / 4));
        const cruiseT = len / s.cruise;
        const edgeT = len / Math.max(s.edge, 1e-9);
        seconds += s.accel > 0
            ? cruiseT * (steps - 2 * rampSteps) / steps + ((cruiseT + edgeT) / 2) * (2 * rampSteps) / steps
            : cruiseT;
        prev = leg; prevV = v;
    }
    return { worst, seconds };
}

module.exports = { limitFeeds, analyze, legShape, DEFAULT_LIMITS, normLimits };
