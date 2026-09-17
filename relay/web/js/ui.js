// DOM helpers. Every piece of dynamic text goes through textContent; nothing
// here ever parses HTML.

export { timeAgo } from './core/view.js';

const BOOLEAN_PROPS = new Set(['disabled', 'hidden', 'checked', 'required', 'readOnly', 'multiple', 'selected', 'autofocus']);
const VALUE_PROPS = new Set(['value', 'type', 'name', 'id', 'htmlFor', 'tabIndex', 'min', 'max', 'step', 'maxLength', 'placeholder']);

export function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const [key, val] of Object.entries(props)) {
            if (val === undefined || val === null || val === false && !BOOLEAN_PROPS.has(key)) continue;
            if (key === 'class') {
                el.className = Array.isArray(val) ? val.filter(Boolean).join(' ') : val;
            } else if (key === 'text') {
                el.textContent = String(val);
            } else if (key === 'on') {
                for (const [ev, fn] of Object.entries(val)) el.addEventListener(ev, fn);
            } else if (key === 'dataset') {
                for (const [k, v] of Object.entries(val)) el.dataset[k] = String(v);
            } else if (BOOLEAN_PROPS.has(key)) {
                el[key] = !!val;
            } else if (VALUE_PROPS.has(key)) {
                el[key] = val;
            } else if (/^on/i.test(key) || key === 'style' || /html/i.test(key) || key === 'src' || key === 'href' && /^\s*javascript:/i.test(String(val))) {
                // Handlers, inline styles, markup and scriptable URLs are never set from here.
                continue;
            } else {
                el.setAttribute(key, String(val));
            }
        }
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        if (Array.isArray(child)) append(el, child);
        else if (child instanceof Node) el.appendChild(child);
        else el.appendChild(document.createTextNode(String(child)));
    }
}

export function clear(el) {
    el.replaceChildren();
}

export function setText(el, text) {
    const s = text === null || text === undefined ? '' : String(text);
    if (el.textContent !== s) el.textContent = s;
}

export function link(hash, text, cls) {
    return h('a', { href: hash, class: cls }, text);
}

let toastRegion = null;

export function toast(message, kind = 'info', ms = 4500) {
    if (!toastRegion) toastRegion = document.getElementById('toasts');
    if (!toastRegion) return;
    const el = h('div', { class: ['toast', 'toast-' + kind], role: kind === 'error' ? 'alert' : 'status' }, message);
    toastRegion.appendChild(el);
    while (toastRegion.children.length > 4) toastRegion.firstElementChild.remove();
    setTimeout(() => el.remove(), ms);
}

// Modal with optional required checkbox. Resolves with the chosen action's
// value, or null when cancelled.
const openModals = new Set();

// Cancels every open dialog (resolving it with null), e.g. on navigation.
export function closeAllModals() {
    for (const close of Array.from(openModals)) close(null);
}

export function openModal({ title, body = [], actions = [], checkbox = null, dismissable = true }) {
    return new Promise((resolve) => {
        const previousFocus = document.activeElement;
        const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
        let box = null;
        const buttons = [];

        const backdrop = h('div', { class: 'modal-backdrop' });
        const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });

        function done(value) {
            if (!openModals.has(done)) return;
            openModals.delete(done);
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
            resolve(value);
        }

        function onKey(e) {
            if (e.key === 'Escape' && dismissable) {
                e.preventDefault();
                done(null);
            } else if (e.key === 'Tab') {
                const focusables = Array.from(dialog.querySelectorAll('button, input, select, textarea, a[href]')).filter((n) => !n.disabled);
                if (focusables.length === 0) return;
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }

        dialog.appendChild(h('h2', { id: titleId, class: 'modal-title' }, title));
        dialog.appendChild(h('div', { class: 'modal-body' }, body));

        if (checkbox) {
            box = h('input', { type: 'checkbox', id: titleId + '-check' });
            box.addEventListener('change', () => {
                for (const b of buttons) if (b.requiresCheck) b.el.disabled = !box.checked;
            });
            dialog.appendChild(h('label', { class: 'check', htmlFor: titleId + '-check' }, box, h('span', null, checkbox)));
        }

        const row = h('div', { class: 'modal-actions' });
        for (const action of actions) {
            const el = h('button', {
                type: 'button',
                class: ['btn', action.kind ? 'btn-' + action.kind : null],
                disabled: !!(action.requiresCheck && checkbox),
                on: { click: () => done(action.value) },
            }, action.label);
            buttons.push({ el, requiresCheck: !!action.requiresCheck });
            row.appendChild(el);
        }
        dialog.appendChild(row);
        backdrop.appendChild(dialog);
        if (dismissable) {
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
        }
        openModals.add(done);
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(backdrop);
        const firstButton = row.querySelector('button');
        if (firstButton) firstButton.focus();
    });
}

export async function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false, checkbox = null, details = [] }) {
    const body = [];
    if (message) body.push(h('p', null, message));
    if (details.length) {
        body.push(h('dl', { class: 'details' }, details.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
    }
    const result = await openModal({
        title,
        body,
        checkbox,
        actions: [
            { label: cancelText, value: false },
            { label: confirmText, value: true, kind: danger ? 'danger' : 'primary', requiresCheck: !!checkbox },
        ],
    });
    return result === true;
}

export function fmtMmSs(ms) {
    const total = Math.max(0, Math.ceil((ms || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

export function fmtDateTime(wallMs) {
    if (!Number.isFinite(wallMs)) return '';
    try {
        return new Date(wallMs).toLocaleString();
    } catch (_) {
        return String(wallMs);
    }
}

export function fmtBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function fmtPos(v) {
    return Number.isFinite(v) ? v.toFixed(3) : '---.---';
}

// Runs an async action with the button disabled; restores it afterwards unless
// the caller re-rendered the button away.
export async function withBusy(button, fn) {
    if (button) {
        if (button.dataset.busy === '1') return undefined;
        button.dataset.busy = '1';
        button.setAttribute('aria-busy', 'true');
    }
    try {
        return await fn();
    } finally {
        if (button) {
            delete button.dataset.busy;
            button.removeAttribute('aria-busy');
        }
    }
}

export function field(label, input, hint) {
    const id = input.id || 'f-' + Math.random().toString(36).slice(2, 9);
    input.id = id;
    return h('div', { class: 'field' },
        h('label', { htmlFor: id }, label),
        input,
        hint ? h('p', { class: 'hint' }, hint) : null);
}

export function pageHeader(title, backHash, backLabel) {
    return h('header', { class: 'page-head' },
        backHash ? h('a', { href: backHash, class: 'back', 'aria-label': backLabel || 'Back' }, '‹ ' + (backLabel || 'Back')) : null,
        h('h1', null, title));
}
