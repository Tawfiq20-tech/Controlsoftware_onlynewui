import { useCNCStore } from '../stores/cncStore';
import { backendUnlock } from '../utils/backendConnection';
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
        firmwareType,
        firmwareVersion,
        remoteDiagStatus,
    } = useCNCStore();

    const stateLabel = !connected
        ? 'OFFLINE'
        : (STATE_LABELS[machineState] ?? machineState.toUpperCase());

    const stateClass = !connected
        ? 'state-offline'
        : `state-${machineState}`;

    return (
        <footer className="status-bar" role="status" aria-label="Machine status">
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
            <div className="sb-item" title="Units">
                <span className="sb-key">Units</span>
                <span className="sb-val">{appPreferences.units}</span>
            </div>

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
