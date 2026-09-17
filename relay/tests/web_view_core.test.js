'use strict';

// Phone app view decisions (relay/web/js/core/view.js, store.js, api.js,
// protocol.js, app.css): start-job loadSeq, camera frame cursor, activity
// paging cursor, tier countdown replay, remote resume, error texts, toast
// contrast, and the tier chip live region.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB_DIR = process.env.RELAY_WEB_DIR || path.join(__dirname, '..', 'web');
const load = (rel) => import(pathToFileURL(path.join(WEB_DIR, 'js', rel)).href);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('job.start expect uses the top-level loadSeq when no file is loaded', async () => {
    const view = await load('core/view.js');
    const st = { file: null, loadSeq: 2, wcsSeq: 5 };
    const choice = { name: 'part.nc', size: 123, libraryId: 'lib1' };
    assert.deepStrictEqual(view.buildStartExpect(st, choice, undefined), { name: 'part.nc', size: 123, loadSeq: 2, wcsSeq: 5 });
    assert.strictEqual(view.buildStartExpect(st, choice, 7).loadSeq, 2, 'published value beats the remembered one');
    assert.strictEqual(view.currentLoadSeq({ file: { loadSeq: 4 } }, 1), 4, 'older machines: file.loadSeq');
    assert.strictEqual(view.currentLoadSeq({ file: null }, 3), 3);
    assert.strictEqual(view.currentLoadSeq({ file: null }, null), 0);
    assert.strictEqual(view.buildStartExpect(null, choice, 0), null);
});

test('store remembers loadSeq from the top level of report.state', async () => {
    const { createDeviceStore } = await load('store.js');
    let t = 1000;
    const store = createDeviceStore({ now: () => t });
    store.apply({ t: 'report.state', topic: 'device/d1/report', body: { seq: 1, at: 5, file: null, loadSeq: 2, wcsSeq: 0 } });
    assert.strictEqual(store.get('d1').lastLoadSeq, 2);
});

test('camera cursor recovers at once after the machine restarts its frame seq', async () => {
    const view = await load('core/view.js');
    let t = 0;
    const cursor = view.createFrameCursor({ now: () => t, resetAfterMs: 5000 });
    // Relay rule (relay/server/http/routes/camera.js): serve only if seq > after.
    const served = (frame) => { const a = cursor.after(); return a === null || frame.seq > a; };
    for (let seq = 1; seq <= 300; seq++) {
        t += 1000;
        assert.ok(served({ seq }));
        assert.strictEqual(cursor.onFrame(seq, 1e12 + seq * 1000), true);
    }
    assert.strictEqual(cursor.after(), 300);
    t += 15000; // card out of view: the lease expires and the machine restarts at seq 1
    t += 1000;
    assert.strictEqual(cursor.after(), null, 'after is dropped once frames stopped arriving');
    assert.ok(served({ seq: 1 }), 'restarted seq 1 is served on the first poll');
    assert.strictEqual(cursor.onFrame(1, 1e12 + 400000), true);
    t += 1000;
    assert.strictEqual(cursor.after(), 1);
    assert.ok(served({ seq: 2 }));
    // A repeat of the same frame (served while after was dropped) is not new.
    assert.strictEqual(cursor.onFrame(1, 1e12 + 400000), false);
    cursor.reset();
    assert.strictEqual(cursor.after(), null);
});

test('activity paging uses the (ts, id) cursor and never skips same-millisecond rows', async () => {
    const view = await load('core/view.js');
    const api = await load('api.js');
    const rows = [];
    let id = 0;
    for (let i = 0; i < 10; i++) rows.push({ id: ++id, ts: 1000 + i });
    for (let i = 0; i < 120; i++) rows.push({ id: ++id, ts: 5000 });
    for (let i = 0; i < 30; i++) rows.push({ id: ++id, ts: 9000 + i });
    const sorted = rows.slice().sort((a, b) => b.ts - a.ts || b.id - a.id);
    // Server rule (relay/server/audit.js list()).
    const list = (cursor, limit) => sorted.filter((r) => !cursor
        || (cursor.beforeId !== undefined ? (r.ts < cursor.before || (r.ts === cursor.before && r.id < cursor.beforeId)) : r.ts < cursor.before)).slice(0, limit);
    const seen = [];
    let cursor = null;
    for (let guard = 0; guard < 20; guard++) {
        const page = list(cursor, 50);
        seen.push(...page.map((r) => r.id));
        const next = view.auditCursor(page);
        if (page.length < 50 || !next) break;
        cursor = next;
    }
    assert.strictEqual(seen.length, rows.length);
    assert.strictEqual(new Set(seen).size, rows.length);
    assert.strictEqual(api.auditCursorQuery(5000, 77), '&before=5000&beforeId=77');
    assert.strictEqual(api.auditCursorQuery(5000, null), '&before=5000');
    assert.strictEqual(api.auditCursorQuery(null, 77), '');
    const src = fs.readFileSync(path.join(WEB_DIR, 'js', 'views', 'audit.js'), 'utf8');
    assert.ok(/beforeId/.test(src) && !/oldest\s*\+\s*1/.test(src), 'audit view pages with beforeId');
});

test('a replayed or already-old report.tier does not overstate the Motion countdown', async () => {
    const { createDeviceStore } = await load('store.js');
    const view = await load('core/view.js');
    let t = 100000;
    const store = createDeviceStore({ now: () => t });
    const machineWall = 1_700_000_000_000;
    store.apply({ t: 'report.state', topic: 'device/d1/report', body: { seq: 1, at: machineWall } });
    const tierEnv = { t: 'report.tier', id: 'm_tier1', topic: 'device/d1/report', body: { tier: 'motion', motionRemainingMs: 60000, serverNow: machineWall } };
    store.apply(tierEnv);
    assert.strictEqual(store.get('d1').tierAt, 100000);
    t += 25000;
    store.apply({ t: 'report.state', topic: 'device/d1/report', body: { seq: 2, at: machineWall + 25000 } });
    store.apply(JSON.parse(JSON.stringify(tierEnv))); // relay replay on re-subscribe
    const d = store.get('d1');
    assert.strictEqual(d.tierAt, 100000, 'replay keeps the original countdown base');
    assert.ok(Math.abs(view.motionRemainingMs(d.tier, d.tierAt, t) - 35000) < 1);

    // Fresh page: the relay replays a tier cached 25 s ago, right after a fresh state.
    let t2 = 5000;
    const fresh = createDeviceStore({ now: () => t2 });
    fresh.apply({ t: 'report.state', topic: 'device/d1/report', body: { seq: 9, at: machineWall + 25000 } });
    fresh.apply(JSON.parse(JSON.stringify(tierEnv)));
    const f = fresh.get('d1');
    assert.ok(Math.abs(view.motionRemainingMs(f.tier, f.tierAt, t2) - 35000) < 1, 'aged by the machine clock');

    // A genuinely new tier (different id/body) restarts from its own values.
    t += 1000;
    store.apply({ t: 'report.tier', id: 'm_tier2', topic: 'device/d1/report', body: { tier: 'motion', motionRemainingMs: 34000, serverNow: machineWall + 26000 } });
    assert.ok(Math.abs(view.motionRemainingMs(store.get('d1').tier, store.get('d1').tierAt, t) - 34000) < 1);
    assert.strictEqual(view.tierAgeMs({ serverNow: 10 }, null, null, 0), 0);
});

test('Resume is enabled only for pauses a cloud client may resume', async () => {
    const view = await load('core/view.js');
    const st = (pause, rawState = 'Hold:0') => ({ pause, machine: { rawState } });
    assert.strictEqual(view.resumeState(st({ origin: 'remote', channel: 'cloud' })).allowed, true);
    assert.strictEqual(view.resumeState(st({ origin: 'remote' })).allowed, true, 'machines that do not publish channel');
    assert.deepStrictEqual(view.resumeState(st({ origin: 'remote', channel: 'lan' })), { allowed: false, reason: 'lan' });
    assert.strictEqual(view.resumeState(st({ origin: 'lan' })).allowed, false);
    assert.deepStrictEqual(view.resumeState(st({ origin: 'remote', channel: 'cloud' }, 'Door:1')), { allowed: false, reason: 'door' });
    assert.strictEqual(view.resumeState(st({ origin: 'toolchange' })).allowed, false);
    assert.strictEqual(view.resumeState(st({ origin: 'local' })).allowed, false);
    assert.strictEqual(view.resumeState(st(null)).allowed, false);
    assert.ok(/LAN|network/i.test(view.resumeBlockedText('lan')));
    const src = fs.readFileSync(path.join(WEB_DIR, 'js', 'views', 'device.js'), 'utf8');
    assert.ok(!/pause\.origin === 'remote'/.test(src), 'device view uses resumeState');
});

test('every relay REST error code has human text', async () => {
    const { errorText } = await load('protocol.js');
    for (const code of [
        'registration_failed', 'invalid_email', 'invalid_password', 'invalid_display_name', 'bad_name', 'bad_role',
        'is_owner', 'pairing_capacity', 'too_large', 'empty', 'bad_sha256', 'length_required', 'timeout', 'incomplete',
        'aborted', 'bad_count', 'bad_expiry', 'cannot_disable_self', 'bad_request', 'origin', 'internal',
        'shutting_down', 'unconfirmed', 'range_not_satisfiable', 'protocol',
    ]) {
        const text = errorText(code);
        assert.ok(!/^Error: /.test(text), code + ' -> ' + text);
    }
    assert.ok(/sign in/i.test(errorText('registration_failed')));
});

function luminance(hex) {
    const n = hex.replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

test('toasts meet WCAG AA contrast in light and dark themes', () => {
    const css = fs.readFileSync(path.join(WEB_DIR, 'app.css'), 'utf8');
    const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
    assert.ok(darkStart > 0);
    const light = css.slice(0, darkStart);
    const dark = css.slice(darkStart, css.indexOf('}\n}', darkStart));
    const token = (block, name) => {
        const m = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(block);
        return m ? m[1] : null;
    };
    const rule = (cls) => {
        const m = new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}').exec(css);
        assert.ok(m, 'missing .' + cls);
        const bg = /background:\s*var\(--([a-z-]+)\)/.exec(m[1]);
        const fg = /color:\s*var\(--([a-z-]+)\)/.exec(m[1]);
        assert.ok(bg && fg, '.' + cls + ' must use theme tokens for background and text');
        return [bg[1], fg[1]];
    };
    for (const cls of ['toast-error', 'toast-ok']) {
        const [bg, fg] = rule(cls);
        for (const [theme, block] of [['light', light], ['dark', dark]]) {
            const b = token(block, bg) || token(light, bg);
            const f = token(block, fg) || token(light, fg);
            assert.ok(b && f, cls + ' tokens resolvable in ' + theme);
            const ratio = contrast(b, f);
            assert.ok(ratio >= 4.5, cls + ' ' + theme + ' contrast ' + ratio.toFixed(2));
        }
    }
});

test('tier chip is not a live region; only changes and thresholds are announced', async () => {
    const view = await load('core/view.js');
    const src = fs.readFileSync(path.join(WEB_DIR, 'js', 'views', 'device.js'), 'utf8');
    const chip = /const tierChip = h\('span', \{([^}]*)\}\)/.exec(src);
    assert.ok(chip, 'tierChip element found');
    assert.ok(!/role|aria-live/.test(chip[1]), 'tierChip must not be a live region');
    assert.strictEqual(view.tierAnnouncement({ tier: 'motion', remaining: 299000 }, { tier: 'motion', remaining: 298000 }), null);
    assert.ok(/60 seconds/.test(view.tierAnnouncement({ tier: 'motion', remaining: 60500 }, { tier: 'motion', remaining: 59500 })));
    assert.ok(/10 seconds/.test(view.tierAnnouncement({ tier: 'motion', remaining: 10200 }, { tier: 'motion', remaining: 9200 })));
    assert.strictEqual(view.tierAnnouncement({ tier: 'job', remaining: null }, { tier: 'motion', remaining: 300000 }), 'Motion enabled');
    assert.ok(/Motion ended/.test(view.tierAnnouncement({ tier: 'motion', remaining: 1000 }, { tier: 'monitor', remaining: null })));
    assert.strictEqual(view.tierAnnouncement(null, { tier: 'monitor', remaining: null }), null);
});

test('machine list is not a live region and telemetry updates cards in place', async () => {
    const view = await load('core/view.js');
    const src = fs.readFileSync(path.join(WEB_DIR, 'js', 'views', 'devices.js'), 'utf8');
    const listDecl = /const list = h\('ul', \{([^}]*)\}\)/.exec(src);
    assert.ok(listDecl, 'device list element found');
    assert.ok(!/role|aria-live/.test(listDecl[1]), 'device list must not be a live region');
    assert.ok(!/replaceChildren\(\s*\.\.\.rows\.map/.test(src), 'list is not rebuilt from rows on every paint');
    // The subscribe handler for presence/state must not call paint().
    const sub = /ctx\.devices\.subscribe\(([\s\S]*?)\n    \}\);/.exec(src);
    assert.ok(sub, 'subscribe handler found');
    const liveBranch = /kind === 'state'\)\) \{([\s\S]*?)\}/.exec(sub[1]);
    assert.ok(liveBranch && !/paint\(\)/.test(liveBranch[1]) && /refresh\(/.test(liveBranch[1]), 'presence/state refreshes in place');

    let replaced = 0;
    let built = 0;
    const container = { replaceChildren: () => { replaced += 1; } };
    const store = new Map();
    const list = view.createKeyedList({
        container,
        key: (d) => d.id,
        shape: view.deviceCardShape,
        build: (d) => { built += 1; return { node: { id: d.id }, text: null }; },
        update: (item, d) => { item.text = view.devicePresence(d, store.get(d.id), 0, { running: 'Running' }).text; },
    });
    const rows = [{ id: 'a', name: 'A', role: 'owner' }, { id: 'b', name: 'B', role: 'operator', online: true }];
    list.setRows(rows);
    assert.strictEqual(built, 2);
    assert.strictEqual(replaced, 1);
    // 5 Hz telemetry for 10 s: nodes are updated, never rebuilt or reinserted.
    for (let i = 0; i < 50; i++) {
        store.set('b', { presence: { online: true }, state: { machine: { state: i % 2 ? 'running' : 'idle' } } });
        list.refresh(rows, 'b');
        list.setRows(rows); // a repaint with the same rows is also a no-op for the DOM
    }
    assert.strictEqual(built, 2, 'no card rebuilt by telemetry');
    assert.strictEqual(replaced, 1, 'container untouched by telemetry');
    // A rename rebuilds that card only; a removal reinserts.
    list.setRows([{ ...rows[0], name: 'A2' }, rows[1]]);
    assert.strictEqual(built, 3);
    assert.strictEqual(replaced, 2);
    list.setRows([rows[1]]);
    assert.strictEqual(built, 3);
    assert.strictEqual(replaced, 3);

    const P = (dev, live) => view.devicePresence(dev, live, 100000, { running: 'Running' });
    assert.strictEqual(P({ status: 'pending_confirmation' }).dot, 'dot-warn');
    assert.strictEqual(P({ online: false }, { presence: { online: true }, state: { machine: { state: 'running' } } }).text, 'Online · Running');
    assert.strictEqual(P({ lastSeenAt: 40000 }).text, 'Offline · last seen 1 min ago');
    assert.strictEqual(P({}).text, 'Offline · never connected');
    assert.strictEqual(P({ controllerType: 'RSP' }).controller, 'RSP');
});

test('camera age line is not a live region; only availability changes are announced', async () => {
    const view = await load('core/view.js');
    const src = fs.readFileSync(path.join(WEB_DIR, 'js', 'views', 'device.js'), 'utf8');
    const age = /const age = h\('p', \{([^}]*)\}/.exec(src);
    assert.ok(age, 'camera age element found');
    assert.ok(!/role|aria-live/.test(age[1]), 'camera age line must not be a live region');
    assert.ok(/setText\(cameraLive, /.test(src), 'transitions go through cameraLive');
    // Frames at ~1 fps with jitter: the age text flips 0 s / 1 s, phase stays live.
    let prev = null;
    const said = [];
    const step = (lastFrameAt, now, code) => {
        const p = view.cameraPhase(lastFrameAt, now, 5000, code);
        const a = view.cameraAnnouncement(prev, p);
        prev = p;
        if (a) said.push(a);
    };
    step(null, 0);
    assert.deepStrictEqual(said, [], 'nothing announced on mount');
    for (let t = 1000; t <= 60000; t += 1000) step(t - (t % 3000 === 0 ? 700 : 100), t);
    assert.deepStrictEqual(said, ['Camera image available'], 'a minute of frames announces once');
    step(60000, 66000);
    step(60000, 67000);
    step(60000, 68000, 'LAN_ONLY');
    assert.deepStrictEqual(said, ['Camera image available', 'No camera image', 'No camera image (machine is LAN-only)']);
});

test('machine page retries a failed /api/devices load', async () => {
    const view = await load('core/view.js');
    assert.strictEqual(view.retryDelayMs(1), 1000);
    assert.strictEqual(view.retryDelayMs(3), 4000);
    assert.strictEqual(view.retryDelayMs(50), 30000);
    const src = fs.readFileSync(path.join(WEB_DIR, 'js', 'views', 'device.js'), 'utf8');
    assert.ok(/metaRetryTimer = setTimeout\(/.test(src), 'loadMeta schedules a retry');
    assert.ok(/ctx\.ws\.on\('open', retryMetaNow\)/.test(src), 'retry when the socket opens');
    assert.ok(/visibilitychange', onMetaVisibility/.test(src), 'retry on resume');
});

test('rsp-cannot-cancel is shown in an assertive banner', () => {
    const src = fs.readFileSync(path.join(WEB_DIR, 'js', 'views', 'device.js'), 'utf8');
    assert.ok(/cancelBanner = h\('div', \{[^}]*'aria-live': 'assertive'/.test(src));
    assert.ok(/rsp-cannot-cancel'\)\) \{\s*\/\/[^\n]*\n\s*cancelBanner\.hidden = false/.test(src));
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log('ok   ' + t.name);
        } catch (err) {
            failed += 1;
            console.log('FAIL ' + t.name + '\n     ' + (err && err.stack || err));
        }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
