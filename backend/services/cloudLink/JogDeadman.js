/**
 * Continuous remote jog as a stream of short, distance-bounded steps held
 * alive by client keepalives (spec §9.4).
 *
 * There is no "jog until told to stop" primitive we can trust over two TCP
 * legs (and RSP has no jog cancel at all), so the generator only ever
 * commands the next small step once telemetry shows the previous one is
 * nearly done. Losing every packet from now on therefore leaves at most
 * ~2 steps of travel.
 */
'use strict';

const defaultClock = require('./clock');
const MachineAdapter = require('./MachineAdapter');

const TICK_MS = 50;
const MAX_DURATION_MS = 60000;
const STALE_TELEMETRY_MS = 500;
const GAP_WINDOW_MS = 5 * 60 * 1000;
const GAP_MAX_SAMPLES = 20000;

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function round3(v) {
    return Math.round(v * 1000) / 1000;
}

class JogDeadman {
    /**
     * @param {object} opts
     * @param {() => object} opts.getEngine
     * @param {() => string|null} opts.getControllerType
     * @param {() => {x:number,y:number,z:number}|null} opts.getPosition
     * @param {() => number} opts.getTelemetryAgeMs
     * @param {(identity) => string[]} opts.getLocks
     * @param {(identity) => string} opts.getOwnerTier
     * @param {() => boolean} opts.isJobActive
     * @param {(info) => void} opts.onCancel      {jogId, identity, reason, commandedMm, progressMm}
     * @param {(activeJogOrNull) => void} opts.onActivity
     * @param {(steps, identity) => {ok, error}} [opts.dispatch]
     * @param {() => void} [opts.onStep]
     */
    constructor({
        getEngine, getControllerType, getPosition, getTelemetryAgeMs, getLocks, getOwnerTier,
        isJobActive, onCancel, onActivity, dispatch, onStep,
        clock = defaultClock, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
        deadmanMs = 400, maxDurationMs = MAX_DURATION_MS, tickMs = TICK_MS,
    } = {}) {
        this.getEngine = getEngine || (() => null);
        this.getControllerType = getControllerType || (() => null);
        this.getPosition = getPosition || (() => null);
        this.getTelemetryAgeMs = getTelemetryAgeMs || (() => Infinity);
        this.getLocks = getLocks || (() => []);
        this.getOwnerTier = getOwnerTier || (() => 'monitor');
        this.isJobActive = isJobActive || (() => false);
        this.onCancel = onCancel || (() => {});
        this.onActivity = onActivity || (() => {});
        this.onStep = onStep || (() => {});
        this.dispatch = dispatch || ((steps, identity) => MachineAdapter.run(this.getEngine(), identity, steps));
        this.clock = clock;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.deadmanMs = clamp(Number(deadmanMs) || 400, 400, 500);
        this.maxDurationMs = maxDurationMs;
        this.tickMs = tickMs;

        this.lease = null;
        this._timer = null;
        this.stats = { deadmanCancels: 0 };
        this._gaps = [];
    }

    isActive() {
        return !!this.lease;
    }

    /** report.tier.activeJog (userLabel is a display name; the gate redacts it for LAN views). */
    activeJog() {
        if (!this.lease) return null;
        const id = this.lease.identity || {};
        return {
            jogId: this.lease.jogId,
            userLabel: id.userLabel || null,
            axis: this.lease.axis,
            dir: this.lease.dir,
        };
    }

    ownedBy(identity) {
        return !!(this.lease && sameOwner(this.lease.identity, identity));
    }

    /**
     * @returns {{ok:boolean, code:string, message?:string}}
     */
    start({ jogId, identity, axis, dir, feed }) {
        if (this.lease) return { ok: false, code: 'JOG_ACTIVE' };
        const pos = this.getPosition() || { x: 0, y: 0, z: 0 };
        const now = this.clock.mono();
        const type = this.getControllerType();
        this.lease = {
            jogId,
            identity,
            axis,
            dir,
            feed,
            controllerType: type,
            stepMm: round3(clamp((feed / 60) * 0.2, 0.05, MachineAdapter.maxStepMm(type))),
            startedAt: now,
            lastKeepaliveAt: now,
            startPos: { x: Number(pos.x) || 0, y: Number(pos.y) || 0, z: Number(pos.z) || 0 },
            commandedMm: 0,
            lastStepAt: -Infinity,
        };
        this._timer = this.setIntervalFn(() => this.tick(), this.tickMs);
        if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
        this.onActivity(this.activeJog());
        this.tick();
        return { ok: true, code: 'OK' };
    }

    /**
     * @returns {{ok:boolean, code:string}}
     */
    keepalive(jogId, identity) {
        const lease = this.lease;
        if (!lease || lease.jogId !== jogId || !sameOwner(lease.identity, identity)) {
            return { ok: false, code: 'EXPIRED' };
        }
        const now = this.clock.mono();
        // The deadman is a promise about the gap, not about when the next
        // tick happens to run: a keepalive that arrives after the window has
        // already lapsed must end the jog, never revive it (§3.4.5).
        if (now - lease.lastKeepaliveAt > this.deadmanMs) {
            this.cancel('deadman');
            return { ok: false, code: 'EXPIRED' };
        }
        this._recordGap(now, now - lease.lastKeepaliveAt);
        lease.lastKeepaliveAt = now;
        return { ok: true, code: 'OK' };
    }

    /**
     * Owner stop. Returns true when a jog was cancelled.
     */
    stopOwned(identity, jogId) {
        const lease = this.lease;
        if (!lease || !sameOwner(lease.identity, identity)) return false;
        if (jogId !== undefined && jogId !== lease.jogId) return false;
        this.cancel('owner-stop');
        return true;
    }

    cancelWhere(predicate, reason) {
        if (this.lease && predicate(this.lease.identity, this.lease)) {
            this.cancel(reason);
            return true;
        }
        return false;
    }

    progressMm() {
        const lease = this.lease;
        if (!lease) return 0;
        const pos = this.getPosition();
        if (!pos || !Number.isFinite(Number(pos[lease.axis]))) return 0;
        return Math.abs(Number(pos[lease.axis]) - lease.startPos[lease.axis]);
    }

    tick() {
        const lease = this.lease;
        if (!lease) return;
        const now = this.clock.mono();
        if (now - lease.lastKeepaliveAt > this.deadmanMs) return this.cancel('deadman');
        if (now - lease.startedAt > this.maxDurationMs) return this.cancel('max-duration');
        if (!(this.getTelemetryAgeMs() <= STALE_TELEMETRY_MS)) return this.cancel('stale-telemetry');
        if (this.getLocks(lease.identity).length > 0) return this.cancel('lock');
        if (this.getOwnerTier(lease.identity) !== 'motion') return this.cancel('tier');
        if (this.isJobActive()) return this.cancel('job-active');

        const feedPerSec = lease.feed / 60;
        const outstanding = lease.commandedMm - this.progressMm();
        const spacingMs = 0.8 * lease.stepMm / feedPerSec * 1000;
        if (outstanding < lease.stepMm && now - lease.lastStepAt >= spacingMs) {
            const steps = MachineAdapter.plan(lease.controllerType, 'jog.cont.step', {
                axis: lease.axis,
                distanceMm: round3(lease.dir * lease.stepMm),
                feed: lease.feed,
            });
            lease.commandedMm = round3(lease.commandedMm + lease.stepMm);
            lease.lastStepAt = now;
            // A failed step needs no special handling: progress stops, so the
            // ledger issues nothing more and the lock/telemetry checks end it.
            this.dispatch(steps, lease.identity);
            this.onStep();
        }
    }

    /**
     * Idempotent: a second call (or a call with no jog) does nothing.
     */
    cancel(reason) {
        const lease = this.lease;
        if (!lease) return false;
        if (this._timer) this.clearIntervalFn(this._timer);
        this._timer = null;
        const progressMm = round3(this.progressMm());
        this.lease = null;
        try {
            const steps = MachineAdapter.plan(lease.controllerType, 'jog.cancel', {});
            if (steps.length) this.dispatch(steps, lease.identity);
        } catch (_) { /* nothing to send for this controller */ }
        if (reason === 'deadman') this.stats.deadmanCancels += 1;
        this.onActivity(null);
        this.onCancel({
            jogId: lease.jogId,
            identity: lease.identity,
            reason,
            commandedMm: lease.commandedMm,
            progressMm,
        });
        return true;
    }

    keepaliveGapP99Ms() {
        const now = this.clock.mono();
        while (this._gaps.length && now - this._gaps[0].at > GAP_WINDOW_MS) this._gaps.shift();
        if (!this._gaps.length) return null;
        const sorted = this._gaps.map(g => g.gap).sort((a, b) => a - b);
        return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]);
    }

    getStats() {
        return { deadmanCancels: this.stats.deadmanCancels, keepaliveGapP99Ms: this.keepaliveGapP99Ms() };
    }

    dispose() {
        if (this._timer) this.clearIntervalFn(this._timer);
        this._timer = null;
        this.lease = null;
    }

    _recordGap(now, gap) {
        this._gaps.push({ at: now, gap });
        if (this._gaps.length > GAP_MAX_SAMPLES) this._gaps.shift();
    }
}

function sameOwner(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === 'cloud') return !!a.connId && a.connId === b.connId;
    if (a.kind === 'lan') return !!a.socketId && a.socketId === b.socketId;
    return false;
}

module.exports = { JogDeadman, sameOwner, TICK_MS };
