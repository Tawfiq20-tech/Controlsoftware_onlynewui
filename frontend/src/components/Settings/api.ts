/**
 * Settings API client — thin fetch wrappers for the Phase A/B backend routes.
 * One file per section keeps imports cheap.
 */
import { remoteAuthHeaders } from '../../utils/remoteAuth';

const BASE = (() => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname, port, origin } = window.location;
        if (port === '5173') return `${protocol}//${hostname}:4000`;
        if (port === '4000') return `${protocol}//${hostname}:4000`;
        return origin;
    }
    return 'http://localhost:4000';
})();

/** Error carrying the backend's `{ error }` message when it sent one. */
async function failure(r: Response): Promise<Error> {
    const body = await r.json().catch(() => null) as { error?: string } | null;
    if (body?.error === 'operator_required') {
        return new Error('Only the machine operator (the control PC kiosk) can change this setting');
    }
    return new Error(body?.error || `${r.status} ${r.statusText}`);
}

// The kiosk page (port 3000) talks to the backend (port 4000) cross-origin, so
// the HttpOnly operator cookie is only sent when credentials are included.
async function jget<T>(path: string): Promise<T> {
    const r = await fetch(`${BASE}${path}`, {
        credentials: 'include',
        headers: { ...remoteAuthHeaders() },
    });
    if (!r.ok) throw await failure(r);
    return r.json();
}
async function jpost<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${BASE}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...remoteAuthHeaders(),
        },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw await failure(r);
    // 204 routes (pairing reject) have no body to parse.
    if (r.status === 204) return undefined as T;
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
}
async function jdelete(path: string): Promise<void> {
    const r = await fetch(`${BASE}${path}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { ...remoteAuthHeaders() },
    });
    if (!r.ok) throw await failure(r);
}

export const API_BASE = BASE;

// Webcams
export interface CameraDevice {
    id: string;
    name: string;
    type: string;
    device?: string;
    instanceId?: string;
}

export interface CameraCfg {
    id?: string;
    name: string;
    type: 'mjpeg-url' | 'rtsp' | 'v4l2' | 'usb';
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
    detectDevices: () => jget<{ devices: CameraDevice[] }>('/api/webcam/devices'),
    autoDetect: () => jpost<{ ok: boolean; camera?: CameraCfg; created?: boolean; error?: string }>('/api/webcam/auto-detect', {}),
    upsert: (cfg: CameraCfg) => jpost<CameraCfg>('/api/webcam/cameras', cfg),
    remove: (id: string) => jdelete(`/api/webcam/cameras/${id}`),
    postFrame: async (id: string, blob: Blob) => {
        try {
            await fetch(`${BASE}/api/webcam/frame/${id}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'image/jpeg', ...remoteAuthHeaders() },
                body: blob,
            });
        } catch (_) {}
    },
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

// Remote access — same Wi-Fi (LAN) or anywhere via Tailscale, optional PIN.
export interface RemoteInfo {
    authorized: boolean;
    /** True when this browser is on the machine's own PC (may change settings). */
    operator: boolean;
    pinSet: boolean;
    minPinLength: number;
    port?: number;
    ips?: string[];
    lanUrl?: string | null;
    lanUrls?: string[];
    unifiedUrl?: string;
    activeSessions?: number;
    /** Where the LAN PIN came from; the code itself is never in this payload. */
    pinSource?: 'custom' | 'access-code' | null;
    accessCodeActive?: boolean;
    /** Identity kind of this browser as resolved by the backend (Decision D1). Field name matches backend/index.js GET /api/remote/info. */
    identityKind?: 'operator' | 'local' | 'lan' | 'cloud' | 'none';
    /** Same value as identityKind (newer backends send both). */
    identity?: 'operator' | 'local' | 'lan' | 'cloud' | 'none';
    /** device-identity.json cannot be read: remote/cloud features are LAN-only until it can. */
    deviceIdentityUnavailable?: boolean;
}

export type TailscaleState =
    'not-installed' | 'needs-login' | 'stopped' | 'service-stopped' | 'starting' | 'running' | 'error';

export interface TailscaleWarning {
    code: string;
    level: 'error' | 'warn' | 'info';
    message: string;
    action?: { label: string; url?: string; fix?: 'firewall' };
}

export interface TailscalePeer {
    name: string;
    os: string;
    online: boolean;
    ip: string | null;
}

export interface TailscaleStatus {
    installed: boolean;
    state: TailscaleState;
    error?: string;
    version?: string | null;
    ipv4: string | null;
    dnsName?: string | null;
    tailnet?: string | null;
    keyExpiry?: number | null;
    authUrl?: string | null;
    url: string | null;
    dnsUrl: string | null;
    peers: TailscalePeer[];
    unattended?: boolean | null;
    firewall?: 'present' | 'missing' | 'unknown' | 'not-applicable';
    downloadUrl?: string;
    adminUrl?: string;
    warnings: TailscaleWarning[];
}

export interface RemoteSession {
    id: string;
    ip: string;
    device: string;
    via: 'tailscale' | 'lan';
    createdAt: number;
    lastSeen: number;
    expiresAt: number;
}

export const remote = {
    info: () => jget<RemoteInfo>('/api/remote/info'),
    tailscale: (refresh = false) => jget<TailscaleStatus>(`/api/remote/tailscale${refresh ? '?refresh=1' : ''}`),
    qr: (url: string) => jget<{ url: string; dataUrl: string }>(`/api/remote/qr?url=${encodeURIComponent(url)}`),
    setPin: (pin: string) => jpost<{ ok: true }>('/api/remote/pin', { pin }),
    clearPin: () => jdelete('/api/remote/pin'),
    verifyPin: (pin: string) => jpost<{ token: string }>('/api/remote/verify-pin', { pin }),
    sessions: () => jget<{ count: number; sessions: RemoteSession[] }>('/api/remote/sessions'),
    revokeSession: (id: string) => jdelete(`/api/remote/sessions/${encodeURIComponent(id)}`),
    revokeSessions: () => jpost<{ ok: true }>('/api/remote/sessions/revoke', {}),
    fixFirewall: () => jpost<{ ok: boolean; error?: string }>('/api/remote/firewall/fix', {}),
};

// Cloud relay + LAN identity (docs/cloud-relay/SPEC.md §5.1.1, §3.4.3, §7.2).
// Shapes are shared with backend/services/cloudLink and must match it exactly.

export interface CloudStatus {
    enabled: boolean;
    lanOnly: boolean;
    relayUrl: string | null;
    paired: boolean;
    relayDeviceId: string | null;
    accountLabel: string | null;
    pairedAt: number | null;
    state: 'disabled' | 'lan-only' | 'unpaired' | 'pairing' | 'connecting' | 'online' | 'backoff' | 'auth-failed';
    since: number;                 // ms when state last changed
    rttMs: number | null;          // machine<->relay, median of last 5
    viewers: number;
    nextRetryAt: number | null;
    lastError: string | null;      // human text, no secrets
    /** Stored remote-file limits (operator view). Optional until every backend reports them. */
    maxFileMb?: number;
    cloudLibraryCapMb?: number;
}

/** Partial limits update: omitted fields keep their stored value on the backend. */
export interface CloudLimitsUpdate {
    maxFileMb?: number;
    cloudLibraryCapMb?: number;
}

export type RemoteChannel = 'lan' | 'cloud';

export type RemoteLock =
    'alarm' | 'disconnected' | 'no-controller' | 'board-link-down' | 'lan-only' | 'host-busy' | 'local-activity';

export type MotionScope = { channel: 'lan' } | { channel: 'cloud'; userId?: string | null };

/** `report.tier` body; the operator view adds `scope.motion.userLabel` and `jobControl`. */
export interface TierState {
    tier: 'monitor' | 'job' | 'motion';
    jobControlEnabled: boolean;
    motionExpiresAt: number | null;   // machine wall clock, display only
    motionRemainingMs: number | null; // monotonic, authoritative
    serverNow: number;
    scope: {
        jobControl: RemoteChannel[];
        motion: { channel: RemoteChannel; userId: string | null; userLabel?: string | null } | null;
    };
    locks: RemoteLock[];
    capabilities: {
        jogStep: boolean;
        jogContinuous: boolean;
        jogCancel: boolean;
        zero: boolean;
        home: boolean;
        spindle: boolean;
        feedOverride: 'real' | 'unverified' | 'none';
        start: boolean;
        load: boolean;
        files: boolean;
        snapshot: boolean;
    };
    limits: {
        jogStepMaxMm: number;
        jogStepMaxFeed: number;
        jogContMaxFeed: number;
        maxRttMs: number;
        deadmanMs: number;
        keepaliveMs: number;
    };
    activeJog: { jogId: string; userLabel: string | null; axis: 'x' | 'y' | 'z'; dir: 1 | -1 } | null;
    stats: { deadmanCancels: number; keepaliveGapP99Ms: number | null };
    stopUnconfirmedAt?: number;
    jobControl?: { lan: boolean; cloud: boolean };
}

export type ActiveJog = NonNullable<TierState['activeJog']>;

export type PairingView =
    | { state: 'pending'; code: string; expiresAt: number }
    | { state: 'claimed'; accountLabel: string; accountDisplayName: string; deviceId: string }
    | { state: 'rejected' | 'expired' };

export interface MdnsStatus {
    state: 'stopped' | 'running' | 'unavailable' | 'conflict';
    hostname: string;
    addresses: string[];
    error: string | null;
}

export interface DeviceView {
    /** null while the identity file is unreadable (unavailable === true). */
    deviceId: string | null;
    displayId: string | null;
    name: string;
    mdnsHostname: string | null;
    lanOnly: boolean;
    /** device-identity.json exists but cannot be read (locked by OneDrive/antivirus, ...). */
    unavailable?: boolean;
    unavailableCode?: string;
    mdns: MdnsStatus;
    // Operator-only fields.
    accessCode?: string;
    accessCodeActive?: boolean;
    pinSource?: 'custom' | 'access-code' | null;
    corruptRecovered?: boolean;
}

export interface RemoteAuditEntry {
    ts: number;
    kind: 'operator' | 'local' | 'lan' | 'cloud' | string;
    event:
        'cmd' | 'jog.cancel' | 'tier.job' | 'tier.motion.grant' | 'tier.motion.revoke' | 'tier.motion.expire' |
        'file.stored' | 'file.rejected' | 'file.deferred' | 'file.reviewed' | 'link.down' | 'link.up' |
        'stop.unconfirmed' | 'spindle.auto-off';
    userId?: string | null;
    userLabel?: string | null;
    connId?: string | null;
    sessionRef?: string | null;
    type?: string;
    args?: Record<string, unknown>;
    status?: 'accepted' | 'rejected' | 'failed';
    code?: string;
    message?: string | null;
    /** Set on gate entries for replayed idem commands. */
    duplicate?: boolean;
    channel?: RemoteChannel;
    enabled?: boolean;
    reason?: string;
    scope?: MotionScope;
}

/** Library entry provenance for files staged through the relay (§5.7). */
export interface LibraryProvenance {
    origin: 'cloud';
    uploadedBy: string;
    uploadedByUserId?: string;
    transferId?: string;
    sha256?: string;
    receivedAt: number;
    reviewed: boolean;
}

export interface LibraryEntry {
    id: string;
    name: string;
    fileName: string;
    size: number;
    lineCount?: number;
    savedAt: string;     // ISO
    provenance?: LibraryProvenance | null;
}

export const library = {
    list: () => jget<LibraryEntry[]>('/api/library'),
    remove: (id: string) => jdelete(`/api/library/${encodeURIComponent(id)}`),
};

export const isRemoteUpload = (e: Pick<LibraryEntry, 'provenance'>): boolean => e.provenance?.origin === 'cloud';

export const remoteCloud = {
    device: () => jget<DeviceView>('/api/remote/device'),
    rename: (name: string) => jpost<DeviceView>('/api/remote/device/name', { name }),
    regenerateAccessCode: () => jpost<{ accessCode: string }>('/api/remote/access-code/regenerate', {}),
    useAccessCode: () => jpost<{ accessCode: string }>('/api/remote/access-code/use', {}),
    setLanOnly: (enabled: boolean) => jpost<{ lanOnly: boolean }>('/api/remote/lan-only', { enabled }),
    status: () => jget<CloudStatus>('/api/remote/cloud/status'),
    setRelayUrl: (relayUrl: string) => jpost<CloudStatus>('/api/remote/cloud/config', { relayUrl }),
    setEnabled: (enabled: boolean) => jpost<CloudStatus>('/api/remote/cloud/enabled', { enabled }),
    startPairing: () => jpost<{ code: string; expiresAt: number }>('/api/remote/cloud/pairing', {}),
    getPairing: () => jget<PairingView | {}>('/api/remote/cloud/pairing'),
    cancelPairing: () => jdelete('/api/remote/cloud/pairing'),
    confirmPairing: () => jpost<CloudStatus>('/api/remote/cloud/pairing/confirm', {}),
    rejectPairing: () => jpost<void>('/api/remote/cloud/pairing/reject', {}),
    unpair: () => jpost<CloudStatus>('/api/remote/cloud/unpair', {}),
    setLimits: (limits: CloudLimitsUpdate) => jpost<CloudStatus>('/api/remote/cloud/limits', limits),
    recentUsers: () => jget<{ userId: string; userLabel: string; lastSeenAt: number }[]>('/api/remote/cloud/recent-users'),
    permissions: () => jget<TierState>('/api/remote/permissions'),
    setJobControl: (channel: 'lan' | 'cloud', enabled: boolean) => jpost<TierState>('/api/remote/permissions/job-control', { channel, enabled }),
    grantMotion: (minutes: 5 | 15 | 30, scope: MotionScope) => jpost<TierState>('/api/remote/permissions/motion', { minutes, scope }),
    revokeMotion: () => jdelete('/api/remote/permissions/motion'),
    audit: (limit = 100) => jget<RemoteAuditEntry[]>(`/api/remote/audit?limit=${limit}`),
    reviewLibraryEntry: (id: string) => jpost<unknown>(`/api/library/${encodeURIComponent(id)}/review`, {}),
};

/* ── Wi-Fi (kiosk network setup; operator-only on the backend) ───────── */

export interface WifiNetwork {
    ssid: string;
    signal: number;
    security: string;
    open: boolean;
    inUse: boolean;
    saved: boolean;
}

export interface WifiStatus {
    supported: boolean;
    /** Why Wi-Fi setup isn't offered here (only when supported is false). */
    reason?: string;
    radioOn?: boolean;
    hasAdapter?: boolean;
    device?: string | null;
    connected?: { ssid: string; signal: number | null; security: string | null } | null;
    ethernet?: { connected: boolean; name: string | null } | null;
    addresses?: string[];
}

export const wifi = {
    status: () => jget<WifiStatus>('/api/wifi/status'),
    scan: (rescan = true) => jpost<{ ok: boolean; networks: WifiNetwork[]; error?: string }>('/api/wifi/scan', { rescan }),
    connect: (ssid: string, password?: string, hidden = false) =>
        jpost<{ ok: boolean; ssid?: string; error?: string }>('/api/wifi/connect', { ssid, password, hidden }),
    disconnect: () => jpost<{ ok: boolean; error?: string }>('/api/wifi/disconnect', {}),
    forget: (ssid: string) => jpost<{ ok: boolean; error?: string }>('/api/wifi/forget', { ssid }),
    radio: (on: boolean) => jpost<{ ok: boolean; radioOn?: boolean; error?: string }>('/api/wifi/radio', { on }),
};
