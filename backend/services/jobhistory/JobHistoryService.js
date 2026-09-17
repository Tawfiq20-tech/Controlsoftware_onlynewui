/**
 * JobHistoryService — persistent log of every run.
 *
 * Stored as JSONL at <data>/jobhistory.jsonl. One record per job:
 *   {
 *     id: 'job_<base36 timestamp>',
 *     startedAt: 1719500000000,
 *     endedAt:   1719500300000,     // null while running / when unknown
 *     durationMs: 300000,           // null while running / when unknown
 *     filename: 'pocket.nc',
 *     gcodeHash: 'sha1...',
 *     gcodeBytes: 14223,
 *     lineCount: 312,
 *     controller: 'GrblHal' | 'RTS' | 'Generic',
 *     outcome:   'running' | 'ok' | 'fail' | 'aborted' | 'interrupted',
 *     error:     string|null,
 *     wcs:       'G54',
 *     toolNumber: 1,
 *     lastLine:  1234,              // last line known executed, when known
 *     pid, bootTime                 // which backend process was running it
 *     feedScale:  100,
 *     spindleRpmMax: 24000,
 *   }
 *
 * A job is written when it STARTS (outcome 'running') and again, under the
 * same id, when it ends; loading keeps the last line written for each id.
 * Writing only at a clean end lost exactly the jobs that went wrong: of 38
 * starts in 2026-09-10..16 only 29 had a record -- the ones cut off by a USB
 * drop, a controller reset or a killed backend were missing, so the
 * statistics showed none of the real mid-job failures.
 *
 * A job still 'running' in the file when the backend starts was cut off by a
 * crash, a forced close or a power cut: it becomes 'interrupted', with the
 * last line from the resume checkpoint when that belongs to the same job.
 * A job whose controller is replaced (reconnect after a connection loss)
 * becomes 'interrupted' at once.
 *
 * The file is only ever appended to, except when it is compacted: at start-up,
 * once enough lines are superseded (COMPACT_MIN_STALE_LINES), and never while
 * another live backend process is running a job on the same data folder.
 * Rewriting it at every start could replace the file under a second backend
 * (a dev instance next to the machine's own) and lose the append it made in
 * the meantime (review, 2026-09-17). Records a failed write missed are
 * appended once writing works again, not rewritten.
 *
 * REST:
 *   GET    /api/jobhistory?limit=50&from=<ts>&to=<ts>
 *   GET    /api/jobhistory/:id
 *   DELETE /api/jobhistory                (clear all)
 *   DELETE /api/jobhistory/:id
 *
 * Socket.IO:
 *   jobhistory:added    ({record})  a job started
 *   jobhistory:updated  ({record})  a job ended / was interrupted
 *   jobhistory:list     (sent on connect with last 50)
 *
 * Hooks the controller via getController() to subscribe to:
 *   - 'job:start'     → open a new record (written at once)
 *   - 'sender:status' → remember the last executed line
 *   - 'job:end'       → close record + persist
 *   - 'job:error'     → mark fail with error message
 *   - 'job:abort'     → mark aborted
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');

// Another program holding the file (OneDrive, antivirus). EACCES is a
// permission problem, not retried.
const LOCK_CODES = new Set(['EPERM', 'EBUSY']);
// Compact at start-up once this many lines are superseded (each job's start
// line once its end is written; torn lines) and they are at least a third of
// the file: about once per 200 jobs.
const COMPACT_MIN_STALE_LINES = 200;
const MSG_BACKEND_STOPPED = 'The sender stopped while this job was running (crash, forced close or power cut)';
const MSG_CONNECTION_LOST = 'The connection to the controller was lost while this job was running';

function bootTime() {
    return Date.now() - Math.round(os.uptime() * 1000);
}

/** Same count as text.split('\n').filter(Boolean).length, without the array. */
function countNonEmptyLines(text) {
    let count = 0;
    let start = 0;
    for (;;) {
        const i = text.indexOf('\n', start);
        const end = i === -1 ? text.length : i;
        if (end > start) count++;
        if (i === -1) return count;
        start = i + 1;
    }
}

// Re-attempted at once within 4 ms, never with a sleep: on Windows a 5 ms
// sleep lasts a whole 15.6 ms timer tick (same rule as JobResumeStore).
function renameWithRetry(from, to) {
    const t0 = performance.now();
    for (let i = 0; ; i++) {
        try {
            return fs.renameSync(from, to);
        } catch (err) {
            if (!LOCK_CODES.has(err && err.code) || i >= 3 || performance.now() - t0 >= 4) throw err;
        }
    }
}

class JobHistoryService extends EventEmitter {
    /**
     * @param {object} opts
     * @param {function} [opts.getCheckpointSummary] () -> {filename, gcodeHash,
     *        lastExecutedLine, savedAt}|null; defaults to the JobResumeStore in dataDir
     */
    constructor({ dataDir, io, logger, getController, getEngine, getCheckpointSummary }) {
        super();
        this.dataDir = dataDir;
        this.io = io;
        this.logger = logger || console;
        this.getController = getController;
        this.getCheckpointSummary = getCheckpointSummary || (() => {
            const { JobResumeStore } = require('../jobresume/JobResumeStore');
            return new JobResumeStore(dataDir, this.logger).readSummary();
        });
        this.file = path.join(dataDir, 'jobhistory.jsonl');
        this.records = [];
        this.activeJob = null;
        this._activeController = null;
        this._wired = new WeakSet();
        this._lastId = null;
        this._writeFailing = null;   // { since, count }
        this._partialLine = false;   // a failed append may have left half a line
        this._unwritten = new Set(); // records whose latest state a failed write missed
        this._staleLines = 0;        // superseded or torn lines in the file
        this._loadFromDisk();
        this._recoverUnfinished();
        this._wireController();

        // Constructor runs before any controller exists, so the call
        // above is a no-op. Re-run it every time CNCEngine binds a fresh
        // controller instance (reconnects create a new object each time)
        // so job:start/end/error/abort are actually captured. Without
        // this, job history silently records nothing for the process
        // lifetime (FIXFILE.html FIX-20).
        const engine = getEngine?.();
        if (engine?.on) {
            engine.on('controller:bound', (ctl) => this._onControllerBound(ctl));
        }
    }

    _loadFromDisk() {
        try {
            if (!fs.existsSync(this.file)) return;
            const text = fs.readFileSync(this.file, 'utf8');
            // Ends in half a line (a write cut off): start the next on a new one.
            if (text && !text.endsWith('\n')) this._partialLine = true;
            const byId = new Map();
            let lines = 0;
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                let rec;
                try { rec = JSON.parse(line); } catch (_) { this._staleLines++; continue; }
                if (!rec || typeof rec !== 'object') { this._staleLines++; continue; }
                lines++;
                const known = rec.id ? byId.get(rec.id) : null;
                if (known) {
                    Object.assign(known, rec);   // a later line for the same job: its update
                } else {
                    const r = { ...rec };
                    this.records.push(r);
                    if (r.id) byId.set(r.id, r);
                }
            }
            this._staleLines += lines - this.records.length;
        } catch (e) {
            this.logger.warn?.(`[jobhistory] load failed: ${e.message}`);
        }
    }

    /** Jobs left 'running' by a backend that is gone become 'interrupted'. */
    _recoverUnfinished() {
        const recovered = [];
        let otherBackendRunning = false;
        let summary;
        for (const r of this.records) {
            if (r.outcome !== 'running') continue;
            if (this._ownerStillRunning(r)) {
                otherBackendRunning = true;
                this.logger.warn?.(`[jobhistory] "${r.filename}" (${r.id}) is still running in another backend process (pid ${r.pid}); left as running`);
                continue;
            }
            if (summary === undefined) {
                try { summary = this.getCheckpointSummary() || null; } catch (_) { summary = null; }
            }
            let lastLine = typeof r.lastLine === 'number' ? r.lastLine : null;
            let lastSeenAt = typeof r.lastSeenAt === 'number' ? r.lastSeenAt : null;
            if (summary && this._checkpointIsFor(summary, r)) {
                if (typeof summary.lastExecutedLine === 'number' && summary.lastExecutedLine > (lastLine || 0)) lastLine = summary.lastExecutedLine;
                if (typeof summary.savedAt === 'number' && summary.savedAt > (lastSeenAt || 0)) lastSeenAt = summary.savedAt;
            }
            Object.assign(r, {
                outcome: 'interrupted',
                endedAt: lastSeenAt,
                durationMs: lastSeenAt ? lastSeenAt - r.startedAt : null,
                error: r.shutdownReason
                    ? `The sender was shut down (${r.shutdownReason}) while this job was running`
                    : MSG_BACKEND_STOPPED,
                lastLine,
            });
            recovered.push(r);
            this.logger.warn?.(`[jobhistory] "${r.filename}" started ${new Date(r.startedAt).toISOString()} never finished -- recorded as interrupted${lastLine ? ` at line ${lastLine}` : ''}`);
        }
        const stale = this._staleLines + recovered.length;
        const compact = !otherBackendRunning && stale >= COMPACT_MIN_STALE_LINES && stale * 2 >= this.records.length;
        if (compact && this._rewriteDisk()) return;
        if (recovered.length) this._appendToDisk(recovered);
    }

    _ownerStillRunning(r) {
        if (!r.pid || r.pid === process.pid) return false;
        // Recorded before the PC last started: that process is gone.
        if (typeof r.bootTime !== 'number' || Math.abs(r.bootTime - bootTime()) > 2 * 60 * 1000) return false;
        try {
            process.kill(r.pid, 0);
            return true;
        } catch (e) {
            return e && e.code === 'EPERM';
        }
    }

    _checkpointIsFor(cp, r) {
        if (typeof cp.savedAt === 'number' && cp.savedAt + 1000 < r.startedAt) return false;
        if (cp.gcodeHash && r.gcodeHash && cp.gcodeHash === r.gcodeHash) return true;
        return !!(cp.filename && r.filename && cp.filename === r.filename);
    }

    /** Append the latest state of `records`, and of any a failed write missed. */
    _appendToDisk(records) {
        for (const r of Array.isArray(records) ? records : [records]) {
            this._unwritten.delete(r);
            this._unwritten.add(r);
        }
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            // After a failed append the file may end in half a line; start on
            // a fresh one so this record is not glued to it.
            const prefix = this._partialLine ? '\n' : '';
            const text = [...this._unwritten].map((r) => JSON.stringify(r)).join('\n') + '\n';
            fs.appendFileSync(this.file, prefix + text, 'utf8');
            this._unwritten.clear();
            this._partialLine = false;
            this._writeWorked();
            return true;
        } catch (e) {
            this._partialLine = true;
            this._writeFailed(e);
            return false;
        }
    }

    _rewriteDisk() {
        const tmp = `${this.file}.tmp`;
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            const text = this.records.length ? this.records.map(r => JSON.stringify(r)).join('\n') + '\n' : '';
            const fd = fs.openSync(tmp, 'w');
            try {
                fs.writeFileSync(fd, text, 'utf8');
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            renameWithRetry(tmp, this.file);
            this._partialLine = false;
            this._staleLines = 0;
            this._unwritten.clear();
            this._writeWorked();
            return true;
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (_) { /* not there */ }
            this._writeFailed(e);
            return false;
        }
    }

    _writeFailed(e) {
        if (this._writeFailing) { this._writeFailing.count++; return; }
        this._writeFailing = { since: Date.now(), count: 1 };
        const why = e && e.code === 'ENOSPC' ? 'the disk is full (ENOSPC)' : ((e && e.message) || String(e));
        this.logger.error?.(`[jobhistory] could not write ${this.file}: ${why} -- job records are kept in memory and written when it works again`);
    }

    _writeWorked() {
        if (!this._writeFailing) return;
        const f = this._writeFailing;
        this._writeFailing = null;
        // What the failed writes missed went out with this write (_unwritten).
        this.logger.info?.(`[jobhistory] writing ${path.basename(this.file)} works again (${f.count} write(s) failed; the missed job records are written now)`);
    }

    _wireController() {
        const ctl = this.getController?.();
        if (!ctl?.on || this._wired.has(ctl)) return;
        this._wired.add(ctl);
        ctl.on('job:start', (meta) => this.startJob(meta, ctl));
        ctl.on('job:end',   (meta) => this.endJob({ outcome: 'ok', ...meta }));
        ctl.on('job:error', (err)  => this.endJob({ outcome: 'fail', error: err?.message || String(err) }));
        ctl.on('job:abort', ()     => this.endJob({ outcome: 'aborted' }));
        ctl.on('sender:status', (s) => this._onProgress(s, ctl));
    }

    _onControllerBound(ctl) {
        // A new controller object means the old connection is gone, and a job
        // that was running on it with it.
        if (this.activeJob && this._activeController && ctl !== this._activeController) {
            this._finish({ outcome: 'interrupted', error: MSG_CONNECTION_LOST });
        }
        this._wireController();
    }

    _onProgress(status, ctl) {
        const r = this.activeJob;
        if (!r || !status || status.macro || (this._activeController && ctl !== this._activeController)) return;
        const line = status.lineNo ?? status.received;
        if (typeof line !== 'number' || !Number.isFinite(line)) return;
        r.lastLine = line;
        r.lastSeenAt = Date.now();
    }

    startJob({ filename, gcode, controller, wcs, toolNumber, gcodeHash, gcodeBytes, lineCount: knownLineCount } = {}, ctl = null) {
        if (this.activeJob) {
            this._finish({ outcome: 'interrupted', error: 'A new job started before this one reported its end' });
        }
        let id = 'job_' + Date.now().toString(36);
        if (id === this._lastId || this.records.some((r) => r.id === id)) id += '_' + crypto.randomBytes(2).toString('hex');
        this._lastId = id;
        // This runs on the main thread as the job starts. It used to copy and
        // split the whole program: 217-245 ms for the 17 MB SHIP FINISHING
        // file (2026-09-17). Now no copy or split (~60 ms), and nothing at all
        // for what the controller already knows and passes in job:start.
        const known = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const text = typeof gcode === 'string' ? gcode : null;
        const buf = text === null ? (gcode || Buffer.alloc(0)) : null;
        const hash = (typeof gcodeHash === 'string' && gcodeHash)
            || crypto.createHash('sha1').update(text !== null ? text : buf).digest('hex');
        const bytes = known(gcodeBytes) ?? (text !== null ? Buffer.byteLength(text) : buf.length);
        const lineCount = known(knownLineCount) ?? (text !== null ? countNonEmptyLines(text) : (gcode ? countNonEmptyLines(gcode.toString()) : 0));
        const record = {
            id,
            startedAt: Date.now(),
            endedAt: null,
            durationMs: null,
            filename: filename || 'untitled.nc',
            gcodeHash: hash,
            gcodeBytes: bytes,
            lineCount,
            controller: controller || 'unknown',
            outcome: 'running',
            error: null,
            wcs: wcs || 'G54',
            toolNumber: toolNumber ?? null,
            lastLine: null,
            pid: process.pid,
            bootTime: bootTime(),
        };
        this.activeJob = record;
        this._activeController = ctl;
        this.records.push(record);
        this._appendToDisk(record);
        this._emit('jobhistory:added', record);
        return record;
    }

    endJob({ outcome, error } = {}) {
        if (!this.activeJob) return null;
        return this._finish({ outcome: outcome || 'ok', error });
    }

    /**
     * The backend is shutting down with this job running: remember why and
     * where, so the record says so whether or not the Stop completes first.
     */
    noteShutdown(signal) {
        const r = this.activeJob;
        if (!r) return null;
        r.shutdownReason = String(signal || 'shutdown');
        r.lastSeenAt = Date.now();
        this._appendToDisk(r);
        return r;
    }

    _finish({ outcome, error }) {
        const r = this.activeJob;
        this.activeJob = null;
        this._activeController = null;
        const now = Date.now();
        Object.assign(r, {
            endedAt: now,
            durationMs: now - r.startedAt,
            outcome,
            error: error || (r.shutdownReason ? `Stopped because the sender was shut down (${r.shutdownReason})` : null),
        });
        this._appendToDisk(r);
        this._emit('jobhistory:updated', r);
        return r;
    }

    _emit(event, record) {
        try { this.io?.emit?.(event, record); } catch (_) { /* the screen is best effort */ }
    }

    list({ limit = 50, from, to } = {}) {
        let arr = this.records.slice();
        if (from) arr = arr.filter(r => r.startedAt >= +from);
        if (to)   arr = arr.filter(r => r.startedAt <= +to);
        arr.sort((a, b) => b.startedAt - a.startedAt);
        return arr.slice(0, +limit);
    }

    get(id) { return this.records.find(r => r.id === id) || null; }

    deleteOne(id) {
        const before = this.records.length;
        this.records = this.records.filter(r => r.id !== id);
        for (const r of this._unwritten) if (r.id === id) this._unwritten.delete(r);
        if (this.records.length !== before) this._rewriteDisk();
    }

    clear() {
        this.records = [];
        this._unwritten.clear();
        this._staleLines = 0;
        try { fs.unlinkSync(this.file); } catch (_) {}
    }

    stats() {
        const total = this.records.length;
        const ok = this.records.filter(r => r.outcome === 'ok').length;
        const fail = this.records.filter(r => r.outcome === 'fail').length;
        const aborted = this.records.filter(r => r.outcome === 'aborted').length;
        const interrupted = this.records.filter(r => r.outcome === 'interrupted').length;
        const running = this.records.filter(r => r.outcome === 'running').length;
        const totalMs = this.records.reduce((s, r) => s + (r.durationMs || 0), 0);
        return { total, ok, fail, aborted, interrupted, running, totalMs };
    }
}

module.exports = { JobHistoryService, countNonEmptyLines };
