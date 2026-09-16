'use strict';

/**
 * Start must never run the previous program while a new file is still loading.
 *
 * File loads are prepared on a worker thread (lib/prepareProgram.js), so a
 * load can still be in progress when Start arrives: the Play button sends
 * file:load and Start 250 ms apart (JobControlBar.tsx), the Space shortcut
 * back to back (useKeyboardShortcuts.ts). With a synchronous load the Start
 * was always handled after the load; CNCEngine now holds job starts until
 * every load in progress is applied, and a Stop in between cancels them.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.NO_BROWSER = '1';

const assert = require('assert');
const { EventEmitter } = require('events');
const { CNCEngine } = require('../services/CNCEngine');

function rig() {
    const io = Object.assign(new EventEmitter(), { emit() {} });
    const engine = new CNCEngine(io);
    const socket = Object.assign(new EventEmitter(), { id: 'test', emitted: [], emit(ev, d) { this.emitted.push([ev, d]); } });
    io.listeners('connection').forEach((fn) => fn(socket));

    const log = [];
    let release = null;
    engine.controller = {
        job: { active: false },
        _loadedLines: [],
        lastLoadResult: null,
        loadGcode(name) {
            log.push(`load-begin ${name}`);
            return new Promise((resolve) => {
                release = () => {
                    log.push(`load-applied ${name}`);
                    this._loadedLines = ['G21 G90 G0 X1.000 Y1.000 Z1.000 F3000'];
                    this.lastLoadResult = { ok: true, name, meta: { errorCount: 0 } };
                    resolve(this.lastLoadResult);
                };
            });
        },
        command(cmd) { log.push(`command ${cmd}`); },
    };
    const send = (ev, ...args) => socket.listeners(ev).forEach((fn) => fn(...args));
    return { engine, socket, log, send, release: () => release() };
}

const tick = () => new Promise((r) => setImmediate(r));

async function testStartWaitsForLoad() {
    const r = rig();
    r.send('file:load', { name: 'new.nc', content: 'G21\nG0 X1 Y1\nM2' });
    r.send('command', 'COM3', 'gcode:start');
    await tick();
    assert.deepStrictEqual(r.log, ['load-begin new.nc'], 'Start is held while the file is still loading');
    r.release();
    for (let i = 0; i < 5; i++) await tick();
    assert.deepStrictEqual(r.log, ['load-begin new.nc', 'load-applied new.nc', 'command gcode:start'], 'Start runs after the new file is applied');
    console.log('  ok  Start sent right after a file load waits until the new file is applied');
}

async function testStopCancelsWaitingStart() {
    const r = rig();
    r.send('file:load', { name: 'new.nc', content: 'G21\nG0 X1 Y1\nM2' });
    r.send('command', 'COM3', 'gcode:start');
    r.send('command', 'COM3', 'gcode:stop');
    await tick();
    r.release();
    for (let i = 0; i < 5; i++) await tick();
    assert.ok(r.log.includes('command gcode:stop'), 'Stop goes through at once');
    assert.ok(!r.log.includes('command gcode:start'), `Start pressed before Stop never runs: ${JSON.stringify(r.log)}`);
    console.log('  ok  a Stop while the file is loading cancels the waiting Start');
}

async function testNoLoadNoDelay() {
    const r = rig();
    r.send('command', 'COM3', 'gcode:start');
    r.send('command', 'COM3', 'gcode:pause');
    assert.deepStrictEqual(r.log, ['command gcode:start', 'command gcode:pause'], 'commands pass straight through when nothing is loading');
    console.log('  ok  with no load in progress commands are dispatched immediately, in order');
}

(async () => {
    console.log('Testing Start vs a file load in progress...');
    await testStartWaitsForLoad();
    await testStopCancelsWaitingStart();
    await testNoLoadNoDelay();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
