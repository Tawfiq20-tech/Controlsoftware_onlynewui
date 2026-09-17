// Half-open socket detection for the browser leg (SPEC §8.2). DOM-free.
//
// Mobile browsers keep a dead TCP connection "open" for minutes after a network
// switch or app suspension. A phone must never show an enabled STOP on such a
// socket, so liveness is proven by received frames, not by readyState.

import { newId as defaultNewId } from '../protocol.js';

export const SILENCE_MS = 12000;
export const PROBE_TIMEOUT_MS = 2000;

export function createLinkWatchdog({
    now,
    send,
    close,
    setTimeout: setTimeoutFn = globalThis.setTimeout,
    clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
    newId = defaultNewId,
    silenceMs = SILENCE_MS,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    onChange = () => {},
} = {}) {
    if (typeof now !== 'function') throw new TypeError('createLinkWatchdog: now() required');
    if (typeof send !== 'function') throw new TypeError('createLinkWatchdog: send() required');
    if (typeof close !== 'function') throw new TypeError('createLinkWatchdog: close() required');

    let running = false;
    let lastRxAt = 0;
    let silenceTimer = null;
    let probeNonce = null;
    let probeTimer = null;
    let lastLive = false;

    function isLive() {
        return running && probeNonce === null && now() - lastRxAt <= silenceMs;
    }

    function notify() {
        const live = isLive();
        if (live === lastLive) return;
        lastLive = live;
        try { onChange(live); } catch (_) { /* listener errors must not break detection */ }
    }

    function clearTimers() {
        if (silenceTimer !== null) { clearTimeoutFn(silenceTimer); silenceTimer = null; }
        if (probeTimer !== null) { clearTimeoutFn(probeTimer); probeTimer = null; }
    }

    function armSilence() {
        if (silenceTimer !== null) clearTimeoutFn(silenceTimer);
        const due = Math.max(0, lastRxAt + silenceMs - now());
        silenceTimer = setTimeoutFn(checkSilence, due + 1);
    }

    function checkSilence() {
        silenceTimer = null;
        if (!running) return;
        if (now() - lastRxAt > silenceMs) trip('silence');
        else armSilence();
    }

    function trip(reason) {
        if (!running) return;
        running = false;
        probeNonce = null;
        clearTimers();
        notify();
        try { close(reason); } catch (_) { /* the owner decides how to reconnect */ }
    }

    return {
        start() {
            clearTimers();
            running = true;
            probeNonce = null;
            lastRxAt = now();
            armSilence();
            notify();
        },
        stop() {
            running = false;
            probeNonce = null;
            clearTimers();
            notify();
        },
        onFrame(msg) {
            if (!running) return;
            lastRxAt = now();
            if (probeNonce !== null && msg && msg.t === 'pong' && msg.body && msg.body.nonce === probeNonce) {
                probeNonce = null;
                if (probeTimer !== null) { clearTimeoutFn(probeTimer); probeTimer = null; }
            }
            notify();
        },
        // Resume probe: visibilitychange->visible, pageshow, online.
        probe() {
            if (!running) return false;
            if (probeNonce !== null) return true;
            const nonce = newId('p_');
            probeNonce = nonce;
            let ok;
            try { ok = send({ t: 'ping', body: { nonce, sentAt: now() } }); } catch (_) { ok = false; }
            if (ok === false) {
                trip('probe-send-failed');
                return false;
            }
            probeTimer = setTimeoutFn(() => {
                probeTimer = null;
                if (running && probeNonce === nonce) trip('probe-timeout');
            }, probeTimeoutMs);
            notify();
            return true;
        },
        isLive,
        isRunning: () => running,
        probeOutstanding: () => probeNonce !== null,
        lastRxAt: () => lastRxAt,
    };
}
