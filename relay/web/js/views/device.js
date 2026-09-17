// Device control page (SPEC §8.2 item 4).

import { apiErrorText, cameraUrl, notifyUnauthorized } from '../api.js';
import { LOCK_TEXT, STATE_LABEL, errorText, newId } from '../protocol.js';
import { closeAllModals, confirmDialog, fmtBytes, fmtMmSs, fmtPos, h, openModal, setText, timeAgo, toast } from '../ui.js';
import { createJogpad } from './jogpad.js';
import {
    buildStartExpect, cameraAnnouncement, cameraPhase, createFrameCursor, motionRemainingMs, resumeBlockedText, resumeState, retryDelayMs, tierAnnouncement,
} from '../core/view.js';

const MOTION_WARN_MS = 60000;
const NO_FRAME_MS = 5000;
// How long the 'use the machine E-stop' banner stays after rsp-cannot-cancel.
const CANNOT_CANCEL_BANNER_MS = 20000;
// After a FILE_CHANGED, how long to wait for telemetry that might explain it.
const FILE_CHANGED_WAIT_MS = 2000;

const STATE_CLASS = {
    idle: 'ok', running: 'run', jogging: 'run', homing: 'run', paused: 'warn',
    stopping: 'warn', alarm: 'bad', disconnected: 'idle', boot: 'idle',
};

const FEED_ACTIONS = [
    { action: 'coarseMinus', label: '−10', aria: 'Feed override minus 10 percent' },
    { action: 'fineMinus', label: '−1', aria: 'Feed override minus 1 percent' },
    { action: 'reset', label: '100%', aria: 'Reset feed override to 100 percent' },
    { action: 'finePlus', label: '+1', aria: 'Feed override plus 1 percent' },
    { action: 'coarsePlus', label: '+10', aria: 'Feed override plus 10 percent' },
];

export function render(root, ctx, deviceId) {
    const me = ctx.me();
    let meta = null;              // row from GET /api/devices
    let destroyed = false;
    let paintQueued = false;
    let jogpad = null;
    let jogpadKey = null;
    let storedFiles = [];
    let camera = null;

    // ---- static skeleton -------------------------------------------------
    const title = h('h1', { class: 'device-title' }, 'Machine');
    const presenceText = h('span');
    const presenceDot = h('span', { class: 'dot dot-idle', 'aria-hidden': 'true' });
    const rttText = h('span', { class: 'muted small' });
    // Not a live region: it is rewritten every second. Tier changes and the
    // 60 s / 10 s thresholds are announced through tierLive instead.
    const tierChip = h('span', { class: 'chip' });
    const tierLive = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    let lastTierAnnounce = null;

    const header = h('header', { class: 'device-head' },
        h('a', { href: '#/devices', class: 'back', 'aria-label': 'Back to machines' }, '‹ Machines'),
        title,
        h('div', { class: 'device-meta' },
            h('span', { class: 'presence' }, presenceDot, presenceText),
            rttText,
            tierChip,
            tierLive));

    const connBanner = h('div', { class: 'banner banner-warn', role: 'alert', hidden: true });
    const lockBanner = h('div', { class: 'banner banner-bad', role: 'alert', 'aria-live': 'assertive', hidden: true });
    const stopBanner = h('div', { class: 'banner banner-bad', role: 'alert', 'aria-live': 'assertive', hidden: true },
        'Stop not confirmed — use the E-stop');
    const cancelBanner = h('div', { class: 'banner banner-bad', role: 'alert', 'aria-live': 'assertive', hidden: true },
        'The machine cannot cancel this motion remotely — use the machine E-stop');
    let cancelBannerTimer = null;

    const stateWord = h('div', { class: 'state-word' }, '—');
    const alarmText = h('p', { class: 'alarm-text', role: 'alert', 'aria-live': 'assertive' });
    const staleText = h('p', { class: 'muted small' });
    const activeJogText = h('p', { class: 'small' });
    const stateCard = h('section', { class: 'card', 'aria-label': 'Machine state' }, stateWord, alarmText, activeJogText, staleText);

    const dro = {};
    const droRows = ['x', 'y', 'z'].map((axis) => {
        dro[axis] = h('span', { class: 'dro-value' }, fmtPos(NaN));
        dro[axis + 'm'] = h('span', { class: 'dro-machine muted' });
        return h('div', { class: 'dro-row' },
            h('span', { class: 'dro-axis' }, axis.toUpperCase()),
            dro[axis],
            dro[axis + 'm']);
    });
    const feedText = h('span');
    const spindleText = h('span');
    const droCard = h('section', { class: 'card', 'aria-label': 'Position' },
        h('div', { class: 'row-between small muted' }, h('span', null, 'Work position (mm)'), h('span', null, 'Machine')),
        droRows,
        h('div', { class: 'row-between small' }, feedText, spindleText));

    const jobName = h('div', { class: 'job-name' });
    const progressFill = h('div', { class: 'progress-fill' });
    const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Job progress' }, progressFill);
    const jobLines = h('div', { class: 'small' });
    const jobNote = h('p', { class: 'small warn-text' });
    const jobCard = h('section', { class: 'card', 'aria-label': 'Job' }, h('h2', null, 'Job'), jobName, progress, jobLines, jobNote);

    const feedValue = h('span', { class: 'feed-value' });
    const feedNote = h('p', { class: 'small muted' });
    const feedButtons = FEED_ACTIONS.map((f) => h('button', {
        type: 'button', class: 'btn', 'aria-label': f.aria,
        on: { click: (e) => runCmd(e.currentTarget, 'feed.override', { action: f.action }) },
    }, f.label));
    const feedCard = h('section', { class: 'card', 'aria-label': 'Feed override', hidden: true },
        h('div', { class: 'row-between' }, h('h2', null, 'Feed override'), feedValue),
        h('div', { class: 'btn-row' }, feedButtons),
        feedNote);

    const motionNote = h('p', { class: 'muted' });
    const motionBody = h('div');
    const motionCard = h('section', { class: 'card', 'aria-label': 'Motion' }, h('h2', null, 'Motion'), motionNote, motionBody);

    const cameraCard = h('section', { class: 'card', 'aria-label': 'Camera', hidden: true });

    const links = h('nav', { class: 'link-row', 'aria-label': 'Machine pages' });

    // Sticky action bar.
    const stopBtn = h('button', { type: 'button', class: 'btn-stop', 'aria-label': 'Stop machine' }, 'STOP');
    const pauseBtn = h('button', { type: 'button', class: 'btn btn-action' }, 'Pause');
    const spindleOffBtn = h('button', { type: 'button', class: 'btn btn-action', 'aria-label': 'Spindle off', hidden: true }, 'Spindle off');
    const actionNote = h('p', { class: 'action-note', role: 'status', 'aria-live': 'polite' });
    const actionBar = h('div', { class: 'action-bar' },
        h('div', { class: 'action-row' }, stopBtn, h('div', { class: 'action-side' }, pauseBtn, spindleOffBtn)),
        actionNote);

    root.append(h('section', { class: 'device-page' },
        header, connBanner, lockBanner, stopBanner, cancelBanner,
        stateCard, droCard, jobCard, feedCard, motionCard, cameraCard, links),
    actionBar);
    document.body.classList.add('has-action-bar');

    // Dialogs end where the bar starts, and the bar grows when Spindle off shows
    // or the STOP label wraps; track its real height.
    let barObserver = null;
    if (typeof ResizeObserver === 'function') {
        barObserver = new ResizeObserver(() => {
            document.documentElement.style.setProperty('--action-bar-total', Math.ceil(actionBar.getBoundingClientRect().height) + 'px');
        });
        barObserver.observe(actionBar);
    }

    // ---- derived state ---------------------------------------------------
    function snapshot() {
        const d = ctx.devices.get(deviceId) || {};
        const conn = ctx.ws.getStatus();
        const presence = d.presence || null;
        const online = !!(presence && presence.online && !presence.stale);
        const st = d.state || null;
        const tier = d.tier || null;
        const locks = tier && Array.isArray(tier.locks) ? tier.locks : [];
        const role = meta ? meta.role : null;
        const canControl = role === 'owner' || role === 'operator';
        const scopeUser = tier && tier.scope && tier.scope.motion ? tier.scope.motion.userId || null : null;
        const motionElsewhere = !!(tier && tier.tier === 'motion' && scopeUser && me && scopeUser !== me.id);
        let myTier = 'monitor';
        if (tier) {
            if (tier.tier === 'motion' && !motionElsewhere) myTier = 'motion';
            else if (tier.tier === 'job' || tier.jobControlEnabled) myTier = 'job';
        }
        if (!canControl) myTier = 'monitor';
        return {
            d, conn, presence, online, st, tier, locks, role, canControl, motionElsewhere, myTier,
            caps: (tier && tier.capabilities) || {},
            limits: (tier && tier.limits) || {},
            live: conn.live,
            synced: conn.synced,
            stopReady: conn.live && online,
            cmdReady: conn.live && conn.synced && online,
        };
    }

    // ---- commands --------------------------------------------------------
    async function runCmd(button, type, args, { idem, quiet } = {}) {
        if (button) {
            if (button.dataset.busy === '1') return null;
            button.dataset.busy = '1';
            button.setAttribute('aria-busy', 'true');
        }
        try {
            const ack = await ctx.ws.sendCmd(deviceId, type, args, { idem });
            if (ack.status !== 'accepted') {
                toast(errorText(ack.code, ack.message), 'error');
            } else if (!quiet) {
                announce(ack);
            }
            return ack;
        } catch (err) {
            toast(errorText(err.code, err.message), 'error');
            return null;
        } finally {
            if (button) {
                delete button.dataset.busy;
                button.removeAttribute('aria-busy');
            }
        }
    }

    function announce(ack) {
        const msg = ack.message;
        if (ack.type === 'job.stop') {
            if (msg && msg.startsWith('rsp-cannot-cancel')) {
                // Safety-critical: shown in an assertive banner, not only a toast.
                cancelBanner.hidden = false;
                if (cancelBannerTimer !== null) clearTimeout(cancelBannerTimer);
                cancelBannerTimer = setTimeout(() => { cancelBannerTimer = null; cancelBanner.hidden = true; }, CANNOT_CANCEL_BANNER_MS);
                toast('The machine cannot cancel this motion remotely — use the machine E-stop', 'error', 8000);
            }
            else if (msg === 'nothing-to-stop') setText(actionNote, 'Stop sent: nothing was moving');
            else setText(actionNote, 'Stop sent');
            return;
        }
        setText(actionNote, 'Sent: ' + ack.type);
    }

    stopBtn.addEventListener('click', () => {
        // Every press is a new user action; STOP is never de-duplicated.
        runCmd(null, 'job.stop', {}, { idem: newId('c_') });
    });

    pauseBtn.addEventListener('click', () => {
        const s = snapshot();
        const job = s.st && s.st.job;
        if (job && job.paused) runCmd(pauseBtn, 'job.resume', {});
        else runCmd(pauseBtn, 'job.pause', {});
    });

    spindleOffBtn.addEventListener('click', () => runCmd(spindleOffBtn, 'spindle.off', {}));

    // ---- motion panel ----------------------------------------------------
    function buildMotionPanel(s) {
        const caps = s.caps;
        const parts = [];

        if (caps.jogStep || caps.jogContinuous) {
            jogpad = createJogpad({ ws: ctx.ws, deviceId, capabilities: caps, limits: s.limits });
            parts.push(jogpad.el);
        } else {
            parts.push(h('p', { class: 'muted' }, 'Jogging is not supported on this controller.'));
        }

        if (caps.zero) {
            const zero = (axes, label) => h('button', {
                type: 'button', class: 'btn', 'aria-label': 'Set work zero ' + label,
                on: {
                    click: async (e) => {
                        const btn = e.currentTarget;
                        const ok = await confirmDialog({
                            title: 'Set work zero ' + label + '?',
                            message: 'The current position becomes zero for ' + label + '. Any loaded job will run relative to it.',
                            confirmText: 'Set zero',
                        });
                        if (ok) runCmd(btn, 'zero', { axes });
                    },
                },
            }, 'Zero ' + label);
            parts.push(h('div', { class: 'btn-row' },
                zero(['x'], 'X'), zero(['y'], 'Y'), zero(['z'], 'Z'), zero(['x', 'y', 'z'], 'all')));
        }

        if (caps.home) {
            parts.push(h('div', { class: 'btn-row' }, h('button', {
                type: 'button', class: 'btn', 'aria-label': 'Home all axes',
                on: {
                    click: async (e) => {
                        const btn = e.currentTarget;
                        const ok = await confirmDialog({ title: 'Home the machine?', message: 'All axes move to their home switches.', confirmText: 'Home', checkbox: 'I can see the machine and the work area is clear' });
                        if (ok) runCmd(btn, 'home', { axis: 'all' });
                    },
                },
            }, 'Home')));
        }

        if (caps.spindle) {
            const rpm = h('input', { type: 'number', min: 1, max: 24000, step: 100, value: '12000', inputmode: 'numeric', 'aria-label': 'Spindle speed in RPM' });
            parts.push(h('div', { class: 'inline-form' },
                h('label', { class: 'inline-field' }, h('span', null, 'Spindle RPM'), rpm),
                h('button', {
                    type: 'button', class: 'btn', 'aria-label': 'Spindle on',
                    on: {
                        click: async (e) => {
                            const btn = e.currentTarget;
                            const value = Number(rpm.value);
                            if (!Number.isInteger(value) || value < 1 || value > 24000) {
                                toast('Enter a whole RPM between 1 and 24000', 'error');
                                return;
                            }
                            const ok = await confirmDialog({ title: 'Start the spindle?', message: 'Spindle on at ' + value + ' RPM.', confirmText: 'Spindle on', checkbox: 'I can see the machine and the work area is clear' });
                            if (ok) runCmd(btn, 'spindle.on', { rpm: value });
                        },
                    },
                }, 'Spindle on')));
        }

        if (caps.start) {
            parts.push(h('button', { type: 'button', class: 'btn btn-primary btn-block', on: { click: () => startJobFlow() } }, 'Start job…'));
        }
        motionBody.replaceChildren(...parts);
    }

    function teardownMotionPanel() {
        if (jogpad) {
            jogpad.destroy();
            jogpad = null;
        }
        jogpadKey = null;
        motionBody.replaceChildren();
    }

    // ---- start job -------------------------------------------------------
    async function refreshStoredFiles() {
        try {
            const list = await ctx.api.files(deviceId);
            storedFiles = (Array.isArray(list) ? list : []).filter((f) => f.status === 'stored' && f.libraryId);
        } catch (err) {
            if (err.status !== 401) storedFiles = [];
        }
    }

    async function startJobFlow() {
        await refreshStoredFiles();
        if (destroyed) return;
        const s = snapshot();
        const loaded = s.st && s.st.file;
        const options = [];
        if (loaded && loaded.name) options.push({ key: 'loaded', label: 'Loaded on the machine: ' + loaded.name, name: loaded.name, size: loaded.size });
        for (const f of storedFiles.slice(0, 10)) {
            options.push({ key: f.transferId, label: 'Uploaded: ' + f.name + ' (' + fmtBytes(f.size) + ')', name: f.name, size: f.size, libraryId: f.libraryId });
        }
        if (options.length === 0) {
            toast('No file loaded on the machine and no delivered uploads', 'info');
            return;
        }
        let choice = options[0];
        if (options.length > 1) {
            const group = 'src-' + Math.random().toString(36).slice(2, 8);
            const radios = options.map((o, i) => {
                const input = h('input', { type: 'radio', name: group, value: String(i), checked: i === 0, id: group + i });
                return { input, row: h('label', { class: 'radio-row', htmlFor: group + i }, input, h('span', null, o.label)) };
            });
            const picked = await openModal({
                title: 'Which file?',
                body: [h('div', { role: 'radiogroup', 'aria-label': 'File to start' }, radios.map((r) => r.row))],
                actions: [{ label: 'Cancel', value: null }, { label: 'Continue', value: 'go', kind: 'primary' }],
            });
            if (picked !== 'go' || destroyed) return;
            const idx = radios.findIndex((r) => r.input.checked);
            choice = options[idx >= 0 ? idx : 0];
        }
        await confirmStart(choice);
    }

    function buildExpect(choice) {
        const s = snapshot();
        return buildStartExpect(s.st, choice, s.d.lastLoadSeq);
    }

    function sameExpect(a, b) {
        return !!a && !!b && a.name === b.name && a.size === b.size && a.loadSeq === b.loadSeq && a.wcsSeq === b.wcsSeq;
    }

    function waitForState(ms) {
        return new Promise((resolve) => {
            let off = null;
            const timer = setTimeout(() => { off(); resolve(); }, ms);
            off = ctx.devices.subscribe((id, kind) => {
                if (id !== deviceId || kind !== 'state') return;
                clearTimeout(timer);
                off();
                resolve();
            });
        });
    }

    async function confirmStart(choice) {
        const d = snapshot().d;
        const expect = buildExpect(choice);
        if (!expect) { toast('No machine state yet', 'error'); return; }
        const zeroAge = d.wcsChangedAt !== null && d.wcsChangedAt !== undefined
            ? 'Work zero last changed ' + timeAgo(performance.now() - d.wcsChangedAt)
            : 'Work zero not changed since this page opened';

        const ok = await confirmDialog({
            title: 'Start job?',
            message: 'The machine will start cutting from the beginning of the file.',
            details: [
                ['File', expect.name],
                ['Size', Number.isFinite(expect.size) ? fmtBytes(expect.size) : 'unknown'],
                ['Work zero', zeroAge],
            ],
            checkbox: 'I can see the machine and the work area is clear',
            confirmText: 'Start job',
            danger: true,
        });
        if (!ok || destroyed) return;
        const args = { fromBeginning: true, expect };
        if (choice.libraryId) args.libraryId = choice.libraryId;
        const ack = await runCmd(null, 'job.start', args, { quiet: true });
        if (!ack || destroyed) return;
        if (ack.status === 'accepted') {
            toast('Job started', 'ok');
        } else if (ack.code === 'FILE_CHANGED') {
            // Re-open only with values that differ from what the machine just
            // refused; the same expect would be refused again. This happens when
            // the load counter or work zero changed after this page's last state,
            // or the library renamed the upload on a name clash.
            let fresh = buildExpect(choice);
            if (sameExpect(fresh, expect)) {
                await waitForState(FILE_CHANGED_WAIT_MS);
                if (destroyed) return;
                fresh = buildExpect(choice);
            }
            if (fresh && !sameExpect(fresh, expect)) {
                await confirmStart(choice);
            } else {
                await openModal({
                    title: 'Cannot start from here',
                    body: [
                        h('p', null, 'The machine reports that the file or work zero is different from what this page shows, and no newer details have arrived.'),
                        h('p', null, choice.libraryId
                            ? 'Load the file on the machine, then start it from this page or on the machine.'
                            : 'Check the file on the machine, or start the job there.'),
                    ],
                    actions: [{ label: 'OK', value: true, kind: 'primary' }],
                });
            }
        } else if (ack.code === 'REVIEW_REQUIRED') {
            await openModal({
                title: 'Review needed',
                body: [h('p', null, 'The operator must review this uploaded file on the machine first.')],
                actions: [{ label: 'OK', value: true, kind: 'primary' }],
            });
        }
    }

    // ---- camera ----------------------------------------------------------
    function createCamera(cameras) {
        let cameraId = cameras[0].id;
        let fps = 1;
        // Drops `after` once frames stop arriving, so a machine that restarted its
        // frame counter (lease expiry, reconnect) is picked up again at once.
        const cursor = createFrameCursor({ now: () => performance.now(), resetAfterMs: NO_FRAME_MS });
        let objectUrl = null;
        let timer = null;
        let inView = true;
        let stopped = false;
        let inFlight = false;

        const img = h('img', { class: 'camera-img', alt: 'Camera image from the machine' });
        // Not a live region: "Frame N s ago" changes about once a second. Only
        // availability transitions are announced, through cameraLive.
        const age = h('p', { class: 'small muted' }, 'No camera image');
        const cameraLive = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
        let cameraPhaseNow = null;
        const fpsBtn = h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', 'aria-label': 'Faster camera, 2 frames per second' }, '2 fps');
        const select = cameras.length > 1
            ? h('select', { 'aria-label': 'Camera' }, cameras.map((c) => h('option', { value: c.id }, c.name || c.id)))
            : null;

        fpsBtn.addEventListener('click', () => {
            fps = fps === 1 ? 2 : 1;
            fpsBtn.setAttribute('aria-pressed', fps === 2 ? 'true' : 'false');
            schedule(0);
        });
        if (select) {
            select.addEventListener('change', () => {
                cameraId = select.value;
                cursor.reset();
                schedule(0);
            });
        }

        cameraCard.replaceChildren(
            h('div', { class: 'row-between' }, h('h2', null, 'Camera'), h('div', { class: 'btn-row compact' }, select, fpsBtn)),
            h('div', { class: 'camera-frame' }, img),
            age,
            cameraLive);

        let observer = null;
        if (typeof IntersectionObserver === 'function') {
            observer = new IntersectionObserver((entries) => {
                inView = entries.some((e) => e.isIntersecting);
                if (inView) schedule(0);
            });
            observer.observe(cameraCard);
        }

        function schedule(ms) {
            if (stopped) return;
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(tick, ms);
        }

        async function tick() {
            timer = null;
            if (stopped) return;
            const s = snapshot();
            const wanted = inView && document.visibilityState === 'visible' && s.online;
            if (!wanted || inFlight) {
                if (!inView || document.visibilityState !== 'visible') return;  // resumed by observer / visibility
                schedule(1000);
                return;
            }
            inFlight = true;
            let next = Math.round(1000 / fps);
            try {
                const res = await fetch(cameraUrl(deviceId, cameraId, { fps, after: cursor.after() }), { credentials: 'same-origin', cache: 'no-store' });
                if (stopped) return;
                if (res.status === 200) {
                    const blob = await res.blob();
                    if (stopped) return;
                    const seqHeader = res.headers.get('X-Frame-Seq');
                    const tsHeader = res.headers.get('X-Frame-Ts');
                    const seq = seqHeader === null ? NaN : Number(seqHeader);
                    const ts = tsHeader === null ? NaN : Number(tsHeader);
                    if (cursor.onFrame(seq, ts)) {
                        const url = URL.createObjectURL(blob);
                        img.src = url;
                        if (objectUrl) URL.revokeObjectURL(objectUrl);
                        objectUrl = url;
                    }
                } else if (res.status === 401) {
                    notifyUnauthorized();
                    return;
                } else if (res.status === 429) {
                    next = 1500;
                } else if (res.status !== 204) {
                    next = 3000;
                }
            } catch (_) {
                next = 3000;
            } finally {
                inFlight = false;
            }
            paintAge();
            schedule(next);
        }

        function paintAge() {
            const d = ctx.devices.get(deviceId);
            const err = d && d.cameraError && performance.now() - d.cameraError.at < 15000 ? d.cameraError : null;
            const lastFrameAt = cursor.lastFrameAt();
            const phase = cameraPhase(lastFrameAt, performance.now(), NO_FRAME_MS, err && err.code);
            const said = cameraAnnouncement(cameraPhaseNow, phase);
            cameraPhaseNow = phase;
            if (said) setText(cameraLive, said);
            if (phase !== 'live') {
                img.classList.add('stale');
                setText(age, phase === 'lan-only' ? 'No camera image (machine is LAN-only)' : 'No camera image');
            } else {
                img.classList.remove('stale');
                setText(age, 'Frame ' + timeAgo(performance.now() - lastFrameAt));
            }
        }

        function onVisibility() {
            if (document.visibilityState === 'visible') schedule(0);
        }
        document.addEventListener('visibilitychange', onVisibility);
        const ageTimer = setInterval(paintAge, 1000);
        schedule(0);

        return {
            key: cameras.map((c) => c.id).join(','),
            destroy() {
                stopped = true;
                if (timer !== null) clearTimeout(timer);
                clearInterval(ageTimer);
                if (observer) observer.disconnect();
                document.removeEventListener('visibilitychange', onVisibility);
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                cameraCard.replaceChildren();
            },
        };
    }

    // ---- paint -----------------------------------------------------------
    function queuePaint() {
        if (paintQueued || destroyed) return;
        paintQueued = true;
        requestAnimationFrame(() => {
            paintQueued = false;
            if (!destroyed) paint();
        });
    }

    function paintTierChip(s) {
        const tier = s.tier;
        tierChip.className = 'chip';
        const remaining = tier && s.myTier === 'motion' ? motionRemainingMs(tier, s.d.tierAt, performance.now()) : null;
        const next = { tier: tier ? s.myTier : null, remaining };
        const said = tierAnnouncement(lastTierAnnounce, next);
        lastTierAnnounce = next;
        if (said) setText(tierLive, said);
        if (!tier) { setText(tierChip, 'Tier unknown'); return; }
        if (s.myTier === 'motion') {
            tierChip.classList.add('chip-motion');
            if (remaining !== null && remaining < MOTION_WARN_MS) tierChip.classList.add('chip-expiring');
            setText(tierChip, remaining === null ? 'Motion' : 'Motion ' + fmtMmSs(remaining));
        } else if (s.myTier === 'job') {
            tierChip.classList.add('chip-job');
            setText(tierChip, 'Job control');
        } else {
            setText(tierChip, s.canControl || !meta ? 'Monitor' : 'Viewer');
        }
    }

    function paint() {
        const s = snapshot();
        const d = s.d;

        if (d.removed || d.denied) {
            teardown();
            root.replaceChildren(h('section', { class: 'narrow' },
                h('h1', null, 'Machine not available'),
                h('p', { class: 'card' }, 'This machine was removed, or you no longer have access to it.'),
                h('a', { href: '#/devices', class: 'btn btn-block' }, 'Back to machines')));
            return;
        }

        setText(title, meta ? meta.name : (s.presence ? 'Machine' : 'Machine'));

        // Header
        presenceDot.className = 'dot ' + (s.online ? 'dot-ok' : 'dot-idle');
        setText(presenceText, s.presence ? (s.online ? 'Online' : 'Offline') : 'Connecting…');
        const cloudRtt = s.st && s.st.link && Number.isFinite(s.st.link.cloudRttMs) ? Math.round(s.st.link.cloudRttMs) : null;
        const clientRtt = Number.isFinite(s.conn.clientRttMs) ? Math.round(s.conn.clientRttMs) : null;
        setText(rttText, cloudRtt === null && clientRtt === null ? '' : 'RTT machine ' + (cloudRtt ?? '?') + ' ms + phone ' + (clientRtt ?? '?') + ' ms');
        paintTierChip(s);

        // Banners
        if (!s.live) {
            connBanner.hidden = false;
            setText(connBanner, 'Reconnecting — use the machine’s E-stop');
        } else if (s.presence && !s.online) {
            connBanner.hidden = false;
            setText(connBanner, 'Machine offline — use the machine’s E-stop');
        } else {
            connBanner.hidden = true;
        }
        if (s.online && s.locks.length) {
            lockBanner.hidden = false;
            setText(lockBanner, s.locks.map((l) => LOCK_TEXT[l] || ('Locked: ' + l)).join(' '));
        } else {
            lockBanner.hidden = true;
        }
        stopBanner.hidden = !(s.online && s.tier && Number.isFinite(s.tier.stopUnconfirmedAt));

        // State card
        const machine = s.st && s.st.machine ? s.st.machine : null;
        const state = s.online && machine ? machine.state : (s.presence ? 'disconnected' : null);
        stateWord.className = 'state-word state-' + (STATE_CLASS[state] || 'idle');
        setText(stateWord, s.online ? (state ? (STATE_LABEL[state] || state) : 'Waiting for status…') : 'Offline');
        const alarm = s.st && s.st.alarm;
        setText(alarmText, s.online && alarm
            ? (alarm.type === 'estop' ? 'E-stop' : alarm.type === 'fault' ? 'Fault' : alarm.type === 'comm_lost' ? 'Communication lost' : 'Alarm')
                + (alarm.code !== null && alarm.code !== undefined ? ' ' + alarm.code : '')
                + (alarm.message ? ': ' + alarm.message : '')
            : '');
        const aj = s.tier && s.tier.activeJog;
        setText(activeJogText, s.online && aj
            ? 'Remote jog: ' + String(aj.axis || '').toUpperCase() + (aj.dir > 0 ? '+' : '−') + (aj.userLabel ? ' by ' + aj.userLabel : '')
            : '');
        const ageMs = machine && Number.isFinite(machine.telemetryAgeMs) ? machine.telemetryAgeMs : null;
        const sinceReport = s.d.stateAt ? performance.now() - s.d.stateAt : null;
        setText(staleText, s.online && ((ageMs !== null && ageMs > 1500) || (sinceReport !== null && sinceReport > 5000))
            ? 'Status is out of date (' + timeAgo(Math.max(ageMs || 0, sinceReport || 0)) + ')'
            : (s.online && machine && machine.boardLinkOk === false ? 'Board link lost' : ''));

        // DRO
        const wpos = machine && (machine.wpos || machine.pos);
        const mpos = machine && machine.pos;
        for (const axis of ['x', 'y', 'z']) {
            setText(dro[axis], fmtPos(wpos ? wpos[axis] : NaN));
            setText(dro[axis + 'm'], mpos && Number.isFinite(mpos[axis]) ? mpos[axis].toFixed(3) : '');
        }
        droCard.classList.toggle('stale', !s.online);
        setText(feedText, machine && Number.isFinite(machine.feedrate) ? 'Feed ' + machine.feedrate + ' mm/min' : 'Feed —');
        setText(spindleText, machine && Number.isFinite(machine.spindleRpm) ? 'Spindle ' + machine.spindleRpm + ' RPM' : 'Spindle —');

        // Job card
        const job = s.st && s.st.job;
        const file = s.st && s.st.file;
        if (job && (job.active || job.paused)) {
            setText(jobName, job.name || (file && file.name) || 'Unnamed job');
            const pct = Math.max(0, Math.min(100, Math.round(job.progressPct || 0)));
            progress.setAttribute('aria-valuenow', String(pct));
            progress.setAttribute('aria-valuetext', pct + ' percent');
            progressFill.style.width = pct + '%';
            setText(jobLines, pct + '% · ' + (job.executed ?? '?') + ' / ' + (job.total ?? '?') + ' lines' + (job.paused ? ' · paused' : ''));
        } else {
            setText(jobName, file && file.name ? 'Loaded: ' + file.name : 'No job running');
            progress.setAttribute('aria-valuenow', '0');
            progress.setAttribute('aria-valuetext', 'No job');
            progressFill.style.width = '0%';
            setText(jobLines, file && Number.isFinite(file.size) ? fmtBytes(file.size) + (Number.isFinite(file.total) ? ' · ' + file.total + ' lines' : '') : '');
        }
        const notes = [];
        if (job && job.stalled) notes.push('Job stalled');
        if (job && job.failReason) notes.push('Failed: ' + job.failReason);
        if (s.st && s.st.pause && job && job.paused) {
            notes.push('Paused by: ' + s.st.pause.origin + (s.st.pause.channel && s.st.pause.channel !== 'cloud' ? ' (' + s.st.pause.channel + ')' : ''));
        }
        setText(jobNote, notes.join(' · '));

        // Action bar
        stopBtn.disabled = !s.stopReady;
        stopBtn.classList.toggle('offline', !s.stopReady);
        setText(stopBtn, s.stopReady ? 'STOP' : (!s.live ? 'Reconnecting — use the machine’s E-stop' : 'Offline — use the machine’s E-stop'));
        stopBtn.setAttribute('aria-label', s.stopReady ? 'Stop machine' : stopBtn.textContent);

        const jobCtl = s.canControl && s.myTier !== 'monitor';
        pauseBtn.hidden = !s.canControl;
        if (job && job.paused) {
            const resume = resumeState(s.st);
            const remotePause = resume.allowed;
            setText(pauseBtn, remotePause ? 'Resume' : resumeBlockedText(resume.reason));
            pauseBtn.setAttribute('aria-label', remotePause ? 'Resume job' : 'Resume is only possible on the machine');
            pauseBtn.disabled = !(jobCtl && remotePause && s.cmdReady && s.locks.length === 0);
        } else {
            setText(pauseBtn, 'Pause');
            pauseBtn.setAttribute('aria-label', 'Pause job');
            pauseBtn.disabled = !(jobCtl && job && job.active && s.cmdReady && s.locks.length === 0);
        }
        spindleOffBtn.hidden = !(s.caps.spindle && machine && machine.spindleRpm > 0);
        spindleOffBtn.disabled = !s.stopReady;

        // Feed override
        const showFeed = jobCtl && s.caps.feedOverride && s.caps.feedOverride !== 'none';
        feedCard.hidden = !showFeed;
        if (showFeed) {
            setText(feedValue, machine && Number.isFinite(machine.feedOverridePct) ? machine.feedOverridePct + '%' : '—');
            setText(feedNote, s.caps.feedOverride === 'unverified' ? 'Host-side value; firmware may not apply it' : '');
            for (const b of feedButtons) b.disabled = !(s.cmdReady && s.locks.length === 0);
        }

        // Motion
        const showMotion = s.canControl && s.myTier === 'motion' && s.locks.length === 0 && s.online;
        if (showMotion) {
            const key = JSON.stringify([s.caps, s.limits]);
            if (key !== jogpadKey && !(jogpad && jogpad.isJogging())) {
                teardownMotionPanel();
                buildMotionPanel(s);
                jogpadKey = key;
            }
            setText(motionNote, s.synced ? '' : 'Synchronising clock…');
            if (jogpad) jogpad.setEnabled(s.cmdReady);
            for (const b of motionBody.querySelectorAll('.btn')) {
                if (!b.closest('.jogpad')) b.disabled = !s.cmdReady;
            }
        } else {
            if (jogpadKey !== null) teardownMotionPanel();
            if (!s.canControl) setText(motionNote, meta ? 'Your access to this machine is view and Stop only.' : '');
            else if (s.motionElsewhere) setText(motionNote, 'Motion is granted to another user');
            else if (s.myTier === 'motion' && s.locks.length) setText(motionNote, 'Motion controls are locked (see the banner above).');
            else setText(motionNote, 'Motion controls are enabled from the machine’s screen');
        }

        // Camera
        const cams = s.presence && Array.isArray(s.presence.cameras) ? s.presence.cameras.filter((c) => c && typeof c.id === 'string') : [];
        const camKey = cams.map((c) => c.id).join(',');
        if (cams.length && (!camera || camera.key !== camKey)) {
            if (camera) camera.destroy();
            cameraCard.hidden = false;
            camera = createCamera(cams);
        } else if (!cams.length && camera) {
            camera.destroy();
            camera = null;
            cameraCard.hidden = true;
        }

        // Links
        if (!links.childElementCount && meta) {
            const base = '#/d/' + encodeURIComponent(deviceId);
            links.append(
                h('a', { href: base + '/files', class: 'btn' }, 'Files'),
                h('a', { href: base + '/audit', class: 'btn' }, 'Activity'),
                h('a', { href: base + '/sharing', class: 'btn' }, meta.role === 'owner' ? 'Sharing & settings' : 'Access'));
        }
    }

    // ---- lifecycle -------------------------------------------------------
    // Without meta the page cannot tell the role, so Pause, feed override and
    // Motion stay hidden. A failed load is retried with backoff, and at once
    // when the socket reopens or the page becomes visible again.
    let metaSettled = false;
    let metaLoading = false;
    let metaAttempt = 0;
    let metaRetryTimer = null;

    async function loadMeta() {
        if (destroyed || metaSettled || metaLoading) return;
        if (metaRetryTimer !== null) {
            clearTimeout(metaRetryTimer);
            metaRetryTimer = null;
        }
        metaLoading = true;
        try {
            const list = await ctx.api.devices();
            if (destroyed) return;
            metaSettled = true;
            metaAttempt = 0;
            meta = (Array.isArray(list) ? list : []).find((dev) => dev.id === deviceId) || null;
            if (!meta || meta.status === 'pending_confirmation') {
                ctx.devices.ensure(deviceId).denied = true;
            }
            queuePaint();
        } catch (err) {
            if (destroyed || err.status === 401) return;
            metaAttempt += 1;
            if (metaAttempt === 1) toast(apiErrorText(err), 'error');
            const retryMs = Math.max(retryDelayMs(metaAttempt), (err.retryAfterSec || 0) * 1000);
            metaRetryTimer = setTimeout(() => { metaRetryTimer = null; loadMeta(); }, retryMs);
        } finally {
            metaLoading = false;
        }
    }

    function retryMetaNow() {
        if (!metaSettled && !destroyed) loadMeta();
    }
    function onMetaVisibility() {
        if (document.visibilityState === 'visible') retryMetaNow();
    }
    const offOpen = ctx.ws.on('open', retryMetaNow);
    document.addEventListener('visibilitychange', onMetaVisibility);

    const unsubDevices = ctx.devices.subscribe((id, kind) => {
        if (id !== deviceId) return;
        if (kind === 'removed') toast('This machine is no longer available to you', 'info');
        queuePaint();
    });
    const offStatus = ctx.ws.on('status', queuePaint);
    const tickTimer = setInterval(() => {
        const s = snapshot();
        paintTierChip(s);
    }, 1000);
    const staleTimer = setInterval(queuePaint, 2000);

    ctx.ws.setSubscriptions([deviceId]);
    loadMeta();
    paint();

    function teardown() {
        if (destroyed) return;
        destroyed = true;
        closeAllModals();
        if (barObserver) barObserver.disconnect();
        document.documentElement.style.removeProperty('--action-bar-total');
        teardownMotionPanel();
        if (camera) camera.destroy();
        camera = null;
        unsubDevices();
        offStatus();
        offOpen();
        document.removeEventListener('visibilitychange', onMetaVisibility);
        if (metaRetryTimer !== null) clearTimeout(metaRetryTimer);
        if (cancelBannerTimer !== null) clearTimeout(cancelBannerTimer);
        clearInterval(tickTimer);
        clearInterval(staleTimer);
        actionBar.remove();
        document.body.classList.remove('has-action-bar');
    }

    return { destroy: teardown };
}
