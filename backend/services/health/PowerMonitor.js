/**
 * PowerMonitor — surfaces a starved power supply on the Raspberry Pi.
 *
 * On a Pi 5 the firmware asks the PSU over USB-PD whether it can deliver 5 A.
 * If it cannot, the Pi restricts everything downstream: total USB current is
 * capped at 600 mA across all ports. Plug a CNC controller in next to a USB
 * touchscreen and the pair exceeds that, so the panel simply stops responding.
 *
 * On the desktop OS this at least announces itself ("this power supply is not
 * capable of supplying 5A; power to peripherals will be restricted"). The
 * kiosk has no desktop and no notifications, so the warning goes nowhere and
 * the operator is left with a dead touchscreen and no explanation.
 *
 * Worse than a dead panel: an under-volted Pi can brown out mid-carve, and the
 * controller's host watchdog then stops the machine with the tool down. This
 * is a condition the operator needs to see before starting a job, not after.
 *
 * Reads vcgencmd, which is Pi-only. Everywhere else this reports "unknown" and
 * the UI shows nothing.
 */
const childProcess = require('child_process');

const POLL_MS = 30000;

// Bit meanings from the Raspberry Pi firmware's get_throttled word.
const UNDERVOLT_NOW = 0x1;
const CAPPED_NOW = 0x2;
const THROTTLED_NOW = 0x4;
const UNDERVOLT_EVER = 0x10000;
const THROTTLED_EVER = 0x40000;

class PowerMonitor {
    /**
     * @param {object}   [opts]
     * @param {object}   [opts.io]        Socket.IO server, for pushing changes
     * @param {object}   [opts.logger]
     * @param {string}   [opts.platform]
     * @param {Function} [opts.execFile]  childProcess.execFile override (tests)
     */
    constructor({ io, logger = console, platform = process.platform, execFile } = {}) {
        this.io = io;
        this._log = logger;
        this._platform = platform;
        this._execFile = execFile || childProcess.execFile;
        this._timer = null;
        this.state = { supported: false, ok: true };
    }

    start() {
        if (this._platform !== 'linux') return;
        const tick = () => {
            this.refresh().catch(() => { /* never throws; see refresh() */ });
        };
        tick();
        this._timer = setInterval(tick, POLL_MS);
        if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    _vcgencmd(args) {
        return new Promise((resolve) => {
            try {
                this._execFile('vcgencmd', args, { timeout: 4000 }, (err, stdout) => {
                    resolve(err ? null : String(stdout || '').trim());
                });
            } catch (_) {
                resolve(null);
            }
        });
    }

    /** Re-read the state and emit it if anything changed. Never rejects. */
    async refresh() {
        const out = await this._vcgencmd(['get_throttled']);
        // Not a Pi, or vcgencmd missing: say nothing rather than guess.
        if (!out) {
            this.state = { supported: false, ok: true };
            return this.state;
        }

        const match = /throttled=0x([0-9a-fA-F]+)/.exec(out);
        if (!match) {
            this.state = { supported: false, ok: true };
            return this.state;
        }
        const bits = parseInt(match[1], 16);

        const next = {
            supported: true,
            bits,
            underVoltageNow: !!(bits & UNDERVOLT_NOW),
            cappedNow: !!(bits & CAPPED_NOW),
            throttledNow: !!(bits & THROTTLED_NOW),
            underVoltageSinceBoot: !!(bits & UNDERVOLT_EVER),
            throttledSinceBoot: !!(bits & THROTTLED_EVER),
        };
        next.ok = !(next.underVoltageNow || next.throttledNow || next.cappedNow
            || next.underVoltageSinceBoot || next.throttledSinceBoot);
        next.message = PowerMonitor.describe(next);

        const changed = !this.state || this.state.bits !== next.bits;
        this.state = next;
        if (changed) {
            if (!next.ok) this._log.warn?.(`[Power] ${next.message} (throttled=0x${bits.toString(16)})`);
            try { this.io?.emit?.('health:power', next); } catch (_) { /* no sockets yet */ }
        }
        return next;
    }

    /** One sentence an operator can act on, or null when nothing is wrong. */
    static describe(s) {
        if (!s || s.ok) return null;
        if (s.underVoltageNow) {
            return 'The Pi is under-voltage right now. The power supply cannot keep up — '
                + 'the touchscreen or the controller can drop out, and a carve can stop mid-cut. '
                + 'Use the official 27 W supply, or power the controller from a powered USB hub.';
        }
        if (s.throttledNow || s.cappedNow) {
            return 'The Pi is throttling because of its power supply. Use the official 27 W '
                + 'supply, or power the controller from a powered USB hub.';
        }
        return 'The Pi lost power headroom at some point since it booted. If the touchscreen '
            + 'or the controller has dropped out, the supply is the reason. Use the official '
            + '27 W supply, or a powered USB hub for the controller.';
    }

    getStatus() {
        return this.state;
    }
}

module.exports = { PowerMonitor };
