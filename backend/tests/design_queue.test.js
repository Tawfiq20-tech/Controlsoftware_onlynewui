'use strict';

/**
 * The design queue.
 *
 * Everything here is about what the queue must NOT do. It runs designs back to
 * back on a machine that cannot switch its own router, so every one of these
 * is a way a list of files could turn into a machine moving when nobody meant
 * it to:
 *
 *   - arming must load, and only load
 *   - a design starts on a tap, never on a load
 *   - alarm, hold, E-stop, an unsure position, a controller restart, or
 *     someone loading another file must all stop the tap
 *   - a stopped or failed job must end the run, not advance it
 *   - a restart must never come back armed
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { QueueService } = require('../services/queue/QueueService');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tick = () => new Promise((r) => setImmediate(r));

function makeHarness({ loadOk = true, entries = 3 } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));

    const controller = new EventEmitter();
    controller.state = { status: { activeState: 'Idle', estop: false, mpos: { x: 0, y: 0, z: 0 } } };
    controller.job = { active: false };
    controller.getResumePoint = () => ({ line: 1, positionExact: true });

    const commands = [];
    const loads = [];
    const engine = {
        controller,
        connection: { isOpen: true },
        loadedFile: null,
        async _handleFileLoad(socket, data) {
            loads.push(data.name);
            if (!loadOk) return { ok: false, reason: 'it cannot run on this machine' };
            engine.loadedFile = { name: data.name, total: 10, size: data.content.length };
            return { ok: true };
        },
        _handleCommand(socket, port, cmd, ...args) {
            commands.push({ cmd, args });
            if (engine.onCommand) engine.onCommand(cmd);
        },
    };

    const library = {
        bodies: new Map(),
        metas: new Map(),
        get(id) { return this.metas.get(id) || null; },
        getBody(id) {
            if (!this.bodies.has(id)) throw new Error(`Library entry ${id} not found`);
            return this.bodies.get(id);
        },
    };
    for (let i = 1; i <= entries; i++) {
        const id = `lib-${i}`;
        library.metas.set(id, { id, name: `design-${i}.nc`, fileName: `design-${i}.nc`, size: 100 });
        library.bodies.set(id, `G21\nG0 X${i}\nG1 Z-1 F300\n`);
    }

    const emitted = [];
    const io = { emit: (ev, payload) => emitted.push({ ev, payload }) };

    const q = new QueueService({
        dataDir, io, logger: { info() {}, warn() {}, error() {} },
        libraryService: library,
        getController: () => controller,
        getEngine: () => engine,
    });

    return { q, engine, controller, library, commands, loads, emitted, dataDir };
}

const started = (h) => h.commands.filter((c) => c.cmd === 'gcode:startFresh');

/** Arm with every entry queued, and wait for the first load. */
async function armed(h, count = 3) {
    for (let i = 1; i <= count; i++) assert.ok(h.q.add(`lib-${i}`).ok, `add lib-${i}`);
    await h.q.setArmed(true);
    return h.q;
}

// ── Arming loads. It does not start. ────────────────────────────────

test('arming loads the first design and stops at the gate', async () => {
    const h = makeHarness();
    await armed(h);
    assert.deepStrictEqual(h.loads, ['design-1.nc'], 'the first design must be on the controller');
    assert.strictEqual(started(h).length, 0, 'ARMING MUST NOT START A JOB');
    assert.strictEqual(h.q.getState().state, 'gate');
    assert.strictEqual(h.q.getState().position, 1);
});

test('the gate tap starts the design, and sends startFresh -- never a resume', async () => {
    const h = makeHarness();
    await armed(h);
    const r = h.q.startNext();
    assert.ok(r.ok, r.error);
    const starts = started(h);
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(h.commands.length, 1, 'nothing else may be dispatched');
    assert.strictEqual(h.q.getState().state, 'running');
});

// ── Between two designs ─────────────────────────────────────────────

test('a finished design waits for the return to origin, then loads the next and stops again', async () => {
    const h = makeHarness();
    await armed(h);
    h.q.startNext();
    h.controller.emit('sender:end', { aborted: false });
    await tick();
    assert.strictEqual(h.q.getState().state, 'returning', 'it must not load while the tool is crossing the work');
    assert.deepStrictEqual(h.loads, ['design-1.nc']);

    h.controller.emit('job:returnedToOrigin', { ok: true, mode: 'origin' });
    await tick();
    assert.deepStrictEqual(h.loads, ['design-1.nc', 'design-2.nc']);
    assert.strictEqual(started(h).length, 1, 'THE NEXT DESIGN MUST NOT START BY ITSELF');
    assert.strictEqual(h.q.getState().state, 'gate');
    assert.strictEqual(h.q.getState().position, 2);
});

test('the last design finishes the queue instead of looking for another', async () => {
    const h = makeHarness({ entries: 1 });
    await armed(h, 1);
    h.q.startNext();
    h.controller.emit('sender:end', { aborted: false });
    await tick();
    const st = h.q.getState();
    assert.strictEqual(st.state, 'done');
    assert.strictEqual(st.armed, false, 'a finished queue must disarm itself');
    assert.strictEqual(st.entries[0].status, 'done');
});

test('a stopped job holds the queue and loads nothing', async () => {
    const h = makeHarness();
    await armed(h);
    h.q.startNext();
    h.controller.emit('sender:end', { aborted: true });
    await tick();
    assert.strictEqual(h.q.getState().state, 'held');
    assert.deepStrictEqual(h.loads, ['design-1.nc'], 'the next design must NOT be loaded after a stop');
    assert.strictEqual(started(h).length, 1);
});

test('a failed job holds the queue', async () => {
    const h = makeHarness();
    await armed(h);
    h.q.startNext();
    h.controller.emit('sender:error', { reason: 'link lost' });
    await tick();
    const st = h.q.getState();
    assert.strictEqual(st.state, 'held');
    assert.strictEqual(st.entries[0].status, 'failed');
    assert.match(st.message, /link lost/);
});

test('a job the queue did not start never advances it', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 3; i++) h.q.add(`lib-${i}`);
    await h.q.setArmed(true);
    // The operator ran a file of their own, or a macro finished.
    h.controller.emit('sender:end', { aborted: false });
    h.controller.emit('sender:end', { aborted: false, macro: true });
    await tick();
    assert.deepStrictEqual(h.loads, ['design-1.nc'], 'nothing new may be loaded');
    assert.strictEqual(started(h).length, 0);
    assert.strictEqual(h.q.getState().state, 'gate');
});

// ── What must stop the tap ──────────────────────────────────────────

test('nothing starts in alarm, in hold, in E-stop, or with the position unsure', async () => {
    for (const [label, apply] of [
        ['alarm', (h) => { h.controller.state.status.activeState = 'Alarm'; }],
        ['hold', (h) => { h.controller.state.status.activeState = 'Hold'; }],
        ['e-stop', (h) => { h.controller.state.status.estop = true; }],
        ['position unsure', (h) => { h.controller.getResumePoint = () => ({ line: 1, positionExact: false }); }],
        ['a job already running', (h) => { h.controller.job.active = true; }],
    ]) {
        const h = makeHarness();
        await armed(h);
        apply(h);
        const r = h.q.startNext();
        assert.strictEqual(r.ok, false, `${label}: the tap must be refused`);
        assert.strictEqual(started(h).length, 0, `${label}: NOTHING MAY BE DISPATCHED`);
        assert.strictEqual(h.q.getState().state, 'held', `${label}: and it must say so`);
    }
});

test('a design someone else loaded meanwhile is never started in its place', async () => {
    const h = makeHarness();
    await armed(h);
    h.engine.loadedFile = { name: 'somebody-elses-file.nc', total: 4, size: 40 };
    const r = h.q.startNext();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(started(h).length, 0);
    assert.match(h.q.getState().message, /somebody-elses-file\.nc/);
});

test('a start the controller refuses leaves the queue held, not running', async () => {
    const h = makeHarness();
    await armed(h);
    // RSPController._refuse(): the console line for the operator, plus a
    // silent 'error' so a caller that is not a person can see it.
    h.engine.onCommand = () => h.controller.emit('error', { code: 'refused', message: 'this design was stopped at line 812 earlier', silent: true });
    const r = h.q.startNext();
    assert.strictEqual(r.ok, false);
    const st = h.q.getState();
    assert.strictEqual(st.state, 'held');
    assert.strictEqual(st.entries[0].status, 'pending', 'a design that did not start is not "running"');
    assert.strictEqual(st.activeId, null);
    assert.match(st.message, /line 812/);
});

test('a controller restart while the queue waits holds it', async () => {
    const h = makeHarness();
    await armed(h);
    h.controller.emit('controller:restarted', { reason: 'power' });
    await tick();
    assert.strictEqual(h.q.getState().state, 'held');
    const r = h.q.startNext();
    assert.strictEqual(r.ok, false, 'and the tap does nothing until it is armed again');
    assert.strictEqual(started(h).length, 0);
});

test('a design running when the machine reconnects is not left "running" for ever', async () => {
    const h = makeHarness();
    await armed(h);
    h.q.startNext();
    assert.strictEqual(h.q.getState().state, 'running');

    // The USB dropped and came back: CNCEngine builds a NEW controller object,
    // and the old one will never emit sender:end.
    const { EventEmitter: EE } = require('events');
    const fresh = new EE();
    fresh.state = { status: { activeState: 'Idle', estop: false } };
    fresh.job = { active: false };
    fresh.getResumePoint = () => ({ line: 1, positionExact: true });
    h.engine.controller = fresh;
    h.q.getController = () => fresh;
    h.q.noteControllerChanged();

    const st = h.q.getState();
    assert.strictEqual(st.state, 'held');
    assert.strictEqual(st.activeId, null);
    assert.strictEqual(st.entries[0].status, 'failed');
    // And the queue is listening to the new controller, not the dead one.
    fresh.emit('sender:end', { aborted: false });
    await tick();
    assert.strictEqual(started(h).length, 1, 'a stray end from the new controller must not advance a held queue');
    assert.strictEqual(h.q.getState().state, 'held');
});

test('a design the machine will not load holds the queue instead of skipping on', async () => {
    const h = makeHarness({ loadOk: false });
    await armed(h);
    const st = h.q.getState();
    assert.strictEqual(st.state, 'held');
    assert.strictEqual(st.entries[0].status, 'failed');
    assert.match(st.entries[0].error, /cannot run/);
    assert.strictEqual(started(h).length, 0);
});

test('a design deleted from the library after it was queued holds the queue', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 2; i++) h.q.add(`lib-${i}`);
    h.library.bodies.delete('lib-1');
    await h.q.setArmed(true);
    assert.strictEqual(h.q.getState().state, 'held');
    assert.match(h.q.getState().message, /no longer in the library/);
});

test('arming again after a load failure runs that design, not the one after it', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 2; i++) h.q.add(`lib-${i}`);
    h.library.bodies.delete('lib-1');           // someone deleted it from the library
    await h.q.setArmed(true);
    assert.strictEqual(h.q.getState().state, 'held');

    h.library.bodies.set('lib-1', ['G21', 'G0 X1', ''].join('\n'));   // ...and put it back
    await h.q.setArmed(true);
    assert.deepStrictEqual(h.loads, ['design-1.nc'], 'the design that failed must be the one loaded');
    assert.strictEqual(h.q.getState().state, 'gate');
    assert.strictEqual(h.q.getState().position, 1);
});

test('arming again after a design was STOPPED mid-cut does not re-run it', async () => {
    const h = makeHarness();
    await armed(h);
    h.q.startNext();
    h.controller.emit('sender:end', { aborted: true });
    await tick();

    await h.q.setArmed(true);
    // Half of design 1 is cut into that piece: running it from line 1 again is
    // the operator's call, so the queue moves on and says nothing happened to it.
    assert.deepStrictEqual(h.loads, ['design-1.nc', 'design-2.nc']);
    assert.strictEqual(h.q.getState().entries[0].status, 'failed');
    assert.strictEqual(h.q.getState().position, 2);
});

// ── Auto mode ───────────────────────────────────────────────────────

test('auto mode is refused until the caller acknowledges the router is not switched', async () => {
    const h = makeHarness();
    const refused = h.q.setMode('auto');
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.error, 'router_not_controlled');
    assert.strictEqual(h.q.getState().mode, 'gate');

    const ok = h.q.setMode('auto', { routerStaysRunningAcknowledged: true });
    assert.ok(ok.ok);
    assert.strictEqual(h.q.getState().mode, 'auto');
});

test('auto mode counts down first, and Hold stops it', async () => {
    const h = makeHarness();
    h.q.setMode('auto', { routerStaysRunningAcknowledged: true });
    h.q.setAutoDelay(5);
    await armed(h);
    const st = h.q.getState();
    assert.strictEqual(st.state, 'countdown', 'auto must still give someone time to stop it');
    assert.ok(st.countdownEndsAt > Date.now(), 'and say when it will go');
    assert.strictEqual(started(h).length, 0, 'not before the countdown ends');

    assert.ok(h.q.hold().ok);
    assert.strictEqual(h.q.getState().state, 'gate');
    assert.strictEqual(started(h).length, 0, 'Hold must leave the machine alone');
});

test('the countdown runs the same checks as the tap', async () => {
    const h = makeHarness();
    h.q.setMode('auto', { routerStaysRunningAcknowledged: true });
    h.q.setAutoDelay(5);
    await armed(h);
    // The machine alarms while the countdown is running.
    h.controller.state.status.activeState = 'Alarm';
    h.q.startNext();   // what the countdown timer calls
    assert.strictEqual(started(h).length, 0);
    assert.strictEqual(h.q.getState().state, 'held');
});

// ── The list ────────────────────────────────────────────────────────

test('a remote upload nobody has reviewed cannot be queued', async () => {
    const h = makeHarness();
    h.library.metas.set('lib-x', {
        id: 'lib-x', name: 'from-the-phone.nc', fileName: 'from-the-phone.nc', size: 10,
        provenance: { origin: 'cloud', reviewed: false },
    });
    const r = h.q.add('lib-x');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'review_required');

    h.library.metas.get('lib-x').provenance.reviewed = true;
    assert.ok(h.q.add('lib-x').ok, 'and it can once the operator has reviewed it');
});

test('the running design cannot be removed, reordered or emptied out from under the machine', async () => {
    const h = makeHarness();
    await armed(h);
    h.q.startNext();
    const id = h.q.getState().activeId;
    assert.strictEqual(h.q.remove(id).ok, false);
    assert.strictEqual(h.q.move(id, 1).ok, false);
    assert.strictEqual(h.q.clear().ok, false);
    assert.strictEqual(h.q.getState().entries.length, 3);
});

test('skip gives up on the gated design and loads the one after it', async () => {
    const h = makeHarness();
    await armed(h);
    await h.q.skip();
    assert.deepStrictEqual(h.loads, ['design-1.nc', 'design-2.nc']);
    assert.strictEqual(h.q.getState().entries[0].status, 'skipped');
    assert.strictEqual(started(h).length, 0, 'skipping is not starting');
});

test('disarming stops the queue advancing any further', async () => {
    const h = makeHarness();
    await armed(h);
    await h.q.setArmed(false);
    h.q.startNext();
    assert.strictEqual(started(h).length, 0, 'a disarmed queue has nothing at the gate');
});

// ── Across a restart ────────────────────────────────────────────────

test('the queue comes back from a restart with its list, and disarmed', async () => {
    const h = makeHarness();
    await armed(h);
    h.q.startNext();
    h.q.stop();

    // A power cut: the file on disk still says a design was running.
    const raw = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'queue.json'), 'utf-8'));
    assert.strictEqual(raw.entries[0].status, 'running');

    const again = new QueueService({
        dataDir: h.dataDir, io: { emit() {} }, logger: { info() {}, warn() {} },
        libraryService: h.library,
        getController: () => h.controller,
        getEngine: () => h.engine,
    });
    const st = again.getState();
    assert.strictEqual(st.armed, false, 'A MACHINE MUST NEVER COME BACK ARMED');
    assert.strictEqual(st.state, 'idle');
    assert.strictEqual(st.entries.length, 3, 'but the list is kept');
    assert.strictEqual(st.entries[0].status, 'failed', 'the design it was cutting did not finish');
    assert.match(st.entries[0].error, /lost power|restarted/);
    assert.strictEqual(again.startNext().ok, false, 'and nothing can be started until someone arms it');
    again.stop();
});

test('a damaged queue file is not a reason to refuse to boot', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-bad-'));
    fs.writeFileSync(path.join(dataDir, 'queue.json'), '{"version":1,"entries":[{"id"', 'utf-8');
    const q = new QueueService({ dataDir, io: { emit() {} }, logger: { info() {}, warn() {} } });
    assert.strictEqual(q.getState().entries.length, 0);
    assert.strictEqual(q.getState().armed, false);
    q.stop();
});

async function main() {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ok  ${t.name}`);
        } catch (err) {
            failed += 1;
            console.log(`  FAIL  ${t.name}`);
            console.log(err && err.stack ? err.stack : err);
        }
    }
    if (failed) {
        console.error(`\n${failed} of ${tests.length} failed`);
        process.exit(1);
    }
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
}

main();
