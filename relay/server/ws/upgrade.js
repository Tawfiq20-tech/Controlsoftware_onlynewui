'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { LIMITS } = require('../protocol/envelope');
const { WindowLimiter } = require('../ratelimit');
const { sha256hex } = require('../auth/tokens');
const { parseCookies, cookieNames } = require('../http/cookies');

function rejectUpgrade(socket, status, body, headers = {}) {
    if (socket.destroyed) return;
    const payload = JSON.stringify(body);
    const lines = [
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(payload)}`,
        'Connection: close',
        'Cache-Control: no-store',
    ];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    socket.end(lines.join('\r\n') + '\r\n\r\n' + payload);
    setTimeout(() => socket.destroy(), 1000).unref();
}

// Authenticates BEFORE the WebSocket handshake completes (§3.1), so an unauthenticated
// peer never gets an open socket.
function createUpgradeHandler(app) {
    const mono = app.clock.mono;
    const lim = app.limits;
    const failedLimit = lim.wsFailedAuthPerIpPerMin || 30;
    const failedByIp = new WindowLimiter({ limit: failedLimit, windowMs: 60000, mono });
    const allByIp = new WindowLimiter({ limit: lim.wsUpgradesPerIpPerMin || 600, windowMs: 60000, mono });
    const bySession = new WindowLimiter({ limit: lim.wsUpgradesPerKeyPerMin || 10, windowMs: 60000, mono });
    const byCredential = new WindowLimiter({ limit: lim.wsUpgradesPerKeyPerMin || 10, windowMs: 60000, mono });

    const deviceWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: LIMITS.deviceMaxPayload });
    const clientWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: LIMITS.clientMaxPayload });

    function failAuth(socket, ip, status, body) {
        failedByIp.tryHit(ip);
        rejectUpgrade(socket, status, body);
    }

    function handleDevice(req, socket, head, ip) {
        const auth = String(req.headers.authorization || '');
        const m = /^Bearer (odc_[A-Za-z0-9_-]{16,100})$/.exec(auth);
        if (!m) return failAuth(socket, ip, 401, { error: 'invalid' });
        const hash = sha256hex(m[1]);
        const db = app.db;
        const row = db.get('SELECT * FROM devices WHERE credential_hash = ? OR previous_credential_hash = ?', hash, hash);
        if (!row) {
            const revoked = db.get('SELECT 1 AS x FROM revoked_credentials WHERE credential_hash = ?', hash);
            return failAuth(socket, ip, 401, { error: revoked ? 'revoked' : 'invalid' });
        }
        if (row.disabled) return failAuth(socket, ip, 401, { error: 'invalid' });
        if (row.status !== 'active') return failAuth(socket, ip, 403, { error: 'unconfirmed' });
        if (String(req.headers['x-onefinity-protocol'] || '') !== '1') {
            return rejectUpgrade(socket, 426, { error: 'protocol', supported: [1] });
        }
        if (!byCredential.tryHit(row.id)) {
            return rejectUpgrade(socket, 429, { error: 'rate_limited' }, { 'Retry-After': '30' });
        }
        // Rotation bookkeeping is decided only by DB columns (§3.4.8).
        if (row.credential_hash === hash && row.previous_credential_hash) {
            db.run('UPDATE devices SET previous_credential_hash = NULL WHERE id = ?', row.id);
        } else if (row.previous_credential_hash === hash) {
            db.run('UPDATE devices SET credential_hash = previous_credential_hash, previous_credential_hash = NULL WHERE id = ?', row.id);
        }
        deviceWss.handleUpgrade(req, socket, head, (ws) => app.hubs.device.accept(ws, row));
        return undefined;
    }

    function handleClient(req, socket, head, ip) {
        const origin = req.headers.origin;
        if (!origin || origin !== app.publicOrigin()) return failAuth(socket, ip, 403, { error: 'origin' });
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[cookieNames(app.allowInsecure).session];
        const session = token ? app.sessions.resolve(token) : null;
        const user = session ? app.db.get('SELECT id, email, display_name, disabled FROM users WHERE id = ?', session.userId) : null;
        if (!session || !user || user.disabled) return failAuth(socket, ip, 401, { error: 'invalid' });
        if (!bySession.tryHit(session.tokenHash)) {
            return rejectUpgrade(socket, 429, { error: 'rate_limited' }, { 'Retry-After': '30' });
        }
        clientWss.handleUpgrade(req, socket, head, (ws) => app.hubs.client.accept(ws, { session, user, ip }));
        return undefined;
    }

    function onUpgrade(req, socket, head) {
        socket.on('error', () => socket.destroy());
        if (app.closing) return rejectUpgrade(socket, 503, { error: 'shutting_down' });
        let pathname;
        try {
            pathname = new URL(req.url, 'http://relay.invalid').pathname;
        } catch (_) {
            return rejectUpgrade(socket, 400, { error: 'bad_request' });
        }
        if (pathname !== '/ws/device' && pathname !== '/ws/client') return rejectUpgrade(socket, 404, { error: 'not_found' });
        const ip = app.clientIp(req);
        if (!allByIp.tryHit(ip)) return rejectUpgrade(socket, 429, { error: 'rate_limited' }, { 'Retry-After': '30' });
        if (failedByIp.win.count(ip) >= failedLimit) return rejectUpgrade(socket, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
        try {
            if (pathname === '/ws/device') return handleDevice(req, socket, head, ip);
            return handleClient(req, socket, head, ip);
        } catch (err) {
            app.logger.error('upgrade failed', { err });
            return rejectUpgrade(socket, 500, { error: 'internal' });
        }
    }

    return {
        onUpgrade,
        close() {
            deviceWss.close();
            clientWss.close();
        },
    };
}

module.exports = { createUpgradeHandler, rejectUpgrade };
