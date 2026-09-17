// Continuous (hold-to-jog) deadman client (SPEC §3.4.5, §8.2 item 5). DOM-free.
//
// The machine stops the jog on its own if keepalives stop for 400 ms, so this
// controller only ever has to fail safe: it never sends a keepalive unless the
// start was accepted AND the pointer is still down, and every doubt ends the jog.
//
// send(cmd) receives {id, type, cls, args, idem, ttlMs, unsynced?, expectAck}
// and returns true when the frame was handed to an open socket.

import { newId as defaultNewId, JOG_KEEPALIVE_MS, KEEPALIVE_TTL_MS, TTL_DEFAULT } from '../protocol.js';

const AXES = ['x', 'y', 'z'];
const MAX_TRACKED_KEEPALIVES = 64;

// Codes that mean "the link hiccuped", not "you did something wrong".
export const HICCUP_CODES = Object.freeze(['EXPIRED', 'LATENCY_TOO_HIGH', 'deadman', 'latency', 'STALE_TELEMETRY']);

export function createJogController({
    send,
    now = () => Date.now(),
    setInterval: setIntervalFn = globalThis.setInterval,
    clearInterval: clearIntervalFn = globalThis.clearInterval,
    isSynced = () => true,
    newId = defaultNewId,
    keepaliveMs = JOG_KEEPALIVE_MS,
    onEvent = () => {},
} = {}) {
    if (typeof send !== 'function') throw new TypeError('createJogController: send() required');

    let phase = 'idle';          // idle | starting | active
    let pressed = false;
    let jog = null;              // {jogId, axis, dir, feed, startRefId, startedAt}
    let timer = null;
    const keepaliveRefs = new Map();   // envelope id -> jogId

    function emit(ev) {
        try { onEvent(ev); } catch (_) { /* UI errors must not affect the deadman */ }
    }

    function transmit(cmd) {
        try { return send(cmd) === true; } catch (_) { return false; }
    }

    function stopKeepalive() {
        if (timer !== null) {
            clearIntervalFn(timer);
            timer = null;
        }
    }

    function finish(reason, code) {
        stopKeepalive();
        const ended = jog;
        phase = 'idle';
        jog = null;
        keepaliveRefs.clear();
        emit({
            kind: 'ended',
            reason,
            code: code || null,
            jogId: ended ? ended.jogId : null,
            hiccup: !!code && HICCUP_CODES.includes(code),
        });
    }

    function sendStop(jogId) {
        const id = newId('j_');
        const synced = !!isSynced();
        const cmd = {
            id,
            type: 'jog.cont.stop',
            cls: 'stop',
            args: jogId ? { jogId } : {},
            idem: id,
            ttlMs: TTL_DEFAULT.stop,
            expectAck: true,
        };
        if (!synced) cmd.unsynced = true;
        return transmit(cmd);
    }

    function tick() {
        if (phase !== 'active' || !jog || !pressed) {
            stopKeepalive();
            return;
        }
        const id = newId('j_');
        keepaliveRefs.set(id, jog.jogId);
        while (keepaliveRefs.size > MAX_TRACKED_KEEPALIVES) {
            keepaliveRefs.delete(keepaliveRefs.keys().next().value);
        }
        const ok = transmit({
            id,
            type: 'jog.cont.keepalive',
            cls: 'motion',
            args: { jogId: jog.jogId },
            idem: id,
            ttlMs: KEEPALIVE_TTL_MS,
            expectAck: false,
        });
        if (!ok) {
            pressed = false;
            finish('link-down', 'DEVICE_OFFLINE');
        }
    }

    function press(axis, dir, feed) {
        if (!AXES.includes(axis) || (dir !== 1 && dir !== -1) || !Number.isInteger(feed) || feed < 1) {
            return { ok: false, code: 'BAD_ARGS' };
        }
        if (phase !== 'idle') return { ok: false, code: 'JOG_ACTIVE' };
        if (!isSynced()) return { ok: false, code: 'NOT_SYNCED' };

        const jogId = newId('j_');
        const startRefId = newId('j_');
        jog = { jogId, axis, dir, feed, startRefId, startedAt: now() };
        phase = 'starting';
        pressed = true;
        const ok = transmit({
            id: startRefId,
            type: 'jog.cont.start',
            cls: 'motion',
            args: { jogId, axis, dir, feed },
            idem: startRefId,
            ttlMs: TTL_DEFAULT.motion,
            expectAck: true,
        });
        if (!ok) {
            pressed = false;
            finish('send-failed', 'DEVICE_OFFLINE');
            return { ok: false, code: 'DEVICE_OFFLINE' };
        }
        emit({ kind: 'starting', jogId, axis, dir, feed });
        return { ok: true, jogId };
    }

    function release() {
        if (!pressed && phase === 'idle') return false;
        pressed = false;
        if (phase === 'active') {
            const jogId = jog.jogId;
            stopKeepalive();
            sendStop(jogId);
            finish('released');
            return true;
        }
        if (phase === 'starting') {
            // Stop right away as well: it travels behind the start on the same
            // socket, so the machine can never see it first. The ack handler
            // sends another stop once the start is known to be accepted.
            sendStop(jog.jogId);
            return true;
        }
        return false;
    }

    function onAck(ack) {
        if (!ack || typeof ack.refId !== 'string') return false;

        if (jog && phase === 'starting' && ack.refId === jog.startRefId) {
            if (ack.status === 'accepted') {
                if (pressed) {
                    phase = 'active';
                    stopKeepalive();
                    timer = setIntervalFn(tick, keepaliveMs);
                    emit({ kind: 'active', jogId: jog.jogId });
                } else {
                    sendStop(jog.jogId);
                    finish('released-before-ack');
                }
            } else {
                pressed = false;
                finish('rejected', ack.code || 'INTERNAL');
            }
            return true;
        }

        if (keepaliveRefs.has(ack.refId)) {
            const jogId = keepaliveRefs.get(ack.refId);
            keepaliveRefs.delete(ack.refId);
            if (ack.status !== 'accepted' && jog && jog.jogId === jogId && phase === 'active') {
                // The machine already ended this jog; the user must press again.
                pressed = false;
                finish('keepalive-rejected', ack.code || 'INTERNAL');
            }
            return true;
        }
        return false;
    }

    function onSocketClose() {
        if (phase === 'idle' && !pressed) return;
        pressed = false;
        // No stop: there is no socket to carry it. The machine deadman and the
        // relay's client.gone both end the jog.
        finish('link-down', 'DEVICE_OFFLINE');
    }

    // Explicit "stop any jog of mine" (jog.cont.stop {}), usable before sync.
    function stopAll() {
        const hadJog = phase !== 'idle';
        pressed = false;
        const sent = sendStop(null);
        if (hadJog) finish('stopped');
        return sent;
    }

    return {
        press,
        release,
        onAck,
        onSocketClose,
        stopAll,
        getState: () => ({
            phase,
            pressed,
            jogId: jog ? jog.jogId : null,
            axis: jog ? jog.axis : null,
            dir: jog ? jog.dir : null,
            feed: jog ? jog.feed : null,
        }),
        isActive: () => phase !== 'idle',
        dispose() {
            release();
            stopKeepalive();
        },
    };
}
