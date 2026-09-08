// MotorErrorDialog — surfaces an alarm/motor-error as a modal instead of
// requiring the operator to notice the small sidebar banner.
//
// Deliberately does NOT decode limitFlags/faultFlags into a per-axis fault
// (e.g. "bit 2 = Z limit") — no verified bit-to-axis mapping exists anywhere
// in the backend (backend/services/rsp/defs.js only documents wire byte
// offsets, not semantics). Showing raw hex here is honest; inventing a
// decode table would not be.
import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { backendMotorReset, backendUnlock } from '../utils/backendConnection';
import './PortSelectionModal.css';

export default function MotorErrorDialog() {
    const machineState = useCNCStore((s) => s.machineState);
    const lastAlarm = useCNCStore((s) => s.lastAlarm);
    const addConsoleLog = useCNCStore((s) => s.addConsoleLog);

    // Track dismissal by the *specific* alarm occurrence (object identity),
    // not by a boolean — so a fresh alarm always reopens the dialog even if
    // the previous one of the same type was just dismissed.
    const [dismissedAlarm, setDismissedAlarm] = useState<typeof lastAlarm>(null);

    const isErrorState = machineState === 'alarm' || machineState === 'motorError';

    // A new alarm (or a state change back to alarm/motorError) clears any
    // prior dismissal so the dialog reopens for the new occurrence.
    useEffect(() => {
        if (!isErrorState) {
            setDismissedAlarm(null);
        }
    }, [isErrorState]);

    if (!isErrorState) return null;
    if (lastAlarm && dismissedAlarm === lastAlarm) return null;

    const handleDismiss = () => setDismissedAlarm(lastAlarm);

    const handleReset = (motor?: string) => {
        backendMotorReset(motor);
        addConsoleLog('info', motor ? `Resetting ${motor} motor...` : 'Resetting all motors...');
    };

    const handleResetAll = () => {
        backendMotorReset();
        backendUnlock();
        addConsoleLog('info', 'Resetting all motors...');
    };

    const hasFlags = !!(lastAlarm?.limitFlags || lastAlarm?.faultFlags);

    return (
        <div className="modal-overlay" onClick={handleDismiss}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="modal-title">
                        <AlertTriangle size={20} color="#e74c3c" />
                        <h2>{machineState === 'motorError' ? 'Motor Error' : 'Alarm — Machine Locked'}</h2>
                    </div>
                    <button className="modal-close" onClick={handleDismiss}>
                        <X size={18} />
                    </button>
                </div>

                <div className="modal-body">
                    <p>
                        {lastAlarm?.message ||
                            (machineState === 'motorError'
                                ? 'Closed-loop motor error detected.'
                                : 'Machine is locked and cannot move.')}
                    </p>
                    {lastAlarm?.description && (
                        <div className="modal-info">
                            <p>{lastAlarm.description}</p>
                        </div>
                    )}
                    {hasFlags && (
                        <div className="modal-info">
                            <p>
                                <strong>Raw flags</strong> (fault: 0x
                                {(lastAlarm?.faultFlags || 0).toString(16).padStart(2, '0')}, limit: 0x
                                {(lastAlarm?.limitFlags || 0).toString(16).padStart(2, '0')}) —
                                {' '}per-axis meaning not yet verified against firmware; not decoded here.
                            </p>
                        </div>
                    )}

                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '12px' }}>
                        {['X', 'Y', 'Z'].map((motor) => (
                            <button
                                key={motor}
                                className="btn-add-port"
                                style={{ flex: 1, minWidth: '70px', background: '#c0392b' }}
                                onClick={() => handleReset(motor)}
                            >
                                Reset {motor}
                            </button>
                        ))}
                    </div>
                    <button className="btn-add-port" style={{ marginTop: '8px', background: '#2980b9' }} onClick={handleResetAll}>
                        Reset All &amp; Unlock
                    </button>
                </div>
            </div>
        </div>
    );
}
