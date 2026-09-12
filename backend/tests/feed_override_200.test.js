/**
 * Verification test for 200% Feed Override Support
 */
const { RSPController } = require('../services/controllers/RSPController');
const { parseFeedOverride } = require('../services/rsp/codec');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
    if (condition) {
        passed++;
        console.log(`  PASS: ${label}${detail ? ' (' + detail + ')' : ''}`);
    } else {
        failed++;
        console.error(`  FAIL: ${label}${detail ? ' (' + detail + ')' : ''}`);
    }
}

console.log('\n=== Testing 200% Feed Override in RSPController ===\n');

// Mock connection
const mockConnection = {
    isOpen: true,
    write: () => {},
    on: () => {},
    removeAllListeners: () => {},
    emitToSockets: () => {},
};

const ctrl = new RSPController();
ctrl.bind(mockConnection);
ctrl.state = { status: {} };

let lastSentPayload = null;
ctrl._fireAndForget = (opcode, payload) => {
    lastSentPayload = payload;
};

// Test 1: Set to 150%
ctrl.command('feedOverride:reset');
assert(ctrl._feedOverridePct === 100, 'Reset sets to 100%');

// Test 2: Increase past 150% up to 200%
ctrl._setFeedOverride(180);
assert(ctrl._feedOverridePct === 180, 'Allows 180% feed override');
assert(parseFeedOverride(lastSentPayload) === 180, 'RSP binary packet encodes 180.0');

// Test 3: Set to exactly 200%
ctrl._setFeedOverride(200);
assert(ctrl._feedOverridePct === 200, 'Allows 200% maximum feed override');
assert(parseFeedOverride(lastSentPayload) === 200, 'RSP binary packet encodes 200.0');

// Test 4: Clamps values above 200% down to 200%
ctrl._setFeedOverride(250);
assert(ctrl._feedOverridePct === 200, 'Clamps 250% down to 200%');
assert(parseFeedOverride(lastSentPayload) === 200, 'RSP binary packet clamped at 200.0');

// Test 5: Clamps values below 10% up to 10%
ctrl._setFeedOverride(5);
assert(ctrl._feedOverridePct === 10, 'Clamps 5% up to 10%');
assert(parseFeedOverride(lastSentPayload) === 10, 'RSP binary packet clamped at 10.0');

// Test 6: Coarse increments
ctrl.command('feedOverride:reset');
for (let i = 0; i < 10; i++) {
    ctrl.command('feedOverride:coarsePlus');
}
assert(ctrl._feedOverridePct === 200, 'Repeated coarsePlus reaches 200% exactly');

// Test 7: Fine decrements
ctrl.command('feedOverride:fineMinus');
assert(ctrl._feedOverridePct === 199, 'fineMinus decrements from 200% to 199%');

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);
