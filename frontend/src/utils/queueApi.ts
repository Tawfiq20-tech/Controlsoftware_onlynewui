/**
 * The design queue's REST calls (backend/services/queue/QueueService.js).
 *
 * The queue's STATE never comes from here: the backend pushes `queue:state`
 * on every change and the store holds it, so two screens watching the same
 * machine always show the same thing. These are the actions only.
 *
 * None of these routes are on the LAN allowlist, so a phone gets 403 and the
 * caller shows why rather than leaving a dead button.
 */
import { remoteAuthHeaders } from './remoteAuth';
import type { QueueView } from '../stores/cncStore';

const BASE = (() => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname, port, origin } = window.location;
        if (port === '5173' || port === '4000') return `${protocol}//${hostname}:4000`;
        return origin;
    }
    return 'http://localhost:4000';
})();

export interface QueueResult {
    ok: boolean;
    error?: string;
    message?: string;
    state?: QueueView;
}

/** Never throws: every caller shows `error` next to the button that was tapped. */
async function call(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<QueueResult> {
    try {
        const r = await fetch(`${BASE}${path}`, {
            method,
            credentials: 'include',
            headers: {
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...remoteAuthHeaders(),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await r.text();
        const parsed = (text ? JSON.parse(text) : {}) as QueueResult;
        if (r.ok) return { ...parsed, ok: true };
        if (r.status === 403) {
            return {
                ok: false,
                error: parsed.error === 'operator_required'
                    ? 'Only the machine’s own screen can change this'
                    : 'The queue can only be used at the machine',
            };
        }
        return { ...parsed, ok: false, error: parsed.message || parsed.error || `${r.status} ${r.statusText}` };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

export const queueApi = {
    get: () => call('/api/queue', 'GET'),
    add: (libraryId: string) => call('/api/queue', 'POST', { libraryId }),
    remove: (entryId: string) => call(`/api/queue/${entryId}`, 'DELETE'),
    move: (entryId: string, delta: -1 | 1) => call(`/api/queue/${entryId}/move`, 'POST', { delta }),
    clear: () => call('/api/queue/clear', 'POST', {}),
    reset: () => call('/api/queue/reset', 'POST', {}),
    arm: (armed: boolean) => call('/api/queue/arm', 'POST', { armed }),
    /** The tap that starts the design waiting at the gate. */
    start: () => call('/api/queue/start', 'POST', {}),
    /** Auto mode: stop the countdown and wait for a tap instead. */
    hold: () => call('/api/queue/hold', 'POST', {}),
    skip: () => call('/api/queue/skip', 'POST', {}),
    /**
     * Auto mode is refused unless the caller acknowledges that this machine
     * cannot switch the router -- see the note the operator has to confirm in
     * QueuePanel.
     */
    setMode: (mode: 'gate' | 'auto', routerStaysRunningAcknowledged = false) =>
        call('/api/queue/mode', 'POST', { mode, routerStaysRunningAcknowledged }),
    setDelay: (seconds: number) => call('/api/queue/delay', 'POST', { seconds }),
};

export default queueApi;
