'use strict';

const { parseSnapshotFrame } = require('./protocol/envelope');
const { TokenBuckets } = require('./ratelimit');

const FRAME_MAX_AGE_MS = 30000;
const SERVE_MAX_AGE_MS = 5000;
const VIEWER_WINDOW_MS = 5000;
const LEASE_MS = 10000;
const RENEW_MS = 5000;
const CAMERA_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_CAMERAS = 8;

// In-memory only (§4.7): nothing is written to disk and frames die with the device link.
class Snapshots {
    constructor({ clock, limits }) {
        this.clock = clock;
        this.maxBytes = limits.snapshotMaxKb * 1024;
        this.maxFps = limits.snapshotMaxFps;
        this.frames = new Map(); // deviceId -> Map(cameraId -> {buf, at, ts, seq})
        this.demand = new Map(); // deviceId|cameraId -> {viewers: Map(key -> {fps, at}), sentAt, fps}
        this.fpsBuckets = new TokenBuckets({ ratePerSec: this.maxFps, burst: this.maxFps, mono: clock.mono });
        this.deviceBuckets = new TokenBuckets({ ratePerSec: this.maxFps * MAX_CAMERAS, burst: this.maxFps * MAX_CAMERAS, mono: clock.mono });
    }

    // Returns null when accepted, or a reason string for SNAPSHOT_REJECTED.
    acceptFrame(authDeviceId, buf) {
        if (buf.length > this.maxBytes + 1024) return 'size';
        const parsed = parseSnapshotFrame(buf);
        if (!parsed) return 'format';
        const { header, jpeg } = parsed;
        if (header.deviceId !== authDeviceId) return 'device';
        if (typeof header.cameraId !== 'string' || !CAMERA_ID.test(header.cameraId)) return 'camera';
        if (header.enc !== undefined && header.enc !== 'none') return 'enc';
        // Memory bound: at most MAX_CAMERAS stored frames per device (the same cap _onHello applies
        // to the announced list). A new cameraId is refused while MAX_CAMERAS fresh frames are held,
        // so a device cannot grow relay memory by inventing camera ids.
        let cams = this.frames.get(authDeviceId);
        if (cams && !cams.has(header.cameraId) && cams.size >= MAX_CAMERAS) {
            const now = this.clock.mono();
            for (const [cam, f] of cams) if (now - f.at > FRAME_MAX_AGE_MS) cams.delete(cam);
            if (cams.size >= MAX_CAMERAS) return 'camera';
        }
        // Per-device aggregate budget, checked before the per-camera bucket so fresh ids get no burst.
        if (!this.deviceBuckets.take(authDeviceId)) return 'fps';
        if (!this.fpsBuckets.take(authDeviceId + '|' + header.cameraId)) return 'fps';
        if (!cams) {
            cams = new Map();
            this.frames.set(authDeviceId, cams);
        }
        const prev = cams.get(header.cameraId);
        const seq = Number.isInteger(header.seq) ? header.seq : (prev ? prev.seq + 1 : 1);
        cams.set(header.cameraId, {
            buf: Buffer.from(jpeg), at: this.clock.mono(), ts: Number.isInteger(header.ts) ? header.ts : this.clock.now(), seq,
        });
        return null;
    }

    latest(deviceId, cameraId) {
        const cams = this.frames.get(deviceId);
        const f = cams && cams.get(cameraId);
        if (!f) return null;
        const age = this.clock.mono() - f.at;
        if (age > FRAME_MAX_AGE_MS) {
            cams.delete(cameraId);
            return null;
        }
        return Object.assign({ ageMs: age, fresh: age <= SERVE_MAX_AGE_MS }, f);
    }

    // Records a viewer poll and returns a camera.demand body when one must be (re)sent.
    poll(deviceId, cameraId, viewerKey, wantedFps) {
        const now = this.clock.mono();
        const key = deviceId + '|' + cameraId;
        let d = this.demand.get(key);
        if (!d) {
            d = { viewers: new Map(), sentAt: -Infinity, fps: 0 };
            this.demand.set(key, d);
        }
        d.viewers.set(viewerKey, { fps: wantedFps, at: now });
        let max = 0;
        for (const [k, v] of d.viewers) {
            if (now - v.at > VIEWER_WINDOW_MS) d.viewers.delete(k);
            else max = Math.max(max, v.fps);
        }
        const fps = Math.min(Math.max(1, max), this.maxFps);
        if (now - d.sentAt > RENEW_MS || fps !== d.fps || now - d.sentAt > LEASE_MS) {
            d.sentAt = now;
            d.fps = fps;
            return { cameraId, fps, leaseMs: LEASE_MS };
        }
        return null;
    }

    // Demand bodies with fps 0 for every camera of a device that had an active lease.
    stopDemand(deviceId) {
        const out = [];
        for (const [key, d] of this.demand) {
            const [dev, cam] = key.split('|');
            if (dev !== deviceId) continue;
            if (d.fps > 0 && this.clock.mono() - d.sentAt <= LEASE_MS) out.push({ cameraId: cam, fps: 0, leaseMs: 0 });
            this.demand.delete(key);
        }
        return out;
    }

    dropDevice(deviceId) {
        this.frames.delete(deviceId);
        for (const key of [...this.demand.keys()]) if (key.startsWith(deviceId + '|')) this.demand.delete(key);
    }

    prune() {
        const now = this.clock.mono();
        for (const [dev, cams] of this.frames) {
            for (const [cam, f] of cams) if (now - f.at > FRAME_MAX_AGE_MS) cams.delete(cam);
            if (cams.size === 0) this.frames.delete(dev);
        }
        for (const [key, d] of this.demand) {
            if (now - d.sentAt > LEASE_MS * 3) this.demand.delete(key);
        }
    }
}

module.exports = { Snapshots, CAMERA_ID, LEASE_MS, MAX_CAMERAS };
