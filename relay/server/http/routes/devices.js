'use strict';

const { httpError } = require('../router');
const { WindowLimiter } = require('../../ratelimit');
const { normalizeEmail } = require('../../auth/passwords');
const { PairingError } = require('../../auth/pairing');

const FIFTEEN_MIN = 15 * 60000;

function deviceView(app, row, role) {
    return {
        id: row.id,
        name: row.name,
        role,
        status: row.status,
        online: row.status === 'active' && app.hubs.device.isOnline(row.id),
        lastSeenAt: row.last_seen_at,
        controllerType: row.controller_type,
        appVersion: row.app_version,
        hardwareIdShort: String(row.hardware_id || '').slice(0, 6),
        pairedAt: row.paired_at,
    };
}

// Unknown and forbidden look identical (§4.3) so device ids cannot be probed.
function requireRole(app, ctx, minRole) {
    const role = app.acl.role(ctx.user.id, ctx.params.id);
    if (!role) throw httpError(404, 'not_found');
    if (minRole && !app.acl.atLeast(role, minRole)) throw httpError(403, 'forbidden');
    return role;
}

// §4.4.4, shared by owner unpair and machine self-unpair.
function unpairDevice(app, deviceId, { by, userId = null, ip = null }) {
    const row = app.db.get('SELECT * FROM devices WHERE id = ?', deviceId);
    if (!row) return false;
    const now = app.clock.now();
    const transfers = app.db.all('SELECT id FROM transfers WHERE device_id = ?', deviceId).map((r) => r.id);
    app.db.transaction(() => {
        for (const h of [row.credential_hash, row.previous_credential_hash]) {
            if (h) app.db.run('INSERT OR REPLACE INTO revoked_credentials(credential_hash, revoked_at) VALUES (?, ?)', h, now);
        }
        app.db.run('DELETE FROM transfers WHERE device_id = ?', deviceId);
        app.db.run('DELETE FROM grants WHERE device_id = ?', deviceId);
        app.db.run('DELETE FROM devices WHERE id = ?', deviceId);
    });
    app.hubs.device.revoke(deviceId);
    app.hubs.client.onDeviceRemoved(deviceId);
    for (const id of transfers) app.blobs.delete(id);
    app.audit.write({ userId, deviceId, ip, action: 'device.unpair', detail: { by } });
    return true;
}

function register(router, app) {
    const mono = app.clock.mono;
    const claimPerUser = new WindowLimiter({ limit: 10, windowMs: FIFTEEN_MIN, mono });
    const claimPerIp = new WindowLimiter({ limit: 30, windowMs: FIFTEEN_MIN, mono });
    const claimGlobal = new WindowLimiter({ limit: 300, windowMs: FIFTEEN_MIN, mono });
    const grantsPerOwner = new WindowLimiter({ limit: 20, windowMs: 3600000, mono });

    router.add('GET', '/api/devices', (ctx) => {
        const rows = app.db.all(
            `SELECT d.*, g.role FROM grants g JOIN devices d ON d.id = g.device_id
              WHERE g.user_id = ? AND d.disabled = 0 AND (d.status = 'active' OR g.role = 'owner')
              ORDER BY d.paired_at ASC`,
            ctx.user.id,
        );
        ctx.json(200, rows.map((r) => deviceView(app, r, r.role)));
    }, { auth: 'session' });

    router.add('POST', '/api/devices/claim', (ctx) => {
        if (!claimGlobal.tryHit('g') || !claimPerIp.tryHit(ctx.ip) || !claimPerUser.tryHit(ctx.user.id)) {
            throw httpError(429, 'rate_limited');
        }
        let device;
        try {
            device = app.pairing.claim({ userId: ctx.user.id, code: ctx.body.code, name: ctx.body.name, ip: ctx.ip });
        } catch (err) {
            if (err instanceof PairingError) throw httpError(err.status, err.code);
            throw err;
        }
        ctx.json(201, { device: deviceView(app, device, 'owner') });
    }, { auth: 'session' });

    router.add('POST', '/api/devices/:id/rename', (ctx) => {
        requireRole(app, ctx, 'owner');
        const name = ctx.body.name;
        if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 60) throw httpError(400, 'bad_name');
        app.db.run('UPDATE devices SET name = ? WHERE id = ?', name.trim(), ctx.params.id);
        app.audit.write({ userId: ctx.user.id, deviceId: ctx.params.id, ip: ctx.ip, action: 'device.rename', detail: { name: name.trim() } });
        const row = app.db.get('SELECT * FROM devices WHERE id = ?', ctx.params.id);
        ctx.json(200, { device: deviceView(app, row, 'owner') });
    }, { auth: 'session' });

    router.add('DELETE', '/api/devices/:id', (ctx) => {
        requireRole(app, ctx, 'owner');
        unpairDevice(app, ctx.params.id, { by: 'owner', userId: ctx.user.id, ip: ctx.ip });
        ctx.json(204);
    }, { auth: 'session' });

    router.add('POST', '/api/devices/:id/rotate', (ctx) => {
        requireRole(app, ctx, 'owner');
        if (!app.hubs.device.requestRotation(ctx.params.id)) throw httpError(409, 'offline');
        app.audit.write({ userId: ctx.user.id, deviceId: ctx.params.id, ip: ctx.ip, action: 'device.rotate', detail: { requested: true } });
        ctx.json(202, {});
    }, { auth: 'session' });

    router.add('GET', '/api/devices/:id/grants', (ctx) => {
        requireRole(app, ctx, 'owner');
        const rows = app.db.all(
            'SELECT g.user_id, g.role, g.created_at, u.email, u.display_name FROM grants g JOIN users u ON u.id = g.user_id WHERE g.device_id = ? ORDER BY g.created_at',
            ctx.params.id,
        );
        ctx.json(200, rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role, createdAt: r.created_at })));
    }, { auth: 'session' });

    router.add('POST', '/api/devices/:id/grants', (ctx) => {
        requireRole(app, ctx, 'owner');
        if (!grantsPerOwner.tryHit(ctx.user.id)) throw httpError(429, 'rate_limited');
        const role = ctx.body.role;
        if (role !== 'operator' && role !== 'viewer') throw httpError(400, 'bad_role');
        const email = normalizeEmail(ctx.body.email);
        const target = email ? app.db.get('SELECT id, email, display_name, disabled FROM users WHERE email = ?', email) : null;
        if (!target || target.disabled) throw httpError(404, 'user_not_found');
        const existing = app.db.get('SELECT role FROM grants WHERE user_id = ? AND device_id = ?', target.id, ctx.params.id);
        if (existing && existing.role === 'owner') throw httpError(409, 'is_owner');
        const now = app.clock.now();
        app.db.run(
            'INSERT INTO grants(user_id, device_id, role, created_at) VALUES (?,?,?,?) ON CONFLICT(user_id, device_id) DO UPDATE SET role = excluded.role',
            target.id, ctx.params.id, role, now,
        );
        // A downgrade to viewer takes effect on the next cmd (ACL is re-checked per message).
        app.audit.write({ userId: ctx.user.id, deviceId: ctx.params.id, ip: ctx.ip, action: 'grant.add', detail: { targetUserId: target.id, role } });
        ctx.json(201, { grant: { userId: target.id, email: target.email, displayName: target.display_name, role, createdAt: now } });
    }, { auth: 'session' });

    router.add('DELETE', '/api/devices/:id/grants/:userId', (ctx) => {
        const role = requireRole(app, ctx, null);
        const targetId = ctx.params.userId;
        if (role !== 'owner' && targetId !== ctx.user.id) throw httpError(403, 'forbidden');
        const grant = app.db.get('SELECT role FROM grants WHERE user_id = ? AND device_id = ?', targetId, ctx.params.id);
        if (!grant) throw httpError(404, 'not_found');
        if (grant.role === 'owner') throw httpError(409, 'is_owner');
        app.db.run('DELETE FROM grants WHERE user_id = ? AND device_id = ?', targetId, ctx.params.id);
        app.hubs.client.onGrantRemoved(targetId, ctx.params.id);
        app.audit.write({ userId: ctx.user.id, deviceId: ctx.params.id, ip: ctx.ip, action: 'grant.remove', detail: { targetUserId: targetId } });
        ctx.json(204);
    }, { auth: 'session' });
}

module.exports = { register, deviceView, requireRole, unpairDevice };
