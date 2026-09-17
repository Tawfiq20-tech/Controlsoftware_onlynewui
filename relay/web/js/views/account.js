// Account: sessions, password, logout; invites for relay admins (SPEC §4.3, §8.2 item 9).

import { apiErrorText } from '../api.js';
import { confirmDialog, field, fmtDateTime, h, toast, withBusy } from '../ui.js';

export function render(root, ctx) {
    const me = ctx.me();
    let destroyed = false;

    const sessionList = h('ul', { class: 'session-list' });
    const sessionStatus = h('p', { class: 'muted', role: 'status' }, 'Loading…');

    async function loadSessions() {
        try {
            const list = await ctx.api.sessions();
            if (destroyed) return;
            const rows = Array.isArray(list) ? list : [];
            sessionStatus.textContent = rows.length ? '' : 'No sessions';
            sessionList.replaceChildren(...rows.map((s) => h('li', { class: 'card row-between' },
                h('div', null,
                    h('div', null, (s.userAgent || 'Unknown browser') + (s.current ? ' (this device)' : '')),
                    h('div', { class: 'muted small' },
                        [s.ip, s.lastSeenAt ? 'active ' + fmtDateTime(s.lastSeenAt) : null, s.createdAt ? 'signed in ' + fmtDateTime(s.createdAt) : null].filter(Boolean).join(' · '))),
                s.current ? null : h('button', {
                    type: 'button', class: 'btn btn-small', 'aria-label': 'Sign out this session',
                    on: {
                        click: async (e) => {
                            const btn = e.currentTarget;
                            const ok = await confirmDialog({ title: 'Sign out that device?', message: 'Its open pages are disconnected immediately and any jog it holds is cancelled.', confirmText: 'Sign out', danger: true });
                            if (!ok) return;
                            await withBusy(btn, async () => {
                                try {
                                    await ctx.api.revokeSession(s.id);
                                    loadSessions();
                                } catch (err) {
                                    if (err.status !== 401) toast(apiErrorText(err), 'error');
                                }
                            });
                        },
                    },
                }, 'Sign out'))));
        } catch (err) {
            if (!destroyed && err.status !== 401) sessionStatus.textContent = apiErrorText(err);
        }
    }

    const current = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxLength: 200 });
    const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, maxLength: 200, minlength: '10' });
    const confirmNext = h('input', { type: 'password', autocomplete: 'new-password', required: true, maxLength: 200 });
    const pwError = h('p', { class: 'form-error', role: 'alert' });
    const pwBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change password');
    const pwForm = h('form', { class: 'card form', novalidate: 'novalidate' },
        h('h2', null, 'Change password'),
        field('Current password', current),
        field('New password', next, 'At least 10 characters. Other devices are signed out.'),
        field('Repeat new password', confirmNext),
        pwError,
        pwBtn);
    pwForm.addEventListener('submit', (e) => {
        e.preventDefault();
        pwError.textContent = '';
        if (next.value.length < 10) { pwError.textContent = 'The new password must be at least 10 characters'; return; }
        if (next.value !== confirmNext.value) { pwError.textContent = 'The new passwords do not match'; return; }
        withBusy(pwBtn, async () => {
            try {
                await ctx.api.changePassword(current.value, next.value);
                current.value = next.value = confirmNext.value = '';
                toast('Password changed; other devices were signed out', 'ok');
                loadSessions();
            } catch (err) {
                pwError.textContent = err.status === 401 || err.code === 'invalid_credentials'
                    ? 'The current password is incorrect'
                    : apiErrorText(err);
            }
        });
    });

    let adminBlock = null;
    if (me && me.isAdmin) {
        const count = h('input', { type: 'number', min: 1, max: 20, value: '1', inputmode: 'numeric' });
        const days = h('input', { type: 'number', min: 1, max: 30, value: '7', inputmode: 'numeric' });
        const codes = h('ul', { class: 'code-list', 'aria-live': 'polite' });
        const inviteBtn = h('button', { type: 'submit', class: 'btn' }, 'Create invite codes');
        adminBlock = h('form', { class: 'card form', novalidate: 'novalidate' },
            h('h2', null, 'Invite codes (admin)'),
            field('How many', count),
            field('Valid for (days)', days),
            inviteBtn,
            codes);
        adminBlock.addEventListener('submit', (e) => {
            e.preventDefault();
            const n = Number(count.value);
            const d = Number(days.value);
            if (!Number.isInteger(n) || n < 1 || n > 20 || !Number.isInteger(d) || d < 1 || d > 30) {
                toast('Use 1–20 codes valid for 1–30 days', 'error');
                return;
            }
            withBusy(inviteBtn, async () => {
                try {
                    const res = await ctx.api.createInvites(n, d);
                    codes.replaceChildren(...((res && res.codes) || []).map((c) => h('li', { class: 'mono' }, c)));
                } catch (err) {
                    if (err.status !== 401) toast(apiErrorText(err), 'error');
                }
            });
        });
    }

    const logoutBtn = h('button', { type: 'button', class: 'btn btn-danger btn-block' }, 'Log out');
    logoutBtn.addEventListener('click', () => withBusy(logoutBtn, () => ctx.logout()));

    root.append(h('section', null,
        h('h1', null, 'Account'),
        h('div', { class: 'card' },
            h('div', null, me ? me.displayName : ''),
            h('div', { class: 'muted small' }, me ? me.email : '')),
        h('h2', null, 'Signed-in devices'),
        sessionStatus,
        sessionList,
        pwForm,
        adminBlock,
        logoutBtn));

    loadSessions();
    return { destroy() { destroyed = true; } };
}
