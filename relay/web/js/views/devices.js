import { apiErrorText } from '../api.js';
import { STATE_LABEL } from '../protocol.js';
import { createKeyedList, deviceCardShape, devicePresence } from '../core/view.js';
import { h, setText } from '../ui.js';

const ROLE_LABEL = { owner: 'Owner', operator: 'Operator', viewer: 'Viewer' };
const REFRESH_MS = 30000;

export function render(root, ctx) {
    const list = h('ul', { class: 'device-list' });
    const status = h('p', { class: 'muted', role: 'status' }, 'Loading machines…');
    let rows = [];
    let destroyed = false;

    root.append(h('section', null,
        h('div', { class: 'page-head row-between' },
            h('h1', null, 'Machines'),
            h('a', { href: '#/pair', class: 'btn btn-primary' }, '+ Add machine')),
        status,
        list));

    function build(dev) {
        const pending = dev.status === 'pending_confirmation';
        const dot = h('span', { class: 'dot dot-idle', 'aria-hidden': 'true' });
        const text = h('span');
        const controller = h('div', { class: 'muted small' });
        const inner = [
            h('div', { class: 'row-between' },
                h('span', { class: 'device-name' }, dev.name || dev.id),
                h('span', { class: 'badge' }, ROLE_LABEL[dev.role] || dev.role || '')),
            h('div', { class: 'presence' }, dot, text),
            controller,
        ];
        const node = h('li', null, pending
            ? h('div', { class: 'card device-card pending' }, inner)
            : h('a', { class: 'card device-card', href: '#/d/' + encodeURIComponent(dev.id) }, inner));
        return { node, dot, text, controller };
    }

    function update(item, dev) {
        const p = devicePresence(dev, ctx.devices.get(dev.id), Date.now(), STATE_LABEL);
        const cls = 'dot ' + p.dot;
        if (item.dot.className !== cls) item.dot.className = cls;
        setText(item.text, p.text);
        setText(item.controller, p.controller);
    }

    // Cards are built once per device and updated in place: report.state arrives
    // at 1-5 Hz and a rebuild would drop focus and swallow taps. Not a live region.
    const cards = createKeyedList({ container: list, key: (d) => d.id, shape: deviceCardShape, build, update });

    function paint() {
        if (destroyed) return;
        cards.setRows(rows);
        setText(status, rows.length === 0
            ? 'No machines yet. On the machine: Settings → Cloud access → Get pairing code, then tap Add machine.'
            : '');
    }

    async function load() {
        try {
            const data = await ctx.api.devices();
            if (destroyed) return;
            rows = Array.isArray(data) ? data : [];
            ctx.ws.setSubscriptions(rows.filter((d) => d.status !== 'pending_confirmation').map((d) => d.id));
            paint();
        } catch (err) {
            if (destroyed) return;
            if (err.status !== 401) status.textContent = apiErrorText(err);
        }
    }

    const unsub = ctx.devices.subscribe((id, kind) => {
        if (kind === 'removed') {
            rows = rows.filter((d) => d.id !== id);
            paint();
        } else if (rows.some((d) => d.id === id) && (kind === 'presence' || kind === 'state')) {
            cards.refresh(rows, id);
        }
    });
    const offOpen = ctx.ws.on('open', () => load());
    const timer = setInterval(load, REFRESH_MS);
    load();

    return {
        destroy() {
            destroyed = true;
            unsub();
            offOpen();
            clearInterval(timer);
        },
    };
}
