// HomingOverlay — fullscreen modal that shows the homing progress sequence.
//
// Backend events consumed (wired in utils/backendConnection.ts):
//   homing:location { location: 'all'|'X'|'Y'|'Z', status: 'started'|'completed'|'failed', sequence?: string[] }
//   homing:axis     { axis: 'X'|'Y'|'Z', remaining: string[] }
//
// Behaviour
//   - On 'all started' we render the full sequence (Z → X → Y per safety rule)
//     with a step indicator and highlight whichever axis is running.
//   - On 'axis' events the active axis advances; previous axes get the
//     "done" check, future axes stay dimmed.
//   - On 'completed' or 'failed' the overlay clears via the store. A failure
//     also displays a transient red banner with the failing axis before the
//     overlay closes so the operator knows WHY it stopped.
//   - A 90-second client-side watchdog auto-dismisses if no progress events
//     arrive in that window (belt-and-braces if the backend forgets to emit).
import { useEffect, useState } from 'react';
import { Check, CircleDot, Loader2, AlertTriangle, X as XIcon } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import controller from '../utils/controller';
import { backendEstop } from '../utils/backendConnection';
import './HomingOverlay.css';

const DEFAULT_SEQUENCE = ['Z', 'X', 'Y'] as const;

export default function HomingOverlay() {
    const { homingLocation, setHomingLocation, addConsoleLog } = useCNCStore();
    const [sequence, setSequence] = useState<readonly string[]>(DEFAULT_SEQUENCE);
    const [activeAxis, setActiveAxis] = useState<string | null>(null);
    const [failureAxis, setFailureAxis] = useState<string | null>(null);
    const [lastEventAt, setLastEventAt] = useState<number>(Date.now());

    useEffect(() => {
        const onAxis = (data: unknown) => {
            const p = data as { axis: string; remaining?: string[] };
            setActiveAxis(p.axis);
            setLastEventAt(Date.now());
        };
        const onLocation = (data: unknown) => {
            const p = data as { location: string; status: string; sequence?: string[] };
            setLastEventAt(Date.now());
            if (p.status === 'started' && p.location === 'all') {
                setSequence(p.sequence && p.sequence.length ? p.sequence : DEFAULT_SEQUENCE);
                setActiveAxis(p.sequence?.[0] || DEFAULT_SEQUENCE[0]);
                setFailureAxis(null);
            }
            if (p.status === 'failed') {
                setFailureAxis(p.location);
                addConsoleLog('error', `Homing FAILED on ${p.location}-axis — limit switch did not trigger.`);
            }
            if (p.status === 'completed') {
                setActiveAxis(null);
                setFailureAxis(null);
            }
        };
        controller.on('homing:axis', onAxis);
        controller.on('homing:location', onLocation);
        return () => {
            controller.off('homing:axis', onAxis);
            controller.off('homing:location', onLocation);
        };
    }, [addConsoleLog]);

    // Belt-and-braces: if no homing progress event arrives in 90 sec, force-close.
    useEffect(() => {
        if (!homingLocation) return;
        const timer = setInterval(() => {
            if (Date.now() - lastEventAt > 90_000) {
                addConsoleLog('error', 'Homing watchdog: 90 s of silence — dismissing overlay.');
                setHomingLocation(null);
            }
        }, 5_000);
        return () => clearInterval(timer);
    }, [homingLocation, lastEventAt, setHomingLocation, addConsoleLog]);

    if (!homingLocation) return null;

    const isAll = homingLocation === 'all';
    const stepsToRender = isAll ? sequence : [homingLocation];
    const activeIdx = activeAxis ? stepsToRender.indexOf(activeAxis) : 0;

    const handleAbort = () => {
        backendEstop();
        addConsoleLog('error', 'HOMING ABORTED');
        setHomingLocation(null);
    };

    return (
        <div className="homing-overlay" role="dialog" aria-live="polite">
            <div className="homing-card">
                <div className="homing-header">
                    <Loader2 className="homing-spinner" size={20} />
                    <span>Homing in progress</span>
                </div>

                <div className="homing-title">{isAll ? 'Auto-home' : `${homingLocation}-axis home`}</div>
                <div className="homing-subtitle">
                    {failureAxis
                        ? <span className="homing-fail-line"><AlertTriangle size={14} /> Limit switch not triggered on {failureAxis}-axis</span>
                        : `Following safety sequence: ${stepsToRender.join(' → ')}`}
                </div>

                <ol className="homing-steps">
                    {stepsToRender.map((step, i) => {
                        const isDone = activeAxis && i < activeIdx;
                        const isActive = step === activeAxis;
                        const isFailed = failureAxis === step;
                        return (
                            <li
                                key={step}
                                className={`homing-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''} ${isFailed ? 'failed' : ''}`}
                            >
                                <span className="homing-step-icon">
                                    {isFailed ? <AlertTriangle size={18} /> :
                                     isDone   ? <Check size={18} /> :
                                     isActive ? <Loader2 className="homing-spinner" size={18} /> :
                                                <CircleDot size={18} />}
                                </span>
                                <div className="homing-step-body">
                                    <div className="homing-step-axis">{step}-axis</div>
                                    <div className="homing-step-status">
                                        {isFailed ? 'TIMEOUT — check switch'
                                         : isDone ? 'homed'
                                         : isActive ? 'moving to limit…'
                                         : 'waiting'}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ol>

                <button className="homing-abort" onClick={handleAbort}>
                    <XIcon size={16} />
                    Abort
                </button>
            </div>
        </div>
    );
}
