'use strict';

const { requireRole } = require('./devices');

function parseDetail(s) {
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch (_) {
        return null;
    }
}

// Emails appear only to the device owner or to the user themselves; everyone else sees
// display names (§4.8).
function rowView(app, row, { showEmailFor }) {
    const u = row.user_id ? app.db.get('SELECT email, display_name FROM users WHERE id = ?', row.user_id) : null;
    const view = {
        id: row.id, ts: row.ts, userId: row.user_id, userLabel: u ? u.display_name : null, deviceId: row.device_id,
        action: row.action, detail: parseDetail(row.detail), result: row.result,
    };
    if (u && showEmailFor(row)) view.userEmail = u.email;
    return view;
}

function register(router, app) {
    router.add('GET', '/api/devices/:id/audit', (ctx) => {
        const role = requireRole(app, ctx, 'viewer');
        app.audit.flush();
        const limit = ctx.query.get('limit');
        const before = ctx.query.get('before');
        const beforeId = ctx.query.get('beforeId');
        const rows = app.audit.list({
            deviceId: ctx.params.id,
            onlyUserId: role === 'viewer' ? ctx.user.id : null,
            limit, before, beforeId,
        });
        ctx.json(200, rows.map((r) => rowView(app, r, { showEmailFor: (row) => role === 'owner' || row.user_id === ctx.user.id })));
    }, { auth: 'session' });

    router.add('GET', '/api/audit/me', (ctx) => {
        app.audit.flush();
        const rows = app.audit.list({ userId: ctx.user.id, limit: ctx.query.get('limit'), before: ctx.query.get('before'), beforeId: ctx.query.get('beforeId') });
        ctx.json(200, rows.map((r) => rowView(app, r, { showEmailFor: () => true })));
    }, { auth: 'session' });
}

module.exports = { register };
