/**
 * SectionCloudAccess — machine identity, LAN access code, the cloud relay
 * link, pairing and remote permissions (docs/cloud-relay/SPEC.md §8.1).
 *
 * Everything that grants power to a remote device (pairing, Motion / Job
 * control, the access code, LAN-only) is operator-only on the backend. This
 * panel mirrors that: non-operators see the same blocks read-only. The one
 * action anyone may take is dropping the Motion grant, because giving up
 * privilege is always safe.
 */
import { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, Check, Cloud, Copy, Fingerprint, Hash, Info, KeyRound, Link2Off, Radio,
    RefreshCw, ShieldAlert, ShieldCheck, Trash2, X,
} from 'lucide-react';
import {
    remote, remoteCloud, library, isRemoteUpload,
    CloudLimitsUpdate, CloudStatus, MotionScope, PairingView, RemoteAuditEntry, RemoteInfo, TierState,
} from './api';
import { useCNCStore } from '../../stores/cncStore';
import { useServerCountdown } from '../../hooks/useServerCountdown';
import controller from '../../utils/controller';

const AUDIT_ROWS = 20;
const POLL_MS = 15000;
const GRANT_BLOCKING_LOCKS = ['alarm', 'disconnected', 'no-controller', 'board-link-down'];

const CLOUD_PILL: Record<CloudStatus['state'], { cls: string; label: string }> = {
    online: { cls: 'ok', label: 'Online' },
    connecting: { cls: 'warn', label: 'Connecting' },
    backoff: { cls: 'warn', label: 'Retrying' },
    pairing: { cls: 'warn', label: 'Pairing' },
    'auth-failed': { cls: 'fail', label: 'Rejected' },
    disabled: { cls: 'idle', label: 'Disabled' },
    'lan-only': { cls: 'idle', label: 'LAN only' },
    unpaired: { cls: 'idle', label: 'Not paired' },
};

const MDNS_PILL: Record<string, { cls: string; label: string }> = {
    running: { cls: 'ok', label: 'mDNS running' },
    unavailable: { cls: 'warn', label: 'mDNS unavailable' },
    conflict: { cls: 'warn', label: 'mDNS name conflict' },
    stopped: { cls: 'idle', label: 'mDNS stopped' },
};

const ERROR_TEXT: Record<string, string> = {
    operator_required: 'Only the machine operator can change this. Open the operator link on this PC.',
    operator_only: 'Can only be changed on the machine\'s own screen.',
    lan_only: 'LAN-only is on. Turn it off to use the cloud relay.',
    no_relay_url: 'Save a relay URL first.',
    already_paired: 'This machine is already paired. Unpair it first.',
    relay_unreachable: 'The relay could not be reached. Check the URL and this PC\'s internet connection.',
    not_claimed: 'Nobody has entered the pairing code yet.',
    invalid_url: 'Enter an https:// relay address (http:// only for localhost).',
    locked: 'Motion cannot be granted while the machine is in alarm, disconnected or has no controller.',
    bad_scope: 'Pick who should get Motion.',
    bad_duration: 'Pick 5, 15 or 30 minutes.',
    invalid_limits: 'File limit must be 1–100 MB and the cloud library cap 50–10000 MB.',
    device_identity_unavailable: 'The machine identity file cannot be read right now, so this cannot be changed. Try again in a minute.',
    store_unreadable: 'The cloud settings file is locked (OneDrive or antivirus?). Nothing was changed; try again.',
};

function errorText(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return ERROR_TEXT[msg] || msg;
}

function timeAgo(ms: number | null | undefined): string {
    if (!ms) return '—';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
}

function groupAccessCode(code: string): string {
    return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

function formatPairingCode(code: string): string {
    const raw = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : code.toUpperCase();
}

function relayHost(url: string | null | undefined): string {
    if (!url) return 'the relay';
    try { return new URL(url).host; } catch (_) { return url; }
}

function isLoopbackHost(): boolean {
    if (typeof window === 'undefined') return false;
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

function scopeLabel(motion: TierState['scope']['motion']): string {
    if (!motion) return '';
    if (motion.channel === 'lan') return 'LAN phones';
    if (motion.userId) return `Cloud: ${motion.userLabel || motion.userId}`;
    return 'Cloud: all users';
}

function auditWho(e: RemoteAuditEntry): string {
    if (e.userLabel) return e.userLabel;
    if (e.kind === 'lan') return 'LAN phone';
    if (e.kind === 'operator' || e.kind === 'local') return 'This machine';
    if (e.kind === 'cloud') return 'Cloud user';
    return e.kind || 'system';
}

function auditWhat(e: RemoteAuditEntry): string {
    switch (e.event) {
        case 'cmd': return e.type || 'command';
        case 'tier.job': return `Job control ${e.channel === 'lan' ? 'LAN' : 'cloud'} ${e.enabled ? 'on' : 'off'}`;
        case 'tier.motion.grant': return `Motion granted${e.scope ? ` (${e.scope.channel === 'lan' ? 'LAN' : 'cloud'})` : ''}`;
        case 'tier.motion.revoke': return `Motion revoked${e.reason ? ` (${e.reason})` : ''}`;
        case 'tier.motion.expire': return 'Motion expired';
        case 'jog.cancel': return `Jog stopped${e.reason ? ` (${e.reason})` : ''}`;
        default: return e.event;
    }
}

/** Switch with a 44px hit area; the visual track stays compact. */
function Switch({ checked, disabled, onChange, label }: {
    checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label: string;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            className={`ca-switch ${checked ? 'on' : ''}`}
            disabled={disabled}
            onClick={() => onChange(!checked)}
        >
            <span className="ca-switch-track"><span className="ca-switch-thumb" /></span>
            <span className="ca-switch-label">{label}</span>
        </button>
    );
}

type ScopeChoice = 'lan' | 'cloud-user' | 'cloud-all';

export default function SectionCloudAccess() {
    const [info, setInfo] = useState<RemoteInfo | null>(null);
    const [pairing, setPairing] = useState<PairingView | null>(null);
    const [audit, setAudit] = useState<RemoteAuditEntry[]>([]);
    const [recentUsers, setRecentUsers] = useState<{ userId: string; userLabel: string; lastSeenAt: number }[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [nameDraft, setNameDraft] = useState<string | null>(null);
    const [relayDraft, setRelayDraft] = useState<string | null>(null);
    // null = not edited: the input shows the stored value and Save leaves it untouched.
    const [maxFileDraft, setMaxFileDraft] = useState<string | null>(null);
    const [capDraft, setCapDraft] = useState<string | null>(null);
    const [scopeChoice, setScopeChoice] = useState<ScopeChoice>('cloud-user');
    const [scopeUserId, setScopeUserId] = useState('');
    const [, setNowTick] = useState(0);

    const status = useCNCStore((s) => s.cloudStatus);
    const perms = useCNCStore((s) => s.remotePermissions);
    const permsAt = useCNCStore((s) => s.remotePermissionsReceivedAt);
    const device = useCNCStore((s) => s.remoteDevice);
    const activity = useCNCStore((s) => s.remoteActivity);
    const setCloudStatus = useCNCStore((s) => s.setCloudStatus);
    const setRemotePermissions = useCNCStore((s) => s.setRemotePermissions);
    const setRemoteDevice = useCNCStore((s) => s.setRemoteDevice);

    const operator = !!info?.operator;
    const localNotOperator = !!info && !operator
        && (info.identityKind === 'local' || (info.identityKind === undefined && isLoopbackHost()));

    async function load() {
        const [i, d, st, p] = await Promise.all([
            remote.info(),
            remoteCloud.device(),
            remoteCloud.status(),
            remoteCloud.permissions(),
        ]);
        setInfo(i);
        setRemoteDevice(d);
        setCloudStatus(st);
        setRemotePermissions(p);
        if (i.operator) {
            const [pv, a, users] = await Promise.all([
                remoteCloud.getPairing().catch(() => ({})),
                remoteCloud.audit(AUDIT_ROWS).catch(() => [] as RemoteAuditEntry[]),
                remoteCloud.recentUsers().catch(() => []),
            ]);
            setPairing(pv && 'state' in pv ? pv : null);
            setAudit(a.slice(0, AUDIT_ROWS));
            setRecentUsers(users);
        }
    }

    useEffect(() => {
        load().catch((err) => setError(errorText(err)));
        const timer = setInterval(() => { load().catch(() => {}); }, POLL_MS);

        const onPairing = (p: PairingView | null) => setPairing(p && 'state' in p ? p : null);
        const onAudit = (e: RemoteAuditEntry) => setAudit((prev) => [e, ...prev].slice(0, AUDIT_ROWS));
        controller.on('remote:cloud:pairing', onPairing);
        controller.on('remote:audit', onAudit);
        return () => {
            clearInterval(timer);
            controller.off('remote:cloud:pairing', onPairing);
            controller.off('remote:audit', onAudit);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The pairing code expiry is display-only, so the wall clock is fine here.
    useEffect(() => {
        if (pairing?.state !== 'pending') return;
        const id = setInterval(() => setNowTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [pairing?.state]);

    // Default the per-user picker to the most recent cloud user.
    useEffect(() => {
        if (!scopeUserId && recentUsers.length > 0) setScopeUserId(recentUsers[0].userId);
    }, [recentUsers, scopeUserId]);

    async function run(action: () => Promise<unknown>, success?: string) {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await action();
            if (success) setNotice(success);
            await load();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    }

    function copy(text: string) {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    const countdown = useServerCountdown(
        perms?.motionRemainingMs ?? null,
        permsAt,
    );
    const motionActive = !!perms && perms.motionRemainingMs !== null && !countdown.expired;
    const grantLocks = (perms?.locks ?? []).filter((l) => GRANT_BLOCKING_LOCKS.includes(l));
    const jobControl = perms?.jobControl ?? {
        lan: !!perms?.scope.jobControl.includes('lan'),
        cloud: !!perms?.scope.jobControl.includes('cloud'),
    };

    const lanOnly = !!(status?.lanOnly ?? device?.lanOnly);
    const pill = status ? CLOUD_PILL[status.state] : null;
    const mdnsPill = device ? (MDNS_PILL[device.mdns?.state] ?? MDNS_PILL.stopped) : null;
    const lanUrl = device && device.mdnsHostname ? `http://${device.mdnsHostname}:4000` : null;
    const relayValue = relayDraft ?? status?.relayUrl ?? '';
    // Stored limits come from the operator status; an unreported value shows empty rather than a guessed default.
    const maxFileValue = maxFileDraft ?? (typeof status?.maxFileMb === 'number' ? String(status.maxFileMb) : '');
    const capValue = capDraft ?? (typeof status?.cloudLibraryCapMb === 'number' ? String(status.cloudLibraryCapMb) : '');
    const pendingExpiresIn = pairing?.state === 'pending'
        ? Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000))
        : 0;

    const selectedUser = useMemo(
        () => recentUsers.find((u) => u.userId === scopeUserId) || null,
        [recentUsers, scopeUserId],
    );

    const readOnlyNote = !info || operator ? null : (
        localNotOperator ? (
            <div className="ra-alert warn">
                <ShieldAlert size={15} />
                <div className="ra-alert-body">
                    <span>
                        This window is not signed in as the machine operator, so cloud pairing, remote permissions,
                        the access code and LAN-only are read-only here. Normal machine control is not affected.
                    </span>
                    <span>
                        To change them, open the kiosk with <code>RUN_FRONTEND_*.bat</code>, or copy the
                        {' '}<strong>Operator link: http://localhost:4000/?op=…</strong> line from the backend console
                        window on this PC into the browser.
                    </span>
                </div>
            </div>
        ) : (
            <div className="ra-alert info">
                <Info size={15} />
                <div className="ra-alert-body">Can only be changed on the machine's own screen</div>
            </div>
        )
    );

    function saveName() {
        const name = (nameDraft ?? '').trim();
        if (name.length < 1 || name.length > 60) {
            setError('The name must be 1–60 characters.');
            return;
        }
        run(async () => {
            setRemoteDevice(await remoteCloud.rename(name));
            setNameDraft(null);
        }, 'Machine renamed.');
    }

    function regenerate() {
        if (!confirm('Generate a new access code? Every phone signed in with the old code will be signed out.')) return;
        run(() => remoteCloud.regenerateAccessCode(), 'New access code generated. Phones must sign in again with it.');
    }

    function toggleLanOnly(next: boolean) {
        if (next && !confirm('LAN-only stops ALL internet traffic from this machine: cloud relay, remote diagnostics, Telegram/WhatsApp notifications, chatbot online answers, firmware update checks. Continue?')) return;
        run(() => remoteCloud.setLanOnly(next), next ? 'LAN-only is on. This machine makes no internet connections.' : 'LAN-only is off.');
    }

    function saveRelayUrl() {
        const url = relayValue.trim();
        run(async () => {
            setCloudStatus(await remoteCloud.setRelayUrl(url));
            setRelayDraft(null);
        }, 'Relay URL saved.');
    }

    function unpair() {
        if (!confirm('Unpair this machine from the cloud account? Phones will lose access until it is paired again.')) return;
        run(async () => { setCloudStatus(await remoteCloud.unpair()); }, 'Machine unpaired.');
    }

    function saveLimits() {
        // Send only the fields the operator edited, so an unchanged (or unreported)
        // limit is never overwritten with a stale or default value.
        const update: CloudLimitsUpdate = {};
        if (maxFileDraft !== null) {
            const maxFileMb = Number(maxFileDraft.trim());
            if (maxFileDraft.trim() === '' || !Number.isInteger(maxFileMb) || maxFileMb < 1 || maxFileMb > 100) {
                setError(ERROR_TEXT.invalid_limits);
                return;
            }
            update.maxFileMb = maxFileMb;
        }
        if (capDraft !== null) {
            const cap = Number(capDraft.trim());
            if (capDraft.trim() === '' || !Number.isInteger(cap) || cap < 50 || cap > 10000) {
                setError(ERROR_TEXT.invalid_limits);
                return;
            }
            update.cloudLibraryCapMb = cap;
        }
        if (update.maxFileMb === undefined && update.cloudLibraryCapMb === undefined) {
            setError(null);
            setNotice('No limit was changed.');
            return;
        }
        run(async () => {
            setCloudStatus(await remoteCloud.setLimits(update));
            setMaxFileDraft(null);
            setCapDraft(null);
        }, 'Remote file limits saved.');
    }

    function deleteRemoteUploads() {
        if (!confirm('Delete every file that was uploaded to this machine through the cloud relay? Local files are kept.')) return;
        run(async () => {
            const entries = (await library.list()).filter(isRemoteUpload);
            for (const e of entries) await library.remove(e.id);
            setNotice(`${entries.length} remote upload${entries.length === 1 ? '' : 's'} deleted.`);
        });
    }

    function grant(minutes: 5 | 15 | 30) {
        let scope: MotionScope;
        if (scopeChoice === 'lan') {
            scope = { channel: 'lan' };
        } else if (scopeChoice === 'cloud-all') {
            if (!confirm('Every cloud user with operator access to this machine will be able to move it.')) return;
            scope = { channel: 'cloud', userId: null };
        } else {
            if (!scopeUserId) {
                setError('Pick the cloud user who should get Motion.');
                return;
            }
            scope = { channel: 'cloud', userId: scopeUserId };
        }
        run(async () => { setRemotePermissions(await remoteCloud.grantMotion(minutes, scope)); },
            `Motion enabled for ${minutes} minutes.`);
    }

    function revokeMotion() {
        run(() => remoteCloud.revokeMotion(), 'Motion revoked. Any remote jog was stopped.');
    }

    function setJob(channel: 'lan' | 'cloud', enabled: boolean) {
        run(async () => { setRemotePermissions(await remoteCloud.setJobControl(channel, enabled)); });
    }

    const claimed = operator && pairing?.state === 'claimed' ? pairing : null;

    return (
        <div className="settings-section">
            <header className="settings-section-header">
                <div>
                    <div className="settings-section-title">
                        <Cloud size={18} /> Cloud access
                    </div>
                    <div className="settings-section-sub">
                        Reach this machine from your phone anywhere through your own relay, or on the same Wi-Fi with the
                        access code. Remote devices can only move the machine while you allow it here.
                    </div>
                </div>
                <div className="settings-section-actions">
                    <button className="settings-btn" onClick={() => run(() => Promise.resolve())} disabled={busy}>
                        <RefreshCw size={14} /> Refresh
                    </button>
                </div>
            </header>

            {error && <div className="settings-error">{error}</div>}
            {notice && <div className="ra-alert info"><Check size={15} /><div className="ra-alert-body">{notice}</div></div>}
            {readOnlyNote}

            {/* ─── 1. This machine ─── */}
            <div className="wa-block">
                <div className="ra-title-row">
                    <div className="wa-block-title ra-title"><Fingerprint size={16} /> This machine</div>
                    {mdnsPill && <span className={`settings-pill ${mdnsPill.cls}`}>{mdnsPill.label}</span>}
                </div>
                {!device && <div className="wa-empty">Loading…</div>}
                {device && (
                    <>
                        {device.unavailable && (
                            <div className="ra-alert warn" role="alert">
                                <AlertTriangle size={15} />
                                <div className="ra-alert-body">
                                    The machine identity file cannot be read{device.unavailableCode ? ` (${device.unavailableCode})` : ''}.
                                    Remote and cloud features stay LAN-only until it can; the backend keeps retrying.
                                    Local control of the machine is not affected.
                                </div>
                            </div>
                        )}
                        {device.corruptRecovered && operator && (
                            <div className="ra-alert warn">
                                <AlertTriangle size={15} />
                                <div className="ra-alert-body">
                                    The machine identity file was damaged and a new device ID was created. Bookmarks
                                    using the old .local name no longer work.
                                </div>
                            </div>
                        )}
                        <div className="ca-kv">
                            <span className="ca-k">Device ID</span>
                            <span className="ca-v mono">{device.displayId}</span>
                            <span className="ca-k">Name</span>
                            <span className="ca-v">
                                {operator && nameDraft !== null ? (
                                    <span className="wa-add-row">
                                        <input
                                            className="wa-input"
                                            value={nameDraft}
                                            maxLength={60}
                                            onChange={(e) => setNameDraft(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
                                            disabled={busy}
                                            aria-label="Machine name"
                                        />
                                        <button className="settings-btn primary" onClick={saveName} disabled={busy}>Save</button>
                                        <button className="settings-btn" onClick={() => setNameDraft(null)} disabled={busy}>Cancel</button>
                                    </span>
                                ) : (
                                    <>
                                        {device.name}
                                        {operator && !device.unavailable && (
                                            <button className="settings-btn ca-inline-btn" onClick={() => setNameDraft(device.name)} disabled={busy}>
                                                Rename
                                            </button>
                                        )}
                                    </>
                                )}
                            </span>
                            <span className="ca-k">Local name</span>
                            <span className="ca-v mono">{device.mdnsHostname}</span>
                        </div>
                        {device.mdns?.state === 'running' && (
                            <div className="wa-block-sub">mDNS: running (check firewall if phones can't resolve)</div>
                        )}
                        {device.mdns && device.mdns.state !== 'running' && device.mdns.error && (
                            <div className="ra-alert warn">
                                <AlertTriangle size={15} />
                                <div className="ra-alert-body">mDNS: {device.mdns.error}</div>
                            </div>
                        )}
                        {lanUrl && (
                            <div className="ca-url-row">
                                <span className="ra-url">{lanUrl}</span>
                                <button className="settings-btn" onClick={() => copy(lanUrl)}>
                                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* ─── 2. LAN access code ─── */}
            <div className="wa-block">
                <div className="ra-title-row">
                    <div className="wa-block-title ra-title"><KeyRound size={16} /> LAN access code</div>
                    {operator && device && (
                        device.accessCodeActive
                            ? <span className="settings-pill ok">Active as PIN</span>
                            : <span className="settings-pill warn">{device.pinSource === 'custom' ? 'Custom PIN in use' : 'Not in use'}</span>
                    )}
                </div>
                <div className="wa-block-sub">
                    Phones on the same Wi-Fi enter this code to sign in. It never leaves this machine and is not sent to the relay.
                </div>
                {operator && device?.accessCode ? (
                    <>
                        <div className="ca-code" aria-label="Access code">{groupAccessCode(device.accessCode)}</div>
                        <div className="ra-actions">
                            {!device.accessCodeActive && (
                                <button
                                    className="settings-btn primary"
                                    disabled={busy}
                                    onClick={() => run(() => remoteCloud.useAccessCode(), 'The access code is now the LAN PIN. Signed-in phones were signed out.')}
                                >
                                    <KeyRound size={14} /> Use access code instead
                                </button>
                            )}
                            <button className="settings-btn danger" onClick={regenerate} disabled={busy}>
                                <RefreshCw size={14} /> Regenerate
                            </button>
                        </div>
                    </>
                ) : (
                    info && <div className="wa-empty">The access code is shown only on the machine's own screen.</div>
                )}
            </div>

            {/* ─── 3. Cloud link ─── */}
            <div className="wa-block">
                <div className="ra-title-row">
                    <div className="wa-block-title ra-title"><Radio size={16} /> Cloud link</div>
                    {pill && <span className={`settings-pill ${pill.cls}`}>{pill.label}</span>}
                </div>

                <Switch
                    label="LAN-only (no internet traffic)"
                    checked={lanOnly}
                    disabled={!operator || busy || !status}
                    onChange={toggleLanOnly}
                />

                {status && !lanOnly && (
                    <>
                        <div className="wa-add-row ca-wrap-row">
                            <input
                                className="wa-input"
                                type="url"
                                inputMode="url"
                                placeholder="https://relay.example.com"
                                value={relayValue}
                                onChange={(e) => setRelayDraft(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && operator) saveRelayUrl(); }}
                                disabled={!operator || busy}
                                aria-label="Relay URL"
                            />
                            {operator && (
                                <button
                                    className="settings-btn primary"
                                    onClick={saveRelayUrl}
                                    disabled={busy || !relayValue.trim() || relayValue.trim() === (status.relayUrl ?? '')}
                                >
                                    Save
                                </button>
                            )}
                        </div>

                        <Switch
                            label="Connect to the relay"
                            checked={status.enabled}
                            disabled={!operator || busy}
                            onChange={(next) => run(async () => { setCloudStatus(await remoteCloud.setEnabled(next)); })}
                        />

                        <div className="ca-kv">
                            <span className="ca-k">Round trip</span>
                            <span className="ca-v">{status.rttMs !== null ? `${status.rttMs} ms` : '—'}</span>
                            <span className="ca-k">Viewers</span>
                            <span className="ca-v">{status.viewers}</span>
                            <span className="ca-k">Since</span>
                            <span className="ca-v">{timeAgo(status.since)}</span>
                        </div>

                        {status.lastError && (
                            <div className="ra-alert warn">
                                <AlertTriangle size={15} />
                                <div className="ra-alert-body">{status.lastError}</div>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* ─── 4. Pair with your account ─── */}
            <div className="wa-block">
                <div className="ra-title-row">
                    <div className="wa-block-title ra-title">
                        {status?.paired ? <Hash size={16} /> : <Link2Off size={16} />} Pair with your account
                    </div>
                    {status?.paired && <span className="settings-pill ok">Paired</span>}
                </div>

                {status && !status.paired && (
                    <>
                        {pairing?.state === 'pending' ? (
                            <>
                                <div className="ca-code ca-code-pair" aria-label="Pairing code">{formatPairingCode(pairing.code)}</div>
                                <div className="wa-block-sub">
                                    Open <strong>{relayHost(status.relayUrl)}</strong> on your phone → Add machine → enter this code.
                                    {' '}Expires in {Math.floor(pendingExpiresIn / 60)}:{String(pendingExpiresIn % 60).padStart(2, '0')}.
                                </div>
                                {operator && (
                                    <div className="ra-actions">
                                        <button
                                            className="settings-btn"
                                            disabled={busy}
                                            onClick={() => run(async () => { await remoteCloud.cancelPairing(); setPairing(null); })}
                                        >
                                            <X size={14} /> Cancel
                                        </button>
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                {pairing && (pairing.state === 'expired' || pairing.state === 'rejected') && (
                                    <div className="wa-empty">
                                        {pairing.state === 'expired' ? 'The pairing code expired.' : 'The pairing was rejected.'}
                                    </div>
                                )}
                                <div className="wa-block-sub">
                                    Pairing links this machine to your relay account. It needs a relay URL and LAN-only off.
                                </div>
                                {operator && (
                                    <div className="ra-actions">
                                        <button
                                            className="settings-btn primary ca-big-btn"
                                            disabled={busy || lanOnly || !status.relayUrl}
                                            onClick={() => run(async () => {
                                                const r = await remoteCloud.startPairing();
                                                setPairing({ state: 'pending', code: r.code, expiresAt: r.expiresAt });
                                            })}
                                        >
                                            <Hash size={14} /> Get pairing code
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}

                {status?.paired && (
                    <div className="ca-kv">
                        <span className="ca-k">Account</span>
                        <span className="ca-v">{status.accountLabel || '—'}</span>
                        <span className="ca-k">Paired</span>
                        <span className="ca-v">{status.pairedAt ? new Date(status.pairedAt).toLocaleString() : '—'}</span>
                    </div>
                )}
                {status?.paired && operator && (
                    <div className="ra-actions">
                        <button className="settings-btn danger" onClick={unpair} disabled={busy}>
                            <Link2Off size={14} /> Unpair
                        </button>
                    </div>
                )}

                <div className="ra-label">Remote file limits</div>
                <div className="wa-block-sub">
                    Files uploaded from a phone are added to the Library, marked as remote uploads, and never start on their own.
                </div>
                <div className="wa-cfg-row ca-wrap-row">
                    <label className="wa-label">
                        Max file size (MB)
                        <input
                            className="wa-input wa-num"
                            type="number" min={1} max={100} step={1}
                            value={maxFileValue}
                            placeholder="not reported"
                            onChange={(e) => setMaxFileDraft(e.target.value)}
                            disabled={!operator || busy}
                        />
                    </label>
                    <label className="wa-label">
                        Cloud library cap (MB)
                        <input
                            className="wa-input wa-num"
                            type="number" min={50} max={10000} step={10}
                            value={capValue}
                            placeholder="not reported"
                            onChange={(e) => setCapDraft(e.target.value)}
                            disabled={!operator || busy}
                        />
                    </label>
                    {operator && (
                        <button className="settings-btn primary ca-align-end" onClick={saveLimits} disabled={busy}>Save limits</button>
                    )}
                </div>
                {operator && (
                    <div className="ra-actions">
                        <button className="settings-btn danger" onClick={deleteRemoteUploads} disabled={busy}>
                            <Trash2 size={14} /> Delete all remote uploads
                        </button>
                    </div>
                )}
            </div>

            {/* ─── 5. Remote permissions ─── */}
            <div className="wa-block">
                <div className="ra-title-row">
                    <div className="wa-block-title ra-title"><ShieldCheck size={16} /> Remote permissions</div>
                    {perms && perms.locks.length > 0 && (
                        <span className="settings-pill warn" title={perms.locks.join(', ')}>Locked: {perms.locks.join(', ')}</span>
                    )}
                </div>

                <div className="ca-tier">
                    <div className="ca-tier-head">
                        <span className="ca-tier-name">Monitor</span>
                        <span className="settings-pill ok">Always on</span>
                    </div>
                    <div className="wa-block-sub">Position, job progress and camera.</div>
                </div>

                <div className="ca-tier">
                    <div className="ca-tier-head">
                        <span className="ca-tier-name">Job control</span>
                    </div>
                    <div className="wa-block-sub">pause / feed override / resume of a remote pause. Stop is always allowed.</div>
                    <div className="ca-wrap-row">
                        <Switch
                            label="LAN phones"
                            checked={!!jobControl.lan}
                            disabled={!operator || busy || !perms}
                            onChange={(next) => setJob('lan', next)}
                        />
                        <Switch
                            label="Cloud"
                            checked={!!jobControl.cloud}
                            disabled={!operator || busy || !perms}
                            onChange={(next) => setJob('cloud', next)}
                        />
                    </div>
                </div>

                <div className={`ca-tier ${motionActive ? 'active' : ''}`}>
                    <div className="ca-tier-head">
                        <span className="ca-tier-name">Motion</span>
                        {motionActive && <span className="settings-pill warn">On</span>}
                    </div>
                    <div className="wa-block-sub">Jog, zero, load and start. Expires automatically and never survives a restart.</div>

                    {motionActive && perms && (
                        <div className={`ca-countdown ${(countdown.remainingMs ?? 0) < 60000 ? 'ending' : ''}`} role="timer" aria-live="off">
                            <span className="ca-countdown-time">{countdown.label}</span>
                            <span className="ca-countdown-scope">{scopeLabel(perms.scope.motion)}</span>
                            <button className="settings-btn danger ca-big-btn" onClick={revokeMotion} disabled={busy}>
                                <X size={14} /> Revoke
                            </button>
                        </div>
                    )}

                    {activity && (
                        <div className="ra-alert error">
                            <AlertTriangle size={15} />
                            <div className="ra-alert-body">
                                Remote jog in progress{activity.userLabel ? ` by ${activity.userLabel}` : ''} ({activity.axis.toUpperCase()}{activity.dir > 0 ? '+' : '−'}).
                            </div>
                        </div>
                    )}

                    {operator && (
                        <>
                            <div className="ca-scope" role="radiogroup" aria-label="Who gets Motion">
                                <label className={`ca-scope-opt ${scopeChoice === 'lan' ? 'on' : ''}`}>
                                    <input type="radio" name="ca-scope" checked={scopeChoice === 'lan'} onChange={() => setScopeChoice('lan')} />
                                    LAN phones
                                </label>
                                <label className={`ca-scope-opt ${scopeChoice === 'cloud-user' ? 'on' : ''}`}>
                                    <input type="radio" name="ca-scope" checked={scopeChoice === 'cloud-user'} onChange={() => setScopeChoice('cloud-user')} />
                                    Cloud: one user
                                </label>
                                <label className={`ca-scope-opt ${scopeChoice === 'cloud-all' ? 'on' : ''}`}>
                                    <input type="radio" name="ca-scope" checked={scopeChoice === 'cloud-all'} onChange={() => setScopeChoice('cloud-all')} />
                                    Cloud: all users
                                </label>
                            </div>
                            {scopeChoice === 'cloud-user' && (
                                recentUsers.length > 0 ? (
                                    <label className="wa-label">
                                        Cloud user
                                        <select
                                            className="wa-input"
                                            value={scopeUserId}
                                            onChange={(e) => setScopeUserId(e.target.value)}
                                            disabled={busy}
                                        >
                                            {recentUsers.map((u) => (
                                                <option key={u.userId} value={u.userId}>
                                                    {u.userLabel} · seen {timeAgo(u.lastSeenAt)}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                ) : (
                                    <div className="wa-empty">No cloud user has used this machine in the last 24 hours. Open it on the phone first.</div>
                                )
                            )}
                            <div className="ca-wrap-row" title={grantLocks.length ? `Locked: ${grantLocks.join(', ')}` : undefined}>
                                {([5, 15, 30] as const).map((m) => (
                                    <button
                                        key={m}
                                        className="settings-btn primary ca-big-btn"
                                        disabled={busy || !perms || grantLocks.length > 0
                                            || (scopeChoice === 'cloud-user' && !selectedUser)}
                                        onClick={() => grant(m)}
                                    >
                                        {m} min
                                    </button>
                                ))}
                            </div>
                            {grantLocks.length > 0 && (
                                <div className="wa-block-sub">Motion cannot be granted while: {grantLocks.join(', ')}.</div>
                            )}
                        </>
                    )}
                </div>

                <div className="ra-alert info">
                    <Info size={15} />
                    <div className="ra-alert-body">
                        A phone is not an emergency stop. Keep the physical E-stop within reach whenever Motion is enabled.
                    </div>
                </div>
                <div className="ra-alert warn">
                    <ShieldAlert size={15} />
                    <div className="ra-alert-body">
                        Raw G-code, console, firmware, macros and settings are never available remotely.
                    </div>
                </div>

                {operator && (
                    <>
                        <div className="ra-label">Recent remote activity</div>
                        {audit.length === 0 ? (
                            <div className="wa-empty">No remote activity yet.</div>
                        ) : (
                            <div className="ra-list">
                                {audit.map((e, idx) => (
                                    <div key={`${e.ts}:${idx}`} className="ra-row">
                                        <span className={`ra-dot ${e.status === 'accepted' ? 'on' : ''}`} />
                                        <div className="ra-row-main">
                                            <span className="ra-row-name">{auditWhat(e)}</span>
                                            <span className="ra-row-meta">
                                                {[
                                                    new Date(e.ts).toLocaleTimeString(),
                                                    auditWho(e),
                                                    e.status ? `${e.status}${e.code && e.code !== 'OK' ? ` (${e.code})` : ''}` : null,
                                                    e.duplicate ? 'retry' : null,
                                                ].filter(Boolean).join(' · ')}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Blocking confirmation: nothing connects until the operator decides. */}
            {claimed && (
                <div className="ca-confirm-backdrop">
                    <div className="ca-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ca-confirm-title">
                        <div id="ca-confirm-title" className="ca-confirm-title">
                            Pair this machine with {claimed.accountDisplayName} ({claimed.accountLabel})?
                        </div>
                        <div className="ca-confirm-note">
                            Only confirm if this is you or someone you trust. They will see the camera and telemetry and can stage files.
                        </div>
                        <div className="ca-confirm-actions">
                            <button
                                className="settings-btn danger ca-big-btn"
                                disabled={busy}
                                onClick={() => run(async () => { await remoteCloud.rejectPairing(); setPairing(null); }, 'Pairing rejected.')}
                            >
                                Reject
                            </button>
                            <button
                                className="settings-btn primary ca-big-btn"
                                disabled={busy}
                                onClick={() => run(async () => {
                                    setCloudStatus(await remoteCloud.confirmPairing());
                                    setPairing(null);
                                }, 'Machine paired.')}
                            >
                                Confirm
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
