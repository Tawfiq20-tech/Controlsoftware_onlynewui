/**
 * The design queue: run a list of designs one after another.
 *
 * WHAT THIS CAN AND CANNOT DO
 *
 * Nothing in this product switches the router on or off. RSPController has no
 * spindle output ("no spindle or laser hardware wired on this board"), so M3
 * and M5 are refused -- the router is a hand-switched VFD. Everything below
 * follows from that one fact:
 *
 *   gate mode (the default)  The next design is loaded and checked the moment
 *                            the last one finishes, and the screen shows
 *                            "Start design 4 of 5". The operator taps once.
 *                            They were walking over to check the router
 *                            anyway; what this removes is finding the file,
 *                            loading it, and re-zeroing.
 *
 *   auto mode (opt-in)       The next design starts on its own after a
 *                            countdown anyone standing there can cancel.
 *                            This is only sane when the router STAYS RUNNING
 *                            between the two designs -- a roughing pass
 *                            followed by a finishing pass on the same
 *                            workpiece, same zero, same tool. With the router
 *                            switched off, design 2 would cut with a stopped
 *                            tool; with a new workpiece to clamp, it would cut
 *                            air or the clamps. The operator turns this on per
 *                            queue, never by default.
 *
 * WHAT THE QUEUE REFUSES TO DO
 *
 * It advances only past a design IT started and that finished on its own. A
 * stopped job, a failed job, an alarm, an E-stop, a controller restart, a load
 * the machine refused, or a position the board is no longer sure of all put
 * the queue in `held` and leave it there until someone at the machine decides.
 * It never resumes: every queued design runs through gcode:startFresh, which
 * is "line 1, or refuse" -- so a design that was stopped half way through
 * earlier cannot be silently continued on fresh stock.
 *
 * On a restart the queue comes back with its list intact and ARMED FALSE. A
 * screen that reboots, or a Pi that browns out, must never come back and start
 * a carve by itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILENAME = 'queue.json';
const SCHEMA_VERSION = 1;

/** How long to wait for the end-of-job return to origin before loading anyway. */
const RETURN_TIMEOUT_MS = 90_000;

/** Auto mode: the countdown the operator can cancel, in seconds. */
const AUTO_DELAY_DEFAULT_S = 10;
const AUTO_DELAY_MIN_S = 5;
const AUTO_DELAY_MAX_S = 300;

const STATES = Object.freeze({
    idle: 'idle',           // nothing to do, or not armed
    loading: 'loading',     // putting the next design on the controller
    gate: 'gate',           // loaded and checked; waiting for the operator's tap
    countdown: 'countdown', // auto mode; starting when the countdown runs out
    running: 'running',     // a queued design is cutting
    returning: 'returning', // it finished; the machine is going back to X0 Y0
    held: 'held',           // something needs a person; the reason is in `message`
    done: 'done',           // every entry finished
});

class QueueService {
    constructor({ dataDir, io, logger, getController, getEngine, libraryService } = {}) {
        this.dataDir = dataDir;
        this.io = io || { emit() {} };
        this.log = logger || { info() {}, warn() {}, error() {} };
        this.getController = getController || (() => null);
        this.getEngine = getEngine || (() => null);
        this.library = libraryService || null;
        this.filePath = dataDir ? path.join(dataDir, FILENAME) : null;

        this.entries = [];
        this.mode = 'gate';
        this.autoDelaySec = AUTO_DELAY_DEFAULT_S;
        this.armed = false;
        this.state = STATES.idle;
        this.message = '';
        this.activeId = null;    // the entry the machine is cutting now
        this.gateId = null;      // the entry loaded and waiting to be started
        this.countdownEndsAt = 0;

        this._attachedController = null;
        this._returnTimer = null;
        this._countdownTimer = null;
        this._preparing = false;

        this._load();
    }

    // ─── State ───────────────────────────────────────────────────────

    getState() {
        const done = this.entries.filter((e) => e.status === 'done').length;
        const pending = this.entries.filter((e) => e.status === 'pending').length;
        return {
            state: this.state,
            armed: this.armed,
            mode: this.mode,
            autoDelaySec: this.autoDelaySec,
            message: this.message,
            // Auto mode only: when the next design starts if nobody stops it.
            countdownEndsAt: this.state === STATES.countdown ? this.countdownEndsAt : 0,
            entries: this.entries.map((e) => ({ ...e })),
            activeId: this.activeId,
            gateId: this.gateId,
            total: this.entries.length,
            done,
            pending,
            // What the screen puts on the button: "Start design 4 of 5".
            position: this._positionOf(this.gateId || this.activeId),
            // The router is the operator's to switch. Say so wherever the
            // queue is shown, not only where auto mode is turned on.
            spindleControl: false,
        };
    }

    _positionOf(entryId) {
        if (!entryId) return 0;
        const i = this.entries.findIndex((e) => e.id === entryId);
        return i < 0 ? 0 : i + 1;
    }

    _emit() {
        try { this.io.emit('queue:state', this.getState()); } catch (_) { /* never break on a broadcast */ }
    }

    _set(state, message = '') {
        this.state = state;
        this.message = message;
        this._emit();
    }

    // ─── The list ────────────────────────────────────────────────────

    /**
     * Add a design from the library. Only the id and the name are kept: the
     * G-code itself stays in the library, so a queue of ten 17 MB designs
     * costs a few hundred bytes on the card, and the file that runs is always
     * the one the library holds now.
     */
    add(libraryId) {
        if (!this.library) return { ok: false, error: 'the library is not available' };
        const meta = this.library.get(String(libraryId || ''));
        if (!meta) return { ok: false, error: 'that design is not in the library' };
        // A design someone sent from off the machine is not runnable until
        // the operator has opened it and said so (RemoteCommandGate answers
        // REVIEW_REQUIRED for the same file). The queue is a way to run
        // designs, so it honours that too -- otherwise queueing would be the
        // way around the review.
        if (meta.provenance && meta.provenance.origin === 'cloud' && !meta.provenance.reviewed) {
            return { ok: false, error: 'review_required', message: `"${meta.name || meta.fileName}" came in from off the machine. Open it in the Library and review it before queueing it.` };
        }
        const entry = {
            id: crypto.randomBytes(8).toString('hex'),
            libraryId: meta.id,
            name: meta.name || meta.fileName || meta.id,
            fileName: meta.fileName || meta.name || '',
            size: Number(meta.size) || 0,
            status: 'pending',
            error: null,
            retryable: false,
            addedAt: Date.now(),
            startedAt: 0,
            finishedAt: 0,
        };
        this.entries.push(entry);
        this._save();
        if (this.state === STATES.done) this._set(STATES.idle, '');
        else this._emit();
        return { ok: true, entry: { ...entry } };
    }

    /** Take an entry out. The one that is cutting stays. */
    remove(entryId) {
        if (entryId && entryId === this.activeId) {
            return { ok: false, error: 'that design is running -- stop the job first' };
        }
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => e.id !== entryId);
        if (this.entries.length === before) return { ok: false, error: 'not in the queue' };
        if (entryId === this.gateId) {
            // The design waiting at the gate was removed: nothing is loaded to
            // start any more, so do not leave a Start button pointing at it.
            this.gateId = null;
            this._cancelCountdown();
            this._set(STATES.idle, 'The design waiting to start was removed from the queue.');
        }
        this._save();
        this._emit();
        return { ok: true };
    }

    /** Move an entry up (-1) or down (+1). */
    move(entryId, delta) {
        const i = this.entries.findIndex((e) => e.id === entryId);
        if (i < 0) return { ok: false, error: 'not in the queue' };
        const j = i + (Number(delta) < 0 ? -1 : 1);
        if (j < 0 || j >= this.entries.length) return { ok: false, error: 'already at the end' };
        if (this.entries[i].id === this.activeId || this.entries[j].id === this.activeId) {
            return { ok: false, error: 'that design is running -- stop the job first' };
        }
        const [moved] = this.entries.splice(i, 1);
        this.entries.splice(j, 0, moved);
        this._save();
        this._emit();
        return { ok: true };
    }

    /** Empty the queue. Refused while a queued design is cutting. */
    clear() {
        if (this.activeId) return { ok: false, error: 'a design is running -- stop the job first' };
        this.entries = [];
        this.gateId = null;
        this.armed = false;
        this._cancelCountdown();
        this._clearReturnTimer();
        this._save();
        this._set(STATES.idle, '');
        return { ok: true };
    }

    /** Put every finished/failed/skipped entry back to pending, in place. */
    resetAll() {
        if (this.activeId) return { ok: false, error: 'a design is running -- stop the job first' };
        for (const e of this.entries) {
            e.status = 'pending';
            e.error = null;
            e.retryable = false;
            e.startedAt = 0;
            e.finishedAt = 0;
        }
        this.gateId = null;
        this._save();
        this._set(STATES.idle, '');
        return { ok: true };
    }

    // ─── Settings ────────────────────────────────────────────────────

    /**
     * 'gate'  -- the operator taps Start for each design (default).
     * 'auto'  -- the next design starts after a countdown.
     *
     * Auto is refused unless the caller says, in the request, that they know
     * the router keeps running between designs. This machine cannot switch it:
     * with the router off, the next design would cut with a stopped tool.
     */
    setMode(mode, { routerStaysRunningAcknowledged = false } = {}) {
        const want = String(mode || '').toLowerCase();
        if (want !== 'gate' && want !== 'auto') return { ok: false, error: 'mode must be gate or auto' };
        if (want === 'auto' && !routerStaysRunningAcknowledged) {
            return {
                ok: false,
                error: 'router_not_controlled',
                message: 'This machine cannot switch the router on or off. In auto mode the next design '
                    + 'starts with the router in whatever state you left it -- use it for passes on the '
                    + 'same workpiece with the router still running, not for a new piece.',
            };
        }
        this.mode = want;
        if (want === 'gate') this._cancelCountdown(STATES.gate);
        this._save();
        this._emit();
        return { ok: true, mode: this.mode };
    }

    setAutoDelay(seconds) {
        const s = Math.round(Number(seconds));
        if (!Number.isFinite(s) || s < AUTO_DELAY_MIN_S || s > AUTO_DELAY_MAX_S) {
            return { ok: false, error: `the countdown must be between ${AUTO_DELAY_MIN_S} and ${AUTO_DELAY_MAX_S} seconds` };
        }
        this.autoDelaySec = s;
        this._save();
        this._emit();
        return { ok: true, autoDelaySec: s };
    }

    // ─── Arming ──────────────────────────────────────────────────────

    /**
     * Arming loads the first pending design and stops at the gate. It does not
     * start anything: the first design needs a tap like every other one.
     */
    async setArmed(on) {
        const want = !!on;
        this.armed = want;
        this._save();
        if (!want) {
            this._cancelCountdown();
            this._clearReturnTimer();
            if (this.state !== STATES.running) this._set(STATES.idle, 'The queue is off.');
            else this._emit();
            return { ok: true, state: this.getState() };
        }
        this._attach();
        if (this.state === STATES.running) { this._emit(); return { ok: true, state: this.getState() }; }
        // A design that failed before the machine ever moved -- no connection,
        // a file that had been deleted, a load the controller refused -- goes
        // back in the list when the operator arms again, because what they
        // just did was fix it. One that stopped part way through a cut does
        // NOT: that piece has half a design in it, and running it from line 1
        // is the operator's decision, not the queue's.
        for (const e of this.entries) {
            if (e.status === 'failed' && e.retryable) {
                e.status = 'pending';
                e.error = null;
                e.retryable = false;
            }
        }
        await this._prepareNext();
        return { ok: true, state: this.getState() };
    }

    // ─── Starting ────────────────────────────────────────────────────

    /**
     * The gate tap, and the end of the auto countdown. Every check runs HERE,
     * not when the design was loaded: the machine can have gone into alarm, or
     * lost its position, in the minutes a design sat at the gate.
     */
    startNext() {
        this._cancelCountdown(null);
        if (this.state !== STATES.gate && this.state !== STATES.countdown) {
            return { ok: false, error: 'nothing is waiting to start' };
        }
        const entry = this.entries.find((e) => e.id === this.gateId);
        if (!entry) {
            this._set(STATES.idle, 'The design waiting to start is no longer in the queue.');
            return { ok: false, error: 'nothing is waiting to start' };
        }
        this._attach();

        const blocked = this._blockReason();
        if (blocked) {
            this._set(STATES.held, `Not started: ${blocked}.`);
            return { ok: false, error: blocked };
        }

        // The design on the controller must still be the one this entry loaded.
        // Someone at the machine can load another file while the queue waits.
        const engine = this.getEngine();
        const loaded = engine && engine.loadedFile;
        if (!loaded || loaded.name !== entry.name) {
            this._set(STATES.held, `Not started: the machine now holds "${(loaded && loaded.name) || 'no file'}", not "${entry.name}". Load it again from the queue.`);
            return { ok: false, error: 'a different file is loaded' };
        }

        // gcode:startFresh refuses rather than resuming; a refusal arrives on
        // the controller's 'error' channel (RSPController._refuse).
        const ctl = this.getController();
        const refusals = [];
        const onErr = (e) => refusals.push((e && e.message) || String(e));
        if (ctl && typeof ctl.on === 'function') ctl.on('error', onErr);
        try {
            engine._handleCommand(this._fakeSocket(), null, 'gcode:startFresh');
        } catch (err) {
            refusals.push((err && err.message) || String(err));
        } finally {
            if (ctl && typeof ctl.removeListener === 'function') ctl.removeListener('error', onErr);
        }
        if (refusals.length) {
            this._set(STATES.held, `Not started: ${refusals[0]}`);
            return { ok: false, error: refusals[0] };
        }

        entry.status = 'running';
        entry.startedAt = Date.now();
        entry.error = null;
        this.activeId = entry.id;
        this.gateId = null;
        this._save();
        this._set(STATES.running, `Running design ${this._positionOf(entry.id)} of ${this.entries.length}: ${entry.name}`);
        this.log.info?.(`[Queue] started ${entry.name} (${this._positionOf(entry.id)}/${this.entries.length})`);
        return { ok: true, state: this.getState() };
    }

    /** Auto mode: stop the countdown and wait for a tap instead. */
    hold() {
        if (this.state !== STATES.countdown) return { ok: false, error: 'nothing is counting down' };
        this._cancelCountdown(null);
        this._set(STATES.gate, 'Held. Tap Start when you are ready.');
        return { ok: true };
    }

    /** Give up on the design at the gate and prepare the one after it. */
    async skip() {
        const entry = this.entries.find((e) => e.id === this.gateId)
            || this.entries.find((e) => e.status === 'pending');
        if (!entry) return { ok: false, error: 'nothing to skip' };
        if (entry.id === this.activeId) return { ok: false, error: 'that design is running -- stop the job first' };
        entry.status = 'skipped';
        this.gateId = null;
        this._cancelCountdown(null);
        this._save();
        this.log.info?.(`[Queue] skipped ${entry.name}`);
        await this._prepareNext();
        return { ok: true, state: this.getState() };
    }

    // ─── Preparing the next design ───────────────────────────────────

    /**
     * Load the next pending design and stop. Loading moves nothing: it hands
     * the program to the controller so the start is one command later, and so
     * a file the machine cannot run is found NOW rather than at the tap.
     */
    async _prepareNext() {
        if (this._preparing) return;
        this._clearReturnTimer();
        if (!this.armed) { this._set(STATES.idle, ''); return; }

        const entry = this.entries.find((e) => e.status === 'pending');
        if (!entry) {
            this.gateId = null;
            this.armed = false;
            this._save();
            const any = this.entries.some((e) => e.status === 'done');
            this._set(STATES.done, any ? 'Every design in the queue is finished.' : 'Nothing left in the queue.');
            return;
        }

        this._preparing = true;
        this._set(STATES.loading, `Loading ${entry.name}…`);
        try {
            const engine = this.getEngine();
            if (!engine) { this._holdEntry(entry, 'the machine is not connected'); return; }

            let body;
            try {
                body = this.library ? this.library.getBody(entry.libraryId) : null;
            } catch (err) {
                body = null;
            }
            if (!body) { this._holdEntry(entry, 'that design is no longer in the library'); return; }

            const result = await engine._handleFileLoad(this._fakeSocket(), { name: entry.name, content: body });
            if (!result || result.ok === false) {
                this._holdEntry(entry, (result && result.reason) || 'the machine would not load it');
                return;
            }

            this.gateId = entry.id;
            const pos = `${this._positionOf(entry.id)} of ${this.entries.length}`;
            if (this.mode === 'auto') {
                this._startCountdown(entry, pos);
            } else {
                this._set(STATES.gate, `Ready: design ${pos}, ${entry.name}. Tap Start.`);
            }
        } catch (err) {
            this._holdEntry(entry, (err && err.message) || String(err));
        } finally {
            this._preparing = false;
        }
    }

    _holdEntry(entry, why) {
        entry.status = 'failed';
        entry.error = why;
        // Nothing moved: the design was never handed to the machine. A cable
        // pushed back in, or a file put back in the library, and arming again
        // should run THIS design -- not step over it to the next one.
        entry.retryable = true;
        this.gateId = null;
        this._save();
        this.log.warn?.(`[Queue] held on ${entry.name}: ${why}`);
        this._set(STATES.held, `"${entry.name}" was not loaded: ${why}. Skip it, or fix it and arm the queue again.`);
    }

    _startCountdown(entry, pos) {
        this._cancelCountdown(null);
        this.countdownEndsAt = Date.now() + this.autoDelaySec * 1000;
        this._countdownTimer = setTimeout(() => {
            this._countdownTimer = null;
            this.startNext();
        }, this.autoDelaySec * 1000);
        if (typeof this._countdownTimer.unref === 'function') this._countdownTimer.unref();
        this._set(STATES.countdown, `Design ${pos}, ${entry.name}, starts in ${this.autoDelaySec} s. Tap Hold to stop it. The router is not switched by this machine.`);
    }

    _cancelCountdown(nextState) {
        if (this._countdownTimer) {
            clearTimeout(this._countdownTimer);
            this._countdownTimer = null;
        }
        this.countdownEndsAt = 0;
        if (nextState) this.state = nextState;
    }

    _clearReturnTimer() {
        if (this._returnTimer) {
            clearTimeout(this._returnTimer);
            this._returnTimer = null;
        }
    }

    // ─── What must be true before anything moves ─────────────────────

    /** @returns {string|null} why the machine must not start, or null. */
    _blockReason() {
        const engine = this.getEngine();
        const ctl = this.getController();
        if (!ctl) return 'the machine is not connected';
        if (engine && engine.connection && engine.connection.isOpen === false) return 'the machine is not connected';

        const st = (ctl.state && ctl.state.status) || {};
        if (st.estop) return 'the E-stop is latched';
        const active = String(st.activeState || '').toLowerCase();
        if (active === 'alarm') return 'the machine is in alarm';
        if (active === 'hold') return 'the machine is on hold';
        if (ctl.job && ctl.job.active) return 'a job is already running';

        const point = typeof ctl.getResumePoint === 'function' ? ctl.getResumePoint() : null;
        if (point && point.positionExact === false) {
            return 'the machine is not sure where it is -- home it or re-zero, then arm the queue again';
        }
        return null;
    }

    _fakeSocket() {
        const errors = this._socketErrors = [];
        return {
            id: 'queue',
            data: { identity: { queue: true } },
            emit(ev, d) { if (ev === 'serialport:error' || ev === 'file:loadError') errors.push(d); },
            join() {},
            to() { return this; },
        };
    }

    // ─── Controller events ───────────────────────────────────────────

    /**
     * A new controller object was bound (CNCEngine emits 'controller:bound'
     * on every connect). The queue's listeners are on the OLD object, so
     * without this a design started before a reconnect would sit in `running`
     * for ever: its sender:end would arrive on a controller nobody is
     * listening to, and the queue would neither advance nor say why.
     */
    noteControllerChanged() {
        const had = this._attachedController;
        this._detach();
        this._attach();
        if (!this.activeId || !had) return;
        const entry = this.entries.find((e) => e.id === this.activeId);
        this.activeId = null;
        if (entry) {
            entry.status = 'failed';
            entry.error = 'the connection to the machine dropped while it was cutting';
            entry.retryable = false;   // the tool was in the work
            entry.finishedAt = Date.now();
            this._save();
        }
        this._cancelCountdown(null);
        this._set(STATES.held, `"${entry ? entry.name : 'The design'}" was interrupted: the machine reconnected. Check where the tool is, then arm the queue again.`);
    }

    /** Idempotent; the controller object changes on every reconnect. */
    _attach() {
        const ctl = this.getController();
        if (!ctl || ctl === this._attachedController) return;
        this._detach();
        this._attachedController = ctl;

        this._onEnd = (data) => this._onSenderEnd(data);
        this._onError = (err) => this._onSenderError(err);
        this._onReturned = (ev) => this._onReturnedToOrigin(ev);
        this._onRestart = () => {
            // The board rebooted. Whatever it was cutting, the queue is not
            // carrying on by itself afterwards.
            if (this.activeId || this.state === STATES.countdown || this.state === STATES.gate) {
                this._cancelCountdown(null);
                this._set(STATES.held, 'The controller restarted. Check the machine, then arm the queue again.');
            }
        };
        if (typeof ctl.on !== 'function') return;
        ctl.on('sender:end', this._onEnd);
        ctl.on('sender:error', this._onError);
        ctl.on('job:returnedToOrigin', this._onReturned);
        ctl.on('controller:restarted', this._onRestart);
    }

    _detach() {
        const ctl = this._attachedController;
        if (!ctl || typeof ctl.removeListener !== 'function') { this._attachedController = null; return; }
        if (this._onEnd) ctl.removeListener('sender:end', this._onEnd);
        if (this._onError) ctl.removeListener('sender:error', this._onError);
        if (this._onReturned) ctl.removeListener('job:returnedToOrigin', this._onReturned);
        if (this._onRestart) ctl.removeListener('controller:restarted', this._onRestart);
        this._attachedController = null;
    }

    _onSenderEnd(data) {
        // Only a design THIS queue started counts. A macro, a probe cycle, or
        // a file the operator ran themselves ends here too.
        if (!this.activeId) return;
        if (data && data.macro) return;
        const entry = this.entries.find((e) => e.id === this.activeId);
        this.activeId = null;
        if (!entry) { this._set(STATES.idle, ''); return; }

        if (data && data.aborted) {
            entry.status = 'failed';
            entry.error = 'stopped';
            // Half a design is cut into that piece. Arming again must not
            // silently run it from line 1 over the top of the first attempt.
            entry.retryable = false;
            entry.finishedAt = Date.now();
            this._save();
            this._set(STATES.held, `"${entry.name}" was stopped. The queue is holding: nothing else will start until you arm it again.`);
            return;
        }

        entry.status = 'done';
        entry.finishedAt = Date.now();
        this._save();
        this.log.info?.(`[Queue] finished ${entry.name}`);

        if (!this.armed) { this._set(STATES.idle, `"${entry.name}" finished.`); return; }
        if (!this.entries.some((e) => e.status === 'pending')) {
            this.armed = false;
            this._save();
            this._set(STATES.done, 'Every design in the queue is finished.');
            return;
        }

        // CNCEngine sends the machine back to X0 Y0 now. Wait for it to get
        // there before loading the next design, so the screen does not offer a
        // Start while the tool is still crossing the work.
        this._set(STATES.returning, `"${entry.name}" finished. Returning to the origin…`);
        this._clearReturnTimer();
        this._returnTimer = setTimeout(() => {
            this._returnTimer = null;
            this.log.warn?.('[Queue] no return-to-origin came back; loading the next design anyway');
            this._prepareNext();
        }, RETURN_TIMEOUT_MS);
        if (typeof this._returnTimer.unref === 'function') this._returnTimer.unref();
    }

    _onSenderError(err) {
        if (!this.activeId) return;
        const entry = this.entries.find((e) => e.id === this.activeId);
        this.activeId = null;
        if (entry) {
            entry.status = 'failed';
            entry.error = (err && (err.reason || err.message)) || 'the job failed';
            entry.retryable = false;   // it stopped part way through the cut
            entry.finishedAt = Date.now();
            this._save();
        }
        this._cancelCountdown(null);
        this._set(STATES.held, `"${entry ? entry.name : 'The design'}" did not finish: ${(err && (err.reason || err.message)) || 'the job failed'}. The queue is holding.`);
    }

    _onReturnedToOrigin(ev) {
        if (this.state !== STATES.returning) return;
        this._clearReturnTimer();
        if (ev && ev.ok === false) {
            // The tool did not go back to the corner. The work zero is still
            // the operator's, so the next design would cut in the right place;
            // say what happened and let them decide.
            this.log.warn?.(`[Queue] the machine did not return to the origin: ${ev.reason}`);
        }
        this._prepareNext();
    }

    // ─── Persistence ─────────────────────────────────────────────────

    _load() {
        if (!this.filePath) return;
        let raw = null;
        try {
            if (fs.existsSync(this.filePath)) raw = fs.readFileSync(this.filePath, 'utf-8');
        } catch (err) {
            this.log.warn?.(`[Queue] could not read ${this.filePath}: ${err && err.message}`);
            return;
        }
        if (!raw) return;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            this.log.warn?.(`[Queue] ${this.filePath} is damaged (${err && err.message}); starting with an empty queue`);
            return;
        }
        if (!parsed || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) return;
        this.entries = parsed.entries
            .filter((e) => e && typeof e.id === 'string' && typeof e.libraryId === 'string')
            .map((e) => ({
                id: e.id,
                libraryId: e.libraryId,
                name: String(e.name || e.libraryId),
                fileName: String(e.fileName || ''),
                size: Number(e.size) || 0,
                // A design recorded as running is one the power went out on.
                // It did not finish, and nobody can say where it stopped.
                status: e.status === 'running' ? 'failed' : (e.status || 'pending'),
                error: e.status === 'running' ? 'the machine lost power or restarted during this design' : (e.error || null),
                retryable: e.status === 'failed' ? e.retryable === true : false,
                addedAt: Number(e.addedAt) || 0,
                startedAt: Number(e.startedAt) || 0,
                finishedAt: Number(e.finishedAt) || 0,
            }));
        this.mode = parsed.mode === 'auto' ? 'auto' : 'gate';
        const d = Number(parsed.autoDelaySec);
        this.autoDelaySec = Number.isFinite(d) && d >= AUTO_DELAY_MIN_S && d <= AUTO_DELAY_MAX_S ? Math.round(d) : AUTO_DELAY_DEFAULT_S;
        // NEVER restored: a machine that comes back from a power cut, a crash
        // or a reboot must not start cutting because it was armed beforehand.
        this.armed = false;
        this.state = STATES.idle;
    }

    _save() {
        if (!this.filePath) return;
        const payload = {
            version: SCHEMA_VERSION,
            mode: this.mode,
            autoDelaySec: this.autoDelaySec,
            // Written for the record only; _load() always comes back disarmed.
            armedWhenSaved: this.armed,
            entries: this.entries,
            savedAt: Date.now(),
        };
        const tmp = `${this.filePath}.tmp`;
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const fd = fs.openSync(tmp, 'w');
            try {
                fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf-8');
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, this.filePath);
        } catch (err) {
            this.log.warn?.(`[Queue] could not save the queue: ${err && err.message}`);
        }
    }

    /** Timers must not keep a test process alive. */
    stop() {
        this._cancelCountdown(null);
        this._clearReturnTimer();
        this._detach();
    }
}

module.exports = { QueueService, STATES, AUTO_DELAY_DEFAULT_S };
