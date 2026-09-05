/**
 * Settings API client — thin fetch wrappers for the Phase A/B backend routes.
 * One file per section keeps imports cheap.
 */
const BASE = (() => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:4000`;
    }
    return 'http://localhost:4000';
})();

async function jget<T>(path: string): Promise<T> {
    const r = await fetch(`${BASE}${path}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
}
async function jpost<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
}
async function jdelete(path: string): Promise<void> {
    const r = await fetch(`${BASE}${path}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
}

// Webcams
export interface CameraCfg {
    id?: string;
    name: string;
    type: 'mjpeg-url' | 'rtsp' | 'v4l2';
    url?: string;
    device?: string;
    resolution?: string;
    fps?: number;
    quality?: number;
    online?: boolean;
    lastError?: string | null;
}
export const webcam = {
    list: () => jget<CameraCfg[]>('/api/webcam/cameras'),
    upsert: (cfg: CameraCfg) => jpost<CameraCfg>('/api/webcam/cameras', cfg),
    remove: (id: string) => jdelete(`/api/webcam/cameras/${id}`),
    streamUrl: (id: string) => `${BASE}/api/webcam/stream/${id}`,
    snapshotUrl: (id: string) => `${BASE}/api/webcam/snapshot/${id}`,
};

// Gamepad
export interface GamepadBindings {
    enabled: boolean;
    deadzone: number;
    maxFeedrate: number;
    axes: { x: number; y: number; z: number };
    axisInvert: { x: boolean; y: boolean; z: boolean };
    buttons: { home: number; estop: number; cyclestart: number; hold: number; probe: number; mistOn: number };
}
export const gamepad = {
    get: () => jget<GamepadBindings>('/api/gamepad/bindings'),
    set: (b: GamepadBindings) => jpost<GamepadBindings>('/api/gamepad/bindings', b),
};

// WatchDir
export interface WatchDirCfg {
    enabled: boolean;
    path: string;
    extensions: string[];
    pollMs?: number;
}
export const watchdir = {
    getConfig: () => jget<WatchDirCfg>('/api/watchdir/config'),
    setConfig: (c: WatchDirCfg) => jpost<WatchDirCfg>('/api/watchdir/config', c),
    listFiles: () => jget<{ name: string; size: number; mtime: number }[]>('/api/watchdir/files'),
};

// Probing
export interface ProbeStrategyMeta { id: string; name: string; corner: string | null; }
export const probing = {
    strategies: () => jget<ProbeStrategyMeta[]>('/api/probing/strategies'),
    run: (req: { strategy: string; wcs?: string; settings?: Record<string, unknown> }) =>
        jpost<{ success: boolean; updates: unknown; reports: unknown[] }>('/api/probing/run', req),
};

// Job History
export interface JobRecord {
    id: string;
    startedAt: number; endedAt: number; durationMs: number;
    filename: string; gcodeHash: string; gcodeBytes: number; lineCount: number;
    controller: string; wcs: string; toolNumber: number | null;
    outcome: 'ok' | 'fail' | 'aborted'; error: string | null;
}
export const jobhistory = {
    list: (limit = 50) => jget<JobRecord[]>(`/api/jobhistory?limit=${limit}`),
    stats: () => jget<{ total: number; ok: number; fail: number; aborted: number; totalMs: number }>('/api/jobhistory/stats'),
    deleteOne: (id: string) => jdelete(`/api/jobhistory/${id}`),
    clear: () => jdelete('/api/jobhistory'),
};

// Tool Library
export interface ToolDef {
    number: number;
    name: string;
    diameter: number;
    flutes: number;
    stickout: number;
    material: 'hss' | 'carbide' | 'diamond' | string;
    coating: 'none' | 'TiN' | 'TiAlN' | string;
    defaultFeed: number;
    defaultPlunge: number;
    defaultRpm: number;
    defaultStepdown: number;
    defaultStepover: number;
    length: number;
    notes?: string;
}
export const toollib = {
    list: () => jget<ToolDef[]>('/api/toollib'),
    upsert: (t: ToolDef) => jpost<ToolDef>('/api/toollib', t),
    remove: (n: number) => jdelete(`/api/toollib/${n}`),
};

// WhatsApp notifications
export type WhatsAppState = 'disabled' | 'init' | 'qr' | 'ready' | 'auth_failed' | 'disconnected';
export type WhatsAppEventKey =
    'connected' | 'disconnected' |
    'job:start' | 'job:pause' | 'job:resume' | 'job:end' | 'job:stop' | 'job:error' |
    'alarm' | 'emergency';
export interface WhatsAppCfg {
    enabled: boolean;
    recipients: string[];
    events: WhatsAppEventKey[];
    minIntervalSec: number;
    includePosition: boolean;
}
export interface WhatsAppStatus {
    state: WhatsAppState;
    qrDataUrl: string | null;
    config: WhatsAppCfg;
}
export const whatsapp = {
    status:   () => jget<WhatsAppStatus>('/api/whatsapp/status'),
    enable:   () => jpost<WhatsAppStatus>('/api/whatsapp/enable', {}),
    disable:  () => jpost<WhatsAppStatus>('/api/whatsapp/disable', {}),
    addRecipient:    (phone: string) => jpost<{ recipients: string[] }>('/api/whatsapp/recipients', { phone }),
    removeRecipient: (phone: string) => jdelete(`/api/whatsapp/recipients/${encodeURIComponent(phone)}`),
    setEvents:  (events: WhatsAppEventKey[]) => jpost<WhatsAppCfg>('/api/whatsapp/events', { events }),
    setConfig:  (patch: Partial<Pick<WhatsAppCfg, 'minIntervalSec' | 'includePosition'>>) =>
        jpost<WhatsAppCfg>('/api/whatsapp/config', patch),
    test: () => jpost<{ results: { phone: string; ok: boolean; error?: string }[] }>('/api/whatsapp/test', {}),
};

// Telegram bot
export type TelegramState = 'disabled' | 'init' | 'ready' | 'auth_failed' | 'reconnecting';
export interface TelegramCfg {
    token: string;               // redacted (•••• + last 4) on read
    allowedChatIds: number[];
    openMode: boolean;
    botEnabled: boolean;
    botEyeCameraId: string | null;
    enabled: boolean;
}
export interface TelegramStatus {
    state: TelegramState;
    info: string;
    config: TelegramCfg;
}
export const telegram = {
    status:  () => jget<TelegramStatus>('/api/telegram/status'),
    enable:  () => jpost<{ ok: boolean; username?: string }>('/api/telegram/enable', {}),
    disable: () => jpost<{ ok: boolean }>('/api/telegram/disable', {}),
    setConfig: (patch: Partial<TelegramCfg>) =>
        jpost<TelegramCfg>('/api/telegram/config', patch),
    test:    () => jpost<{ ok: boolean; sent: number }>('/api/telegram/test', {}),
};

// Config (general settings)
export interface PreferencesPatch {
    units?: 'mm' | 'in';
    jogSpeed?: number;
    safeHeight?: number;
    baudRate?: number;
    reconnectAutomatically?: boolean;
}
export const config = {
    get: (key: string) => jget<{ key: string; value: unknown }>(`/api/config/${key}`),
    set: (key: string, value: unknown) =>
        jpost<{ ok: true }>('/api/config', { key, value }),
};
