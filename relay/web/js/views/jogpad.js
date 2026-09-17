// Deadman jog pad (SPEC §8.2 item 5): DOM wrapper around js/core/jog.js.

import { createJogController } from '../core/jog.js';
import { errorText } from '../protocol.js';
import { h, toast } from '../ui.js';

const STEP_SIZES = [0.1, 1, 10];
const STEP_FEEDS = [100, 300, 600, 1000, 1500, 2000, 3000];
const HOLD_FEEDS = [60, 150, 300, 600, 1000, 1500];

const BUTTONS = [
    { axis: 'y', dir: 1, label: 'Y+', aria: 'Jog Y plus', area: 'yp' },
    { axis: 'x', dir: -1, label: 'X−', aria: 'Jog X minus', area: 'xm' },
    { axis: 'x', dir: 1, label: 'X+', aria: 'Jog X plus', area: 'xp' },
    { axis: 'y', dir: -1, label: 'Y−', aria: 'Jog Y minus', area: 'ym' },
    { axis: 'z', dir: 1, label: 'Z+', aria: 'Jog Z plus', area: 'zp' },
    { axis: 'z', dir: -1, label: 'Z−', aria: 'Jog Z minus', area: 'zm' },
];

const KEYS = {
    ArrowLeft: ['x', -1],
    ArrowRight: ['x', 1],
    ArrowUp: ['y', 1],
    ArrowDown: ['y', -1],
    PageUp: ['z', 1],
    PageDown: ['z', -1],
};

function pickDefault(options, preferred) {
    if (options.length === 0) return null;
    return options.includes(preferred) ? preferred : options[options.length - 1];
}

export function createJogpad({ ws, deviceId, capabilities = {}, limits = {} }) {
    const canStep = !!capabilities.jogStep;
    const canHold = !!capabilities.jogContinuous;
    const maxStepMm = Number.isFinite(limits.jogStepMaxMm) ? limits.jogStepMaxMm : 10;
    const maxStepFeed = Number.isFinite(limits.jogStepMaxFeed) ? limits.jogStepMaxFeed : 3000;
    const maxHoldFeed = Number.isFinite(limits.jogContMaxFeed) ? limits.jogContMaxFeed : 600;

    const stepSizes = STEP_SIZES.filter((s) => s <= maxStepMm);
    const stepFeeds = STEP_FEEDS.filter((f) => f <= maxStepFeed);
    if (stepFeeds.length === 0) stepFeeds.push(maxStepFeed);
    const holdFeeds = HOLD_FEEDS.filter((f) => f <= maxHoldFeed);
    if (holdFeeds.length === 0) holdFeeds.push(maxHoldFeed);

    let mode = canStep ? 'step' : 'hold';
    let stepMm = pickDefault(stepSizes, 1);
    let stepFeed = pickDefault(stepFeeds, 1000);
    let holdFeed = pickDefault(holdFeeds, 300);
    let enabled = false;
    let stepPending = false;
    let activePointer = null;
    let activeButton = null;
    let stepDown = null;       // {button, pointerId}
    let destroyed = false;

    const status = h('p', { class: 'jog-status', role: 'status', 'aria-live': 'polite' });

    const core = createJogController({
        send: (cmd) => ws.sendRaw(deviceId, cmd),
        now: () => performance.now(),
        isSynced: () => ws.isSynced(),
        onEvent: (ev) => {
            if (ev.kind === 'active') {
                status.textContent = 'Jogging… release to stop';
            } else if (ev.kind === 'ended') {
                clearPressedVisual();
                status.textContent = '';
                if (ev.reason === 'keepalive-rejected' || ev.reason === 'rejected') {
                    if (ev.hiccup) toast('Jog stopped (connection hiccup) — press again', 'info');
                    else toast(errorText(ev.code), 'error');
                } else if (ev.reason === 'link-down' || ev.reason === 'send-failed') {
                    toast('Jog stopped: connection lost', 'info');
                }
            }
        },
    });

    const offAck = ws.on('ack', (ack) => core.onAck(ack));
    const offClose = ws.on('close', () => {
        core.onSocketClose();
        activePointer = null;
        clearPressedVisual();
    });

    function clearPressedVisual() {
        if (activeButton) activeButton.classList.remove('pressed');
        activeButton = null;
    }

    function currentFeed() {
        return mode === 'hold' ? holdFeed : stepFeed;
    }

    async function sendStep(axis, dir, button) {
        if (!enabled || !canStep || stepPending || stepMm === null) return;
        stepPending = true;
        if (button) button.classList.add('pressed');
        pad.setAttribute('aria-busy', 'true');
        try {
            const distanceMm = Math.round(dir * stepMm * 1000) / 1000;
            const ack = await ws.sendCmd(deviceId, 'jog.step', { axis, distanceMm, feed: stepFeed });
            if (ack.status !== 'accepted') toast(errorText(ack.code, ack.message), 'error');
        } catch (err) {
            toast(errorText(err.code, err.message), 'error');
        } finally {
            stepPending = false;
            if (button) button.classList.remove('pressed');
            if (!destroyed) pad.removeAttribute('aria-busy');
        }
    }

    function endHold() {
        if (activePointer === null && !core.isActive()) return;
        activePointer = null;
        clearPressedVisual();
        core.release();
    }

    function onPointerDown(e, spec, button) {
        if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
        if (!enabled) return;
        e.preventDefault();
        if (mode === 'step') {
            if (stepDown) return;
            stepDown = { button, pointerId: e.pointerId };
            return;
        }
        if (activePointer !== null || core.isActive()) return;
        try { button.setPointerCapture(e.pointerId); } catch (_) { /* not all engines */ }
        const r = core.press(spec.axis, spec.dir, holdFeed);
        if (!r.ok) {
            toast(errorText(r.code), 'error');
            return;
        }
        activePointer = e.pointerId;
        activeButton = button;
        button.classList.add('pressed');
        const activated = !navigator.userActivation || navigator.userActivation.hasBeenActive;
        if (navigator.vibrate && activated) {
            try { navigator.vibrate(10); } catch (_) { /* optional */ }
        }
    }

    function onPointerUp(e, spec, button) {
        if (mode === 'step') {
            if (!stepDown || stepDown.pointerId !== e.pointerId) return;
            const downOn = stepDown.button;
            stepDown = null;
            // Touch pointers are implicitly captured, so hit-test the release point.
            let under = button;
            if (typeof document.elementFromPoint === 'function' && Number.isFinite(e.clientX)) {
                const hit = document.elementFromPoint(e.clientX, e.clientY);
                under = hit && hit.closest ? hit.closest('button') : null;
            }
            if (downOn === button && under === button) sendStep(spec.axis, spec.dir, button);
            return;
        }
        if (e.pointerId === activePointer) endHold();
    }

    function onPointerEnd(e) {
        if (mode === 'step') {
            if (stepDown && stepDown.pointerId === e.pointerId && e.type !== 'pointerleave') stepDown = null;
            return;
        }
        if (e.pointerId === activePointer) endHold();
    }

    const buttons = BUTTONS.map((spec) => {
        const button = h('button', {
            type: 'button',
            class: ['jog-btn', 'jog-' + spec.area],
            'aria-label': spec.aria,
        }, spec.label);
        button.addEventListener('pointerdown', (e) => onPointerDown(e, spec, button));
        button.addEventListener('pointerup', (e) => onPointerUp(e, spec, button));
        for (const type of ['pointercancel', 'lostpointercapture', 'pointerleave']) {
            button.addEventListener(type, onPointerEnd);
        }
        // Keyboard activation (Enter/Space) arrives as a click with detail 0: always a step.
        button.addEventListener('click', (e) => {
            if (e.detail === 0) sendStep(spec.axis, spec.dir, button);
        });
        return { spec, button };
    });

    const pad = h('div', {
        class: 'jog-pad',
        role: 'group',
        'aria-label': 'Jog controls. Arrow keys and Page Up/Down send single steps.',
        tabIndex: 0,
    }, buttons.map((b) => b.button));
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
    pad.addEventListener('keydown', (e) => {
        const k = KEYS[e.key];
        if (!k) return;
        e.preventDefault();
        if (e.repeat) return;
        sendStep(k[0], k[1], null);
    });

    function onBlur() { endHold(); }
    function onVisibility() {
        if (document.visibilityState === 'hidden') endHold();
    }
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);

    // Mode, step size and feed selectors.
    const modeRow = h('div', { class: 'seg', role: 'group', 'aria-label': 'Jog mode' });
    const stepRow = h('div', { class: 'seg', role: 'group', 'aria-label': 'Step size' });
    const feedSelect = h('select', { class: 'feed-select', 'aria-label': 'Jog feed rate' });
    const feedWrap = h('label', { class: 'inline-field' }, h('span', null, 'Feed (mm/min)'), feedSelect);

    function segButton(label, pressed, onClick, aria) {
        return h('button', {
            type: 'button',
            class: 'seg-btn',
            'aria-pressed': pressed ? 'true' : 'false',
            'aria-label': aria || label,
            on: { click: onClick },
        }, label);
    }

    function paintControls() {
        modeRow.replaceChildren(
            canStep ? segButton('Step', mode === 'step', () => setMode('step'), 'Step mode') : null,
            canHold ? segButton('Hold', mode === 'hold', () => setMode('hold'), 'Hold to jog mode') : null);
        modeRow.hidden = !(canStep && canHold);

        stepRow.replaceChildren(...stepSizes.map((s) =>
            segButton(s + ' mm', s === stepMm, () => { stepMm = s; paintControls(); }, 'Step ' + s + ' millimetres')));
        stepRow.hidden = mode !== 'step';

        const feeds = mode === 'hold' ? holdFeeds : stepFeeds;
        const selected = currentFeed();
        feedSelect.replaceChildren(...feeds.map((f) => h('option', { value: String(f) }, String(f))));
        feedSelect.value = String(selected);
        status.textContent = mode === 'hold' ? 'Hold a button to jog; release to stop.' : '';
    }

    function setMode(next) {
        if (next === mode) return;
        endHold();
        mode = next;
        paintControls();
    }

    feedSelect.addEventListener('change', () => {
        const v = Number(feedSelect.value);
        if (!Number.isInteger(v)) return;
        if (mode === 'hold') holdFeed = v;
        else stepFeed = v;
    });

    paintControls();

    const el = h('div', { class: 'jogpad' },
        modeRow,
        h('div', { class: 'jog-options' }, stepRow, feedWrap),
        pad,
        status);

    function setEnabled(next) {
        enabled = !!next;
        for (const { button } of buttons) button.disabled = !enabled;
        if (!enabled) endHold();
    }
    setEnabled(false);

    return {
        el,
        setEnabled,
        isJogging: () => core.isActive(),
        destroy() {
            destroyed = true;
            endHold();
            core.dispose();
            offAck();
            offClose();
            window.removeEventListener('blur', onBlur);
            document.removeEventListener('visibilitychange', onVisibility);
        },
    };
}
