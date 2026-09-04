'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const defs = require('../services/rsp/defs');
const codec = require('../services/rsp/codec');
const { ReliableStream } = require('../services/rsp/stream');
const { JobStream } = require('../services/rsp/job');
const { RSPController } = require('../services/controllers/RSPController');
const { JobResumeService } = require('../services/jobresume/JobResumeService');
const { RecoveryOrchestrator } = require('../services/jobresume/RecoveryOrchestrator');
const fs = require('fs');
const os = require('os');
const path = require('path');

class FakeConnection extends EventEmitter {
    constructor() {
        super();
        this.isOpen = true;
        this.written = [];
    }
    writeRaw(buf) {
        this.written.push(buf);
    }
    emitToSockets(ev, data) {}
}

async function runTests() {
    console.log('Testing RSP Alarm & Mid-run Stop/Resume Fixes...');

    // 1. Test RSPController alarm handling during job streaming
    const conn = new FakeConnection();
    const ctrl = new RSPController();
    ctrl.bind(conn);

    let consoleMessages = [];
    ctrl.on('console', (msg) => consoleMessages.push(msg));

    const gcode = 'G21\nG90\nG0 X10 Y10\nG1 Z-1 F200\nG1 X20 Y20\nG0 Z5';
    ctrl.command('gcode:load', 'test.nc', gcode);
    ctrl.command('gcode:start');

    assert.strictEqual(ctrl.job.active, true, 'Job should be active after start');

    // Simulate telemetry reporting state 9 (ST_ESTOP / Alarm) at line 3
    ctrl.stream.emit('status', {
        state: defs.ST_ESTOP,
        state_name: 'EStop',
        estop_active: true,
        x: 10, y: 10, z: -1,
        last_executed_line: 3,
        feed: 200,
        spindle_speed: 0,
        buffer_fill_pct: 0,
        planner_depth: 0,
        link_ok: true,
        error_code: 0,
    });

    assert.strictEqual(ctrl.job.paused, true, 'Job should be paused when alarm/estop is triggered');
    assert.strictEqual(ctrl._resumeLine, 4, 'Resume line should be captured as 4');
    assert.strictEqual(ctrl._resumeGcode, gcode, 'Resume G-code should match loaded G-code');

    // 2. Test Unlock and Resume
    ctrl.command('unlock');
    const hasUnlockMsg = consoleMessages.some(m => m.includes('Alarm cleared / unlocked'));
    const hasResumePrompt = consoleMessages.some(m => m.includes('Press START to resume from line 4'));
    assert(hasUnlockMsg, 'Should emit alarm cleared message');
    assert(hasResumePrompt, 'Should emit resume prompt on unlock');

    // 3. Test starting after unlock without "already running" error
    consoleMessages = [];
    ctrl.command('gcode:start');
    const hasAlreadyRunningError = consoleMessages.some(m => m.includes('already running'));
    assert(!hasAlreadyRunningError, 'Should NOT block gcode:start with "already running"');
    assert.strictEqual(ctrl.job.active, true, 'Job should be active again');
    assert.strictEqual(ctrl.job.nextLineToRun(), 4, 'Job should resume from line 4');

    // 4. Test JobResumeService preamble injection + slicing
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'));
    const resumeService = new JobResumeService({
        dataDir: tmpDir,
        io: new EventEmitter(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        getController: () => ctrl,
    });

    resumeService.onLoad({ filename: 'test.nc', gcodeText: gcode, modalState: { units: 'G21', spindleRpm: 12000, spindleState: 'M3' } });
    resumeService.onStart({ totalLines: 6 });

    // Save checkpoint at line 3
    resumeService.store.save({
        filename: 'test.nc',
        gcodeText: gcode,
        gcodeHash: 'testhash',
        totalLines: 6,
        lastExecutedLine: 3,
        lastConfirmedPos: { x: 10, y: 10, z: -1 },
        modalState: { units: 'G21', spindleRpm: 12000, spindleState: 'M3', feedRate: 200 },
        timestamp: Date.now(),
    });

    const resumeRes = resumeService.resumeFromCheckpoint();
    assert.strictEqual(resumeRes.ok, true, 'resumeFromCheckpoint should succeed');
    assert(ctrl._loadedGcode.includes('M3 S12000'), 'Loaded G-code must contain preamble spindle command');
    assert(ctrl._loadedGcode.includes('G1 X20 Y20'), 'Loaded G-code must contain remaining cut line');

    ctrl.unbind();
    console.log('ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
