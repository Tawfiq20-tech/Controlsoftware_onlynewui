'use strict';

const crypto = require('crypto');
const { httpError } = require('../router');
const { sha256hex } = require('../../auth/tokens');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateInviteCode() {
    let s = '';
    for (let i = 0; i < 12; i++) s += BASE32[crypto.randomInt(32)];
    return s;
}

function createInvites(db, clock, { count, expiresInDays, createdBy = null }) {
    const now = clock.now();
    const codes = [];
    db.transaction(() => {
        for (let i = 0; i < count; i++) {
            const code = generateInviteCode();
            db.run('INSERT INTO invites(code_hash, created_by, created_at, expires_at) VALUES (?,?,?,?)', sha256hex(code), createdBy, now, now + expiresInDays * 86400000);
            codes.push(code);
        }
    });
    return codes;
}

function register(router, app) {
    router.add('POST', '/api/admin/invites', (ctx) => {
        const count = ctx.body.count === undefined ? 1 : ctx.body.count;
        const days = ctx.body.expiresInDays === undefined ? 7 : ctx.body.expiresInDays;
        if (!Number.isInteger(count) || count < 1 || count > 20) throw httpError(400, 'bad_count');
        if (!Number.isInteger(days) || days < 1 || days > 30) throw httpError(400, 'bad_expiry');
        const codes = createInvites(app.db, app.clock, { count, expiresInDays: days, createdBy: ctx.user.id });
        app.audit.write({ userId: ctx.user.id, ip: ctx.ip, action: 'admin.invite', detail: { count, expiresInDays: days } });
        ctx.json(200, { codes });
    }, { auth: 'admin' });

    router.add('GET', '/api/admin/users', (ctx) => {
        const rows = app.db.all('SELECT id, email, display_name, is_admin, disabled, created_at FROM users ORDER BY created_at');
        ctx.json(200, rows.map((u) => ({
            id: u.id, email: u.email, displayName: u.display_name, isAdmin: !!u.is_admin, disabled: !!u.disabled, createdAt: u.created_at,
        })));
    }, { auth: 'admin' });

    router.add('POST', '/api/admin/users/:id/disable', (ctx) => {
        const disabled = ctx.body.disabled;
        if (typeof disabled !== 'boolean') throw httpError(400, 'bad_request');
        const target = app.db.get('SELECT id FROM users WHERE id = ?', ctx.params.id);
        if (!target) throw httpError(404, 'not_found');
        if (target.id === ctx.user.id && disabled) throw httpError(409, 'cannot_disable_self');
        app.db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, target.id);
        if (disabled) {
            app.sessions.revokeUser(target.id, 'user-disabled');
            app.hubs.client.closeUser(target.id, 'user-disabled');
        }
        app.audit.write({ userId: ctx.user.id, ip: ctx.ip, action: 'admin.user_disable', detail: { targetUserId: target.id, disabled } });
        ctx.json(204);
    }, { auth: 'admin' });
}

module.exports = { register, createInvites, generateInviteCode };
