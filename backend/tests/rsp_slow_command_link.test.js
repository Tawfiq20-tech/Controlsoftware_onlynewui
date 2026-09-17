'use strict';

/**
 * A command that legitimately takes longer than the stream's 20 s stall
 * timeout -- a slow probe, a long OP_MOVE, homing -- must not be reported as
 * a lost link while the board is alive, and a link that really is dead must
 * still be found within the existing bounds.
 *
 * Firmware 0.2.0 answers OP_PROBE / OP_MOVE / OP_HOME only when the motion
 * ends (rsp_handle_probe/move/home block the main loop and every later frame
 * waits in the USB buffer); run_move() keeps pushing EV_STATUS at ~10 Hz, the
 * probe and homing loops send nothing. A newer firmware may ACK such a
 * command first and reply when done. The device double below models these on
 * the wire, so this file does not depend on the fake firmware's personalities.
 *
 * Time is virtual (node:test mock timers).
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { mock } = require('node:test');
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_700_000_000_000 });

const assert = require('assert');
const { EventEmitter } = require('events');
const defs = require('../services/rsp/defs');
const codec = require('../services/rsp/codec');
const { ReliableStream, DEFAULT_STALL_TIMEOUT_S, MAX_RETRIES } = require('../services/rsp/stream');
const { FrameParser, buildFrame, FT_CMD, FT_RSP, FT_EVT, FT_ACK, FT_NAK, FT_HB } = require('../services/rsp/frame');

const flush = () => new Promise((r) => setImmediate(r));

async function advance(ms, step = 5) {
    for (let t = 0; t < ms; t += step) {
        mock.timers.tick(step);
        await flush();
    }
}

/**
 * In-order RSP receiver with a blocking (or early-ACKed) OP_PROBE, and a
 * blocking OP_MOVE / OP_HOME when `moveS` / `homeS` are set. During an OP_MOVE
 * it keeps sending EV_STATUS (0.2.0 run_move()); during a probe or home only
 * with `statusWhileBusy`.
 */
class SlowOpDevice extends EventEmitter {
    constructor({ probeS = 60, moveS = 0, homeS = 0, earlyAck = false, statusMs = 100, statusWhileBusy = true } = {}) {
        super();
        this.probeS = probeS;
        this.moveS = moveS;
        this.homeS = homeS;
        this.earlyAck = earlyAck;
        this.statusWhileBusy = statusWhileBusy; // false: 0.2.0 probe/home loops send nothing
        this.parser = new FrameParser();
        this.expected = 0;
        this.synced = false;
        this.lastReply = null;
        this.busyUntil = 0;
        this.busyOp = 0;
        this.busyReply = null;
        this.queue = [];
        this.handled = [];     // [{seq, op}] every command handled, in order
        this.copies = new Map(); // seq -> command frames that reached the device
        this.rxMuted = false;  // host -> device bytes lost
        this.txMuted = false;  // device -> host bytes lost
        this.answerNothing = false; // alive (telemetry) but never answers a command
        this._status = setInterval(() => {
            if (!this.statusWhileBusy && this.busyOp !== defs.OP_MOVE && Date.now() < this.busyUntil) return;
            this._evt(Buffer.concat([Buffer.from([defs.EV_STATUS]), this._tel()]));
        }, statusMs);
        this._loop = setInterval(() => this._service(), 1);
    }

    destroy() { clearInterval(this._status); clearInterval(this._loop); }

    receive(buf) {
        if (this.rxMuted) return;
        for (const f of this.parser.feed(buf)) {
            if (f.frameType === FT_CMD) this.copies.set(f.seq, (this.copies.get(f.seq) || 0) + 1);
            if (Date.now() < this.busyUntil) this.queue.push(f); // main loop blocked in the motion
            else this._dispatch(f);
        }
    }

    _send(type, seq, payload, cache) {
        const frame = buildFrame(type, 0, seq, payload);
        if (cache) this.lastReply = { seq, frame };
        if (!this.txMuted) setTimeout(() => this.emit('tx', frame), 1);
    }

    _evt(payload) { this._send(FT_EVT, 0, payload, false); }

    _tel() {
        return defs.packTelemetry({
            state: defs.ST_IDLE, faultFlags: 0, limitFlags: 0, flags: 0x20, x: 0, y: 0, z: 0, feed: 0, spindleSpeed: 0,
            lastExecutedLine: 0, jobId: 0, bufferFillPct: 0, plannerDepth: 0, linkOk: 1, errorCode: 0,
            jogActive: 0, jogDoneEvt: 0, tim2IsrCount: 0, stepsDone: 0, stepsTotal: 0,
        });
    }

    _dispatch(f) {
        if (f.frameType === FT_HB) { this._send(FT_HB, 0, Buffer.alloc(0), false); return; }
        if (f.frameType !== FT_CMD || !f.payload.length) return;
        if (this.answerNothing) return;
        const op = f.payload[0];
        if (!this.synced || f.seq === 0) { this.expected = f.seq; this.synced = true; }
        if (f.seq !== this.expected) {
            if (this.lastReply && this.lastReply.seq === f.seq) { if (!this.txMuted) setTimeout(() => this.emit('tx', this.lastReply.frame), 1); return; }
            this._send(FT_NAK, this.expected, Buffer.from([op, defs.ST_ERR_SEQ_GAP]), true);
            return;
        }
        this.expected = (this.expected + 1) & 0xFFFF;
        this.handled.push({ seq: f.seq, op });
        const busyS = op === defs.OP_PROBE ? this.probeS : op === defs.OP_MOVE ? this.moveS : op === defs.OP_HOME ? this.homeS : 0;
        if (busyS > 0) {
            if (this.earlyAck) this._send(FT_ACK, f.seq, Buffer.alloc(0), true);
            this.busyUntil = Date.now() + busyS * 1000;
            this.busyOp = op;
            let data = Buffer.alloc(0);
            if (op === defs.OP_PROBE) {
                data = Buffer.alloc(18);
                data[0] = defs.PROBE_RESULT_CONTACT;
                data[1] = 2;
            }
            this.busyReply = { seq: f.seq, payload: Buffer.concat([Buffer.from([op, defs.ST_OK]), data]) };
            return;
        }
        this._send(FT_RSP, f.seq, Buffer.from([op, defs.ST_OK]), true);
    }

    _service() {
        if (!this.busyReply || Date.now() < this.busyUntil) return;
        const r = this.busyReply;
        this.busyReply = null;
        this._send(FT_RSP, r.seq, r.payload, true);
        const q = this.queue;
        this.queue = [];
        for (const f of q) this._dispatch(f);
    }
}

function rig(deviceOpts) {
    const dev = new SlowOpDevice(deviceOpts);
    const transport = new EventEmitter();
    transport.send = (buf) => setTimeout(() => dev.receive(buf), 1);
    dev.on('tx', (frame) => transport.emit('data', frame));
    const stream = new ReliableStream(transport, { logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const linkEvents = [];
    const gaveUp = [];
    const t0 = Date.now();
    stream.start(); // link up (not recorded)
    stream.on('link', (ok) => linkEvents.push({ ok, atS: (Date.now() - t0) / 1000, reason: stream._linkDownReason }));
    stream.on('gaveUp', (g) => gaveUp.push(g));
    return {
        dev, stream, linkEvents, gaveUp, t0,
        close() { stream.stop(); dev.destroy(); },
    };
}

function settle(promise) {
    const box = { done: false, value: undefined, error: undefined };
    promise.then((v) => { box.done = true; box.value = v; }, (e) => { box.done = true; box.error = e; });
    return box;
}

const probePayload = () => codec.buildProbe(2, 0, 30, 30);

// ---------------------------------------------------------------------------

async function testBlockingProbeLongerThanStallTimeout() {
    const r = rig({ probeS: 60, earlyAck: false });
    await advance(300);
    const probe = settle(r.stream.sendCommand(defs.OP_PROBE, probePayload(), { timeout: 95 }));
    await advance(5000);
    // the operator clicks something while the machine is probing
    const status = settle(r.stream.sendCommand(defs.OP_GET_STATUS, Buffer.alloc(0), { timeout: 2 }));
    await advance(60000);
    assert.ok(probe.done && !probe.error, `60 s probe resolved: ${probe.error && probe.error.message}`);
    assert.strictEqual(probe.value.payload[1], defs.ST_OK);
    assert.deepStrictEqual(r.linkEvents, [], `link never reported lost during a 60 s probe: ${JSON.stringify(r.linkEvents)}`);
    assert.deepStrictEqual(r.gaveUp, [], 'no command given up');
    assert.ok(status.done, 'the command queued behind the probe settled');
    await advance(3000);
    assert.strictEqual(r.stream._sent.size, 0, 'nothing left pending once the probe and the queued command are through');
    assert.deepStrictEqual(r.dev.handled.filter((h) => h.seq !== 0).map((h) => h.op), [defs.OP_PROBE, defs.OP_GET_STATUS],
        'each command handled exactly once, in order (after the session PING)');
    // Copies of the unanswered probe stop once its retries are used up: more
    // only fill the board's USB buffer while it is blocked in the probe.
    const probeSeq = r.dev.handled.find((h) => h.op === defs.OP_PROBE).seq;
    const probeCopies = r.dev.copies.get(probeSeq);
    assert.ok(probeCopies <= 1 + MAX_RETRIES, `the probe frame reached the board ${probeCopies} times (at most ${1 + MAX_RETRIES})`);
    r.close();
    console.log(`  ok  firmware that answers a probe only after 60 s of motion: no link loss, nothing given up, queued command handled after it, probe sent ${probeCopies} times`);
}

async function testEarlyAckedProbe() {
    const r = rig({ probeS: 60, earlyAck: true });
    await advance(300);
    const probe = settle(r.stream.sendCommand(defs.OP_PROBE, probePayload(), { timeout: 95 }));
    await advance(5000);
    assert.strictEqual(r.stream._sent.size, 0, 'the early ACK settles the frame (no retransmits)');
    const jog = settle(r.stream.sendCommand(defs.OP_PING, Buffer.alloc(0), { timeout: 3 }));
    await advance(60000);
    assert.ok(probe.done && !probe.error, `probe resolved: ${probe.error && probe.error.message}`);
    assert.deepStrictEqual(r.linkEvents, [], `link never reported lost: ${JSON.stringify(r.linkEvents)}`);
    assert.deepStrictEqual(r.gaveUp, []);
    assert.ok(jog.done, 'the command queued behind the probe settled');
    await advance(3000);
    assert.strictEqual(r.stream._sent.size, 0);
    r.close();
    console.log('  ok  firmware that ACKs the probe at once and replies after 60 s: no link loss, queued command waits its turn');
}

async function testDeadLinkDuringSlowCommandStillDetected() {
    const r = rig({ probeS: 60, earlyAck: false });
    await advance(300);
    const probe = settle(r.stream.sendCommand(defs.OP_PROBE, probePayload(), { timeout: 95 }));
    await advance(5000);
    const cutAt = Date.now();
    r.dev.rxMuted = true;
    r.dev.txMuted = true; // cable pulled: nothing either way
    await advance(4000);
    const down = r.linkEvents.find((e) => !e.ok);
    assert.ok(down, 'dead link detected while the slow command is outstanding');
    const afterS = (down.atS * 1000 + r.t0 - cutAt) / 1000;
    assert.ok(afterS <= r.stream.heartbeatS * 3 + 0.1, `within the heartbeat bound (${afterS.toFixed(2)} s)`);
    // indistinguishable from a 0.2.0 board probing in silence, and named so
    assert.strictEqual(down.reason, 'silent_during_slow_command');
    void probe;
    r.close();

    // silence that began before the command: a plain lost link
    const r2 = rig({});
    await advance(300);
    r2.dev.rxMuted = true;
    r2.dev.txMuted = true;
    await advance(1000);
    settle(r2.stream.sendCommand(defs.OP_PROBE, probePayload(), { timeout: 95 }));
    await advance(3000);
    const down2 = r2.linkEvents.find((e) => !e.ok);
    assert.ok(down2 && down2.reason === 'heartbeat', `plain link loss: ${JSON.stringify(r2.linkEvents)}`);
    r2.close();
    console.log(`  ok  cable pulled during a 60 s probe: link lost after ${afterS.toFixed(2)} s (heartbeat bound, unchanged)`);
}

async function testSilentFirmwareProbe() {
    // Firmware 0.2.0 sends nothing at all while probing or homing. That cannot
    // be told from a pulled cable, so the link still goes down at the heartbeat
    // bound -- but with a reason the controller can show honestly -- and
    // comes back with the reply; nothing is given up or duplicated.
    const r = rig({ probeS: 40, earlyAck: false, statusWhileBusy: false });
    await advance(300);
    const probe = settle(r.stream.sendCommand(defs.OP_PROBE, probePayload(), { timeout: 65 }));
    await advance(4000);
    assert.strictEqual(r.stream.linkOk, false);
    assert.strictEqual(r.stream.linkDownReason, 'silent_during_slow_command');
    await advance(38000);
    assert.ok(probe.done && !probe.error, `probe resolved: ${probe.error && probe.error.message}`);
    assert.strictEqual(r.stream.linkOk, true, 'link back with the reply');
    assert.deepStrictEqual(r.gaveUp, [], 'nothing given up');
    assert.deepStrictEqual(r.linkEvents.map((e) => e.ok), [false, true]);
    assert.strictEqual(r.dev.handled.filter((h) => h.op === defs.OP_PROBE).length, 1, 'probe run once');
    r.close();
    console.log('  ok  firmware silent for a 40 s probe: link down reason "silent_during_slow_command", back with the reply, nothing given up');
}

async function testSilenceReasonOnlyWhereTheFirmwareIsSilent() {
    // The controller shows a soft "busy probing/homing" message for
    // 'silent_during_slow_command' instead of 'RSP link lost'. That is only
    // honest where the firmware really sends nothing: a probe or home it did
    // not ACK early. A cable pulled during a long diagonal move (EV_STATUS keeps
    // coming on every firmware) or during a probe the board ACKed at once
    // (0.2.1, which reports while probing) is a lost link and must say so.
    const cases = [
        { label: '60 s OP_MOVE', dev: { moveS: 60 }, op: defs.OP_MOVE, payload: codec.buildMove(100, 0, 0, 100), timeout: 95, want: 'heartbeat' },
        { label: 'early-ACKed 60 s probe', dev: { probeS: 60, earlyAck: true }, op: defs.OP_PROBE, payload: probePayload(), timeout: 95, want: 'heartbeat' },
        { label: '60 s home', dev: { homeS: 60 }, op: defs.OP_HOME, payload: codec.buildHome(0x07), timeout: 95, want: 'silent_during_slow_command' },
    ];
    for (const c of cases) {
        const r = rig(c.dev);
        await advance(300);
        settle(r.stream.sendCommand(c.op, c.payload, { timeout: c.timeout }));
        await advance(5000);
        assert.deepStrictEqual(r.linkEvents, [], `${c.label}: link up while the board reports`);
        r.dev.rxMuted = true;
        r.dev.txMuted = true; // cable pulled
        await advance(3500);
        const down = r.linkEvents.find((e) => !e.ok);
        assert.ok(down, `${c.label}: link loss detected`);
        assert.strictEqual(down.reason, c.want, `${c.label}: cable pulled -> reason '${down.reason}' (expected '${c.want}')`);
        r.close();
    }

    // 0.2.0 silent through an ordinary probe or home (own timeout under the
    // 20 s stall bound): named the same way, back with the reply, nothing lost.
    for (const c of [
        { label: '6 s probe (timeout 14 s)', dev: { probeS: 6, statusWhileBusy: false }, op: defs.OP_PROBE, payload: probePayload(), timeout: 14 },
        { label: '15 s home (timeout 19 s)', dev: { homeS: 15, statusWhileBusy: false }, op: defs.OP_HOME, payload: codec.buildHome(0x07), timeout: 19 },
    ]) {
        const r = rig(c.dev);
        await advance(300);
        const cmd = settle(r.stream.sendCommand(c.op, c.payload, { timeout: c.timeout }));
        await advance(4000);
        assert.strictEqual(r.stream.linkOk, false, `${c.label}: premise, the silent board drops the link after 3 s`);
        assert.strictEqual(r.stream.linkDownReason, 'silent_during_slow_command', `${c.label}: reason '${r.stream.linkDownReason}'`);
        await advance(c.dev.probeS === 6 ? 3000 : 12000);
        assert.ok(cmd.done && !cmd.error, `${c.label}: resolved (${cmd.error && cmd.error.message})`);
        assert.strictEqual(r.stream.linkOk, true, `${c.label}: link back with the reply`);
        assert.deepStrictEqual(r.gaveUp, [], `${c.label}: nothing given up`);
        r.close();
    }
    console.log('  ok  "silent_during_slow_command" only for a probe or home the board did not ACK early (any timeout over 3 s); a pulled cable during a move or an early-ACKed probe is "heartbeat"');
}

async function testSilentDeviceStillStallsAtTheCommandsOwnBound() {
    // Alive (telemetry keeps coming) but answering no command: the old
    // 20 s stall bound for ordinary commands, the caller's own timeout for a
    // slow one -- never later.
    const r = rig({});
    await advance(300);
    r.dev.answerNothing = true;
    const t = Date.now();
    settle(r.stream.sendCommand(defs.OP_PING, Buffer.alloc(0), { timeout: 3 }));
    await advance((DEFAULT_STALL_TIMEOUT_S + 1) * 1000);
    const down = r.linkEvents.find((e) => !e.ok);
    assert.ok(down && down.reason === 'stall', `ordinary command stalled: ${JSON.stringify(r.linkEvents)}`);
    const atS = (down.atS * 1000 + r.t0 - t) / 1000;
    assert.ok(Math.abs(atS - DEFAULT_STALL_TIMEOUT_S) < 0.1, `ordinary command given up at ${atS.toFixed(2)} s`);
    r.close();

    const r2 = rig({});
    await advance(300);
    r2.dev.answerNothing = true;
    const t2 = Date.now();
    settle(r2.stream.sendCommand(defs.OP_PROBE, probePayload(), { timeout: 30 }));
    await advance(29000);
    assert.deepStrictEqual(r2.linkEvents, [], 'a 30 s command is not given up before its own timeout');
    await advance(4000);
    const down2 = r2.linkEvents.find((e) => !e.ok);
    assert.ok(down2 && down2.reason === 'stall', `slow command stalled after its budget: ${JSON.stringify(r2.linkEvents)}`);
    const at2 = (down2.atS * 1000 + r2.t0 - t2) / 1000;
    assert.ok(at2 >= 30 && at2 <= 32.1, `slow command given up at ${at2.toFixed(2)} s (timeout 30 s + 2 s margin)`);
    assert.strictEqual(r2.gaveUp.length, 1);
    r2.close();
    console.log(`  ok  board alive but answering nothing: ordinary command given up at ${atS.toFixed(1)} s, a 30 s command at ${at2.toFixed(1)} s`);
}

async function testQueuedBehindSlowCommandGetsFreshClock() {
    // A frame sent early in a long probe must not be declared stalled the
    // moment the probe finishes (it has been waiting more than 20 s by then).
    const r = rig({ probeS: 45, earlyAck: false });
    await advance(300);
    settle(r.stream.sendCommand(defs.OP_PROBE, probePayload(), { timeout: 70 }));
    await advance(1000);
    // a job-style queued frame (no reply waiter) behind the probe
    r.stream.sendNowait(defs.OP_PING, Buffer.alloc(0));
    await advance(50000);
    assert.deepStrictEqual(r.linkEvents, [], `no link loss: ${JSON.stringify(r.linkEvents)}`);
    assert.deepStrictEqual(r.gaveUp, []);
    assert.strictEqual(r.stream._sent.size, 0, 'queued frame delivered after the probe');
    r.close();
    console.log('  ok  a frame queued 1 s into a 45 s probe is delivered afterwards, not given up');
}

async function testRenumberedCommandTimeoutLeavesNoWaiter() {
    // A board still on another session's numbering makes the stream renumber
    // what is pending. A renumbered command that then times out must not stay
    // registered under its new seq (a leaked waiter also kept its frame from
    // being settled by a later ACK).
    const r = rig({});
    await advance(300);
    for (let i = 0; i < 4; i++) settle(r.stream.sendCommand(defs.OP_PING, Buffer.alloc(0), { timeout: 3 }));
    await advance(300);
    assert.strictEqual(r.stream._txSeq, 5, 'premise: four commands answered');
    r.dev.expected = 40000; // the board lost our numbering
    const cmd = settle(r.stream.sendCommand(defs.OP_PING, Buffer.alloc(0), { timeout: 3 }));
    for (let t = 0; t < 200 && r.stream._txSeq !== 2; t++) await advance(1, 1);
    assert.strictEqual(r.stream._txSeq, 2, 'premise: the command was renumbered to seq 1');
    r.dev.answerNothing = true;
    await advance(3500);
    assert.ok(cmd.done && cmd.error, 'the command timed out');
    assert.strictEqual(r.stream._replyWaiters.size, 0, 'no waiter left behind');
    r.close();
    console.log('  ok  a command renumbered by a session re-sync leaves no waiter behind when it times out');
}

async function testReplyForAnotherCommandNeverAnswersAWaiter() {
    // After a USB reconnect a board busy in a blocking probe/home (0.2.0 and
    // 0.2.1) or a 0.2.0 OP_MOVE sends the OLD session's reply when it ends,
    // with the old seq, before it reads the new session's frames. The stream
    // matched replies by seq only, so that reply answered whatever the new
    // session was waiting for under the same seq -- e.g. a Zero reported done
    // that never happened (contracts/firmware-0.2.1.md 2.12, FW-needs item 4).
    const staleProbeReply = () => {
        const b = Buffer.alloc(20);
        b[0] = defs.OP_PROBE; b[1] = defs.ST_OK; b[2] = defs.PROBE_RESULT_CONTACT; b[3] = 2;
        return b;
    };
    for (const earlyAck of [false, true]) {
        const r = rig({});
        await advance(300);
        r.dev.answerNothing = true; // the board is still busy: its own reply comes later
        const seq = r.stream._txSeq;
        const zero = settle(r.stream.sendCommand(defs.OP_ZERO, codec.buildZero(0x01), { timeout: 5 }));
        await advance(20, 1);
        if (earlyAck) {
            r.dev._send(FT_ACK, seq, Buffer.alloc(0), false);
            await advance(20, 1);
        }
        r.dev._send(FT_RSP, seq, staleProbeReply(), false);
        await advance(20, 1);
        assert.ok(!zero.done, `${earlyAck ? 'ACKed' : 'pending'} zero is not answered by another command's reply (${zero.error ? zero.error.message : 'resolved OK by a reply echoing op 0x13'})`);
        if (!earlyAck) assert.ok(r.stream._sent.has(seq), 'the stale reply does not settle the zero\'s frame');
        // the zero's own reply still answers it
        r.dev._send(FT_RSP, seq, Buffer.from([defs.OP_ZERO, defs.ST_ERR_STATE]), false);
        await advance(20, 1);
        assert.ok(zero.done && zero.error && zero.error.status === defs.ST_ERR_STATE,
            `the zero gets its own answer (refused): ${zero.done ? (zero.error ? zero.error.message : 'resolved OK') : 'not settled'}`);
        assert.strictEqual(r.stream._replyWaiters.size, 0, 'no waiter left behind');
        r.close();
    }
    console.log('  ok  a reply echoing a different op (an old session\'s probe) never answers the waiting command; its own reply does');
}

(async () => {
    console.log('Testing slow commands versus link-loss detection...');
    await testBlockingProbeLongerThanStallTimeout();
    await testEarlyAckedProbe();
    await testDeadLinkDuringSlowCommandStillDetected();
    await testSilentFirmwareProbe();
    await testSilenceReasonOnlyWhereTheFirmwareIsSilent();
    await testSilentDeviceStillStallsAtTheCommandsOwnBound();
    await testQueuedBehindSlowCommandGetsFreshClock();
    await testRenumberedCommandTimeoutLeavesNoWaiter();
    await testReplyForAnotherCommandNeverAnswersAWaiter();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
