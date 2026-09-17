/**
 * Crash-safe JSON file store (spec §5.1.2).
 *
 * One instance per file, shared by every owner of that file, so a credential
 * save can never overwrite the gate's `tiers` block with a stale copy (and
 * vice versa). Writes are synchronous: tmp + fsync, current file -> .bak,
 * rename tmp over the file. A torn or corrupt main file falls back to .bak.
 *
 * Only unparseable content counts as corruption. A file that exists but
 * cannot be read (Windows sharing violations from OneDrive or an AV scan:
 * EBUSY/EPERM/EACCES) is retried briefly; if it stays unreadable the store
 * comes up read-only with defaults and refuses update(), because writing the
 * defaults back would erase the real pairing on disk. It re-reads the file
 * lazily (one non-sleeping read, at most every 5 s from get() and once per
 * update()) and adopts it as soon as the lock clears.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TRANSIENT_IO_CODES = Object.freeze(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);
const READ_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 150, 175]);
const RENAME_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200, 300, 325]);
const READONLY_RECHECK_MS = 5000;

function deepFreeze(obj) {
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
        Object.freeze(obj);
        for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    }
    return obj;
}

function clone(obj) {
    return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj));
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Defaults fill keys the file does not have yet; stored values always win.
function mergeDefaults(defaults, data) {
    if (!isPlainObject(defaults)) return data === undefined ? clone(defaults) : data;
    const out = isPlainObject(data) ? data : {};
    for (const key of Object.keys(defaults)) {
        if (!(key in out)) out[key] = clone(defaults[key]);
        else if (isPlainObject(defaults[key]) && isPlainObject(out[key])) mergeDefaults(defaults[key], out[key]);
    }
    return out;
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {
        const until = Date.now() + ms;
        while (Date.now() < until) { /* busy wait fallback */ }
    }
}

function isTransient(err) {
    return !!(err && TRANSIENT_IO_CODES.includes(err.code));
}

/**
 * @returns {{missing:boolean, ok:boolean, value?:object, ioError?:string}}
 *   ioError is set when the file exists but could not be read (not corrupt).
 */
function tryRead(file, { retry = true } = {}) {
    let raw;
    for (let attempt = 0; ; attempt += 1) {
        try {
            raw = fs.readFileSync(file, 'utf-8');
            break;
        } catch (err) {
            if (err && err.code === 'ENOENT') return { missing: true, ok: false };
            if (retry && isTransient(err) && attempt < READ_RETRY_DELAYS_MS.length) {
                sleepSync(READ_RETRY_DELAYS_MS[attempt]);
                continue;
            }
            return { missing: false, ok: false, ioError: (err && err.code) || 'EIO' };
        }
    }
    try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) return { missing: false, ok: false };
        return { missing: false, ok: true, value: parsed };
    } catch (_) {
        return { missing: false, ok: false };
    }
}

function renameWithRetry(from, to) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (err) {
            if (isTransient(err) && attempt < RENAME_RETRY_DELAYS_MS.length) {
                sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
                continue;
            }
            throw err;
        }
    }
}

function writeAtomic(file, data) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, `${file}.bak`); } catch (_) { /* .bak is best effort */ }
    }
    renameWithRetry(tmp, file);
}

function quarantineCorrupt(file, log, { retry = true } = {}) {
    const bak = tryRead(`${file}.bak`, { retry });
    try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (_) { /* nothing to preserve */ }
    log.error(`[atomicJson] ${path.basename(file)} is corrupt${bak.ok ? ', restored from .bak' : ', starting from defaults'}`);
    return bak.ok ? bak.value : {};
}

function createAtomicJsonStore(file, { defaults = {}, logger = null } = {}) {
    const log = logger || { error() {}, warn() {}, info() {} };
    let data;
    let readOnlyCode = null;
    let lastRecheckAt = 0;

    const main = tryRead(file);
    if (main.ok) {
        data = main.value;
    } else if (main.ioError) {
        // Exists but locked/unreadable: never treat as corrupt, never write
        // defaults over it.
        readOnlyCode = main.ioError;
        lastRecheckAt = Date.now();
        log.error(`[atomicJson] ${path.basename(file)} is unreadable (${main.ioError}); using defaults read-only until it can be read`);
        data = {};
    } else if (main.missing) {
        const bak = tryRead(`${file}.bak`);
        data = bak.ok ? bak.value : {};
    } else {
        data = quarantineCorrupt(file, log);
    }
    data = mergeDefaults(defaults, data);
    let snapshot = deepFreeze(clone(data));

    // Re-read a file that was unreadable at startup. Returns true when the
    // store is writable (again). This runs on the request/event path (get()
    // from the gate's getState, update() from routes), so it makes exactly one
    // read and never sleeps: a persistent lock must not stall the event loop
    // that carries stop/feed-hold and the jog deadman. Only the one-time boot
    // load in the constructor uses the sleeping retry.
    function recover(force) {
        if (readOnlyCode === null) return true;
        const now = Date.now();
        if (!force && now - lastRecheckAt < READONLY_RECHECK_MS) return false;
        lastRecheckAt = now;
        const again = tryRead(file, { retry: false });
        if (again.ioError) {
            readOnlyCode = again.ioError;
            return false;
        }
        let value;
        if (again.ok) value = again.value;
        else if (again.missing) value = {};
        else value = quarantineCorrupt(file, log, { retry: false });
        data = mergeDefaults(defaults, value);
        snapshot = deepFreeze(clone(data));
        readOnlyCode = null;
        log.info(`[atomicJson] ${path.basename(file)} is readable again`);
        return true;
    }

    return {
        file,
        get() {
            if (readOnlyCode !== null) recover(false);
            return snapshot;
        },
        update(mutator) {
            if (!recover(true)) {
                const err = new Error(`store_unreadable: ${path.basename(file)} (${readOnlyCode})`);
                err.code = 'STORE_UNREADABLE';
                err.ioCode = readOnlyCode;
                throw err;
            }
            const draft = clone(data);
            mutator(draft);
            writeAtomic(file, draft);
            data = draft;
            snapshot = deepFreeze(clone(data));
            return snapshot;
        },
        isReadOnly() {
            return readOnlyCode !== null;
        },
        loadError() {
            return readOnlyCode;
        },
        flush() {},
    };
}

module.exports = { createAtomicJsonStore, deepFreeze, TRANSIENT_IO_CODES };
