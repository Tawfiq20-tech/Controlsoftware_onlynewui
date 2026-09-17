import { apiErrorText } from '../api.js';
import { field, h, pageHeader, toast, withBusy } from '../ui.js';

const POLL_MS = 3000;

export function formatPairingCode(raw) {
    const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return clean.length > 4 ? clean.slice(0, 4) + '-' + clean.slice(4) : clean;
}

export function render(root, ctx) {
    let destroyed = false;
    let pollTimer = null;

    const code = h('input', {
        type: 'text',
        inputmode: 'text',
        autocapitalize: 'characters',
        autocomplete: 'one-time-code',
        spellcheck: 'false',
        maxLength: 9,
        required: true,
        class: 'code-input',
        placeholder: 'ABCD-EFGH',
    });
    const name = h('input', { type: 'text', maxLength: 60, autocomplete: 'off' });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Add machine');

    code.addEventListener('input', () => {
        const formatted = formatPairingCode(code.value);
        if (formatted !== code.value) {
            code.value = formatted;
            code.setSelectionRange(formatted.length, formatted.length);
        }
    });

    const form = h('form', { class: 'card form', novalidate: 'novalidate' },
        field('Pairing code', code, 'The 8-character code shown on the machine screen.'),
        field('Name (optional)', name),
        error,
        submit);

    const waiting = h('div', { class: 'card', hidden: true, role: 'status', 'aria-live': 'polite' });

    const section = h('section', { class: 'narrow' },
        pageHeader('Add machine', '#/devices', 'Machines'),
        h('ol', { class: 'steps' },
            h('li', null, 'On the machine: Settings → Cloud access → Get pairing code'),
            h('li', null, 'Enter the code below'),
            h('li', null, 'Confirm the pairing on the machine screen')),
        form,
        waiting);
    root.append(section);
    code.focus();

    function showWaiting(text, done) {
        form.hidden = true;
        waiting.hidden = false;
        waiting.replaceChildren(
            h('p', { class: done ? '' : 'pulse' }, text),
            done ? h('a', { href: '#/devices', class: 'btn btn-block' }, 'Back to machines') : null);
    }

    async function poll(deviceId) {
        pollTimer = null;
        if (destroyed) return;
        try {
            const list = await ctx.api.devices();
            if (destroyed) return;
            const dev = (Array.isArray(list) ? list : []).find((d) => d.id === deviceId);
            if (!dev) {
                showWaiting('The machine operator rejected this pairing, or it expired.', true);
                return;
            }
            if (dev.status === 'active') {
                toast('Machine added', 'ok');
                ctx.navigate('#/d/' + encodeURIComponent(deviceId));
                return;
            }
        } catch (err) {
            if (destroyed || err.status === 401) return;
        }
        pollTimer = setTimeout(() => poll(deviceId), POLL_MS);
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        error.textContent = '';
        const value = code.value.replace(/[^A-Za-z0-9]/g, '');
        if (value.length !== 8) {
            error.textContent = 'Enter all 8 characters of the code';
            return;
        }
        withBusy(submit, async () => {
            try {
                const res = await ctx.api.claim(formatPairingCode(value), name.value.trim() || undefined);
                const device = res && (res.device || res);
                if (!device || !device.id) throw new Error('bad response');
                showWaiting('Waiting for confirmation on the machine screen…', false);
                pollTimer = setTimeout(() => poll(device.id), POLL_MS);
            } catch (err) {
                error.textContent = apiErrorText(err);
            }
        });
    });

    return {
        destroy() {
            destroyed = true;
            if (pollTimer !== null) clearTimeout(pollTimer);
        },
    };
}
