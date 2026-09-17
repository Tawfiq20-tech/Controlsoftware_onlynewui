/**
 * RemoteActivityBadge — status-bar indicator for the cloud link, an active
 * Motion grant and a remote jog (docs/cloud-relay/SPEC.md §8.1).
 *
 * It lives in the status bar because Header tabs lock while carving: the
 * operator must be able to see and revoke remote Motion mid-job without
 * navigating anywhere.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { useServerCountdown } from '../hooks/useServerCountdown';
import { remoteCloud } from './Settings/api';
import './RemoteActivityBadge.css';

function openCloudSettings() {
    window.dispatchEvent(new CustomEvent('cnc:open-settings', { detail: { tab: 'cloud' } }));
}

export default function RemoteActivityBadge() {
    const cloudStatus = useCNCStore((s) => s.cloudStatus);
    const perms = useCNCStore((s) => s.remotePermissions);
    const permsAt = useCNCStore((s) => s.remotePermissionsReceivedAt);
    const activity = useCNCStore((s) => s.remoteActivity);
    const addConsoleLog = useCNCStore((s) => s.addConsoleLog);
    const [revoking, setRevoking] = useState(false);

    const countdown = useServerCountdown(perms?.motionRemainingMs ?? null, permsAt);
    const motionActive = !!perms && perms.motionRemainingMs !== null && !countdown.expired;

    let link: { label: string; dot: 'idle' | 'ok' | 'warn'; title: string } | null = null;
    if (cloudStatus?.lanOnly) {
        link = { label: 'LAN ONLY', dot: 'idle', title: 'LAN-only: this machine makes no internet connections' };
    } else if (cloudStatus?.paired && cloudStatus.state === 'online') {
        link = { label: 'CLOUD', dot: 'ok', title: `Cloud relay online${cloudStatus.viewers ? ` · ${cloudStatus.viewers} viewing` : ''}` };
    } else if (cloudStatus?.paired) {
        link = { label: 'CLOUD OFFLINE', dot: 'warn', title: cloudStatus.lastError || 'Cloud relay not connected' };
    }

    if (!link && !motionActive && !activity) return null;

    async function revoke() {
        setRevoking(true);
        try {
            await remoteCloud.revokeMotion();
            addConsoleLog('warning', '[Remote] Motion revoked from the status bar');
        } catch (err) {
            addConsoleLog('error', `[Remote] Revoke failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setRevoking(false);
        }
    }

    const revokeButton = (
        <button
            type="button"
            className="rab-revoke"
            onClick={revoke}
            disabled={revoking}
            aria-label="Revoke remote Motion"
            title="Revoke remote Motion (stops any remote jog)"
        >
            <X size={13} /> Revoke
        </button>
    );

    return (
        <>
            <div className="sb-divider" />
            <div className="rab" role="group" aria-label="Remote access">
                {link && (
                    <button type="button" className="rab-chip" onClick={openCloudSettings} title={link.title}>
                        <span className={`rab-dot ${link.dot}`} />
                        <span>{link.label}</span>
                    </button>
                )}
                {motionActive && (
                    <span className="rab-alert warn">
                        <button type="button" className="rab-chip" onClick={openCloudSettings} title="Remote Motion is enabled">
                            <span>MOTION {countdown.label}</span>
                        </button>
                        {!activity && revokeButton}
                    </span>
                )}
                {activity && (
                    <span className="rab-alert bad">
                        <button type="button" className="rab-chip" onClick={openCloudSettings} title="A remote device is jogging the machine">
                            <span>REMOTE JOG{activity.userLabel ? ` · ${activity.userLabel}` : ''}</span>
                        </button>
                        {revokeButton}
                    </span>
                )}
            </div>
        </>
    );
}
