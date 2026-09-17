'use strict';

const fs = require('fs');
const path = require('path');

const TRANSFER_ID = /^x_[a-z0-9]{12}$/;

class BlobStore {
    constructor({ dir, statfs = fs.statfsSync, logger }) {
        this.dir = dir;
        this.tmpDir = path.join(dir, 'tmp');
        this.statfs = statfs;
        this.logger = logger;
        fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    }

    _check(id) {
        if (!TRANSFER_ID.test(id)) throw new Error('bad transfer id');
    }

    tmpPath(id) {
        this._check(id);
        return path.join(this.tmpDir, id + '.part');
    }

    path(id) {
        this._check(id);
        return path.join(this.dir, id);
    }

    // Leftovers from a crash mid-upload are never referenced by a transfer row.
    cleanupOrphans() {
        let removed = 0;
        for (const name of fs.readdirSync(this.tmpDir)) {
            if (!name.endsWith('.part')) continue;
            try {
                fs.unlinkSync(path.join(this.tmpDir, name));
                removed++;
            } catch (_) { /* raced with another cleanup */ }
        }
        return removed;
    }

    async commit(id, fd) {
        await new Promise((resolve, reject) => fs.fsync(fd, (e) => (e ? reject(e) : resolve())));
        await new Promise((resolve, reject) => fs.close(fd, (e) => (e ? reject(e) : resolve())));
        const final = this.path(id);
        await fs.promises.rename(this.tmpPath(id), final);
        try { await fs.promises.chmod(final, 0o600); } catch (_) { /* not supported on every FS */ }
        return final;
    }

    discardTmp(id) {
        try { fs.unlinkSync(this.tmpPath(id)); } catch (_) { /* already gone */ }
    }

    delete(id) {
        try {
            fs.unlinkSync(this.path(id));
            return true;
        } catch (_) {
            return false;
        }
    }

    exists(id) {
        try {
            return fs.statSync(this.path(id)).isFile();
        } catch (_) {
            return false;
        }
    }

    freeBytes() {
        try {
            const st = this.statfs(this.dir);
            return Number(st.bavail) * Number(st.bsize);
        } catch (err) {
            if (this.logger) this.logger.warn('statfs failed', { err });
            return Infinity;
        }
    }
}

module.exports = { BlobStore, TRANSFER_ID };
