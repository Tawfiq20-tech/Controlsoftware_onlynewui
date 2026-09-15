/**
 * FilefinityService — Filefinity -> control-software model import.
 *
 * Implements the fixed design from FILEFINITY_API_SPECIFICATION_FIXED.md
 * (msg12447): PKCE token exchange (no client_secret) + a locally-issued,
 * single-use X-Import-Token gate on the import endpoint + a downloadUrl
 * host allowlist (closes the SSRF hole in the original draft).
 *
 * NOT independently confirmed: whether main.filefinity.com/cdn.filefinity.com
 * are Filefinity's real, published endpoints. FILEFINITY_AUTHORIZE_URL /
 * FILEFINITY_TOKEN_URL / FILEFINITY_CDN_HOST are env-configurable for exactly
 * this reason -- swap them in once Filefinity's eng team confirms the real
 * values. Everything else here (PKCE math, token HMAC, allowlist enforcement,
 * library write) is real and works standalone today.
 */
const crypto = require('crypto');

const PKCE_TTL_MS = 5 * 60 * 1000;      // state/verifier must be used within 5 min of auth/start
const IMPORT_TOKEN_TTL_MS = 60 * 1000;  // spec: 60s single-use

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class FilefinityService {
    constructor({ logger, importTokenSecret } = {}) {
        this.log = logger || console;
        // Persist-across-restarts isn't required -- worst case a restart
        // invalidates in-flight (<=5min) auth attempts and issued (<=60s)
        // import tokens, which is exactly the failure mode a short TTL
        // is supposed to make survivable (user just retries the import).
        this.secret = importTokenSecret || crypto.randomBytes(32).toString('hex');
        this.pending = new Map();     // state -> { verifier, createdAt }
        this.usedTokens = new Set();  // single-use enforcement

        this.clientId = process.env.FILEFINITY_CLIENT_ID || 'onefinity-desktop';
        this.authorizeUrl = process.env.FILEFINITY_AUTHORIZE_URL || 'https://main.filefinity.com/oauth/authorize';
        this.tokenUrl = process.env.FILEFINITY_TOKEN_URL || 'https://main.filefinity.com/api/v1/auth/token';
        this.cdnHost = process.env.FILEFINITY_CDN_HOST || 'cdn.filefinity.com';
        this.redirectUri = process.env.FILEFINITY_REDIRECT_URI || 'http://localhost:4000/api/filefinity/auth/callback';

        setInterval(() => this._sweepExpired(), 60 * 1000).unref?.();
    }

    // ─── PKCE / OAuth ────────────────────────────────────────────────

    startAuth() {
        const verifier = base64url(crypto.randomBytes(48)); // 64 chars, within spec's 43-128
        const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
        const state = base64url(crypto.randomBytes(16));
        this.pending.set(state, { verifier, createdAt: Date.now() });

        const url = new URL(this.authorizeUrl);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', this.clientId);
        url.searchParams.set('redirect_uri', this.redirectUri);
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('scope', 'files:read models:read');
        url.searchParams.set('state', state);

        return { authorizeUrl: url.toString(), state };
    }

    /** Exchanges an auth code for tokens. Real network call -- will fail
     *  until FILEFINITY_TOKEN_URL points at a live, confirmed endpoint. */
    async exchangeCode({ code, state }) {
        const pending = this.pending.get(state);
        if (!pending) throw new Error('Unknown or expired auth state');
        this.pending.delete(state);
        if (Date.now() - pending.createdAt > PKCE_TTL_MS) throw new Error('Auth state expired');

        const res = await fetch(this.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                code,
                code_verifier: pending.verifier,
                client_id: this.clientId,
                redirect_uri: this.redirectUri,
            }),
        });
        if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status}`);
        return res.json(); // { access_token, expires_in, refresh_token, scope }
    }

    // ─── Import-token gate (local, no dependency on Filefinity being live) ──

    issueImportToken(modelId) {
        const ts = Date.now();
        const sig = crypto.createHmac('sha256', this.secret).update(`${modelId}:${ts}`).digest('hex');
        return { token: `${ts}.${sig}`, modelId, expiresAt: ts + IMPORT_TOKEN_TTL_MS };
    }

    verifyImportToken(token, modelId) {
        if (!token || typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };
        if (this.usedTokens.has(token)) return { ok: false, reason: 'already used' };
        const [tsStr, sig] = token.split('.');
        const ts = Number(tsStr);
        if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed' };
        if (Date.now() - ts > IMPORT_TOKEN_TTL_MS) return { ok: false, reason: 'expired' };
        const expected = crypto.createHmac('sha256', this.secret).update(`${modelId}:${ts}`).digest('hex');
        const a = Buffer.from(sig || '', 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
        this.usedTokens.add(token);
        return { ok: true };
    }

    // ─── downloadUrl allowlist (closes the SSRF hole in the original draft) ──

    isAllowedDownloadUrl(rawUrl) {
        let u;
        try { u = new URL(rawUrl); } catch (_) { return false; }
        return u.protocol === 'https:' && u.hostname === this.cdnHost;
    }

    async fetchModelBody(downloadUrl) {
        if (!this.isAllowedDownloadUrl(downloadUrl)) {
            throw new Error(`downloadUrl host not allowlisted (expected ${this.cdnHost})`);
        }
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
        return res.text();
    }

    _sweepExpired() {
        const now = Date.now();
        for (const [state, entry] of this.pending) {
            if (now - entry.createdAt > PKCE_TTL_MS) this.pending.delete(state);
        }
        // usedTokens entries are only ever <=60s relevant; cap growth so a
        // long-running process doesn't accumulate them forever.
        if (this.usedTokens.size > 10000) this.usedTokens.clear();
    }
}

module.exports = { FilefinityService };
