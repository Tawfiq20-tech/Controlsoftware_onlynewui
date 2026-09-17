'use strict';

const { httpError } = require('../router');
const { TokenBuckets } = require('../../ratelimit');
const { CAMERA_ID } = require('../../snapshots');
const { requireRole } = require('./devices');

function register(router, app) {
    const pollBuckets = new TokenBuckets({ ratePerSec: 4, burst: 4, mono: app.clock.mono });

    router.add('GET', '/api/devices/:id/camera/:cameraId/latest.jpg', (ctx) => {
        const { res } = ctx;
        const deviceId = ctx.params.id;
        const cameraId = ctx.params.cameraId;
        requireRole(app, ctx, 'viewer');
        if (!CAMERA_ID.test(cameraId)) throw httpError(404, 'not_found');
        if (!pollBuckets.take(ctx.session.tokenHash + '|' + deviceId + '|' + cameraId)) throw httpError(429, 'rate_limited');
        res.setHeader('Cache-Control', 'no-store');
        if (!app.hubs.device.isOnline(deviceId)) {
            res.setHeader('X-Device-Offline', '1');
            res.statusCode = 204;
            res.end();
            return;
        }
        const fpsRaw = ctx.query.get('fps');
        const wanted = fpsRaw === '2' ? 2 : 1;
        const demand = app.snapshots.poll(deviceId, cameraId, ctx.session.tokenHash, wanted);
        if (demand) app.hubs.device.send(deviceId, 'camera.demand', demand);

        const frame = app.snapshots.latest(deviceId, cameraId);
        const afterRaw = ctx.query.get('after');
        const after = afterRaw != null && /^\d{1,15}$/.test(afterRaw) ? Number(afterRaw) : null;
        if (!frame || !frame.fresh || (after != null && !(frame.seq > after))) {
            res.statusCode = 204;
            res.end();
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', frame.buf.length);
        res.setHeader('X-Frame-Ts', String(frame.ts));
        res.setHeader('X-Frame-Seq', String(frame.seq));
        res.end(frame.buf);
    }, { auth: 'session' });
}

module.exports = { register };
