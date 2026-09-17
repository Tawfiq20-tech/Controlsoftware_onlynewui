// Sharing (owner) plus owner machine settings; non-owners can leave (SPEC §4.3, §8.2 item 8).

import { apiErrorText } from '../api.js';
import { confirmDialog, field, h, pageHeader, toast, withBusy } from '../ui.js';

const ROLE_LABEL = { owner: 'Owner', operator: 'Operator', viewer: 'Viewer' };
const ROLE_HELP = {
    operator: 'Operator: camera, uploads, and commands the machine screen allows.',
    viewer: 'Viewer: telemetry, camera, file list, and Stop.',
};

export function render(root, ctx, deviceId) {
    const me = ctx.me();
    let destroyed = false;
    let device = null;

    const body = h('div', null, h('p', { class: 'muted', role: 'status' }, 'Loading…'));
    root.append(h('section', null,
        pageHeader('Sharing & settings', '#/d/' + encodeURIComponent(deviceId), 'Machine'),
        body));

    function paintNonOwner() {
        body.replaceChildren(
            h('div', { class: 'card' },
                h('p', null, 'You have ' + (ROLE_LABEL[device.role] || device.role) + ' access to ' + device.name + '.'),
                h('p', { class: 'muted small' }, ROLE_HELP[device.role] || ''),
                h('button', {
                    type: 'button', class: 'btn btn-danger',
                    on: {
                        click: async (e) => {
                            const btn = e.currentTarget;
                            const ok = await confirmDialog({ title: 'Leave this machine?', message: 'You will lose access until the owner shares it again.', confirmText: 'Leave', danger: true });
                            if (!ok) return;
                            await withBusy(btn, async () => {
                                try {
                                    await ctx.api.removeGrant(deviceId, me.id);
                                    ctx.navigate('#/devices');
                                } catch (err) {
                                    if (err.status !== 401) toast(apiErrorText(err), 'error');
                                }
                            });
                        },
                    },
                }, 'Remove my access')));
    }

    async function paintOwner() {
        let grants = [];
        try {
            grants = await ctx.api.grants(deviceId);
        } catch (err) {
            if (destroyed || err.status === 401) return;
            body.replaceChildren(h('p', { class: 'form-error' }, apiErrorText(err)));
            return;
        }
        if (destroyed) return;

        const grantList = h('ul', { class: 'grant-list' }, (Array.isArray(grants) ? grants : []).map((g) => h('li', { class: 'card row-between' },
            h('div', null,
                h('div', null, g.displayName || g.email),
                h('div', { class: 'muted small' }, (g.email || '') + ' · ' + (ROLE_LABEL[g.role] || g.role))),
            g.role === 'owner' ? null : h('button', {
                type: 'button', class: 'btn btn-small', 'aria-label': 'Remove access for ' + (g.displayName || g.email),
                on: {
                    click: async (e) => {
                        const btn = e.currentTarget;
                        const ok = await confirmDialog({ title: 'Remove access?', message: (g.displayName || g.email) + ' will lose access immediately.', confirmText: 'Remove', danger: true });
                        if (!ok) return;
                        await withBusy(btn, async () => {
                            try {
                                await ctx.api.removeGrant(deviceId, g.userId);
                                paintOwner();
                            } catch (err) {
                                if (err.status !== 401) toast(apiErrorText(err), 'error');
                            }
                        });
                    },
                },
            }, 'Remove'))));

        const email = h('input', { type: 'email', required: true, maxLength: 254, autocomplete: 'off', inputmode: 'email' });
        const role = h('select', null,
            h('option', { value: 'viewer' }, 'Viewer'),
            h('option', { value: 'operator' }, 'Operator'));
        const addError = h('p', { class: 'form-error', role: 'alert' });
        const addBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Share');
        const addForm = h('form', { class: 'card form', novalidate: 'novalidate' },
            h('h2', null, 'Share with someone'),
            field('Their account email', email),
            field('Role', role, ROLE_HELP.viewer + ' ' + ROLE_HELP.operator + ' Motion is always granted on the machine screen.'),
            addError,
            addBtn);
        addForm.addEventListener('submit', (e) => {
            e.preventDefault();
            addError.textContent = '';
            const value = email.value.trim().toLowerCase();
            if (!value) { addError.textContent = 'Enter an email'; return; }
            withBusy(addBtn, async () => {
                try {
                    await ctx.api.addGrant(deviceId, value, role.value);
                    toast('Shared', 'ok');
                    paintOwner();
                } catch (err) {
                    addError.textContent = apiErrorText(err);
                }
            });
        });

        const nameInput = h('input', { type: 'text', maxLength: 60, value: device.name || '' });
        const renameBtn = h('button', { type: 'submit', class: 'btn' }, 'Rename');
        const renameForm = h('form', { class: 'inline-form', novalidate: 'novalidate' },
            h('label', { class: 'inline-field' }, h('span', null, 'Name'), nameInput), renameBtn);
        renameForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = nameInput.value.trim();
            if (name.length < 1 || name.length > 60) { toast('Name must be 1 to 60 characters', 'error'); return; }
            withBusy(renameBtn, async () => {
                try {
                    const res = await ctx.api.rename(deviceId, name);
                    device = { ...device, ...(res && res.device ? res.device : {}), name };
                    toast('Renamed', 'ok');
                } catch (err) {
                    if (err.status !== 401) toast(apiErrorText(err), 'error');
                }
            });
        });

        const rotateBtn = h('button', {
            type: 'button', class: 'btn',
            on: {
                click: (e) => withBusy(e.currentTarget, async () => {
                    try {
                        await ctx.api.rotate(deviceId);
                        toast('The machine is replacing its credential', 'ok');
                    } catch (err) {
                        if (err.status !== 401) toast(apiErrorText(err), 'error');
                    }
                }),
            },
        }, 'Rotate machine credential');

        const unpairBtn = h('button', {
            type: 'button', class: 'btn btn-danger',
            on: {
                click: async (e) => {
                    const btn = e.currentTarget;
                    const ok = await confirmDialog({
                        title: 'Unpair this machine?',
                        message: 'Everyone loses cloud access to it and pending uploads are deleted. The machine must be paired again from its screen.',
                        confirmText: 'Unpair',
                        danger: true,
                    });
                    if (!ok) return;
                    await withBusy(btn, async () => {
                        try {
                            await ctx.api.unpair(deviceId);
                            toast('Machine unpaired', 'ok');
                            ctx.navigate('#/devices');
                        } catch (err) {
                            if (err.status !== 401) toast(apiErrorText(err), 'error');
                        }
                    });
                },
            },
        }, 'Unpair machine');

        body.replaceChildren(
            h('h2', null, 'People with access'),
            grantList,
            addForm,
            h('div', { class: 'card form' },
                h('h2', null, 'Machine'),
                renameForm,
                h('div', { class: 'btn-row' }, rotateBtn),
                h('div', { class: 'btn-row' }, unpairBtn)));
    }

    (async () => {
        try {
            const list = await ctx.api.devices();
            if (destroyed) return;
            device = (Array.isArray(list) ? list : []).find((d) => d.id === deviceId) || null;
            if (!device) {
                body.replaceChildren(h('p', { class: 'card' }, 'This machine is not available.'));
                return;
            }
            if (device.role === 'owner') await paintOwner();
            else paintNonOwner();
        } catch (err) {
            if (!destroyed && err.status !== 401) body.replaceChildren(h('p', { class: 'form-error' }, apiErrorText(err)));
        }
    })();

    return { destroy() { destroyed = true; } };
}
