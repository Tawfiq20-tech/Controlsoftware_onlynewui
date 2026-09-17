// Boot + hash router (SPEC §8.2).

import { api, setCsrfToken, setUnauthorizedHandler } from './api.js';
import { createWsClient } from './ws.js';
import { createDeviceStore, createStore } from './store.js';
import { closeAllModals, h, toast } from './ui.js';

import * as loginView from './views/login.js';
import * as registerView from './views/register.js';
import * as devicesView from './views/devices.js';
import * as pairView from './views/pair.js';
import * as deviceView from './views/device.js';
import * as filesView from './views/files.js';
import * as auditView from './views/audit.js';
import * as sharingView from './views/sharing.js';
import * as accountView from './views/account.js';

const ID = '([A-Za-z0-9_-]{1,40})';

const ROUTES = [
    { re: /^\/login$/, view: loginView, auth: false },
    { re: /^\/register$/, view: registerView, auth: false },
    { re: /^\/devices$/, view: devicesView, auth: true },
    { re: /^\/pair$/, view: pairView, auth: true },
    { re: new RegExp('^/d/' + ID + '$'), view: deviceView, auth: true },
    { re: new RegExp('^/d/' + ID + '/files$'), view: filesView, auth: true },
    { re: new RegExp('^/d/' + ID + '/audit$'), view: auditView, auth: true },
    { re: new RegExp('^/d/' + ID + '/sharing$'), view: sharingView, auth: true },
    { re: /^\/account$/, view: accountView, auth: true },
];

const DEFAULT_CONFIG = { signup: 'closed', protocol: 1, maxUploadMb: 25, snapshotMaxFps: 2 };

const app = createStore({ me: null, config: DEFAULT_CONFIG, booted: false });
const devices = createDeviceStore();

let current = null;       // {destroy}
let authLostShown = false;

const ws = createWsClient({
    onAuthLost: () => handleAuthLost(),
    probeAuth: async () => {
        const r = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
        return { status: r.status, retryAfterSec: Number(r.headers.get('Retry-After')) || 0 };
    },
});

ws.on('message', (msg) => devices.apply(msg));
ws.on('close', () => devices.markAllUnknown());
ws.on('status', () => renderConnBadge());

function navigate(hash, { replace = false } = {}) {
    if (location.hash === hash) {
        render();
        return;
    }
    if (replace) {
        history.replaceState(null, '', hash);
        render();
    } else {
        location.hash = hash;
    }
}

function handleAuthLost() {
    const wasSignedIn = !!app.get().me;
    ws.disconnect();
    setCsrfToken(null);
    devices.clear();
    app.set({ me: null });
    if (wasSignedIn && !authLostShown) {
        authLostShown = true;
        toast('You were signed out', 'info');
        setTimeout(() => { authLostShown = false; }, 3000);
    }
    navigate('#/login', { replace: true });
}

setUnauthorizedHandler(handleAuthLost);

const ctx = {
    api,
    ws,
    app,
    devices,
    navigate,
    config: () => app.get().config,
    me: () => app.get().me,
    onLogin(user, csrfToken) {
        setCsrfToken(csrfToken);
        app.set({ me: user });
        ws.connect();
        navigate('#/devices', { replace: true });
    },
    async logout() {
        try { await api.logout(); } catch (_) { /* the session may already be gone */ }
        ws.disconnect();
        setCsrfToken(null);
        devices.clear();
        app.set({ me: null });
        navigate('#/login', { replace: true });
    },
};

const root = document.getElementById('app');
const navBar = document.getElementById('topbar');
let connBadge = null;

function renderNav() {
    const me = app.get().me;
    navBar.replaceChildren();
    if (!me) {
        navBar.hidden = true;
        return;
    }
    navBar.hidden = false;
    connBadge = h('span', { class: 'conn', role: 'status', 'aria-live': 'polite' });
    navBar.append(
        h('a', { href: '#/devices', class: 'brand' }, 'Onefinity Remote'),
        h('nav', { class: 'topnav', 'aria-label': 'Main' },
            h('a', { href: '#/devices' }, 'Machines'),
            h('a', { href: '#/account' }, 'Account')),
        connBadge,
    );
    renderConnBadge();
}

function renderConnBadge() {
    if (!connBadge) return;
    const st = ws.getStatus();
    let label = 'Offline';
    let cls = 'bad';
    if (st.live && st.synced) { label = 'Connected'; cls = 'ok'; }
    else if (st.live) { label = 'Syncing'; cls = 'warn'; }
    else if (st.state === 'connecting' || st.state === 'reconnecting' || st.state === 'open') { label = 'Reconnecting'; cls = 'warn'; }
    connBadge.className = 'conn conn-' + cls;
    connBadge.textContent = label;
}

function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    return raw.startsWith('/') ? raw.split('?')[0] : '/devices';
}

function render() {
    if (!app.get().booted) return;
    const path = parseHash();
    const me = app.get().me;
    let match = null;
    let route = null;
    for (const r of ROUTES) {
        match = r.re.exec(path);
        if (match) { route = r; break; }
    }
    if (!route) {
        navigate(me ? '#/devices' : '#/login', { replace: true });
        return;
    }
    if (route.auth && !me) {
        navigate('#/login', { replace: true });
        return;
    }
    if (!route.auth && me) {
        navigate('#/devices', { replace: true });
        return;
    }

    if (current && typeof current.destroy === 'function') {
        try { current.destroy(); } catch (err) { console.error('[router] destroy', err); }
    }
    current = null;
    // A dialog belongs to the page that opened it; never leave a backdrop
    // (or a pending confirm) over the next page.
    closeAllModals();
    renderNav();
    root.replaceChildren();
    const params = match.slice(1).map(decodeURIComponent);
    try {
        current = route.view.render(root, ctx, ...params) || null;
    } catch (err) {
        console.error('[router] render', err);
        root.replaceChildren(h('p', { class: 'empty' }, 'This page failed to load. Reload to try again.'));
    }
    const heading = root.querySelector('h1');
    if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
}

function installLifecycle() {
    window.addEventListener('hashchange', render);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') ws.onResume({ suspended: true });
    });
    window.addEventListener('pageshow', (e) => ws.onResume({ suspended: !!e.persisted }));
    window.addEventListener('online', () => ws.onResume());
}

async function boot() {
    installLifecycle();
    root.replaceChildren(h('p', { class: 'empty', role: 'status' }, 'Loading…'));
    let config = DEFAULT_CONFIG;
    try {
        const c = await api.config();
        if (c && typeof c === 'object') config = { ...DEFAULT_CONFIG, ...c };
    } catch (_) { /* keep defaults; login still works */ }

    let me = null;
    try {
        const res = await api.me();
        if (res && res.user) {
            me = res.user;
            setCsrfToken(res.csrfToken);
        }
    } catch (err) {
        if (err.status !== 401) toast('Cannot reach the relay; retrying when you act', 'error');
    }
    app.set({ config, me, booted: true });
    if (me) ws.connect();
    render();
}

boot();
