'use strict';

// Loads the DOM-free web cores (relay/web/js/core/*.js, ES modules) from
// CommonJS with dynamic import() and checks the deadman client contract
// (SPEC §3.4.5, §3.6, §8.2, §10.3).

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB_DIR = process.env.RELAY_WEB_DIR || path.join(__dirname, '..', 'web');

function load(rel) {
    return import(pathToFileURL(path.join(WEB_DIR, 'js', 'core', rel)).href);
}

// Deterministic timers driven by a fake monotonic clock.
function fakeTimers() {
    let t = 0;
    let nextId = 1;
    const timers = new Map();
    function add(fn, ms, repeat) {
        const id = nextId++;
        timers.set(id, { fn, at: t + Math.max(0, ms), every: repeat ? Math.max(1, ms) : 0 });
        return id;
    }
    return {
        now: () => t,
        setTimeout: (fn, ms) => add(fn, ms, false),
        clearTimeout: (id) => { timers.delete(id); },
        setInterval: (fn, ms) => add(fn, ms, true),
        clearInterval: (id) => { timers.delete(id); },
        advance(ms) {
            const end = t + ms;
            for (;;) {
                let dueId = null;
                let due = null;
                for (const [id, tm] of timers) {
                    if (tm.at <= end && (due === null || tm.at < due.at)) { due = tm; dueId = id; }
                }
                if (!due) break;
                t = due.at;
                if (due.every) due.at += due.every;
                else timers.delete(dueId);
                due.fn();
            }
            t = end;
        },
        pending: () => timers.size,
    };
}

function harness(jogMod, { synced = true } = {}) {
    const timers = fakeTimers();
    const sent = [];
    const events = [];
    let isSynced = synced;
    let socketOpen = true;
    const jog = jogMod.createJogController({
        send: (cmd) => {
            if (!socketOpen) return false;
            sent.push(cmd);
            return true;
        },
        now: timers.now,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isSynced: () => isSynced,
        onEvent: (ev) => events.push(ev),
    });
    return {
        jog, timers, sent, events,
        setSynced(v) { isSynced = v; },
        closeSocket() { socketOpen = false; jog.onSocketClose(); },
        ofType: (type) => sent.filter((c) => c.type === type),
    };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('keepalives every 100 ms after the accepted start', async (m) => {
    const h = harness(m.jog);
    const r = h.jog.press('x', 1, 300);
    assert.strictEqual(r.ok, true);
    const start = h.ofType('jog.cont.start');
    assert.strictEqual(start.length, 1);
    assert.strictEqual(start[0].cls, 'motion');
    assert.deepStrictEqual(Object.keys(start[0].args).sort(), ['axis', 'dir', 'feed', 'jogId']);
    assert.match(start[0].args.jogId, /^j_[a-z0-9]{6,20}$/);

    h.timers.advance(500);
    assert.strictEqual(h.ofType('jog.cont.keepalive').length, 0, 'no keepalive before the ack');

    h.jog.onAck({ refId: start[0].id, status: 'accepted', code: 'OK' });
    h.timers.advance(99);
    assert.strictEqual(h.ofType('jog.cont.keepalive').length, 0);
    h.timers.advance(1);
    assert.strictEqual(h.ofType('jog.cont.keepalive').length, 1);
    h.timers.advance(900);
    const ka = h.ofType('jog.cont.keepalive');
    assert.strictEqual(ka.length, 10);
    for (const k of ka) {
        assert.strictEqual(k.cls, 'motion');
        assert.strictEqual(k.ttlMs, 300);
        assert.strictEqual(k.args.jogId, start[0].args.jogId);
        assert.strictEqual(k.idem, k.id, 'keepalive idem is its fresh envelope id');
    }
    assert.strictEqual(new Set(ka.map((k) => k.id)).size, ka.length);
});

test('release before the start ack: accepted ack sends stop, never a keepalive', async (m) => {
    const h = harness(m.jog);
    h.jog.press('y', -1, 300);
    const start = h.ofType('jog.cont.start')[0];
    h.jog.release();
    h.timers.advance(50);
    const stopsBeforeAck = h.ofType('jog.cont.stop').length;
    h.jog.onAck({ refId: start.id, status: 'accepted', code: 'OK' });
    h.timers.advance(1000);
    assert.strictEqual(h.ofType('jog.cont.keepalive').length, 0);
    const stops = h.ofType('jog.cont.stop');
    assert.ok(stops.length > stopsBeforeAck, 'a stop is sent when the accepted ack arrives');
    assert.strictEqual(stops[stops.length - 1].cls, 'stop');
    assert.strictEqual(stops[stops.length - 1].args.jogId, start.args.jogId);
    assert.strictEqual(h.jog.getState().phase, 'idle');
    assert.strictEqual(h.timers.pending(), 0);
});

test('release sends stop and stops keepalives', async (m) => {
    const h = harness(m.jog);
    h.jog.press('z', 1, 300);
    const start = h.ofType('jog.cont.start')[0];
    h.jog.onAck({ refId: start.id, status: 'accepted', code: 'OK' });
    h.timers.advance(350);
    const before = h.ofType('jog.cont.keepalive').length;
    assert.strictEqual(before, 3);
    h.jog.release();
    const stops = h.ofType('jog.cont.stop');
    assert.strictEqual(stops.length, 1);
    assert.strictEqual(stops[0].args.jogId, start.args.jogId);
    h.timers.advance(1000);
    assert.strictEqual(h.ofType('jog.cont.keepalive').length, before);
    assert.strictEqual(h.timers.pending(), 0);
});

test('a keepalive rejection stops keepalives', async (m) => {
    const h = harness(m.jog);
    h.jog.press('x', -1, 300);
    const start = h.ofType('jog.cont.start')[0];
    h.jog.onAck({ refId: start.id, status: 'accepted', code: 'OK' });
    h.timers.advance(200);
    const ka = h.ofType('jog.cont.keepalive');
    assert.strictEqual(ka.length, 2);
    h.jog.onAck({ refId: ka[1].id, status: 'rejected', code: 'EXPIRED' });
    h.timers.advance(1000);
    assert.strictEqual(h.ofType('jog.cont.keepalive').length, 2);
    const ended = h.events.filter((e) => e.kind === 'ended');
    assert.strictEqual(ended.length, 1);
    assert.strictEqual(ended[0].code, 'EXPIRED');
    assert.strictEqual(ended[0].hiccup, true, 'EXPIRED is shown as a connection hiccup');
    // The finger is still down; a later release must not start anything.
    h.jog.release();
    h.timers.advance(500);
    assert.strictEqual(h.ofType('jog.cont.keepalive').length, 2);
});

test('a rejected start sends no keepalives', async (m) => {
    const h = harness(m.jog);
    h.jog.press('x', 1, 300);
    const start = h.ofType('jog.cont.start')[0];
    h.jog.onAck({ refId: start.id, status: 'rejected', code: 'TIER_REQUIRED', message: 'motion' });
    h.timers.advance(1000);
    assert.strictEqual(h.ofType('jog.cont.keepalive').length, 0);
    assert.strictEqual(h.jog.getState().phase, 'idle');
});

test('socket close stops keepalives with no stop sent', async (m) => {
    const h = harness(m.jog);
    h.jog.press('x', 1, 300);
    const start = h.ofType('jog.cont.start')[0];
    h.jog.onAck({ refId: start.id, status: 'accepted', code: 'OK' });
    h.timers.advance(300);
    const before = h.sent.length;
    h.closeSocket();
    h.timers.advance(1000);
    assert.strictEqual(h.sent.length, before, 'nothing sent after close');
    assert.strictEqual(h.ofType('jog.cont.stop').length, 0);
    assert.strictEqual(h.timers.pending(), 0);
});

test('nothing non-stop is sent before clock sync; stop is sent unsynced', async (m) => {
    const h = harness(m.jog, { synced: false });
    const r = h.jog.press('x', 1, 300);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NOT_SYNCED');
    h.timers.advance(1000);
    assert.strictEqual(h.sent.length, 0);

    assert.strictEqual(h.jog.stopAll(), true);
    assert.strictEqual(h.sent.length, 1);
    assert.strictEqual(h.sent[0].type, 'jog.cont.stop');
    assert.strictEqual(h.sent[0].cls, 'stop');
    assert.strictEqual(h.sent[0].unsynced, true);

    h.setSynced(true);
    assert.strictEqual(h.jog.press('x', 1, 300).ok, true);
    assert.strictEqual(h.ofType('jog.cont.start').length, 1);
    assert.strictEqual(h.ofType('jog.cont.start')[0].unsynced, undefined);
});

test('only one jog at a time', async (m) => {
    const h = harness(m.jog);
    assert.strictEqual(h.jog.press('x', 1, 300).ok, true);
    const second = h.jog.press('y', 1, 300);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(h.ofType('jog.cont.start').length, 1);
});

test('clock sync: 5 pings 200 ms apart, median offset, synced after the burst', async (m) => {
    const timers = fakeTimers();
    const sent = [];
    const clock = m.clock.createClockSync({
        now: timers.now,
        send: (msg) => { sent.push(msg); return true; },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    });
    assert.strictEqual(clock.isSynced(), false);
    clock.startBurst();
    assert.strictEqual(sent.length, 1);
    timers.advance(800);
    assert.strictEqual(sent.length, 5);
    assert.deepStrictEqual(sent.map((s) => s.body.sentAt), [0, 200, 400, 600, 800]);
    assert.strictEqual(clock.isSynced(), false);
    const relayAhead = 10000;
    timers.advance(40);
    for (const s of sent) {
        // rtt 40..840; the relay stamps recvAt at the midpoint of each rtt.
        const rtt = timers.now() - s.body.sentAt;
        clock.onPong({ nonce: s.body.nonce, sentAt: s.body.sentAt, recvAt: s.body.sentAt + rtt / 2 + relayAhead });
    }
    assert.strictEqual(clock.isSynced(), true);
    assert.strictEqual(clock.offsetMs(), relayAhead);
    assert.strictEqual(clock.nowSynced(), timers.now() + relayAhead);
    assert.strictEqual(clock.onPong({ nonce: 'p_unknown00000', sentAt: 0, recvAt: 1 }), null);
});

function syncedClock(m, timers, sent) {
    const clock = m.clock.createClockSync({
        now: timers.now,
        send: (msg) => { sent.push(msg); return true; },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    });
    clock.startBurst();
    timers.advance(820);
    for (const s of sent.splice(0)) clock.onPong({ nonce: s.body.nonce, sentAt: s.body.sentAt, recvAt: s.body.sentAt + 5000 });
    assert.strictEqual(clock.isSynced(), true);
    return clock;
}

test('clock: a new socket or a suspension forgets the offset; stop goes unsynced until fresh pongs', async (m) => {
    const timers = fakeTimers();
    const sent = [];
    const clock = syncedClock(m, timers, sent);
    const cmds = [];
    const jog = m.jog.createJogController({
        send: (cmd) => { cmds.push(cmd); return true; },
        now: timers.now,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isSynced: () => clock.isSynced(),
    });

    assert.ok(clock.ping());
    const stale = sent.splice(0)[0];
    clock.resetSocket();
    assert.strictEqual(clock.isSynced(), false);
    assert.strictEqual(clock.offsetMs(), null);
    // A pong for a ping sent before the reset must not restore the old offset.
    assert.strictEqual(clock.onPong({ nonce: stale.body.nonce, sentAt: stale.body.sentAt, recvAt: 1 }), null);

    clock.startBurst();
    assert.strictEqual(jog.stopAll(), true);
    assert.strictEqual(cmds[0].cls, 'stop');
    assert.strictEqual(cmds[0].unsynced, true, 'stop after resetSocket and before the new burst completes is unsynced');
    assert.strictEqual(jog.press('x', 1, 300).code, 'NOT_SYNCED');

    const first = sent[0];
    timers.advance(30);
    clock.onPong({ nonce: first.body.nonce, sentAt: first.body.sentAt, recvAt: first.body.sentAt - 2000 });
    assert.strictEqual(clock.isSynced(), false, 'one burst pong is not yet a majority');
    timers.advance(800);
    for (const s of sent.slice(1, 3)) clock.onPong({ nonce: s.body.nonce, sentAt: s.body.sentAt, recvAt: s.body.sentAt - 2000 });
    assert.strictEqual(clock.isSynced(), true, 'three fresh samples are enough');
    assert.ok(clock.offsetMs() < -1000, 'offset comes only from fresh samples');

    clock.invalidate();
    assert.strictEqual(clock.isSynced(), false);
    assert.strictEqual(jog.stopAll(), true);
    assert.strictEqual(cmds[cmds.length - 1].unsynced, true);
});

test('clock: a pong arriving after the burst settle window still completes sync', async (m) => {
    const timers = fakeTimers();
    const sent = [];
    const clock = m.clock.createClockSync({
        now: timers.now,
        send: (msg) => { sent.push(msg); return true; },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    });
    clock.startBurst();
    timers.advance(5000);
    assert.strictEqual(clock.isSynced(), false, 'no pong within the settle window');
    const late = sent[0];
    clock.onPong({ nonce: late.body.nonce, sentAt: late.body.sentAt, recvAt: late.body.sentAt + 100 });
    assert.strictEqual(clock.isSynced(), true);
});

test('link watchdog: 12 s of silence closes the socket', async (m) => {
    const timers = fakeTimers();
    const closes = [];
    const wd = m.link.createLinkWatchdog({
        now: timers.now,
        send: () => true,
        close: (reason) => closes.push(reason),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    });
    wd.start();
    assert.strictEqual(wd.isLive(), true);
    timers.advance(6000);
    wd.onFrame({ t: 'ping', body: {} });
    timers.advance(11900);
    assert.deepStrictEqual(closes, []);
    assert.strictEqual(wd.isLive(), true);
    timers.advance(200);
    assert.deepStrictEqual(closes, ['silence']);
    assert.strictEqual(wd.isLive(), false);
    assert.strictEqual(timers.pending(), 0);
});

test('link watchdog: resume probe without a pong in 2 s closes; with a pong it stays', async (m) => {
    const timers = fakeTimers();
    const closes = [];
    const sent = [];
    const wd = m.link.createLinkWatchdog({
        now: timers.now,
        send: (msg) => { sent.push(msg); return true; },
        close: (reason) => closes.push(reason),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    });
    wd.start();
    assert.strictEqual(wd.probe(), true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].t, 'ping');
    assert.strictEqual(wd.isLive(), false, 'not verified live while a probe is outstanding');
    timers.advance(1000);
    wd.onFrame({ t: 'pong', body: { nonce: sent[0].body.nonce } });
    assert.strictEqual(wd.isLive(), true);
    timers.advance(3000);
    assert.deepStrictEqual(closes, []);

    wd.probe();
    timers.advance(1500);
    wd.onFrame({ t: 'report.state', body: {} });  // other frames do not answer the probe
    timers.advance(501);
    assert.deepStrictEqual(closes, ['probe-timeout']);
});

(async () => {
    console.log('=== Web Jog Core Tests ===');
    const mods = {
        jog: await load('jog.js'),
        clock: await load('clock.js'),
        link: await load('link.js'),
    };
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn(mods);
            console.log('✓ ' + t.name);
        } catch (err) {
            failed++;
            console.log('✗ ' + t.name);
            console.log(err && err.stack ? err.stack : err);
        }
    }
    if (failed) {
        console.log(failed + ' test(s) failed');
        process.exit(1);
    }
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
