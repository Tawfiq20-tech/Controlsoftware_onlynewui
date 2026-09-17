// Activity log (SPEC §8.2 item 7, §4.8).

import { apiErrorText } from '../api.js';
import { fmtDateTime, h, pageHeader } from '../ui.js';
import { auditCursor } from '../core/view.js';

const PAGE = 50;

function parseDetail(detail) {
    if (!detail) return null;
    if (typeof detail === 'object') return detail;
    try { return JSON.parse(detail); } catch (_) { return null; }
}

function userOf(row) {
    return row.userLabel || row.displayName || row.userDisplayName || row.email || row.userId || 'machine';
}

export function render(root, ctx, deviceId) {
    let destroyed = false;
    // (ts, id) cursor of the last row shown; rows sharing one millisecond are
    // paged by id, so none are skipped or repeated.
    let cursor = null;
    let exhausted = false;

    const list = h('ol', { class: 'audit-list' });
    const status = h('p', { class: 'muted', role: 'status' }, 'Loading…');
    const more = h('button', { type: 'button', class: 'btn btn-block', hidden: true }, 'Load older');

    root.append(h('section', null,
        pageHeader('Activity', '#/d/' + encodeURIComponent(deviceId), 'Machine'),
        status,
        list,
        more));

    function row(entry) {
        const detail = parseDetail(entry.detail);
        const type = detail && typeof detail.type === 'string' ? detail.type : null;
        let result = entry.result || null;
        if (detail && (detail.status || detail.code)) {
            result = [detail.status, detail.code && detail.code !== 'OK' ? detail.code : null].filter(Boolean).join(' ');
        }
        return h('li', { class: 'card audit-row' },
            h('div', { class: 'row-between small muted' },
                h('span', null, fmtDateTime(entry.ts)),
                h('span', null, userOf(entry))),
            h('div', { class: 'row-between' },
                h('span', { class: 'audit-action' }, entry.action + (type ? ' · ' + type : '')),
                result ? h('span', { class: ['badge', /rejected|failed|denied/.test(result) ? 'badge-bad' : ''] }, result) : null));
    }

    async function fetchRows(from) {
        const data = await ctx.api.deviceAudit(deviceId, { limit: PAGE, before: from ? from.before : null, beforeId: from ? from.beforeId : null });
        return Array.isArray(data) ? data : (data && (data.rows || data.entries)) || [];
    }

    async function loadPage() {
        more.disabled = true;
        try {
            const rows = await fetchRows(cursor);
            if (destroyed) return;
            for (const entry of rows) list.appendChild(row(entry));
            const next = auditCursor(rows);
            if (next) cursor = next;
            exhausted = rows.length < PAGE || !next;
            status.textContent = list.childElementCount ? '' : 'No activity recorded yet.';
        } catch (err) {
            if (destroyed || err.status === 401) return;
            status.textContent = apiErrorText(err);
        } finally {
            if (!destroyed) {
                more.hidden = exhausted;
                more.disabled = false;
            }
        }
    }

    more.addEventListener('click', loadPage);
    loadPage();

    return { destroy() { destroyed = true; } };
}
