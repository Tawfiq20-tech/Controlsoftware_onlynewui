'use strict';

const { URL } = require('url');

const JSON_LIMIT = 64 * 1024;
const TOTAL_TIMEOUT_MS = 30000;

const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

class HttpError extends Error {
    constructor(status, code, extra) {
        super(code);
        this.status = status;
        this.code = code;
        this.extra = extra || null;
    }
}

function applySecurityHeaders(res, { allowInsecure }) {
    if (!allowInsecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJson(res, status, obj, headers) {
    if (res.headersSent || res.writableEnded) return;
    const body = obj === undefined || status === 204 ? '' : JSON.stringify(obj);
    if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (body) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = status;
    res.end(body);
}

function compile(pattern) {
    const names = [];
    const src = pattern.split('/').map((seg) => {
        if (seg.startsWith(':')) {
            names.push(seg.slice(1));
            return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return { re: new RegExp('^' + src + '$'), names };
}

function readJsonBody(req, limit = JSON_LIMIT) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            reject(new HttpError(413, 'too_large'));
            req.resume();
            return;
        }
        const chunks = [];
        let size = 0;
        let failed = false;
        req.on('data', (chunk) => {
            if (failed) return;
            size += chunk.length;
            if (size > limit) {
                failed = true;
                reject(new HttpError(413, 'too_large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (failed) return;
            if (size === 0) return resolve({});
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    reject(new HttpError(400, 'bad_json'));
                    return;
                }
                resolve(parsed);
            } catch (_) {
                reject(new HttpError(400, 'bad_json'));
            }
        });
        req.on('error', (err) => {
            if (!failed) reject(err);
        });
    });
}

class Router {
    constructor({ logger, allowInsecure }) {
        this.routes = [];
        this.logger = logger;
        this.allowInsecure = allowInsecure;
        // Every hook runs before the handler; used for auth resolution and CSRF.
        this.before = [];
    }

    add(method, pattern, handler, opts = {}) {
        const { re, names } = compile(pattern);
        this.routes.push({ method, pattern, re, names, handler, opts });
    }

    match(method, pathname) {
        let pathMatched = false;
        for (const r of this.routes) {
            const m = r.re.exec(pathname);
            if (!m) continue;
            pathMatched = true;
            if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
            const params = {};
            let bad = false;
            r.names.forEach((n, i) => {
                try {
                    params[n] = decodeURIComponent(m[i + 1]);
                } catch (_) {
                    bad = true;
                }
            });
            if (bad) return { route: null, pathMatched: true };
            return { route: r, params };
        }
        return { route: null, pathMatched };
    }

    async handle(req, res, app) {
        let url;
        try {
            url = new URL(req.url, 'http://relay.invalid');
        } catch (_) {
            sendJson(res, 400, { error: 'bad_request' });
            return true;
        }
        if (!url.pathname.startsWith('/api/')) return false;
        const { route, params, pathMatched } = this.match(req.method, url.pathname);
        if (!route) {
            sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method_not_allowed' : 'not_found' });
            return true;
        }

        let timer = null;
        if (!route.opts.streaming) {
            timer = setTimeout(() => {
                if (!res.headersSent) sendJson(res, 503, { error: 'timeout' });
                req.destroy();
            }, TOTAL_TIMEOUT_MS);
            res.on('close', () => clearTimeout(timer));
        }

        const ctx = {
            req, res, app, url, params, query: url.searchParams, route,
            ip: app.clientIp(req),
            body: null, session: null, user: null,
            json: (status, obj, headers) => sendJson(res, status, obj, headers),
        };
        try {
            for (const hook of this.before) await hook(ctx);
            if (route.opts.body !== 'raw' && route.opts.body !== 'none' && req.method !== 'GET' && req.method !== 'HEAD') {
                ctx.body = await readJsonBody(req);
            } else if (route.opts.body !== 'raw') {
                ctx.body = {};
            }
            await route.handler(ctx);
            if (!res.headersSent && !res.writableEnded && !route.opts.streaming) sendJson(res, 204);
        } catch (err) {
            if (err instanceof HttpError) {
                sendJson(res, err.status, Object.assign({ error: err.code }, err.extra || {}), err.headers);
            } else if (app.isBusyError && app.isBusyError(err)) {
                sendJson(res, 503, { error: 'busy' });
            } else {
                this.logger.error('route failed', { route: route.pattern, err });
                sendJson(res, 500, { error: 'internal' });
            }
        } finally {
            if (timer && res.writableEnded) clearTimeout(timer);
        }
        return true;
    }
}

function httpError(status, code, extra, headers) {
    const e = new HttpError(status, code, extra);
    if (headers) e.headers = headers;
    return e;
}

module.exports = { Router, HttpError, httpError, sendJson, applySecurityHeaders, readJsonBody, CSP, JSON_LIMIT };
