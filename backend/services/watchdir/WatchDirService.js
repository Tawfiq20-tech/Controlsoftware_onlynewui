/**
 * WatchDirService — auto-detect new G-code files in a configured folder.
 *
 * Frontend subscribes via Socket.IO:
 *   watchdir:list   (full list of files; sent on connect + on change)
 *   watchdir:added  (single file appeared)
 *   watchdir:removed (single file disappeared)
 *
 * REST routes (mounted by index.js):
 *   GET    /api/watchdir/files       → current list
 *   POST   /api/watchdir/config      → { path, enabled, extensions }
 *   GET    /api/watchdir/file/:name  → raw file contents (for load-to-job)
 *
 * Uses chokidar (already a transitive of most node tooling) if available,
 * else falls back to a 5-second fs.readdir poll. The poll path means we don't
 * need to add a hard dep just to ship Phase A.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_CFG = {
    enabled: false,
    path: '',
    extensions: ['.nc', '.gcode', '.gc', '.cnc', '.tap', '.ngc'],
    pollMs: 5000,
};

// backend/data holds cloud-link.json, device-identity.json and operator-token.
const DEFAULT_FORBIDDEN_ROOTS = [path.resolve(__dirname, '..', '..', 'data')];

let chokidar = null;
try { chokidar = require('chokidar'); } catch (_) { /* fall back to polling */ }

class WatchDirService extends EventEmitter {
    constructor({ configStore, io, logger, forbiddenRoots }) {
        super();
        this.forbiddenRoots = [...DEFAULT_FORBIDDEN_ROOTS, ...(forbiddenRoots || [])].map((p) => path.resolve(p));
        this.configStore = configStore;
        this.io = io;
        this.logger = logger || console;
        this.cfg = DEFAULT_CFG;
        this.watcher = null;
        this.pollTimer = null;
        this.knownFiles = new Map();    // basename → { size, mtime }
    }

    init() {
        const stored = this.configStore.get('watchdir');
        this.cfg = { ...DEFAULT_CFG, ...(stored || {}) };
        if (this.cfg.path && this.isForbiddenPath(this.cfg.path)) {
            this.logger.warn?.('[watchdir] configured path is inside the backend data folder; watching is disabled');
        } else if (this.cfg.enabled && this.cfg.path) {
            this._start();
        }
        this._broadcastList();
    }

    getConfig() { return this.cfg; }

    setConfig(cfg) {
        const next = { ...DEFAULT_CFG, ...(cfg || {}) };
        if (typeof next.path !== 'string') throw new Error('Invalid watch path');
        if (!Array.isArray(next.extensions)) throw new Error('Invalid extensions');
        if (next.path && this.isForbiddenPath(next.path)) throw new Error('Forbidden watch path');
        this._stop();
        this.cfg = next;
        this.configStore.set('watchdir', this.cfg);
        if (this.cfg.enabled && this.cfg.path) this._start();
        this._broadcastList();
        return this.cfg;
    }

    list() {
        return [...this.knownFiles.entries()].map(([name, meta]) => ({
            name, ...meta,
        })).sort((a, b) => b.mtime - a.mtime);
    }

    readFile(name) {
        if (!this.cfg.path) return null;
        if (typeof name !== 'string' || name.includes('..') || name.includes('/') || name.includes('\\')) {
            throw new Error('Invalid filename');
        }
        if (this.isForbiddenPath(this.cfg.path)) throw new Error('Forbidden watch path');
        if (!this._matches(name)) throw new Error('Invalid file type');
        const full = path.join(path.resolve(this.cfg.path), name);
        if (!full.startsWith(path.resolve(this.cfg.path))) {
            throw new Error('Path traversal blocked');
        }
        return fs.readFileSync(full, 'utf8');
    }

    _matches(name) {
        const exts = Array.isArray(this.cfg.extensions) ? this.cfg.extensions : [];
        return exts.some(ext => typeof ext === 'string' && ext && name.toLowerCase().endsWith(ext.toLowerCase()));
    }

    /**
     * True when p is, or resolves into, a forbidden root. Windows paths are
     * compared case-insensitively, and junctions/symlinks are followed when
     * they exist, so an alias of backend/data is refused too.
     */
    isForbiddenPath(p) {
        if (typeof p !== 'string' || !p) return false;
        const candidates = [path.resolve(p)];
        try { candidates.push(fs.realpathSync.native(p)); } catch (_) { /* may not exist yet */ }
        const roots = [];
        for (const root of this.forbiddenRoots) {
            roots.push(root);
            try { roots.push(fs.realpathSync.native(root)); } catch (_) { /* ignore */ }
        }
        const norm = (x) => {
            const trimmed = x.length > 1 ? x.replace(/[\\/]+$/, '') : x;
            return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
        };
        return candidates.some((c) => roots.some((r) => {
            const cn = norm(c);
            const rn = norm(r);
            return cn === rn || cn.startsWith(rn + path.sep);
        }));
    }

    _start() {
        if (!fs.existsSync(this.cfg.path)) {
            this.logger.warn?.(`[watchdir] path does not exist: ${this.cfg.path}`);
            return;
        }
        this._scan(true);
        if (chokidar) {
            this.watcher = chokidar.watch(this.cfg.path, {
                ignored: (p) => {
                    const base = path.basename(p);
                    return base.startsWith('.') || (!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() && !this._matches(base));
                },
                persistent: true,
                ignoreInitial: true,
                depth: 0,
                awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
            });
            this.watcher.on('add', (full) => this._onAdd(full));
            this.watcher.on('unlink', (full) => this._onRemove(full));
            this.watcher.on('change', (full) => this._onChange(full));
        } else {
            this.pollTimer = setInterval(() => this._scan(false), this.cfg.pollMs);
        }
    }

    _stop() {
        if (this.watcher) { try { this.watcher.close(); } catch (_) {} this.watcher = null; }
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        this.knownFiles.clear();
    }

    _scan(initial) {
        let entries;
        try { entries = fs.readdirSync(this.cfg.path); }
        catch (e) { this.logger.warn?.(`[watchdir] readdir failed: ${e.message}`); return; }
        const seen = new Set();
        for (const name of entries) {
            if (!this._matches(name)) continue;
            const full = path.join(this.cfg.path, name);
            let stat;
            try { stat = fs.statSync(full); } catch (_) { continue; }
            if (!stat.isFile()) continue;
            seen.add(name);
            const meta = { size: stat.size, mtime: stat.mtimeMs };
            const prev = this.knownFiles.get(name);
            this.knownFiles.set(name, meta);
            if (!prev) {
                if (!initial) this.io.emit('watchdir:added', { name, ...meta });
            } else if (prev.size !== meta.size || prev.mtime !== meta.mtime) {
                this.io.emit('watchdir:changed', { name, ...meta });
            }
        }
        // Removed.
        for (const name of [...this.knownFiles.keys()]) {
            if (!seen.has(name)) {
                this.knownFiles.delete(name);
                this.io.emit('watchdir:removed', { name });
            }
        }
        if (initial) this._broadcastList();
    }

    _onAdd(full) {
        const name = path.basename(full);
        if (!this._matches(name)) return;
        try {
            const stat = fs.statSync(full);
            this.knownFiles.set(name, { size: stat.size, mtime: stat.mtimeMs });
            this.io.emit('watchdir:added', { name, size: stat.size, mtime: stat.mtimeMs });
            this._broadcastList();
        } catch (_) {}
    }

    _onRemove(full) {
        const name = path.basename(full);
        if (this.knownFiles.delete(name)) {
            this.io.emit('watchdir:removed', { name });
            this._broadcastList();
        }
    }

    _onChange(full) {
        const name = path.basename(full);
        try {
            const stat = fs.statSync(full);
            this.knownFiles.set(name, { size: stat.size, mtime: stat.mtimeMs });
            this.io.emit('watchdir:changed', { name, size: stat.size, mtime: stat.mtimeMs });
        } catch (_) {}
    }

    _broadcastList() {
        this.io.emit('watchdir:list', this.list());
    }

    shutdown() { this._stop(); }
}

module.exports = { WatchDirService };
