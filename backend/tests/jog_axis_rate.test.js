'use strict';

/**
 * RSP jog speed is held to the machine's per-axis maximum rate.
 *
 * 2026-09-16 session: Z jogs went to the firmware at 9000 mm/min while every
 * program move is clamped to Z 3000 (machine.maxRate, lib/wireCompiler.js).
 * The jog only had the absolute 10000 mm/min cap.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.NO_BROWSER = '1';

const assert = require('assert');
const { EventEmitter } = require('events');
const defs = require('../services/rsp/defs');
const codec = require('../services/rsp/codec');
const { RSPController } = require('../services/controllers/RSPController');
const { CNCEngine } = require('../services/CNCEngine');
const { FIRMWARE_RSP } = require('../services/Connection');

const dummyConnection = () => ({ isOpen: true, write: () => {}, on: () => {}, removeListener: () => {}, removeAllListeners: () => {}, emitToSockets: () => {}, writeRaw: () => {} });

function newController() {
    const ctrl = new RSPController();
    ctrl.on('console', () => {});
    ctrl.on('error', () => {});
    ctrl.bind(dummyConnection());
    const sent = [];
    ctrl._fireAndForget = (op, payload) => { sent.push({ op, payload }); };
    const jog = (p) => {
        sent.length = 0;
        ctrl.command('jog', p);
        return sent.map((s) => (s.op === defs.OP_JOG
            ? { op: 'jog', axis: s.payload[0], feed: Math.round(s.payload.readFloatLE(6)) }
            : { op: 'move', feed: Math.round(codec.parseMove(s.payload).feed) }));
    };
    return { ctrl, jog };
}

function testDefaultsMatchTheCompiler() {
    const { ctrl, jog } = newController();
    assert.deepStrictEqual(jog({ z: 5, feedRate: 9000 }), [{ op: 'jog', axis: 2, feed: 3000 }], 'Z jog at 9000 is sent at the Z max 3000');
    assert.deepStrictEqual(jog({ x: -5, feedRate: 9000 }), [{ op: 'jog', axis: 0, feed: 5000 }], 'X jog capped at the X max 5000');
    assert.deepStrictEqual(jog({ y: 5, feedRate: 1200 }), [{ op: 'jog', axis: 1, feed: 1200 }], 'a jog under the limit is unchanged');
    assert.deepStrictEqual(jog({ z: 1 }), [{ op: 'jog', axis: 2, feed: 500 }], 'no feed given: 500 as before');
    assert.deepStrictEqual(jog({ x: 5, z: 5, feedRate: 9000 }), [{ op: 'move', feed: 3000 }], 'diagonal X+Z: the slowest jogged axis (Z)');
    assert.deepStrictEqual(jog({ x: 5, y: 5, feedRate: 9000 }), [{ op: 'move', feed: 5000 }], 'diagonal X+Y: 5000');
    ctrl.unbind();
    console.log('  ok  without a config the jog uses the compiler defaults (X/Y 5000, Z 3000)');
}

function testConfiguredRatesAndAbsoluteCap() {
    const { ctrl, jog } = newController();
    let maxRate = { x: 4000, y: 4000, z: 1200 };
    ctrl.setMachineLimitsProvider(() => ({ maxRate }));
    assert.strictEqual(jog({ z: -2, feedRate: 9000 })[0].feed, 1200, 'machine.maxRate.z from the config');
    assert.strictEqual(jog({ y: 2, feedRate: 9000 })[0].feed, 4000);
    maxRate = { z: 2000 }; // partial setting: other axes keep the compiler defaults
    assert.strictEqual(jog({ z: 2, feedRate: 9000 })[0].feed, 2000, 'a changed setting applies to the next jog');
    assert.strictEqual(jog({ x: 2, feedRate: 9000 })[0].feed, 5000);
    maxRate = { x: 50000, y: 50000, z: 50000 };
    assert.strictEqual(jog({ x: 2, feedRate: 20000 })[0].feed, 10000, 'the absolute 10000 mm/min cap stays');
    ctrl.setMachineLimitsProvider(() => { throw new Error('config unreadable'); });
    assert.strictEqual(jog({ z: 2, feedRate: 9000 })[0].feed, 3000, 'a failing provider falls back to the defaults');
    ctrl.setMachineLimitsProvider(null);
    ctrl._lastCompileOptions = { maxRate: { x: 5000, y: 5000, z: 900 } };
    assert.strictEqual(jog({ z: 2, feedRate: 9000 })[0].feed, 900, 'no provider: the loaded file\'s compile options');
    ctrl.unbind();
    console.log('  ok  configured per-axis rates cap the jog, the 10000 mm/min cap stays');
}

function testEngineHandsTheConfigToTheController() {
    const io = Object.assign(new EventEmitter(), { emit() { return true; } });
    const engine = new CNCEngine(io);
    engine._restartMonitor = { onStatus: () => null, onBind() {}, onConnectionLost() {} };
    engine.config = { get: (k, d) => (k === 'machine.maxRate' ? { x: 3500, y: 3500, z: 1500 } : d), set() {} };
    engine.connection = dummyConnection();
    engine._onFirmwareDetected(FIRMWARE_RSP, []);
    const ctrl = engine.controller;
    assert.ok(ctrl instanceof RSPController);
    const sent = [];
    ctrl._fireAndForget = (op, payload) => { sent.push({ op, payload }); };
    ctrl.command('jog', { z: 3, feedRate: 9000 });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(Math.round(sent[0].payload.readFloatLE(6)), 1500, 'jog capped by machine.maxRate from the engine config');
    ctrl.unbind();
    console.log('  ok  CNCEngine gives the RSP controller machine.maxRate for jogs');
}

(async () => {
    console.log('Testing jog per-axis rate cap...');
    testDefaultsMatchTheCompiler();
    testConfiguredRatesAndAbsoluteCap();
    testEngineHandsTheConfigToTheController();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
