'use strict';

const fs = require('fs');
const { httpError } = require('../router');
const { WindowLimiter } = require('../../ratelimit');
const { PairingError } = require('../../auth/pairing');
const { unpairDevice } = require('./devices');

const TRANSFER_ID = /^x_[a-z0-9]{12}$/;
const MAX_CONCURRENT_DOWNLOADS = 3;

function bearer(req) {
    const m = /^Bearer (\S{1,200})$/.exec(String(req.headers.authorization || ''));
    return m ? m[1] : null;
}

function register(router, app) {
    const pairingPerIp = new WindowLimiter({ limit: 10, windowMs: 3600000, mono: app.clock.mono });
    const downloads = new Map(); // deviceId -> active count

    function pairingCall(fn) {
        try {
            return fn();
        } catch (err) {
            if (err instanceof PairingError) throw httpError(err.status, err.code);
            throw err;
        }
    }

    router.add('POST', '/api/device/pairing', (ctx) => {
        if (!pairingPerIp.tryHit(ctx.ip)) throw httpError(429, 'rate_limited');
        if (app.lowDisk) throw httpError(503, 'insufficient_storage');
        const req = app.pairing.validateRequest(ctx.body);
        if (!req) throw httpError(400, 'bad_request');
        const out = pairingCall(() => app.pairing.create(req, ctx.ip));
        ctx.json(201, out);
    });

    router.add('GET', '/api/device/pairing/:pairingId', (ctx) => {
        ctx.json(200, pairingCall(() => app.pairing.poll(ctx.params.pairingId, bearer(ctx.req))));
    });

    router.add('POST', '/api/device/pairing/:pairingId/confirm', (ctx) => {
        pairingCall(() => app.pairing.confirm(ctx.params.pairingId, bearer(ctx.req), ctx.ip));
        ctx.json(204);
    });

    router.add('POST', '/api/device/pairing/:pairingId/reject', (ctx) => {
        pairingCall(() => app.pairing.reject(ctx.params.pairingId, bearer(ctx.req), ctx.ip));
        ctx.json(204);
    });

    router.add('DELETE', '/api/device/pairing/:pairingId', (ctx) => {
        pairingCall(() => app.pairing.cancel(ctx.params.pairingId, bearer(ctx.req), ctx.ip));
        ctx.json(204);
    });

    router.add('GET', '/api/device/files/:transferId', (ctx) => {
        const { req, res } = ctx;
        const device = ctx.device;
        const transferId = ctx.params.transferId;
        if (!TRANSFER_ID.test(transferId)) throw httpError(404, 'not_found');
        const row = app.db.get('SELECT * FROM transfers WHERE id = ?', transferId);
        // Another device's credential gets the same 404 as a missing transfer.
        if (!row || row.device_id !== device.id || row.blob_deleted || row.status === 'expired') throw httpError(404, 'not_found');
        let stat;
        try {
            stat = fs.statSync(app.blobs.path(transferId));
        } catch (_) {
            throw httpError(404, 'not_found');
        }
        const size = stat.size;
        let start = 0;
        let status = 200;
        const range = req.headers.range;
        if (range !== undefined) {
            const m = /^bytes=(\d+)-$/.exec(String(range).trim());
            if (!m || Number(m[1]) >= size) {
                throw httpError(416, 'range_not_satisfiable', null, { 'Content-Range': `bytes */${size}` });
            }
            start = Number(m[1]);
            status = 206;
        }
        const active = downloads.get(device.id) || 0;
        if (active >= MAX_CONCURRENT_DOWNLOADS) throw httpError(429, 'rate_limited', null, { 'Retry-After': '5' });
        downloads.set(device.id, active + 1);
        app.inflight++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            const n = (downloads.get(device.id) || 1) - 1;
            if (n <= 0) downloads.delete(device.id);
            else downloads.set(device.id, n);
            app.inflight--;
        };

        res.statusCode = status;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', size - start);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-Content-Sha256', row.sha256);
        res.setHeader('Cache-Control', 'no-store');
        if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${size - 1}/${size}`);

        const stream = fs.createReadStream(app.blobs.path(transferId), { start });
        const idleMs = app.limits.transferIdleMs || 60000;
        let idle = null;
        const armIdle = () => {
            clearTimeout(idle);
            idle = setTimeout(() => {
                stream.destroy();
                res.destroy();
            }, idleMs);
        };
        armIdle();
        stream.on('data', armIdle);
        stream.on('error', () => res.destroy());
        res.on('close', () => {
            clearTimeout(idle);
            stream.destroy();
            release();
        });
        stream.pipe(res);
    }, { auth: 'device', streaming: true });

    router.add('DELETE', '/api/device/self', (ctx) => {
        unpairDevice(app, ctx.device.id, { by: 'device', ip: ctx.ip });
        ctx.json(204);
    }, { auth: 'device' });
}

module.exports = { register };
