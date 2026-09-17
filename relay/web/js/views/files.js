// File staging (SPEC §8.2 item 6).

import { apiErrorText, getCsrfToken, notifyUnauthorized, uploadUrl } from '../api.js';
import { DEFERRED_HINT, REJECT_TEXT, errorText } from '../protocol.js';
import { confirmDialog, fmtBytes, fmtDateTime, h, pageHeader, toast } from '../ui.js';

const EXTENSIONS = ['.nc', '.gcode', '.ngc', '.tap', '.txt', '.cnc'];
const DEFERRED_CODES = Object.keys(DEFERRED_HINT);

export function statusText(row) {
    const code = row.code || null;
    switch (row.status) {
    case 'stored':
        return 'Delivered to machine library (operator must review before it can be started remotely)';
    case 'rejected':
        return 'Rejected: ' + (REJECT_TEXT[code] || code || 'unknown');
    case 'expired':
        return 'Expired before the machine collected it';
    case 'deferred':
        return 'Waiting: ' + (DEFERRED_HINT[code] || code || 'machine not ready');
    case 'pending':
    case 'offered':
        if (code && DEFERRED_CODES.includes(code)) return 'Waiting: ' + DEFERRED_HINT[code];
        return 'Waiting for machine';
    default:
        return row.status || 'Unknown';
    }
}

async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function uploadWithProgress(url, buffer, sha, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-Content-Sha256', sha);
        const csrf = getCsrfToken();
        if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) onProgress(e.loaded / e.total);
        });
        xhr.addEventListener('load', () => {
            let data = null;
            try { data = JSON.parse(xhr.responseText); } catch (_) { data = null; }
            if (xhr.status >= 200 && xhr.status < 300) resolve(data);
            else reject({ status: xhr.status, code: data && data.error ? data.error : 'http_' + xhr.status, data });
        });
        xhr.addEventListener('error', () => reject({ status: 0, code: 'network' }));
        xhr.addEventListener('abort', () => reject({ status: 0, code: 'aborted' }));
        xhr.send(buffer);
    });
}

export function render(root, ctx, deviceId) {
    const me = ctx.me();
    let destroyed = false;
    let role = null;
    const rows = new Map();

    const input = h('input', { type: 'file', accept: EXTENSIONS.join(','), class: 'file-input' });
    const progressFill = h('div', { class: 'progress-fill' });
    const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Upload progress', hidden: true }, progressFill);
    const uploadStatus = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
    const list = h('ul', { class: 'file-list' });
    const listStatus = h('p', { class: 'muted', role: 'status' }, 'Loading…');

    root.append(h('section', null,
        pageHeader('Files', '#/d/' + encodeURIComponent(deviceId), 'Machine'),
        h('p', { class: 'banner banner-info' }, 'Files are added to the machine library. They never start automatically.'),
        h('div', { class: 'card form' },
            h('label', { class: 'field' }, h('span', null, 'Upload G-code (' + EXTENSIONS.join(', ') + ')'), input),
            progress,
            uploadStatus),
        h('h2', null, 'Recent uploads'),
        listStatus,
        list));

    function setProgress(frac) {
        const pct = Math.round(frac * 100);
        progress.hidden = false;
        progress.setAttribute('aria-valuenow', String(pct));
        progressFill.style.width = pct + '%';
    }

    function paint() {
        if (destroyed) return;
        const sorted = Array.from(rows.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        list.replaceChildren(...sorted.map((row) => {
            const uploader = row.uploadedBy && typeof row.uploadedBy === 'object'
                ? (row.uploadedBy.userLabel || row.uploadedBy.displayName || '')
                : (typeof row.uploadedBy === 'string' ? row.uploadedBy : '');
            const uploaderId = row.uploadedBy && typeof row.uploadedBy === 'object' ? row.uploadedBy.userId : null;
            const canDelete = role === 'owner' || (role === 'operator' && me && uploaderId === me.id);
            const done = row.status === 'stored' || row.status === 'rejected' || row.status === 'expired';
            return h('li', { class: 'card file-row' },
                h('div', { class: 'row-between' },
                    h('span', { class: 'file-name' }, row.name || row.transferId),
                    h('span', { class: 'muted small' }, fmtBytes(row.size))),
                h('p', { class: ['small', row.status === 'rejected' ? 'bad-text' : done ? 'ok-text' : 'warn-text'] }, statusText(row)),
                h('p', { class: 'muted small' },
                    [uploader ? 'By ' + uploader : null, row.createdAt ? fmtDateTime(row.createdAt) : null].filter(Boolean).join(' · ')),
                canDelete ? h('button', {
                    type: 'button',
                    class: 'btn btn-small',
                    'aria-label': 'Delete upload ' + (row.name || ''),
                    on: { click: (e) => remove(row, e.currentTarget) },
                }, 'Delete') : null);
        }));
        listStatus.textContent = rows.size ? '' : 'No uploads yet.';
    }

    async function remove(row, button) {
        const ok = await confirmDialog({
            title: 'Delete upload?',
            message: row.status === 'stored'
                ? 'This removes the relay copy only. The file stays in the machine library.'
                : 'The machine will not receive this file.',
            confirmText: 'Delete',
            danger: true,
        });
        if (!ok) return;
        button.disabled = true;
        try {
            await ctx.api.deleteFile(deviceId, row.transferId);
            await load();
        } catch (err) {
            button.disabled = false;
            if (err.status !== 401) toast(apiErrorText(err), 'error');
        }
    }

    async function load() {
        try {
            const [files, devices] = await Promise.all([ctx.api.files(deviceId), role ? null : ctx.api.devices()]);
            if (destroyed) return;
            if (devices) {
                const dev = (Array.isArray(devices) ? devices : []).find((d) => d.id === deviceId);
                role = dev ? dev.role : null;
            }
            rows.clear();
            for (const f of Array.isArray(files) ? files : []) {
                if (f && f.transferId) rows.set(f.transferId, f);
            }
            input.disabled = !(role === 'owner' || role === 'operator');
            if (input.disabled) uploadStatus.textContent = 'Viewers cannot upload files.';
            paint();
        } catch (err) {
            if (destroyed || err.status === 401) return;
            listStatus.textContent = apiErrorText(err);
        }
    }

    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const lower = file.name.toLowerCase();
        if (!EXTENSIONS.some((ext) => lower.endsWith(ext))) {
            toast(errorText('bad_type'), 'error');
            input.value = '';
            return;
        }
        const maxMb = Number(ctx.config().maxUploadMb) || 25;
        if (file.size > maxMb * 1024 * 1024) {
            toast('File is larger than the ' + maxMb + ' MB upload limit', 'error');
            input.value = '';
            return;
        }
        if (file.size === 0) {
            toast('The file is empty', 'error');
            input.value = '';
            return;
        }
        if (!globalThis.crypto || !crypto.subtle) {
            toast('Uploading needs a secure (https) connection', 'error');
            return;
        }
        input.disabled = true;
        progress.hidden = true;
        try {
            uploadStatus.textContent = 'hashing…';
            const buffer = await file.arrayBuffer();
            const sha = await sha256Hex(buffer);
            if (destroyed) return;
            uploadStatus.textContent = 'Uploading ' + file.name + '…';
            setProgress(0);
            const res = await uploadWithProgress(uploadUrl(deviceId, file.name), buffer, sha, setProgress);
            if (destroyed) return;
            const transfer = res && (res.transfer || res);
            if (transfer && transfer.transferId) rows.set(transfer.transferId, { ...transfer, name: transfer.name || file.name });
            uploadStatus.textContent = 'Uploaded ' + file.name + '. ' + (transfer ? statusText(transfer) : '');
            paint();
            load();
        } catch (err) {
            if (destroyed) return;
            if (err && err.status === 401) {
                notifyUnauthorized();
                return;
            }
            const code = err && err.code;
            uploadStatus.textContent = 'Upload failed: ' + (err && err.status === 413 && code === 'http_413' ? 'file too large for the relay' : errorText(code));
        } finally {
            if (!destroyed) {
                input.disabled = false;
                input.value = '';
                progress.hidden = true;
            }
        }
    });

    const unsub = ctx.devices.subscribe((id, kind, body) => {
        if (id !== deviceId || kind !== 'file' || !body) return;
        const prev = rows.get(body.transferId) || {};
        rows.set(body.transferId, { ...prev, ...body, createdAt: prev.createdAt || Date.now() });
        paint();
    });

    ctx.ws.setSubscriptions([deviceId]);
    load();

    return {
        destroy() {
            destroyed = true;
            unsub();
        },
    };
}
