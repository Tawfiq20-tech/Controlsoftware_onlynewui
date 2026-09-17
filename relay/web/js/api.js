// REST client (SPEC §4.3, §8.2). The CSRF token lives in memory only.

import { errorText } from './protocol.js';

let csrfToken = null;
let unauthorizedHandler = () => {};

export class ApiError extends Error {
    constructor(status, code, message, data, retryAfterSec) {
        super(message || code);
        this.status = status;
        this.code = code;
        this.data = data || null;
        this.retryAfterSec = retryAfterSec || 0;
    }
}

export function setCsrfToken(token) {
    csrfToken = typeof token === 'string' ? token : null;
}

export function getCsrfToken() {
    return csrfToken;
}

export function setUnauthorizedHandler(fn) {
    unauthorizedHandler = typeof fn === 'function' ? fn : () => {};
}

export function notifyUnauthorized() {
    unauthorizedHandler();
}

export function apiErrorText(err) {
    if (!err) return 'Something went wrong';
    if (err instanceof ApiError) {
        if (err.code === 'locked' && err.data && err.data.retryAfterSec) {
            return 'Too many attempts; try again in ' + Math.ceil(err.data.retryAfterSec / 60) + ' min';
        }
        if (err.status === 413 && err.code === 'http_413') return 'File too large for the relay';
        if (err.status === 429 && err.code === 'http_429') return errorText('rate_limited');
        return errorText(err.code, err.data && err.data.message);
    }
    return errorText(err.code, err.message);
}

async function request(method, path, { body, allow401 = false } = {}) {
    const headers = { Accept: 'application/json' };
    const init = { method, credentials: 'same-origin', cache: 'no-store', headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

    let res;
    try {
        res = await fetch(path, init);
    } catch (_) {
        throw new ApiError(0, 'network');
    }

    let data = null;
    if (res.status !== 204) {
        const text = await res.text().catch(() => '');
        if (text) {
            try { data = JSON.parse(text); } catch (_) { data = null; }
        }
    }
    if (!res.ok) {
        const code = data && typeof data.error === 'string' ? data.error : 'http_' + res.status;
        const retryAfterSec = Number(res.headers.get('Retry-After')) || 0;
        if (res.status === 401 && !allow401) unauthorizedHandler();
        throw new ApiError(res.status, code, data && data.message, data, retryAfterSec);
    }
    return data;
}

const enc = encodeURIComponent;

// `before` alone is an exclusive ts bound; with `beforeId` it is a (ts, id) cursor.
export function auditCursorQuery(before, beforeId) {
    if (before === null || before === undefined || before === '') return '';
    let q = '&before=' + enc(before);
    if (beforeId !== null && beforeId !== undefined && beforeId !== '') q += '&beforeId=' + enc(beforeId);
    return q;
}

export const api = {
    get: (path, opts) => request('GET', path, opts),
    post: (path, body = {}, opts) => request('POST', path, { ...opts, body }),
    del: (path, opts) => request('DELETE', path, opts),

    config: () => request('GET', '/api/config', { allow401: true }),
    me: () => request('GET', '/api/auth/me', { allow401: true }),
    login: (email, password) => request('POST', '/api/auth/login', { body: { email, password }, allow401: true }),
    register: (payload) => request('POST', '/api/auth/register', { body: payload, allow401: true }),
    logout: () => request('POST', '/api/auth/logout', { body: {}, allow401: true }),
    changePassword: (currentPassword, newPassword) => request('POST', '/api/auth/password', { body: { currentPassword, newPassword }, allow401: true }),
    sessions: () => request('GET', '/api/auth/sessions'),
    revokeSession: (id) => request('DELETE', '/api/auth/sessions/' + enc(id)),

    devices: () => request('GET', '/api/devices'),
    claim: (code, name) => request('POST', '/api/devices/claim', { body: name ? { code, name } : { code } }),
    rename: (id, name) => request('POST', '/api/devices/' + enc(id) + '/rename', { body: { name } }),
    unpair: (id) => request('DELETE', '/api/devices/' + enc(id)),
    rotate: (id) => request('POST', '/api/devices/' + enc(id) + '/rotate', { body: {} }),
    grants: (id) => request('GET', '/api/devices/' + enc(id) + '/grants'),
    addGrant: (id, email, role) => request('POST', '/api/devices/' + enc(id) + '/grants', { body: { email, role } }),
    removeGrant: (id, userId) => request('DELETE', '/api/devices/' + enc(id) + '/grants/' + enc(userId)),

    files: (id) => request('GET', '/api/devices/' + enc(id) + '/files'),
    deleteFile: (id, transferId) => request('DELETE', '/api/devices/' + enc(id) + '/files/' + enc(transferId)),

    deviceAudit: (id, { limit = 50, before, beforeId } = {}) => request('GET', '/api/devices/' + enc(id) + '/audit?limit=' + limit + auditCursorQuery(before, beforeId)),
    myAudit: ({ limit = 50, before, beforeId } = {}) => request('GET', '/api/audit/me?limit=' + limit + auditCursorQuery(before, beforeId)),

    createInvites: (count, expiresInDays) => request('POST', '/api/admin/invites', { body: { count, expiresInDays } }),
};

export function cameraUrl(deviceId, cameraId, { fps = 1, after = null } = {}) {
    let url = '/api/devices/' + enc(deviceId) + '/camera/' + enc(cameraId) + '/latest.jpg?fps=' + fps;
    if (after !== null && after !== undefined) url += '&after=' + enc(after);
    return url;
}

export function uploadUrl(deviceId, name) {
    return '/api/devices/' + enc(deviceId) + '/files?name=' + enc(name);
}
