/**
 * Remote file staging (spec §5.7): download an offered transfer from the
 * relay into the library, and nothing more.
 *
 * Nothing here loads, starts or even reads a file into memory in one piece.
 * Bodies stream to disk with the hash and UTF-8 check done incrementally;
 * the URL is always built from the configured relay origin plus a validated
 * transferId, so a message can never steer the credential to another host.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const defaultClock = require('./clock');
const { createAtomicJsonStore } = require('./atomicJson');
const { TRANSFER_ID_RE, SHA256_RE, hasAllowedExtension } = require('./protocol');

const MIB = 1024 * 1024;
const MIN_FREE_BYTES = 1024 * MIB;
const IDLE_TIMEOUT_MS = 30000;
const MIN_TOTAL_MS = 120000;
const MIN_RATE_BPS = 50 * 1024;
const MAX_QUEUE = 5;
const RETRY_DELAYS_MS = Object.freeze([2000, 4000, 8000, 16000, 32000]);
const INDEX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REFEED_CHUNK = 64 * 1024;
const READY_RETRY_MS = 1000;

class TerminalError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

class AbortedError extends Error {}

function baseName(name) {
    return path.basename(String(name || '').replace(/\\/g, '/'));
}

class FileIngest {
    constructor({
        dataDir, store, logger, gate, libraryService,
        getRelayUrl, getCredential, isLanOnly = () => false, sendResult = () => false,
        fetchImpl = globalThis.fetch, clock = defaultClock,
        setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
        statfs = (p) => fs.statfsSync(p), retryDelaysMs = RETRY_DELAYS_MS,
    }) {
        this.dataDir = dataDir;
        this.inbox = path.join(dataDir, 'cloud-inbox');
        this.store = store;
        this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
        this.gate = gate;
        this.libraryService = libraryService;
        this.getRelayUrl = getRelayUrl || (() => null);
        this.getCredential = getCredential || (() => null);
        this.isLanOnly = isLanOnly;
        this.sendResult = sendResult;
        this.fetchImpl = fetchImpl;
        this.clock = clock;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.statfs = statfs;
        this.retryDelaysMs = retryDelaysMs;

        this._index = null;
        this._queue = [];
        this._active = null;      // {offer, controller, reason}
        this._ready = new Map();  // transferId -> {offer, readyPath}
        this._readyTimer = null;
        this._retryTimers = new Map(); // timer -> resolve, so abortAll can wake sleepers
        this._generation = 0;
    }

    init() {
        try {
            fs.mkdirSync(this.inbox, { recursive: true });
        } catch (err) {
            this.logger.warn(`[cloud-ingest] cannot create inbox: ${err.message}`);
            return;
        }
        this._index = createAtomicJsonStore(path.join(this.inbox, 'ingest-index.json'), { logger: this.logger });
        const cutoff = this.clock.wall() - INDEX_RETENTION_MS;
        const stale = Object.entries(this._index.get().entries || {}).filter(([, e]) => !e || e.storedAt < cutoff);
        if (stale.length) {
            this._index.update((d) => {
                for (const [id] of stale) delete d.entries[id];
            });
        }
        let names = [];
        try { names = fs.readdirSync(this.inbox); } catch (_) { /* empty */ }
        for (const name of names) {
            if (name.endsWith('.part')) {
                try { fs.unlinkSync(path.join(this.inbox, name)); } catch (_) { /* best effort */ }
            } else if (name.endsWith('.ready.json')) {
                try {
                    const offer = JSON.parse(fs.readFileSync(path.join(this.inbox, name), 'utf-8'));
                    const readyPath = path.join(this.inbox, `${offer.transferId}.ready`);
                    if (offer && TRANSFER_ID_RE.test(offer.transferId) && fs.existsSync(readyPath)) {
                        this._ready.set(offer.transferId, { offer, readyPath });
                    }
                } catch (_) { /* unusable sidecar */ }
            }
        }
        if (this._ready.size) this._scheduleReady();
    }

    _indexStore() {
        if (!this._index) this.init();
        return this._index;
    }

    // ─── entry point ─────────────────────────────────────────────────

    /**
     * Returns a promise that settles when this offer has been answered (or
     * parked as .ready / dropped by abortAll). Never rejects.
     */
    handleOffer(offer) {
        return this._handleOffer(offer).catch((err) => {
            this.logger.error(`[cloud-ingest] offer failed: ${err && err.message}`);
            if (offer && typeof offer === 'object' && typeof offer.transferId === 'string') {
                this._reply({ ...offer, transferId: offer.transferId.slice(0, 40) }, 'rejected', 'INTERNAL', 'internal error');
            }
        });
    }

    async _handleOffer(offer) {
        const o = offer && typeof offer === 'object' ? offer : {};
        const transferId = typeof o.transferId === 'string' ? o.transferId : '';

        // 0. idempotency
        if (TRANSFER_ID_RE.test(transferId)) {
            const known = (this._indexStore().get().entries || {})[transferId];
            if (known && this._libraryHas(known.libraryId)) {
                this._reply(o, 'stored', 'OK', null, { libraryId: known.libraryId, sha256: known.sha256 });
                return;
            }
        }
        // 1. shape
        if (!TRANSFER_ID_RE.test(transferId) || typeof o.sha256 !== 'string' || !SHA256_RE.test(o.sha256)
            || !Number.isInteger(o.size) || o.size <= 0) {
            // Echo at most a bounded string id; it is never used to build a path or URL.
            this._reply({ ...o, transferId: transferId.slice(0, 40) || null, name: typeof o.name === 'string' ? o.name : '' },
                'rejected', 'INTERNAL', 'bad offer');
            return;
        }
        // 2-3. link and tier
        if (this.isLanOnly()) return this._reply(o, 'deferred', 'LAN_ONLY');
        const tier = this.gate.getState('cloud').tier;
        if (tier !== 'job' && tier !== 'motion') return this._reply(o, 'deferred', 'TIER_REQUIRED');
        // 4. type and size
        if (!hasAllowedExtension(baseName(o.name))) return this._reply(o, 'rejected', 'BAD_TYPE');
        const cfg = this.store.get();
        const maxFileMb = Number.isFinite(Number(cfg.maxFileMb)) ? Number(cfg.maxFileMb) : 25;
        if (o.size > maxFileMb * MIB) return this._reply(o, 'rejected', 'TOO_LARGE');
        // 5. machine storage
        const capMb = Number.isFinite(Number(cfg.cloudLibraryCapMb)) ? Number(cfg.cloudLibraryCapMb) : 500;
        let usage = 0;
        try { usage = Number(this.libraryService.cloudUsageBytes()) || 0; } catch (_) { usage = 0; }
        if (usage + o.size > capMb * MIB) return this._reply(o, 'rejected', 'TOO_LARGE', 'cloud library full');
        if (this._freeBytes() - o.size < MIN_FREE_BYTES) return this._reply(o, 'rejected', 'NO_SPACE');
        // 6. protect the running machine
        if (this.gate.isBusyForIngest()) return this._reply(o, 'deferred', 'BUSY');
        if (this._ready.has(transferId)) return this._tryReady(transferId);
        // 7. one download at a time
        if ((this._active && this._active.offer.transferId === transferId)
            || this._queue.some(q => q.offer.transferId === transferId)) {
            return;
        }
        let active;
        if (this._active) {
            if (this._queue.length >= MAX_QUEUE) return this._reply(o, 'deferred', 'BUSY');
            // _next() hands over the slot directly, so a new offer arriving in
            // between can never start a second concurrent download.
            active = await new Promise((resolve) => this._queue.push({ offer: o, resolve }));
            if (!active) return;
        } else {
            active = { offer: o, controller: null, reason: null };
            this._active = active;
        }
        await this._download(o, active);
    }

    _libraryHas(libraryId) {
        if (!libraryId) return false;
        try {
            if (typeof this.libraryService.get === 'function') return !!this.libraryService.get(libraryId);
            return this.libraryService.list().some(m => m.id === libraryId);
        } catch (_) {
            return false;
        }
    }

    _freeBytes() {
        try {
            const s = this.statfs(this.dataDir);
            return Number(s.bavail) * Number(s.bsize);
        } catch (_) {
            return Infinity;
        }
    }

    // ─── download ────────────────────────────────────────────────────

    async _download(offer, active) {
        const generation = this._generation;
        const transferId = offer.transferId;
        const partPath = path.join(this.inbox, `${transferId}.part`);
        try {
            // 8. URL from the configured relay origin only
            const relayUrl = this.getRelayUrl();
            let url;
            try {
                url = new URL('/api/device/files/' + transferId, relayUrl);
                if (url.origin !== new URL(relayUrl).origin) throw new Error('origin');
            } catch (_) {
                return this._reply(offer, 'rejected', 'INTERNAL', 'bad relay url');
            }

            let lastError = null;
            let digest = null;
            for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
                if (attempt > 0) {
                    await this._sleep(this.retryDelaysMs[attempt - 1]);
                }
                if (generation !== this._generation) return;
                try {
                    digest = await this._attempt(offer, url, partPath, active);
                    lastError = null;
                    break;
                } catch (err) {
                    if (generation !== this._generation || err instanceof AbortedError) {
                        this._unlink(partPath);
                        return;
                    }
                    if (err instanceof TerminalError) {
                        this._unlink(partPath);
                        return this._reply(offer, 'rejected', err.code, err.message === err.code ? null : err.message);
                    }
                    lastError = err;
                    this.logger.warn(`[cloud-ingest] download ${transferId} attempt ${attempt + 1} failed: ${err && err.message}`);
                }
            }
            if (lastError) {
                this._unlink(partPath);
                return this._reply(offer, 'deferred', 'DOWNLOAD_FAILED');
            }

            // 10. digest
            const expected = Buffer.from(offer.sha256.toLowerCase(), 'hex');
            if (digest.length !== expected.length || !crypto.timingSafeEqual(digest, expected)) {
                this._unlink(partPath);
                return this._reply(offer, 'rejected', 'HASH_MISMATCH');
            }
            if (generation !== this._generation) return;

            // 11. park while the machine is busy; answer once idle
            const readyPath = path.join(this.inbox, `${transferId}.ready`);
            fs.renameSync(partPath, readyPath);
            fs.writeFileSync(`${readyPath}.json`, JSON.stringify(offer));
            this._ready.set(transferId, { offer, readyPath });
            await this._tryReady(transferId);
        } finally {
            if (this._active === active) {
                this._active = null;
                this._next();
            }
        }
    }

    _next() {
        const nextItem = this._queue.shift();
        if (!nextItem) return;
        const active = { offer: nextItem.offer, controller: null, reason: null };
        this._active = active;
        nextItem.resolve(active);
    }

    _sleep(ms) {
        return new Promise((resolve) => {
            const t = this.setTimeoutFn(() => {
                this._retryTimers.delete(t);
                resolve();
            }, ms);
            this._retryTimers.set(t, resolve);
        });
    }

    async _attempt(offer, url, partPath, active) {
        let partSize = 0;
        try { partSize = fs.statSync(partPath).size; } catch (_) { partSize = 0; }

        const hash = crypto.createHash('sha256');
        let decoder = new TextDecoder('utf-8', { fatal: true });
        const controller = new AbortController();
        active.controller = controller;
        let idleTimer = null;
        const armIdle = () => {
            if (idleTimer) this.clearTimeoutFn(idleTimer);
            idleTimer = this.setTimeoutFn(() => controller.abort(new Error('idle timeout')), IDLE_TIMEOUT_MS);
        };
        const totalMs = Math.max(MIN_TOTAL_MS, (offer.size / MIN_RATE_BPS) * 1000);
        const totalTimer = this.setTimeoutFn(() => controller.abort(new Error('total timeout')), totalMs);

        try {
            if (partSize > 0) {
                await this._refeed(partPath, partSize, hash, decoder);
            }
            const headers = { Authorization: 'Bearer ' + this.getCredential() };
            if (partSize > 0) headers.Range = `bytes=${partSize}-`;
            armIdle();
            const res = await this.fetchImpl(url.href, { headers, redirect: 'error', signal: controller.signal });
            if (res.status !== 200 && res.status !== 206) {
                if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
                throw new Error(`HTTP ${res.status}`);
            }
            if (res.status === 200 && partSize > 0) {
                // Server ignored the Range: start over.
                decoder = new TextDecoder('utf-8', { fatal: true });
                const fresh = await this._streamBody(res, partPath, 'w', 0, crypto.createHash('sha256'), decoder, offer, armIdle, active);
                return fresh.digest();
            }
            if (res.status === 206) {
                const range = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-range') : null;
                const m = range && /^bytes (\d+)-/.exec(range);
                if (!m || Number(m[1]) !== partSize) {
                    this._unlink(partPath);
                    throw new Error('bad content-range');
                }
            }
            const done = await this._streamBody(res, partPath, partSize > 0 ? 'a' : 'w', partSize, hash, decoder, offer, armIdle, active);
            return done.digest();
        } catch (err) {
            if (active.reason) throw new AbortedError(active.reason);
            throw err;
        } finally {
            if (idleTimer) this.clearTimeoutFn(idleTimer);
            this.clearTimeoutFn(totalTimer);
            active.controller = null;
        }
    }

    async _streamBody(res, partPath, flags, written, hash, decoder, offer, armIdle, active) {
        const fh = await fs.promises.open(partPath, flags);
        try {
            if (!res.body) throw new Error('empty body');
            for await (const chunk of res.body) {
                armIdle();
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                written += buf.length;
                if (written > offer.size) {
                    active.controller && active.controller.abort(new Error('too large'));
                    throw new TerminalError('TOO_LARGE');
                }
                try {
                    decoder.decode(buf, { stream: true });
                } catch (_) {
                    active.controller && active.controller.abort(new Error('not utf8'));
                    throw new TerminalError('NOT_UTF8');
                }
                hash.update(buf);
                await fh.write(buf);
            }
        } finally {
            await fh.close().catch(() => {});
        }
        if (written !== offer.size) throw new Error(`short body ${written}/${offer.size}`);
        try {
            decoder.decode();
        } catch (_) {
            throw new TerminalError('NOT_UTF8');
        }
        return hash;
    }

    async _refeed(partPath, partSize, hash, decoder) {
        const fh = await fs.promises.open(partPath, 'r');
        try {
            const buf = Buffer.alloc(REFEED_CHUNK);
            let pos = 0;
            while (pos < partSize) {
                const { bytesRead } = await fh.read(buf, 0, Math.min(REFEED_CHUNK, partSize - pos), pos);
                if (bytesRead <= 0) break;
                const chunk = buf.subarray(0, bytesRead);
                try {
                    decoder.decode(chunk, { stream: true });
                } catch (_) {
                    throw new TerminalError('NOT_UTF8');
                }
                hash.update(chunk);
                pos += bytesRead;
                await new Promise(resolve => setImmediate(resolve));
            }
        } finally {
            await fh.close().catch(() => {});
        }
    }

    // ─── ready files (steps 11-13) ───────────────────────────────────

    async _tryReady(transferId) {
        const item = this._ready.get(transferId);
        if (!item) return;
        if (this.gate.isBusyForIngest()) {
            this._scheduleReady();
            return;
        }
        if (item.storing) return;
        item.storing = true;
        const { offer, readyPath } = item;
        try {
            const fileName = baseName(offer.name).slice(0, 200);
            const ext = path.extname(fileName);
            const name = (ext ? fileName.slice(0, -ext.length) : fileName).slice(0, 120) || fileName.slice(0, 120);
            const uploadedBy = offer.uploadedBy && typeof offer.uploadedBy === 'object' ? offer.uploadedBy : {};
            const meta = await this.libraryService.upsertFromFile({
                name,
                fileName,
                srcPath: readyPath,
                provenance: {
                    origin: 'cloud',
                    uploadedBy: typeof uploadedBy.userLabel === 'string' ? uploadedBy.userLabel.slice(0, 60) : null,
                    uploadedByUserId: typeof uploadedBy.userId === 'string' ? uploadedBy.userId.slice(0, 40) : null,
                    transferId,
                    sha256: offer.sha256.toLowerCase(),
                    receivedAt: this.clock.wall(),
                    reviewed: false,
                },
            });
            this._indexStore().update((d) => {
                if (!d.entries || typeof d.entries !== 'object') d.entries = {};
                d.entries[transferId] = { libraryId: meta.id, sha256: offer.sha256.toLowerCase(), storedAt: this.clock.wall() };
            });
            this._ready.delete(transferId);
            this._unlink(`${readyPath}.json`);
            this._reply(offer, 'stored', 'OK', null, { libraryId: meta.id, sha256: offer.sha256.toLowerCase() });
        } catch (err) {
            item.storing = false;
            this.logger.error(`[cloud-ingest] store ${transferId} failed: ${err && err.message}`);
            this._ready.delete(transferId);
            this._unlink(readyPath);
            this._unlink(`${readyPath}.json`);
            this._reply(offer, 'rejected', 'INTERNAL', 'store failed');
        }
    }

    _scheduleReady() {
        if (this._readyTimer) return;
        this._readyTimer = this.setTimeoutFn(() => {
            this._readyTimer = null;
            this.retryReady();
        }, READY_RETRY_MS);
        if (this._readyTimer && typeof this._readyTimer.unref === 'function') this._readyTimer.unref();
    }

    /** Called when the machine may have become idle. */
    retryReady() {
        for (const transferId of [...this._ready.keys()]) this._tryReady(transferId);
    }

    hasPendingReady() {
        return this._ready.size > 0;
    }

    // ─── results and teardown ────────────────────────────────────────

    _reply(offer, status, code, message = null, extra = {}) {
        const body = {
            transferId: offer.transferId,
            status,
            libraryId: extra.libraryId || null,
            sha256: extra.sha256 || (typeof offer.sha256 === 'string' ? offer.sha256.toLowerCase() : null),
            code,
            message,
        };
        try { this.sendResult(body); } catch (_) { /* link may be down; relay re-offers */ }
        const event = status === 'stored' ? 'file.stored' : status === 'rejected' ? 'file.rejected' : 'file.deferred';
        const uploadedBy = offer.uploadedBy && typeof offer.uploadedBy === 'object' ? offer.uploadedBy : {};
        if (this.gate && typeof this.gate.audit === 'function') {
            this.gate.audit({
                kind: 'cloud',
                userId: typeof uploadedBy.userId === 'string' ? uploadedBy.userId : null,
                userLabel: typeof uploadedBy.userLabel === 'string' ? uploadedBy.userLabel : null,
            }, {
                event,
                type: 'file',
                args: { transferId: offer.transferId, name: baseName(offer.name).slice(0, 120), size: offer.size, libraryId: body.libraryId },
                status,
                code,
                message,
            });
        }
        return body;
    }

    _unlink(p) {
        try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
    }

    /** Abort everything in flight; sends nothing over the network. */
    abortAll(reason) {
        this._generation += 1;
        const active = this._active;
        if (active) {
            active.reason = reason || 'aborted';
            if (active.controller) active.controller.abort(new Error(active.reason));
        }
        const queued = this._queue.splice(0);
        this._active = null;
        for (const q of queued) q.resolve(null);
        // Resolve the cleared backoff sleeps: the download then sees the
        // bumped generation and returns, so handleOffer settles.
        const sleepers = [...this._retryTimers];
        this._retryTimers.clear();
        for (const [t, wake] of sleepers) {
            this.clearTimeoutFn(t);
            wake();
        }
        let names = [];
        try { names = fs.readdirSync(this.inbox); } catch (_) { /* no inbox */ }
        for (const name of names) {
            if (name.endsWith('.part')) this._unlink(path.join(this.inbox, name));
        }
    }

    stop() {
        this.abortAll('shutdown');
        if (this._readyTimer) this.clearTimeoutFn(this._readyTimer);
        this._readyTimer = null;
    }
}

module.exports = { FileIngest, TerminalError };
