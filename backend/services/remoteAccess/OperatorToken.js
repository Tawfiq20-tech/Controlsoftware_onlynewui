/**
 * OperatorToken — second factor that proves a loopback request comes from the
 * kiosk launched on this PC.
 *
 * Loopback alone is not enough: a header-less TCP forwarder (ssh -L, netsh
 * portproxy, socat, a TCP-mode tunnel) makes remote traffic arrive from
 * 127.0.0.1 with no proxy headers. The kiosk launcher reads the secret from
 * backend/data/operator-token (only processes on this PC can) and exchanges
 * it once for an HttpOnly cookie derived from it.
 *
 * The secret itself is never sent to a socket or to a remote route; only the
 * HMAC-derived cookie value travels in HTTP headers.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const OPERATOR_COOKIE = 'onefinity_op';
const COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const COOKIE_CONTEXT = 'onefinity-operator-cookie-v1';
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

const IDENTITY_KINDS = Object.freeze(['operator', 'local', 'lan', 'cloud']);

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Both sides are hashed first so the comparison is constant-time even when
 * the lengths differ (timingSafeEqual throws on a length mismatch).
 */
function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

// OneDrive sync and antivirus scanners briefly lock files.
const TRANSIENT_IO_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);
const IO_RETRY_DELAYS_MS = [50, 150, 300];
const RELOAD_THROTTLE_MS = 30000;

/**
 * Runs a sync fs call, retrying only transient lock errors. Reloads on the
 * request path pass no delays: they must never sleep the event loop.
 */
function withIoRetry(fn, delays = IO_RETRY_DELAYS_MS) {
    for (let attempt = 0; ; attempt++) {
        try {
            return fn();
        } catch (err) {
            if (!TRANSIENT_IO_CODES.has(err.code) || attempt >= delays.length) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
        }
    }
}

function writeFileAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    withIoRetry(() => fs.renameSync(tmp, file));
}

class OperatorToken {
    /**
     * @param {object} opts
     * @param {string} opts.file
     * @param {object} [opts.logger]
     * @param {(n:number) => Buffer} [opts.randomBytes]
     * @param {Function} [opts.execFile]   child_process.execFile (injected by tests)
     * @param {string} [opts.platform]     process.platform (injected by tests)
     */
    constructor({ file, logger, randomBytes = crypto.randomBytes, execFile = childProcess.execFile, platform = process.platform, env = process.env } = {}) {
        if (!file) throw new Error('OperatorToken requires a file path');
        this.file = file;
        this.logger = logger || noopLogger;
        this.randomBytes = randomBytes;
        this.execFile = execFile;
        this.platform = platform;
        this.env = env;
        this._secret = null;
        this._cookie = null;
        this._aclWarned = false;
        this._loadError = null;
        this._lastReloadAt = 0;
    }

    /**
     * A new secret is generated only when the file is missing or malformed.
     * If an existing file cannot be read (a lock that outlives the retries,
     * wrong ACL owner) the token stays unloaded: rotating would silently log
     * the kiosk out and leave the launcher holding a different secret. While
     * unloaded nobody is operator; loopback clients remain `local`.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.retry=true] sleep-retry transient lock errors.
     *        Only boot may block; reloads from request handling pass false.
     */
    load({ retry = true } = {}) {
        let existing = null;
        const quiet = !retry && !!this._loadError;
        try {
            existing = withIoRetry(() => fs.readFileSync(this.file, 'utf8'), retry ? IO_RETRY_DELAYS_MS : []).trim().toLowerCase();
        } catch (err) {
            if (err.code !== 'ENOENT') {
                const code = err.code || err.message;
                const repeated = quiet && code === this._loadError;
                this._loadError = code;
                if (!repeated) this.logger.error(`[OperatorToken] cannot read token file (${this._loadError}); operator access is unavailable until it can be read`);
                return this;
            }
        }
        this._loadError = null;
        if (existing && SECRET_PATTERN.test(existing)) {
            this._setSecret(existing);
            return this;
        }
        if (existing) this.logger.warn('[OperatorToken] token file is malformed; generating a new operator secret');
        const secret = this._generate();
        this._setSecret(secret);
        try {
            this._persist(secret);
        } catch (_) {
            // Logged by _persist. There was no usable file, so the in-memory
            // secret still works through the console link printed at boot.
        }
        return this;
    }

    isLoaded() {
        return !!this._secret;
    }

    /** Error code from the last failed load(), or null. */
    getLoadError() {
        return this._loadError;
    }

    /** Hex secret for the local launcher only. */
    getLaunchSecret() {
        this._ensureLoaded();
        return this._secret;
    }

    cookieValue() {
        this._ensureLoaded();
        return this._cookie;
    }

    /** Set-Cookie header value that carries the operator cookie. */
    cookieHeader() {
        return `${OPERATOR_COOKIE}=${this.cookieValue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}`;
    }

    verifyLaunchSecret(secret) {
        if (typeof secret !== 'string' || !secret) return false;
        this._reloadIfUnreadable();
        if (!this._secret) return false;
        return constantTimeEqual(secret.trim().toLowerCase(), this._secret);
    }

    verifyCookie(value) {
        if (typeof value !== 'string' || !value) return false;
        this._reloadIfUnreadable();
        if (!this._cookie) return false;
        return constantTimeEqual(value, this._cookie);
    }

    /**
     * A lock may clear; retry the read. Runs on every cookie check (HTTP
     * requests, socket handshakes), so it is throttled and never sleeps: one
     * plain read of a tiny file, no lock-retry delays.
     */
    _reloadIfUnreadable() {
        if (this._secret || !this._loadError) return;
        const t = Date.now();
        if (t - this._lastReloadAt < RELOAD_THROTTLE_MS) return;
        this._lastReloadAt = t;
        this.load({ retry: false });
    }

    /** New secret; every operator cookie issued so far stops working. */
    rotate() {
        this._ensureLoaded();
        const secret = this._generate();
        // Persist first: a secret the launcher cannot read would lock the kiosk out.
        this._persist(secret);
        this._setSecret(secret);
        return this;
    }

    _ensureLoaded() {
        if (this._secret) return;
        this.load({ retry: !this._loadError });
        if (!this._secret) {
            const err = new Error('operator_token_unreadable');
            err.code = this._loadError;
            throw err;
        }
    }

    _generate() {
        return Buffer.from(this.randomBytes(32)).toString('hex');
    }

    _setSecret(secret) {
        this._secret = secret;
        this._cookie = crypto.createHmac('sha256', secret).update(COOKIE_CONTEXT).digest('base64url');
    }

    _persist(secret) {
        try {
            writeFileAtomic(this.file, `${secret}\n`);
        } catch (err) {
            this.logger.error(`[OperatorToken] cannot write token file: ${err.code || err.message}`);
            throw err;
        }
        this._restrictAcl();
    }

    /** Best effort: only the current Windows user may read the secret. */
    _restrictAcl() {
        if (this.platform !== 'win32') return;
        const user = this.env && this.env.USERNAME;
        const warnOnce = (msg) => {
            if (this._aclWarned) return;
            this._aclWarned = true;
            this.logger.warn(`[OperatorToken] could not restrict token file permissions: ${msg}`);
        };
        if (!user) return warnOnce('USERNAME is not set');
        try {
            this.execFile('icacls', [this.file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true }, (err) => {
                if (err) warnOnce(err.code || err.message);
            });
        } catch (err) {
            warnOnce(err.code || err.message);
        }
    }
}

module.exports = {
    OperatorToken,
    OPERATOR_COOKIE,
    IDENTITY_KINDS,
    constantTimeEqual,
};
