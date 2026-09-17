/**
 * JobResumeStore — atomic, CRC32-protected persistence for job resume
 * checkpoints.
 *
 * Saves exactly one file: <dataDir>/job_resume.json
 * Maintains a backup:    <dataDir>/job_resume.json.bak
 *
 * The checkpoint captures enough state to reload and restart the job
 * from the last successfully executed line — even after a full power loss.
 *
 * Schema v2:
 *   {
 *     version:          2,         // schema version for forward compat
 *     filename:         string,    // original filename shown in UI
 *     gcodeText:        string,    // FULL G-code text (survives USB removal)
 *     gcodeHash:        string,    // sha1 of gcodeText (for integrity check)
 *     totalLines:       number,    // total parsed line count
 *     lastExecutedLine: number,    // last line confirmed executed by firmware
 *     lastConfirmedPos: {x,y,z},  // machine position at last confirmed line
 *     modalState: {               // modal state at checkpoint
 *       wcs:            string,   // active WCS (e.g. 'G54')
 *       units:          string,   // G20/G21
 *       distanceMode:   string,   // G90/G91
 *       feedMode:       string,   // G93/G94
 *       spindleState:   string,   // M3/M4/M5
 *       spindleRpm:     number,
 *       coolantState:   string,   // M7/M8/M9
 *       feedRate:       number,
 *       toolNumber:     number,
 *       feedOverridePct: number,
 *     },
 *     spindleDelay:     number?,  // spin-up dwell (s) the file was loaded with
 *     compileOptions:   object?,  // RSP wire-compile options it was loaded with
 *     savedAt:          number,   // epoch ms
 *     crc32:            string,   // hex CRC32 of JSON without this field
 *   }
 *
 * Writes are atomic: write to .tmp → rename over the real file, so a crash
 * mid-write leaves either the old file intact or the new one complete —
 * never a half-written JSON. save() returns with the new checkpoint in place.
 *
 * A .bak backup is maintained: before overwriting the main file, the current
 * good copy is renamed to .bak. If the main file fails to load (CRC error,
 * corrupt JSON), the .bak is tried as a fallback — at most one checkpoint
 * interval of progress is lost.
 *
 * Power cuts: the fsync that puts a new checkpoint on the disk for good runs
 * on libuv's thread pool, not on the main thread. A progress save used to
 * block the sender for 25-40 ms (sha1 of the whole program + fsync + copy;
 * measured 2026-09-17 on the 17 MB SHIP FINISHING file) every ~2.5 s while
 * the machine cut; now it is a few file operations (~1-3 ms on Windows).
 * What keeps a power cut safe instead: .bak only ever receives a main file
 * whose fsync has completed (a main still waiting for its fsync -- two saves
 * milliseconds apart -- is fsynced on the spot before it is rotated), so at
 * any instant either main is on the disk for good or .bak is.
 *
 * The data folder sits inside OneDrive on the machine PC: a rename or delete
 * can fail with EPERM/EBUSY while OneDrive, antivirus or a backup tool holds
 * the file. Such an operation is re-attempted at once, a few times within
 * 4 ms, never with a sleep (see LOCK_RETRY_BUDGET_MS); while a file stays
 * held, saves make one attempt each. Refreshing .bak is never retried: the
 * older .bak is still a good checkpoint. A save that fails is reported once
 * (not at every save) and the next periodic save tries again.
 *
 * CRC32 (IEEE 802.3, reflected) is computed over the JSON payload without
 * the crc32 field, using the same algorithm as the RSP frame layer
 * (rsp/frame.js) for consistency.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const FILENAME     = 'job_resume.json';
const FILENAME_TMP = 'job_resume.json.tmp';
const FILENAME_BAK = 'job_resume.json.bak';
// The program text lives in its own file, written ONCE per job, and the
// checkpoint JSON only points at it. Inlining the G-code meant every
// checkpoint rewrote the whole program: for the 13 MB Halloween file, saving
// progress every 25 lines would have written ~260 GB over one job and stalled
// the sender on disk I/O while the machine was cutting.
const FILENAME_GCODE = 'job_resume_gcode.nc';

// Current schema version. Bump this when the checkpoint structure changes
// in a way that older code can't load.
const SCHEMA_VERSION = 2;

// --------------------------------------------------------------------------
// CRC32 (IEEE 802.3, reflected) — same table/algorithm as rsp/frame.js
// --------------------------------------------------------------------------
const _CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _CRC_TABLE[i] = c >>> 0;
}

/**
 * @param {Buffer|string} data
 * @returns {string} hex CRC32
 */
function computeCrc32(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = (_CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// --------------------------------------------------------------------------
// File operations that another program may briefly block
// --------------------------------------------------------------------------
// Windows reports "another program has this file open" as EPERM (access
// denied) or EBUSY (sharing violation). EACCES is a permission problem that
// does not go away by trying again, so it is not retried.
const LOCK_CODES = new Set(['EPERM', 'EBUSY']);
// Re-attempt at once, without sleeping, within this much time in all.
// The first version slept 1/3/8/16 ms between attempts; on Windows every such
// sleep lasts a whole 15.6 ms timer tick, so each held file operation blocked
// ~78 ms and every save 80-160 ms while OneDrive or an editor held a
// checkpoint file (review, 2026-09-17) -- worse than the stall it replaced.
const LOCK_RETRY_BUDGET_MS = 4;
const LOCK_RETRY_MAX = 3;
// After an operation stayed held through its retries: a single attempt per
// operation for this long, or until a save works again.
const LOCK_FAIL_FAST_MS = 5000;

function withLockRetry(fn, maxRetries = LOCK_RETRY_MAX) {
    const t0 = performance.now();
    for (let i = 0; ; i++) {
        try {
            return fn();
        } catch (err) {
            if (!LOCK_CODES.has(err && err.code) || i >= maxRetries ||
                performance.now() - t0 >= LOCK_RETRY_BUDGET_MS) throw err;
        }
    }
}

function closeQuietly(fd) { try { fs.closeSync(fd); } catch (_) { /* already closed */ } }
function unlinkQuietly(p) { try { fs.unlinkSync(p); } catch (_) { /* not there */ } }
function fsyncPathSync(p) {
    const fd = fs.openSync(p, 'r+');
    try { fs.fsyncSync(fd); } finally { closeQuietly(fd); }
}

// Durability of the files, per data folder, shared by every store on that
// folder in this process. A file already there when the process started is
// on the disk. Each file this process writes gets a generation number; its
// handle stays open until its background fsync is done (openGens).
const _dirStates = new Map();
function dirState(dir) {
    const r = path.resolve(dir);
    const key = process.platform === 'win32' ? r.toLowerCase() : r;
    let s = _dirStates.get(key);
    if (!s) {
        s = { gen: 0, mainGen: 0, bakGen: 0, gcodeGen: 0, mainDurable: true, openGens: new Set(), pendingFsyncs: 0, idleWaiters: [] };
        _dirStates.set(key, s);
    }
    return s;
}

// Windows cannot rename a file over one that still has an open handle (our
// fsync handle, for the few milliseconds it runs). Such a file is renamed
// out of the way first -- renaming an open file is allowed -- and deleted;
// the name frees at once, the data when the handle closes.
function moveAside(p, tag) {
    const aside = `${p}.${tag}.old`;
    try {
        fs.renameSync(p, aside);
    } catch (e) {
        if (e && e.code === 'ENOENT') return;
        throw e;
    }
    unlinkQuietly(aside);
}

// Default modal state — used when the caller doesn't provide one.
const DEFAULT_MODAL_STATE = Object.freeze({
    wcs: 'G54',
    units: 'G21',
    distanceMode: 'G90',
    feedMode: 'G94',
    spindleState: 'M5',
    spindleRpm: 0,
    coolantState: 'M9',
    feedRate: 0,
    toolNumber: 0,
    feedOverridePct: 100,
});

class JobResumeStore {
    /**
     * @param {string} dataDir  Absolute path to the backend data directory.
     * @param {object} [logger]
     */
    constructor(dataDir, logger) {
        this.dataDir  = dataDir;
        this.filePath = path.join(dataDir, FILENAME);
        this.tmpPath  = path.join(dataDir, FILENAME_TMP);
        this.bakPath  = path.join(dataDir, FILENAME_BAK);
        this.gcodePath = path.join(dataDir, FILENAME_GCODE);
        this._gcodeHashOnDisk = null;
        this._log     = logger || console;
        this._state   = dirState(dataDir);
        this._dirReady = false;
        // sha1 of the last program saved, kept with the string it was computed
        // from: the same job passes the same string object at every save, so
        // comparing it is instant, and the program is hashed once per job.
        this._hashedText = undefined;
        this._hashedHash = null;
        // A failing save is reported once, until a save works again.
        this._failing = null;   // { since, count, code }
        // Until then (epoch ms) a held file gets one attempt, no retries.
        this._lockFailFastUntil = 0;
        /** Outcome of the last save(): { ok, at, line?, filename?, error? } */
        this.lastSave = null;
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Save a checkpoint. Required fields:
     *   filename, gcodeText, totalLines, lastExecutedLine
     * Optional fields:
     *   wcs, lastConfirmedPos, modalState
     *
     * All fields except `savedAt`, `gcodeHash`, `crc32`, and `version` must
     * be supplied by the caller; this method fills in the derived/timestamp/
     * integrity fields.
     *
     * Never throws: a failure (disk full, file locked) is reported once and
     * the previous checkpoint stays in place.
     *
     * @param {object} data
     * @returns {boolean} true when the checkpoint was written
     */
    save(data) {
        const text = (data && data.gcodeText) || '';
        for (let attempt = 0; ; attempt++) {
            try {
                if (!this._dirReady) {
                    fs.mkdirSync(this.dataDir, { recursive: true });
                    this._dirReady = true;
                }

                const hash = this._hashOf(text);

                // Program text: written once per job, then referenced. Checkpoints
                // after that are a kilobyte of JSON, so they can be frequent.
                let gcodeFile = null;
                if (text) {
                    if (this._gcodeHashOnDisk !== hash || !fs.existsSync(this.gcodePath)) {
                        this._writeProgram(text);
                        this._gcodeHashOnDisk = hash;
                    }
                    gcodeFile = FILENAME_GCODE;
                }

                // Build the record WITHOUT crc32 first, compute CRC over it,
                // then add crc32 to the final record.
                const recordBase = {
                    version:          SCHEMA_VERSION,
                    filename:         data.filename        || 'untitled.nc',
                    gcodeFile,
                    gcodeHash:        hash,
                    totalLines:       data.totalLines      ?? 0,
                    lastExecutedLine: data.lastExecutedLine ?? 0,
                    lastConfirmedPos: data.lastConfirmedPos || { x: 0, y: 0, z: 0 },
                    modalState:       { ...DEFAULT_MODAL_STATE, ...(data.modalState || {}) },
                    // How the program was loaded (RSP): a spin-up delay adds a
                    // line after each M3, so lastExecutedLine only names the same
                    // line when the file is reloaded the same way. Absent = unknown.
                    spindleDelay:     data.spindleDelay,
                    compileOptions:   data.compileOptions,
                    savedAt:          Date.now(),
                };

                // CRC32 is computed over the JSON string of the record without crc32
                const jsonForCrc = JSON.stringify(recordBase);
                const crc = computeCrc32(jsonForCrc);

                const record = { ...recordBase, crc32: crc };
                this._commit(JSON.stringify(record, null, 2));

                this._saved(record);
                return true;
            } catch (e) {
                // The folder went away under us (deleted, drive remounted):
                // recreate it once and try again.
                if (e && e.code === 'ENOENT' && attempt === 0) {
                    this._dirReady = false;
                    continue;
                }
                this._saveFailed(e);
                return false;
            }
        }
    }

    /**
     * Resolves when every fsync this process started on this data folder has
     * finished (the saved checkpoints are on the disk for good).
     * @returns {Promise<void>}
     */
    whenDurable() {
        const st = this._state;
        return st.pendingFsyncs ? new Promise((resolve) => st.idleWaiters.push(resolve)) : Promise.resolve();
    }

    /**
     * Load and parse the stored checkpoint with integrity validation.
     *
     * Validation chain:
     *   1. Parse JSON
     *   2. Verify CRC32 (if present; v1 records without CRC are accepted)
     *   3. Re-hash gcodeText and compare to gcodeHash
     *
     * If the main file fails, tries the .bak backup.
     *
     * @returns {object|null}
     */
    load() {
        // Try main file first.
        const main = this._loadAndValidate(this.filePath);
        if (main) return main;

        // Main file missing or corrupt — try backup.
        const bak = this._loadAndValidate(this.bakPath);
        if (bak) {
            this._log.warn?.('[JobResumeStore] main checkpoint corrupt/missing — recovered from backup');
            // Restore the backup as the main file so future loads don't
            // need to fall back again.
            try {
                this._retryLocked(() => fs.copyFileSync(this.bakPath, this.filePath));
                // The copy is not flushed yet: fsync it before it can ever
                // be rotated into .bak.
                this._state.mainGen = ++this._state.gen;
                this._state.mainDurable = false;
            } catch (_) { /* best effort */ }
            return bak;
        }

        return null;
    }

    /**
     * Delete the checkpoint file (and backup). Called when a job completes
     * successfully (no resume needed) or when the user explicitly clears it.
     */
    clear() {
        const st = this._state;
        const tag = ++st.gen;
        // Each file on its own: one locked file must not leave the others
        // (a stale .bak alone would bring a finished job back as resumable).
        let failure = null;
        const files = [
            [this.filePath, st.mainGen], [this.tmpPath, 0], [this.bakPath, st.bakGen],
            [this.gcodePath, st.gcodeGen], [`${this.gcodePath}.tmp`, 0],
        ];
        for (const [p, gen] of files) {
            try {
                // Still being flushed: free the name now (see moveAside).
                if (gen && st.openGens.has(gen)) this._retryLocked(() => moveAside(p, tag));
                else this._retryLocked(() => fs.unlinkSync(p));
            } catch (e) {
                if (e && e.code !== 'ENOENT' && !failure) failure = e;
            }
        }
        try {
            for (const f of fs.readdirSync(this.dataDir)) {
                if (/^job_resume.*\.old$/.test(f)) unlinkQuietly(path.join(this.dataDir, f));
            }
        } catch (_) { /* no folder */ }
        this._gcodeHashOnDisk = null;
        this._hashedText = undefined;
        this._hashedHash = null;
        st.mainGen = 0;
        st.bakGen = 0;
        st.gcodeGen = 0;
        st.mainDurable = true;
        if (failure) {
            this._log.warn?.(`[JobResumeStore] clear failed: ${failure.message}`);
        }
    }

    /** @returns {boolean} */
    has() {
        return fs.existsSync(this.filePath) || fs.existsSync(this.bakPath);
    }

    /**
     * Where the saved checkpoint says the job got to, without reading or
     * hashing the program (the CRC of the small record is still checked).
     * Main file first, then .bak. Never throws.
     * @returns {{filename:string, gcodeHash:string, lastExecutedLine:number, totalLines:number, savedAt:number}|null}
     */
    readSummary() {
        for (const p of [this.filePath, this.bakPath]) {
            try {
                const record = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (record.crc32) {
                    const { crc32: savedCrc, ...rest } = record;
                    if (computeCrc32(JSON.stringify(rest)) !== savedCrc) continue;
                }
                return {
                    filename: record.filename,
                    gcodeHash: record.gcodeHash,
                    lastExecutedLine: record.lastExecutedLine,
                    totalLines: record.totalLines,
                    savedAt: record.savedAt,
                };
            } catch (_) { /* missing or unreadable: try the next */ }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /** sha1 of the program, computed once per program string. */
    _hashOf(text) {
        if (this._hashedHash === null || text !== this._hashedText) {
            this._hashedHash = crypto.createHash('sha1').update(text).digest('hex');
            this._hashedText = text;
        }
        return this._hashedHash;
    }

    /**
     * A file operation another program may be holding up (LOCK_RETRY_BUDGET_MS).
     * Once one stayed held through its retries, the next ones get a single
     * attempt for LOCK_FAIL_FAST_MS or until a save works again.
     */
    _retryLocked(fn) {
        const retries = Date.now() < this._lockFailFastUntil ? 0 : LOCK_RETRY_MAX;
        try {
            return withLockRetry(fn, retries);
        } catch (e) {
            if (e && LOCK_CODES.has(e.code)) this._lockFailFastUntil = Date.now() + LOCK_FAIL_FAST_MS;
            throw e;
        }
    }

    /** The program file: tmp -> rename, flushed to disk on the thread pool. */
    _writeProgram(text) {
        const st = this._state;
        const gen = ++st.gen;
        const tmp = `${this.gcodePath}.tmp`;
        const fd = this._retryLocked(() => fs.openSync(tmp, 'w'));
        try {
            fs.writeFileSync(fd, text, 'utf8');
            if (st.openGens.has(st.gcodeGen)) moveAside(this.gcodePath, gen);
            this._retryLocked(() => fs.renameSync(tmp, this.gcodePath));
        } catch (e) {
            closeQuietly(fd);
            unlinkQuietly(tmp);
            throw e;
        }
        st.gcodeGen = gen;
        this._fsyncLater(fd, gen);
    }

    /**
     * Put `json` in place as the main file: tmp -> (main -> .bak) -> main.
     * The new main's fsync runs on the thread pool; .bak only ever receives a
     * main that is already on the disk for good (see the header).
     */
    _commit(json) {
        const st = this._state;
        const gen = ++st.gen;
        const fd = this._retryLocked(() => fs.openSync(this.tmpPath, 'w'));
        try {
            fs.writeFileSync(fd, json, 'utf8');
        } catch (e) {
            closeQuietly(fd);
            unlinkQuietly(this.tmpPath);
            throw e;
        }
        try {
            let rotate = true;
            if (!st.mainDurable) {
                try {
                    fsyncPathSync(this.filePath);
                    st.mainDurable = true;
                } catch (e) {
                    // No main (ENOENT): nothing to rotate. Main that cannot be
                    // flushed: do not let it replace a good .bak.
                    rotate = false;
                    if (e && e.code === 'ENOENT') st.mainDurable = true;
                }
            }
            if (rotate) {
                // One attempt, never retried: if it fails (no main yet, or main
                // or .bak held by another program) the older .bak stays -- it
                // is still a good checkpoint -- and main is replaced anyway.
                try {
                    if (st.openGens.has(st.bakGen)) moveAside(this.bakPath, gen);
                    fs.renameSync(this.filePath, this.bakPath);
                    st.bakGen = st.mainGen;
                } catch (e) {
                    if (!(e && e.code === 'ENOENT')) this._note('bak', `could not refresh ${FILENAME_BAK} (${e.code || e.message}); the older backup is kept`);
                }
            }
            if (st.openGens.has(st.mainGen) && fs.existsSync(this.filePath)) moveAside(this.filePath, gen);
            this._retryLocked(() => fs.renameSync(this.tmpPath, this.filePath));
        } catch (e) {
            closeQuietly(fd);
            unlinkQuietly(this.tmpPath);
            throw e;
        }
        st.mainGen = gen;
        st.mainDurable = false;
        this._fsyncLater(fd, gen);
    }

    _fsyncLater(fd, gen) {
        const st = this._state;
        st.openGens.add(gen);
        st.pendingFsyncs++;
        fs.fsync(fd, (err) => {
            if (err) {
                this._note('fsync', `could not flush the checkpoint to disk (${err.code || err.message})`);
            } else if (st.mainGen === gen) {
                st.mainDurable = true;
            }
            fs.close(fd, () => {
                st.openGens.delete(gen);
                st.pendingFsyncs--;
                if (!st.pendingFsyncs && st.idleWaiters.length) {
                    const waiters = st.idleWaiters.splice(0);
                    for (const w of waiters) w();
                }
            });
        });
    }

    /** A secondary problem (backup, flush): one warning per store. */
    _note(key, message) {
        this._noted = this._noted || new Set();
        if (this._noted.has(key)) return;
        this._noted.add(key);
        this._log.warn?.(`[JobResumeStore] ${message}`);
    }

    _saved(record) {
        this.lastSave = { ok: true, at: Date.now(), line: record.lastExecutedLine, filename: record.filename };
        this._lockFailFastUntil = 0;
        if (this._failing) {
            const f = this._failing;
            this._failing = null;
            this._log.info?.(`[JobResumeStore] saving the resume checkpoint works again (${f.count} save(s) failed since ${new Date(f.since).toISOString()})`);
        }
    }

    _saveFailed(e) {
        const code = (e && e.code) || '';
        this.lastSave = { ok: false, at: Date.now(), error: (e && e.message) || String(e) };
        if (this._failing) {
            this._failing.count++;
            return;
        }
        this._failing = { since: Date.now(), count: 1, code };
        let why;
        if (code === 'ENOSPC') {
            why = 'the disk is full (ENOSPC). Free some space: until then the job\'s resume point is not being saved';
        } else if (LOCK_CODES.has(code)) {
            why = `${this.dataDir} is held by another program (${code}) -- OneDrive, a backup tool or antivirus. Retrying at every save`;
        } else if (code === 'EACCES') {
            why = `no permission to write in ${this.dataDir} (EACCES); the job's resume point is not being saved until that is fixed`;
        } else {
            why = (e && e.message) || String(e);
        }
        this._log.error?.(`[JobResumeStore] save failed: ${why}`);
    }

    /**
     * Load, parse, and validate a single checkpoint file.
     * @param {string} filePath
     * @returns {object|null}
     */
    _loadAndValidate(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null;
            const raw = fs.readFileSync(filePath, 'utf8');
            const record = JSON.parse(raw);

            // ---- CRC32 validation (v2+ records only) ----
            if (record.crc32) {
                // Rebuild the record without crc32 to recompute the hash.
                const { crc32: savedCrc, ...recordWithoutCrc } = record;
                const jsonForCrc = JSON.stringify(recordWithoutCrc);
                const computedCrc = computeCrc32(jsonForCrc);
                if (computedCrc !== savedCrc) {
                    this._log.error?.(
                        `[JobResumeStore] CRC32 mismatch in ${path.basename(filePath)}: ` +
                        `expected ${savedCrc}, got ${computedCrc} — checkpoint rejected`
                    );
                    return null;
                }
            }

            // ---- program text: read the companion file when referenced ----
            if (!record.gcodeText && record.gcodeFile) {
                const gpath = path.join(path.dirname(filePath), record.gcodeFile);
                if (!fs.existsSync(gpath)) {
                    this._log.error?.(`[JobResumeStore] checkpoint references ${record.gcodeFile}, which is missing — checkpoint rejected`);
                    return null;
                }
                record.gcodeText = fs.readFileSync(gpath, 'utf8');
            }

            // ---- gcodeHash validation ----
            if (record.gcodeText && record.gcodeHash) {
                const recomputedHash = crypto.createHash('sha1')
                    .update(record.gcodeText)
                    .digest('hex');
                if (recomputedHash !== record.gcodeHash) {
                    this._log.error?.(
                        `[JobResumeStore] gcodeHash mismatch in ${path.basename(filePath)}: ` +
                        `stored=${record.gcodeHash}, computed=${recomputedHash} — checkpoint rejected`
                    );
                    return null;
                }
            }

            // ---- Migrate v1 records to v2 shape ----
            if (!record.version || record.version < SCHEMA_VERSION) {
                record.version = SCHEMA_VERSION;
                if (!record.lastConfirmedPos) record.lastConfirmedPos = { x: 0, y: 0, z: 0 };
                if (!record.modalState) record.modalState = { ...DEFAULT_MODAL_STATE };
                if (record.wcs) {
                    record.modalState.wcs = record.wcs;
                    delete record.wcs;
                }
            }

            return record;
        } catch (e) {
            this._log.warn?.(`[JobResumeStore] load from ${path.basename(filePath)} failed: ${e.message}`);
            return null;
        }
    }
}

module.exports = { JobResumeStore, computeCrc32, DEFAULT_MODAL_STATE, SCHEMA_VERSION };
