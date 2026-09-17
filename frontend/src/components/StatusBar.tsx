import { Ruler } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { backendUnlock, sendBackendCommand } from '../utils/backendConnection';
import RemoteActivityBadge from './RemoteActivityBadge';
import './StatusBar.css';

const STATE_LABELS: Record<string, string> = {
    idle: 'IDLE',
    running: 'RUNNING',
    paused: 'PAUSED',
    alarm: 'ALARM',
};

export default function StatusBar() {
    const {
        connected,
        connectionStatus,
        machineState,
        activeWCS,
        appPreferences,
        setAppPreferences,
        firmwareType,
        firmwareVersion,
        remoteDiagStatus,
        remotePermissions,
        remoteActivity,
    } = useCNCStore();
    // A Revoke button needs a 44px touch target, so the bar grows while one shows.
    const remoteAttention = !!remoteActivity || (remotePermissions?.motionRemainingMs ?? 0) > 0;

    const stateLabel = !connected
        ? 'OFFLINE'
        : (STATE_LABELS[machineState] ?? machineState.toUpperCase());

    const stateClass = !connected
        ? 'state-offline'
        : `state-${machineState}`;

    const handleToggleUnits = () => {
        const currentUnit = appPreferences?.units?.toLowerCase() === 'inches' || appPreferences?.units?.toLowerCase() === 'in' ? 'inches' : 'mm';
        const nextUnits = currentUnit === 'inches' ? 'mm' : 'inches';
        setAppPreferences({ ...appPreferences, units: nextUnits });
        sendBackendCommand(nextUnits === 'mm' ? 'G21' : 'G20');
    };

    return (
        <footer className={`status-bar${remoteAttention ? ' sb-remote-attention' : ''}`} role="status" aria-label="Machine status">
            {/* Connection indicator */}
            <div className="sb-item sb-connection" title={`Connection: ${connectionStatus}`}>
                <span className={`sb-dot ${connected ? 'connected' : 'disconnected'}`} />
                <span className="sb-label">{connected ? 'Connected' : 'Disconnected'}</span>
            </div>

            <div className="sb-divider" />

            {/* Machine state */}
            <div className={`sb-item sb-state ${stateClass}`} title="Machine state">
                <span className="sb-label">{stateLabel}</span>
            </div>

            <div className="sb-divider" />

            {/* WCS */}
            <div className="sb-item" title="Active Work Coordinate System">
                <span className="sb-key">WCS</span>
                <span className="sb-val">{activeWCS}</span>
            </div>

            <div className="sb-divider" />

            {/* Units */}
            <button
                type="button"
                className="sb-item sb-unit-btn"
                onClick={handleToggleUnits}
                title={`Active Units: ${appPreferences?.units || 'mm'} — Click to toggle mm / inches (G20/G21)`}
            >
                <Ruler size={11} className="sb-unit-icon" />
                <span className="sb-key">Units</span>
                <span className="sb-val">{appPreferences?.units?.toLowerCase() === 'inches' || appPreferences?.units?.toLowerCase() === 'in' ? 'in' : 'mm'}</span>
            </button>

            {/* Alarm badge + clear button */}
            {machineState === 'alarm' && (
                <>
                    <div className="sb-divider" />
                    <div className="sb-item sb-alarm-badge" title="Machine is in alarm state — click Clear to unlock">
                        <span>ALARM</span>
                        <button
                            className="sb-alarm-clear"
                            onClick={() => backendUnlock()}
                            title="Send $X to clear alarm and unlock machine"
                        >
                            Clear
                        </button>
                    </div>
                </>
            )}

            {/* ECSS-E: Remote diagnostic mirror badge */}
            {remoteDiagStatus?.enabled && (
                <>
                    <div className="sb-divider" />
                    <div className="sb-item sb-remote-diag" title={
                        remoteDiagStatus.connected
                            ? `Remote diagnostic ACTIVE — connected to ${remoteDiagStatus.url}. Click off in Settings to stop.`
                            : `Remote diagnostic enabled, RECONNECTING to ${remoteDiagStatus.url}...`
                    }>
                        <span className={`sb-rd-dot ${remoteDiagStatus.connected ? 'live' : 'reconnecting'}`} />
                        <span className="sb-label">REMOTE DIAG</span>
                    </div>
                </>
            )}

            {/* Cloud link / remote Motion / remote jog — visible on every tab, mid-job too */}
            <RemoteActivityBadge />

            {/* Firmware */}
            {connected && firmwareType !== 'unknown' && (
                <>
                    <div className="sb-spacer" />
                    <div className="sb-item sb-firmware" title="Controller firmware">
                        <span className="sb-key">FW</span>
                        <span className="sb-val">{firmwareType} {firmwareVersion}</span>
                    </div>
                </>
            )}
        </footer>
    );
}
