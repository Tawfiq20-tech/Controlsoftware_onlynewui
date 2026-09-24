/**
 * JobResumeService — wires JobResumeStore + RecoveryOrchestrator to the
 * active controller's sender events so checkpoints are written/cleared
 * automatically, and handles the full resume-from-checkpoint flow.
 *
 * Architecture note:
 *   This service follows the same pattern as JobHistoryService: it receives
 *   a `getController()` factory at construction time and calls it each time
 *   it needs the active controller reference. CNCEngine creates controllers
 *   dynamically on firmware detection, so we hook controller events at the
 *   point the engine signals a new controller is live (via the 'controller'
 *   property changing), not at construction time.
 *
 *   CNCEngine already relays all sender:* events to Socket.IO. We hook the
 *   same events on the controller directly so we don't need to modify
 *   CNCEngine. The attachment happens lazily: the first call to any
 *   checkpoint-writing path checks whether we've attached to the current
 *   controller and re-attaches if not.
 *
 * This is the SINGLE checkpoint owner for all controller types. The old
 * parallel persistence in RSPController (rsp_resume_state.json) has been
 * removed; all checkpoint I/O goes through this service.
 *
 * Checkpoint lifecycle:
 *
 *   gcode:load  ─► pending state saved in memory (not yet on disk)
 *   gcode:start ─► checkpoint written to disk (line 0, job in progress)
 *   progress    ─► checkpoint updated every CHECKPOINT_EVERY_N lines
 *   sender:pause─► checkpoint SAVED immediately (pause = potential resume)
 *   sender:end  ─► checkpoint CLEARED  (job completed OK — no resume needed);
 *                  { aborted: true } is a Stop: checkpoint SAVED, not cleared;
 *                  { macro: true } (RSP macro run) is ignored
 *   sender:error─► checkpoint SAVED with last executed line (resume available)
 *   gcode:stop  ─► checkpoint SAVED with last executed line (user aborted)
 *   link lost   ─► checkpoint SAVED with last executed line (power/cable loss)
 *   file:unload ─► checkpoint CLEARED when it is the unloaded file's
 *
 *   On next boot: JobResumeService.getCheckpoint() returns the saved record.
 *   Frontend calls POST /api/job/resume → resumeFromCheckpoint() reloads
 *   the G-code and calls gcode:startFromLine(lastExecutedLine + 1), with
 *   a modal-state restoration preamble injected first.
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { JobResumeStore } = require('./JobResumeStore');
const { RecoveryOrchestrator } = require('./RecoveryOrchestrator');

// Save a checkpoint every this many executed lines (in addition to
// save-on-stop/error/pause). Lower = more disk writes but finer granularity.
const CHECKPOINT_EVERY_N = 25;
// ...and never more often than this, however fast the lines go by.
const CHECKPOINT_MIN_INTERVAL_MS = 1000;

class JobResumeService extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string}   opts.dataDir        Path to backend/data/
     * @param {object}   opts.io             Socket.IO server
     * @param {object}   [opts.logger]
     * @param {function} opts.getController  Returns active controller or null
     * @param {function} [opts.getConfig]    Returns ConfigStore instance or null
     * @param {function} [opts.onProgramLoaded] Called with {name, content} after
     *                   the resume program is loaded into the controller, so
     *                   the engine (and remote UIs) show what it really holds
     */
    constructor({ dataDir, io, logger, getController, getConfig, onProgramLoaded }) {
        super();
        this.onProgramLoaded = typeof onProgramLoaded === 'function' ? onProgramLoaded : null;
        this.io            = io;
        this._log          = logger || console;
        this.getController = getController;
        this.getConfig     = getConfig || (() => null);
        this.store         = new JobResumeStore(dataDir, logger);

        // In-flight state (populated by _onLoad, cleared by _onEnd/_onClear)
        this._pending = null;   // { filename, gcodeText, modalState } — from last gcode:load
        this._active  = null;   // { ...pending, totalLines, lastExecutedLine, ... } — job live
        this._progressCount = 0;

        // Track which controller we've attached listeners to.
        this._attachedController = null;

        // Emit current checkpoint to any client that connects after boot.
        this.io.on('connection', (socket) => {
            const cp = this.store.load();
            if (cp) {
                socket.emit('job:checkpoint', this._checkpointMeta(cp));
            }
        });
    }

    // ------------------------------------------------------------------
    // Called by RSPController (via index.js wiring) when a command fires.
    // index.js hooks these after each gcode:load / gcode:start / gcode:stop.
    // ------------------------------------------------------------------

    /**
     * Called when gcode:load fires — store pending state. spindleDelay /
     * compileOptions: how the controller loaded the file, kept so a resume
     * from the checkpoint compiles the same lines (see resumeFromCheckpoint).
     */
    onLoad({ filename, gcodeText, modalState, spindleDelay, compileOptions }) {
        this._pending = {
            filename:   filename || 'untitled.nc',
            gcodeText:  gcodeText || '',
            modalState: modalState || {},
            spindleDelay,
            compileOptions,
        };
    }

    /**
     * Called when gcode:start fires — write initial checkpoint to disk.
     * `startLine` > 1 is a resume: lines before it are already cut, so the
     * first save must not put the checkpoint back to line 0.
     */
    onStart({ totalLines, modalState, startLine } = {}) {
        if (!this._pending) return;
        this._active = {
            ...this._pending,
            totalLines:        totalLines ?? 0,
            lastExecutedLine:  startLine > 1 ? startLine - 1 : 0,
            lastConfirmedPos:  { x: 0, y: 0, z: 0 },
            modalState:        modalState || this._pending.modalState || {},
        };
        this._progressCount = 0;
        this._saveActive();
        this._attachController();
    }

    /** Called when gcode:stop fires (user abort). */
    onStop() {
        if (this._active) this._saveActive();
    }

    /** Called when gcode:pause fires. */
    onPause() {
        if (this._active) this._saveActive();
    }

    // ------------------------------------------------------------------
    // Public — REST endpoints call these
    // ------------------------------------------------------------------

    /** @returns {object|null} Full checkpoint record, or null. */
    getCheckpoint() {
        return this.store.load();
    }

    /**
     * @returns {object|null} Checkpoint metadata (without gcodeText) for UI display.
     */
    getCheckpointMeta() {
        const cp = this.store.load();
        return cp ? this._checkpointMeta(cp) : null;
    }

    /** @returns {boolean} */
    hasCheckpoint() {
        return this.store.has();
    }

    /**
     * Validate the stored checkpoint.
     * @returns {{ valid: boolean, reason?: string, checkpoint?: object }}
     */
    validateCheckpoint() {
        const cp = this.store.load();
        if (!cp) return { valid: false, reason: 'No checkpoint file found' };
        const result = RecoveryOrchestrator.validateCheckpoint(cp);
        if (result.valid) {
            return { valid: true, checkpoint: this._checkpointMeta(cp) };
        }
        return result;
    }

    /**
     * Resume the job from the saved checkpoint.
     *
     * This is the full resume flow:
     *   1. Load and validate the checkpoint
     *   2. Compute the correct resume line
     *   3. Build the modal-state restoration preamble
     *   4. Load the G-code and start from the resume line
     *
     * @param {object} [opts]
     * @param {boolean} [opts.skipPreamble=false] If true, skip the modal-state preamble
     * @returns {{ ok: boolean, fromLine?: number, filename?: string, preamble?: string[], error?: string }}
     */
    resumeFromCheckpoint(opts = {}) {
        const cp = this.store.load();
        if (!cp) return { ok: false, error: 'No resume checkpoint available' };

        const validation = RecoveryOrchestrator.validateCheckpoint(cp);
        if (!validation.valid) return { ok: false, error: validation.reason };

        const ctl = this.getController?.();
        if (!ctl) return { ok: false, error: 'No active controller' };

        // Never touch the controller while it is cutting. gcode:load and
        // gcode:startFromLine both refuse in that state, but this service used
        // to call _notifyProgramLoaded() regardless, rewriting the engine's
        // idea of the loaded file out from under the running carve -- and then
        // report ok:true.
        const live = ctl.job;
        if (live && live.active && !live.firmwareLost) {
            return { ok: false, error: 'A job is running on the machine. Stop it before resuming a checkpoint.' };
        }

        const fromLine = RecoveryOrchestrator.computeResumeLine(cp);

        this._log.info?.(`[JobResume] Resuming "${cp.filename}" from line ${fromLine} / ${cp.totalLines}`);

        const config = this.getConfig?.();
        const safeZ = config?.get?.('preferences.safeHeight') ?? 10;

        // Restore pending state so onStart() gets the right data when
        // gcode:startFromLine internally fires gcode:load equivalent.
        this._pending = {
            filename:   cp.filename,
            gcodeText:  cp.gcodeText,
            modalState: cp.modalState || {},
            spindleDelay:   cp.spindleDelay,
            compileOptions: cp.compileOptions,
        };

        // Controllers that build their own safe resume (RSP: lib/wireCompiler +
        // lib/resumeFromLine) get the file unchanged and the line to resume at.
        // Prepending a preamble here would be wrong for them twice over: the
        // file's own units line sits BEFORE the resume point, so an inch file
        // continued after a plain "G21" preamble would read every remaining
        // coordinate as millimetres, and the controller would then add its own
        // retract/travel/plunge on top.
        const controllerBuildsPreamble = typeof ctl.getResumePoint === 'function';
        let preamble = [];
        if (controllerBuildsPreamble) {
            // Loaded the way the checkpointed run was: without its spin-up
            // delay the reloaded program is one line shorter per M3 before the
            // resume point, and lastExecutedLine + 1 skips a line.
            ctl.command('gcode:load', cp.filename, cp.gcodeText, cp.spindleDelay, cp.compileOptions);
            // A refused load leaves the controller holding the OLD program.
            // Telling the engine the checkpoint is loaded at that point makes
            // a later file:unload hash-match and delete the only copy of the
            // interrupted job.
            if (ctl.lastLoadResult && ctl.lastLoadResult.ok === false) {
                const m = ctl.lastLoadResult.meta;
                const why = (m && m.errors && m.errors[0] && m.errors[0].msg) || 'the machine would not load the file';
                return { ok: false, error: why };
            }
            this._notifyProgramLoaded(cp.filename, cp.gcodeText, {
                spindleDelay: cp.spindleDelay,
                compileOptions: cp.compileOptions,
            });
            const refusal = this._runWatchingForRefusal(ctl, () => {
                ctl.command('gcode:startFromLine', fromLine, { safeZ });
            });
            if (refusal) return { ok: false, error: refusal, fromLine, filename: cp.filename };
        } else {
            if (!opts.skipPreamble) {
                const currentPos = ctl.state?.status?.mpos || { x: 0, y: 0, z: 0 };
                preamble = RecoveryOrchestrator.buildResumePreamble(cp, currentPos, safeZ);
            }
            let gcodeToLoad = cp.gcodeText;
            if (preamble.length > 0) {
                const origLines = String(cp.gcodeText || '').split(/\r?\n/);
                const remainingLines = origLines.slice(Math.max(0, fromLine - 1));
                gcodeToLoad = preamble.concat(remainingLines).join('\n');
                ctl.command('gcode:load', cp.filename, gcodeToLoad);
                this._notifyProgramLoaded(cp.filename, gcodeToLoad, {
                    spindleDelay: cp.spindleDelay,
                    compileOptions: cp.compileOptions,
                });
                ctl.command('gcode:startFromLine', 1);
            } else {
                ctl.command('gcode:load', cp.filename, gcodeToLoad);
                this._notifyProgramLoaded(cp.filename, gcodeToLoad, {
                    spindleDelay: cp.spindleDelay,
                    compileOptions: cp.compileOptions,
                });
                ctl.command('gcode:startFromLine', fromLine);
            }
        }

        this.io.emit('job:resume:start', {
            filename: cp.filename,
            fromLine,
            totalLines: cp.totalLines,
            preambleLines: preamble.length,
        });

        return { ok: true, fromLine, filename: cp.filename, preamble };
    }

    /**
     * Clear the checkpoint (user decided not to resume).
     */
    _notifyProgramLoaded(name, content, options) {
        if (!this.onProgramLoaded) return;
        try {
            this.onProgramLoaded({
                name,
                content: typeof content === 'string' ? content : String(content || ''),
                // The engine keeps loadedFile / _loadedGcodeContent /
                // _loadedFileOptions as ONE record. Leaving the options out
                // meant the next checkpoint was saved with
                // spindleDelay/compileOptions undefined, so a second resume
                // recompiled with wireCompiler DEFAULTS -- no motion limit, the
                // wrong maxRate and safeHeight, and one fewer line per M3, which
                // is exactly what shifts computeResumeLine() onto the wrong line.
                options: options || null,
            });
        } catch (err) {
            this._log.warn?.(`[JobResume] program-loaded hook failed: ${err && err.message}`);
        }
    }

    /**
     * Run a controller command and return the refusal message if the
     * controller emitted one. RSPController._refuse() emits 'error' for every
     * start it declines (position uncertain, no file, job running, a line
     * outside the file); without this the service reported ok:true and the
     * banner showed a job resuming on a machine that had not moved.
     * @private
     */
    _runWatchingForRefusal(ctl, fn) {
        if (typeof ctl.on !== 'function' || typeof ctl.removeListener !== 'function') {
            fn();
            return null;
        }
        const seen = [];
        const onErr = (e) => seen.push((e && e.message) || String(e));
        ctl.on('error', onErr);
        try {
            fn();
        } finally {
            ctl.removeListener('error', onErr);
        }
        return seen.length ? seen[0] : null;
    }

    clearCheckpoint() {
        this.store.clear();
        this.io.emit('job:checkpoint', null);
        this._active  = null;
        this._pending = null;
    }

    /**
     * The operator unloaded `gcodeText`: its checkpoint goes too, as the
     * controller's own resume point does. A Stop keeps the checkpoint now, so
     * without this an unloaded file could still be resumed after a restart.
     * A checkpoint for a different file is left alone.
     * @returns {boolean} true if a checkpoint was cleared
     */
    discardCheckpointFor(gcodeText) {
        if (!gcodeText) return false;
        const cp = this.store.load();
        if (!cp || cp.gcodeHash !== crypto.createHash('sha1').update(gcodeText).digest('hex')) return false;
        this._log.info?.(`[JobResume] "${cp.filename}" unloaded — clearing its checkpoint`);
        this.clearCheckpoint();
        return true;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    _saveActive() {
        if (!this._active) return;

        // Grab the latest modal state and position from the controller.
        const ctl = this.getController?.();
        if (ctl) {
            if (typeof ctl.getModalState === 'function') {
                this._active.modalState = ctl.getModalState();
            }
            const pos = ctl.state?.status?.mpos;
            if (pos) {
                this._active.lastConfirmedPos = { x: pos.x, y: pos.y, z: pos.z };
            }
        }

        try {
            this.store.save(this._active);
            this.io.emit('job:checkpoint', this._checkpointMeta(this._active));
        } catch (e) {
            this._log.warn?.(`[JobResume] checkpoint save failed: ${e.message}`);
        }
    }

    _checkpointMeta(cp) {
        // Strip gcodeText from the Socket.IO event — can be megabytes.
        const { gcodeText: _, ...meta } = cp;
        return meta;
    }

    /**
     * Attach to the current controller's sender events.
     * Safe to call repeatedly — skips if already attached to this controller.
     */
    _attachController() {
        const ctl = this.getController?.();
        if (!ctl || ctl === this._attachedController) return;

        // Detach from old controller if any.
        this._detachController();
        this._attachedController = ctl;

        // Progress — update lastExecutedLine every N lines.
        this._onProgress = ({ executed, total, lineNo, macro } = {}) => {
            if (!this._active || macro) return; // a macro's line numbers are not the file's
            // sender:status also carries updates that are not progress (RSP
            // sends { feedOverridePct } alone). Taking those as progress set
            // lastExecutedLine to undefined, and a save then recorded line 0.
            const line = lineNo ?? executed;
            if (typeof line !== 'number' || !Number.isFinite(line)) return;
            this._active.lastExecutedLine = line;
            if (this._active.totalLines === 0 && total) this._active.totalLines = total;
            this._progressCount++;
            // Every N lines AND at most once a second: a 3D finishing file
            // finishes hundreds of lines a second, and each checkpoint is a
            // write + fsync + backup copy. Losing at most a second of progress
            // to a power cut is a far better trade than fsyncing while the
            // machine is cutting.
            const now = Date.now();
            if (this._progressCount % CHECKPOINT_EVERY_N === 0 && (now - (this._lastCheckpointAt || 0)) >= CHECKPOINT_MIN_INTERVAL_MS) {
                this._lastCheckpointAt = now;
                this._saveActive();
            }
        };

        // sender:end is also a Stop ({ aborted: true } from RSP / RTS). On
        // 2026-09-17 onStop() saved the checkpoint and this cleared it 22 ms
        // later, so a backend restart lost the resume point. Only a finished
        // job clears it; a stopped one is saved. A macro run is not the job.
        this._onSenderEnd = (data) => {
            if (data && data.macro) return;
            if (data && data.aborted) {
                if (this._active) {
                    this._log.info?.(`[JobResume] Job stopped — checkpoint kept at line ${this._active.lastExecutedLine}`);
                    this._saveActive();
                }
                return;
            }
            this._log.info?.('[JobResume] Job complete — clearing checkpoint');
            this.store.clear();
            this.io.emit('job:checkpoint', null);
            this._active  = null;
            this._pending = null;
        };

        // Job failed or link lost — save checkpoint for resume.
        this._onSenderError = ({ reason } = {}) => {
            if (this._active) {
                this._log.warn?.(`[JobResume] Job error (${reason}) — checkpoint saved at line ${this._active.lastExecutedLine}`);
                this._saveActive();
            }
        };

        // Pause — save checkpoint immediately.
        this._onPause = () => {
            if (this._active) {
                this._log.info?.(`[JobResume] Job paused — checkpoint saved at line ${this._active.lastExecutedLine}`);
                this._saveActive();
            }
        };

        // Link lost (power/cable) — save immediately.
        this._onError = () => {
            if (this._active) {
                this._log.warn?.('[JobResume] Link/controller error — saving checkpoint');
                this._saveActive();
            }
        };

        // on(), not once(): this attaches once per controller (see the early
        // return above), and a connection runs many jobs. With once() every
        // job after the first never saved or cleared its checkpoint on
        // end/error. _detachController() removes them when the controller changes.
        ctl.on('sender:status', this._onProgress);
        ctl.on('sender:end',    this._onSenderEnd);
        ctl.on('sender:error',  this._onSenderError);
        ctl.on('sender:pause',  this._onPause);
        ctl.on('error',         this._onError);
    }

    _detachController() {
        const ctl = this._attachedController;
        if (!ctl) return;
        if (this._onProgress)    ctl.off('sender:status', this._onProgress);
        if (this._onSenderEnd)   ctl.off('sender:end',    this._onSenderEnd);
        if (this._onSenderError) ctl.off('sender:error',  this._onSenderError);
        if (this._onPause)       ctl.off('sender:pause',  this._onPause);
        if (this._onError)       ctl.off('error',         this._onError);
        this._attachedController = null;
    }
}

module.exports = { JobResumeService };
