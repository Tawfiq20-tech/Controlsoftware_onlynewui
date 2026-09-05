/**
 * SectionNotifications — WhatsApp live job updates.
 *
 * Lets the user enable WhatsApp on the backend (which boots whatsapp-web.js
 * over a headless Chromium), shows the pairing QR until scanned, then lets
 * them add recipient phone numbers (E.164) and pick which job events trigger
 * a message.
 *
 * Uses a dedicated Socket.IO connection so live status/QR updates stream in
 * without polling. Falls back to REST for one-time reads.
 */
import { useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { MessageCircle, RefreshCw, Plus, Trash2, Send, Power, AlertCircle } from 'lucide-react';
import { whatsapp, WhatsAppStatus, WhatsAppCfg, WhatsAppEventKey, WhatsAppState } from './api';

const EVENT_OPTIONS: { key: WhatsAppEventKey; label: string; hint: string }[] = [
    { key: 'connected',    label: 'Machine connected',     hint: 'Controller comes online' },
    { key: 'disconnected', label: 'Machine disconnected',  hint: 'Controller goes offline' },
    { key: 'job:start',    label: 'Job started',           hint: 'A G-code program begins' },
    { key: 'job:pause',    label: 'Job paused',            hint: 'User presses pause' },
    { key: 'job:resume',   label: 'Job resumed',           hint: 'User presses resume' },
    { key: 'job:end',      label: 'Job completed',         hint: 'G-code finishes successfully' },
    { key: 'job:stop',     label: 'Job stopped',           hint: 'User stops mid-job' },
    { key: 'job:error',    label: 'Job error',             hint: 'Sender or controller fault' },
    { key: 'alarm',        label: 'Alarm',                 hint: 'GRBL/ESP3D alarm fires' },
    { key: 'emergency',    label: 'Emergency stop',        hint: 'E-stop or motor fault' },
];

const STATE_PILL: Record<WhatsAppState, { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
    disabled:     { label: 'Disabled',         tone: 'idle' },
    init:         { label: 'Starting…',        tone: 'warn' },
    qr:           { label: 'Scan QR',          tone: 'warn' },
    ready:        { label: 'Connected',        tone: 'ok' },
    auth_failed:  { label: 'Auth failed',      tone: 'bad' },
    disconnected: { label: 'Disconnected',     tone: 'bad' },
};

function pickBackendHost() {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return env.replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:4000`;
    }
    return 'http://localhost:4000';
}

export default function SectionNotifications() {
    const [status, setStatus] = useState<WhatsAppStatus | null>(null);
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [phoneDraft, setPhoneDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<string | null>(null);

    // Socket subscription for live updates
    useEffect(() => {
        let socket: Socket | null = null;
        try {
            socket = io(pickBackendHost(), {
                path: '/socket.io',
                transports: ['websocket', 'polling'],
                reconnection: true,
            });
            socket.on('whatsapp:status', (msg: { state: WhatsAppState; info?: string }) => {
                setStatus((cur) => cur ? { ...cur, state: msg.state } : cur);
                if (msg.state !== 'qr') setQrDataUrl(null);
            });
            socket.on('whatsapp:qr', (msg: { dataUrl: string }) => setQrDataUrl(msg.dataUrl));
            socket.on('whatsapp:config', (cfg: WhatsAppCfg) => {
                setStatus((cur) => cur ? { ...cur, config: cfg } : cur);
            });
            socket.on('whatsapp:recipients', (recipients: string[]) => {
                setStatus((cur) => cur ? { ...cur, config: { ...cur.config, recipients } } : cur);
            });
            socket.on('whatsapp:bot:log', (entry: { ts: string }) => {
                // Bridge to a window event so BotConfigBlock can subscribe.
                window.dispatchEvent(new CustomEvent('cnc:wa-bot-log', { detail: entry }));
            });
            socket.on('telegram:bot:log', (entry: { ts: string }) => {
                window.dispatchEvent(new CustomEvent('cnc:tg-bot-log', { detail: entry }));
            });
        } catch (_) { /* socket optional */ }
        return () => { socket?.disconnect(); };
    }, []);

    // Initial REST read
    useEffect(() => { refresh(); }, []);

    async function refresh() {
        try {
            const s = await whatsapp.status();
            setStatus(s);
            setQrDataUrl(s.qrDataUrl);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function toggleEnabled() {
        if (!status) return;
        setBusy(true); setError(null); setTestResult(null);
        try {
            const next = status.state === 'disabled' || status.state === 'auth_failed' || status.state === 'disconnected'
                ? await whatsapp.enable()
                : await whatsapp.disable();
            setStatus(next);
            setQrDataUrl(next.qrDataUrl);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function addPhone() {
        const v = phoneDraft.trim();
        if (!v) return;
        setBusy(true); setError(null);
        try {
            const r = await whatsapp.addRecipient(v);
            setStatus((cur) => cur ? { ...cur, config: { ...cur.config, recipients: r.recipients } } : cur);
            setPhoneDraft('');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function removePhone(phone: string) {
        setBusy(true); setError(null);
        try {
            await whatsapp.removeRecipient(phone);
            setStatus((cur) => cur
                ? { ...cur, config: { ...cur.config, recipients: cur.config.recipients.filter((p) => p !== phone) } }
                : cur);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function toggleEvent(key: WhatsAppEventKey) {
        if (!status) return;
        const cur = status.config.events;
        const next = cur.includes(key) ? cur.filter((e) => e !== key) : [...cur, key];
        try {
            await whatsapp.setEvents(next);
            setStatus((s) => s ? { ...s, config: { ...s.config, events: next } } : s);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function updateInterval(sec: number) {
        if (!status) return;
        try {
            const cfg = await whatsapp.setConfig({ minIntervalSec: sec });
            setStatus((s) => s ? { ...s, config: cfg } : s);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function togglePosition() {
        if (!status) return;
        try {
            const cfg = await whatsapp.setConfig({ includePosition: !status.config.includePosition });
            setStatus((s) => s ? { ...s, config: cfg } : s);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function sendTest() {
        setTestResult(null); setError(null); setBusy(true);
        try {
            const r = await whatsapp.test();
            const okCount = r.results.filter((x) => x.ok).length;
            setTestResult(`Sent to ${okCount}/${r.results.length} recipient(s).`);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    const pill = useMemo(() => status ? STATE_PILL[status.state] : STATE_PILL.disabled, [status]);
    const recipients = status?.config.recipients || [];
    const enabledEvents = useMemo(() => new Set(status?.config.events || []), [status]);
    const isOn = status?.state === 'ready' || status?.state === 'init' || status?.state === 'qr';

    return (
        <div className="settings-section">
            <header className="settings-section-header">
                <div className="settings-section-title">
                    <MessageCircle size={18} /> WhatsApp Notifications
                    <span className={`settings-pill wa-pill-${pill.tone}`}>{pill.label}</span>
                </div>
                <div className="settings-section-actions">
                    <button className="settings-btn" onClick={refresh} disabled={busy}>
                        <RefreshCw size={14} /> Refresh
                    </button>
                    <button
                        className={`settings-btn ${isOn ? 'settings-btn danger' : 'settings-btn primary'}`}
                        onClick={toggleEnabled} disabled={busy}>
                        <Power size={14} /> {isOn ? 'Disable' : 'Enable'}
                    </button>
                </div>
            </header>

            {error && (
                <div className="settings-error">
                    <AlertCircle size={14} /> {error}
                </div>
            )}

            {status?.state === 'qr' && qrDataUrl && (
                <div className="wa-qr-block">
                    <div>
                        <div className="wa-qr-title">Scan to link this device</div>
                        <ol className="wa-qr-steps">
                            <li>Open WhatsApp on your phone</li>
                            <li>Tap Settings → Linked devices → Link a device</li>
                            <li>Point the camera at this QR code</li>
                        </ol>
                        <div className="wa-qr-note">QR refreshes automatically. Keep this tab open until you see <b>Connected</b>.</div>
                    </div>
                    <img src={qrDataUrl} alt="WhatsApp pairing QR" className="wa-qr-img" />
                </div>
            )}

            <div className="wa-block">
                <div className="wa-block-title">Recipients</div>
                <div className="wa-block-sub">Phone numbers that receive job updates (E.164 with country code, e.g. <code>+919876543210</code>).</div>

                <div className="wa-add-row">
                    <input
                        type="tel"
                        className="wa-input"
                        placeholder="+919876543210"
                        value={phoneDraft}
                        onChange={(e) => setPhoneDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addPhone(); }}
                        disabled={busy} />
                    <button className="settings-btn settings-btn primary" onClick={addPhone} disabled={busy || !phoneDraft.trim()}>
                        <Plus size={14} /> Add
                    </button>
                </div>

                {recipients.length === 0 && (
                    <div className="wa-empty">No recipients yet. Add at least one number to start receiving alerts.</div>
                )}
                {recipients.length > 0 && (
                    <ul className="wa-list">
                        {recipients.map((p) => (
                            <li key={p} className="wa-list-item">
                                <span className="wa-list-phone">{p}</span>
                                <button className="settings-btn settings-btn danger" onClick={() => removePhone(p)} disabled={busy}>
                                    <Trash2 size={14} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                <div className="wa-test-row">
                    <button className="settings-btn" onClick={sendTest} disabled={busy || !recipients.length || status?.state !== 'ready'}>
                        <Send size={14} /> Send test message
                    </button>
                    {testResult && <span className="wa-test-result">{testResult}</span>}
                </div>
            </div>

            <div className="wa-block">
                <div className="wa-block-title">Events to notify</div>
                <div className="wa-block-sub">Tick the events that should send a WhatsApp message.</div>
                <ul className="wa-events">
                    {EVENT_OPTIONS.map((opt) => (
                        <li key={opt.key} className={`wa-event ${enabledEvents.has(opt.key) ? 'on' : ''}`}>
                            <label>
                                <input type="checkbox"
                                    checked={enabledEvents.has(opt.key)}
                                    onChange={() => toggleEvent(opt.key)} />
                                <span className="wa-event-label">{opt.label}</span>
                                <span className="wa-event-hint">{opt.hint}</span>
                            </label>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="wa-block">
                <div className="wa-block-title">Throttling & content</div>
                <div className="wa-cfg-row">
                    <label className="wa-label">
                        Minimum seconds between same-event messages
                        <input type="number" min={0} max={3600} className="wa-input wa-num"
                            value={status?.config.minIntervalSec ?? 30}
                            onChange={(e) => updateInterval(Math.max(0, Number(e.target.value) || 0))} />
                    </label>
                </div>
                <div className="wa-cfg-row">
                    <label className="wa-label-inline">
                        <input type="checkbox"
                            checked={!!status?.config.includePosition}
                            onChange={togglePosition} />
                        Include machine position (X / Y / Z) in messages
                    </label>
                </div>
            </div>

            <BotConfigBlock status={status} setStatus={setStatus} />

            <TelegramBlock />
        </div>
    );
}

// ─── Bot config sub-section (Tawfiq msg 7430 / 7432) ───────────────
import { useEffect as _useEffect, useState as _useState } from 'react';
import { whatsapp as _wa, telegram as _tg, webcam as _wc, CameraCfg, TelegramStatus } from './api';

interface BotConfig {
    botEnabled?: boolean;
    botEyeCameraId?: string | null;
}

function BotConfigBlock({ status, setStatus }: { status: WhatsAppStatus | null; setStatus: React.Dispatch<React.SetStateAction<WhatsAppStatus | null>> }) {
    const [cameras, setCameras] = _useState<CameraCfg[]>([]);
    const [recentCmds, setRecentCmds] = _useState<Array<{ ts: string; phone?: string; cmd?: string; ok?: boolean; reason?: string; error?: string }>>([]);

    _useEffect(() => { _wc.list().then(setCameras).catch(() => {}); }, []);

    // Tap the bot:log socket stream for recent commands
    _useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { ts: string };
            setRecentCmds((prev) => [detail, ...prev].slice(0, 25));
        };
        window.addEventListener('cnc:wa-bot-log', handler as EventListener);
        return () => window.removeEventListener('cnc:wa-bot-log', handler as EventListener);
    }, []);

    async function toggleBot() {
        if (!status) return;
        const cfg = status.config as WhatsAppCfg & BotConfig;
        const next = await _wa.setConfig({ botEnabled: !cfg.botEnabled } as Partial<Pick<WhatsAppCfg, 'minIntervalSec' | 'includePosition'>> & BotConfig);
        setStatus((s) => s ? { ...s, config: next } : s);
    }
    async function setEye(id: string) {
        const next = await _wa.setConfig({ botEyeCameraId: id || null } as Partial<Pick<WhatsAppCfg, 'minIntervalSec' | 'includePosition'>> & BotConfig);
        setStatus((s) => s ? { ...s, config: next } : s);
    }

    const cfg = (status?.config || {}) as WhatsAppCfg & BotConfig;

    return (
        <div className="wa-block">
            <div className="wa-block-title">Bot — slash commands</div>
            <div className="wa-block-sub">
                Lets recipient phones send <code>/status</code>, <code>/jog X+10</code>, <code>/home</code>, <code>/start</code>, <code>/stop</code>, <code>/files</code>, <code>/load &lt;name&gt;</code>, <code>/upload</code> (with attached G-code file) and <code>/help</code>. Destructive commands require a "YES" reply within 30 s.
            </div>
            <div className="wa-cfg-row">
                <label className="wa-label-inline">
                    <input type="checkbox" checked={!!cfg.botEnabled} onChange={toggleBot} />
                    Bot commands enabled
                </label>
            </div>
            <div className="wa-cfg-row">
                <label className="wa-label">
                    Bot-eye webcam (snapshot attached after /jog)
                    <select className="wa-input"
                        value={cfg.botEyeCameraId ?? ''}
                        onChange={(e) => setEye(e.target.value)}>
                        <option value="">— None —</option>
                        {cameras.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                </label>
            </div>
            {recentCmds.length > 0 && (
                <div className="wa-cfg-row" style={{ display: 'block' }}>
                    <div className="wa-block-sub" style={{ marginBottom: 6 }}>Recent commands (this session)</div>
                    <ul className="wa-list" style={{ maxHeight: 200, overflowY: 'auto' }}>
                        {recentCmds.map((c, i) => (
                            <li key={i} className="wa-list-item" style={{ fontSize: 11 }}>
                                <span className="wa-list-phone">{c.phone}</span>
                                <code>{c.cmd}</code>
                                <span style={{ color: c.ok ? '#4ade80' : '#fca5a5' }}>{c.ok ? 'ok' : (c.error || c.reason || 'fail')}</span>
                                <span style={{ color: 'var(--text-mute)' }}>{new Date(c.ts).toLocaleTimeString()}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

// ─── Telegram bot sub-section (Tawfiq msg 7454 — "Go start name or as Onefinity_bot") ───
function TelegramBlock() {
    const [status, setStatus] = _useState<TelegramStatus | null>(null);
    const [tokenInput, setTokenInput] = _useState('');
    const [chatInput, setChatInput] = _useState('');
    const [cameras, setCameras] = _useState<CameraCfg[]>([]);
    const [busy, setBusy] = _useState(false);
    const [msg, setMsg] = _useState('');
    const [recentCmds, setRecentCmds] = _useState<Array<{ ts: string; chatId?: number; cmd?: string; ok?: boolean; reason?: string; error?: string }>>([]);

    _useEffect(() => { _tg.status().then(setStatus).catch(() => {}); }, []);
    _useEffect(() => { _wc.list().then(setCameras).catch(() => {}); }, []);

    _useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { ts: string };
            setRecentCmds((prev) => [detail, ...prev].slice(0, 25));
        };
        window.addEventListener('cnc:tg-bot-log', handler as EventListener);
        return () => window.removeEventListener('cnc:tg-bot-log', handler as EventListener);
    }, []);

    const cfg = status?.config;
    const state = status?.state ?? 'disabled';

    async function saveToken() {
        if (!tokenInput.trim()) return;
        setBusy(true); setMsg('');
        try {
            await _tg.setConfig({ token: tokenInput.trim() });
            setTokenInput('');
            const r = await _tg.enable();
            setMsg(r.username ? `Connected as @${r.username}` : 'Saved.');
            setStatus(await _tg.status());
        } catch (e: any) {
            setMsg(`Failed: ${e?.message || e}`);
        } finally { setBusy(false); }
    }

    async function addChat() {
        const n = Number(chatInput.trim());
        if (!Number.isFinite(n)) { setMsg('chat_id must be a number'); return; }
        const current = cfg?.allowedChatIds || [];
        await _tg.setConfig({ allowedChatIds: [...current, n] });
        setChatInput('');
        setStatus(await _tg.status());
    }
    async function removeChat(id: number) {
        const current = cfg?.allowedChatIds || [];
        await _tg.setConfig({ allowedChatIds: current.filter((x) => x !== id) });
        setStatus(await _tg.status());
    }
    async function toggleBot() {
        if (!cfg) return;
        await _tg.setConfig({ botEnabled: !cfg.botEnabled });
        setStatus(await _tg.status());
    }
    async function toggleOpen() {
        if (!cfg) return;
        await _tg.setConfig({ openMode: !cfg.openMode });
        setStatus(await _tg.status());
    }
    async function setEye(id: string) {
        await _tg.setConfig({ botEyeCameraId: id || null });
        setStatus(await _tg.status());
    }
    async function reconnect() {
        setBusy(true); setMsg('');
        try { await _tg.disable(); const r = await _tg.enable(); setMsg(r.username ? `Reconnected as @${r.username}` : 'Reconnected.'); setStatus(await _tg.status()); }
        catch (e: any) { setMsg(`Failed: ${e?.message || e}`); }
        finally { setBusy(false); }
    }
    async function disable() {
        setBusy(true); setMsg('');
        try { await _tg.disable(); setStatus(await _tg.status()); setMsg('Disabled.'); }
        catch (e: any) { setMsg(`Failed: ${e?.message || e}`); }
        finally { setBusy(false); }
    }
    async function test() {
        setBusy(true); setMsg('');
        try { const r = await _tg.test(); setMsg(`Sent test to ${r.sent} chat(s).`); }
        catch (e: any) { setMsg(`Failed: ${e?.message || e}`); }
        finally { setBusy(false); }
    }

    const stateColor = state === 'ready' ? '#4ade80' : state === 'disabled' ? 'var(--text-mute)' : '#fbbf24';

    return (
        <div className="wa-block">
            <div className="wa-block-title">Telegram bot — same commands as WhatsApp, no SIM needed</div>
            <div className="wa-block-sub">
                Setup: open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> in Telegram → <code>/newbot</code> → name it <code>Onefinity_bot</code> (or any name) → copy the HTTP token → paste below. Then message your bot any text; it'll reply with your chat_id which you add to the allow-list below.
            </div>

            <div className="wa-cfg-row" style={{ alignItems: 'baseline' }}>
                <span className="wa-label-inline" style={{ minWidth: 88 }}>State:</span>
                <span style={{ color: stateColor, fontWeight: 600 }}>{state}</span>
                {status?.info && <span style={{ color: 'var(--text-mute)', marginLeft: 8 }}>{status.info}</span>}
            </div>

            <div className="wa-cfg-row">
                <label className="wa-label" style={{ flex: 1 }}>
                    BotFather HTTP token
                    <input type="password"
                        className="wa-input"
                        placeholder={cfg?.token || 'paste 0123456789:ABC... here'}
                        value={tokenInput}
                        onChange={(e) => setTokenInput(e.target.value)} />
                </label>
                <button className="wa-btn-primary"
                    disabled={busy || !tokenInput.trim()}
                    onClick={saveToken}
                    style={{ marginLeft: 8 }}>Save + Connect</button>
            </div>

            <div className="wa-cfg-row">
                <button className="wa-btn-ghost" disabled={busy || !cfg?.token} onClick={reconnect}>Reconnect</button>
                <button className="wa-btn-ghost" disabled={busy} onClick={disable}>Disable</button>
                <button className="wa-btn-ghost" disabled={busy || state !== 'ready' || !(cfg?.allowedChatIds?.length)} onClick={test}>Send test message</button>
            </div>

            <div className="wa-cfg-row">
                <label className="wa-label-inline">
                    <input type="checkbox" checked={!!cfg?.botEnabled} onChange={toggleBot} />
                    Bot commands enabled
                </label>
                <label className="wa-label-inline" style={{ marginLeft: 16 }}>
                    <input type="checkbox" checked={!!cfg?.openMode} onChange={toggleOpen} />
                    Open mode (accept any sender when allow-list is empty)
                </label>
            </div>

            <div className="wa-cfg-row">
                <label className="wa-label">
                    Bot-eye webcam (snapshot attached after /jog)
                    <select className="wa-input"
                        value={cfg?.botEyeCameraId ?? ''}
                        onChange={(e) => setEye(e.target.value)}>
                        <option value="">— None —</option>
                        {cameras.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                </label>
            </div>

            <div className="wa-cfg-row" style={{ display: 'block' }}>
                <div className="wa-block-sub" style={{ marginBottom: 6 }}>Allowed chat IDs</div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <input className="wa-input" style={{ flex: 1 }}
                        placeholder="message your bot once, send /ping, copy the chat_id"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)} />
                    <button className="wa-btn-primary" onClick={addChat}>Add</button>
                </div>
                {!!cfg?.allowedChatIds?.length && (
                    <ul className="wa-list" style={{ marginTop: 8 }}>
                        {cfg.allowedChatIds.map((id) => (
                            <li key={id} className="wa-list-item">
                                <span className="wa-list-phone">{id}</span>
                                <button className="wa-btn-ghost" onClick={() => removeChat(id)}>Remove</button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {msg && <div className="wa-cfg-row" style={{ color: 'var(--text-mute)' }}>{msg}</div>}

            {recentCmds.length > 0 && (
                <div className="wa-cfg-row" style={{ display: 'block' }}>
                    <div className="wa-block-sub" style={{ marginBottom: 6 }}>Recent commands (this session)</div>
                    <ul className="wa-list" style={{ maxHeight: 200, overflowY: 'auto' }}>
                        {recentCmds.map((c, i) => (
                            <li key={i} className="wa-list-item" style={{ fontSize: 11 }}>
                                <span className="wa-list-phone">chat {c.chatId ?? '?'}</span>
                                <code>{c.cmd}</code>
                                <span style={{ color: c.ok ? '#4ade80' : '#fca5a5' }}>{c.ok ? 'ok' : (c.error || c.reason || 'fail')}</span>
                                <span style={{ color: 'var(--text-mute)' }}>{new Date(c.ts).toLocaleTimeString()}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
