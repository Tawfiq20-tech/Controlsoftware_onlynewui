/**
 * ProbingModal — full-screen overlay 3-step probing wizard.
 *
 * Step 1 · pick probe type (Z Probe / XYZ Probe) — cards with diagram
 * Step 2 · jog to position + enter bit diameter — Done → next
 * Step 3 · start probing — live status — OK closes modal
 *
 * Replaces the old in-sidebar multi-step ProbeWizard (Tawfiq msg 7350).
 * Backend probe G-code emission is stubbed to a placeholder call against
 * /api/probing/run — v2 will swap in real strategies per type.
 */
import { useEffect, useState } from 'react';
import { X, ArrowLeft, ArrowRight, Play, Check, Crosshair } from 'lucide-react';
import { useCNCStore } from '../../stores/cncStore';
import { backendJog } from '../../utils/backendConnection';
import { remoteAuthHeaders } from '../../utils/remoteAuth';
import zProbeImg from '../../assets/probing/z-probe.jpg';
import xyzProbeImg from '../../assets/probing/xyz-probe.jpg';
import './ProbingModal.css';

type ProbeType = 'z' | 'xyz';
type Step = 1 | 2 | 3;
type RunState = 'idle' | 'running' | 'success' | 'error';

interface Props {
    open: boolean;
    /** Pre-picked probe type (Sidebar PROBE tiles set this so the modal
     *  skips step 1). When null (e.g. opened from the File-Management
     *  "Probe" button — Tawfiq msg 7375), the modal starts at step 1 so
     *  the user picks Z vs XYZ inside the modal itself. */
    initialType: ProbeType | null;
    onClose: () => void;
}

const BACKEND_BASE = (() => {
    const env = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
    if (env) return String(env).replace(/\/$/, '');
    if (typeof window !== 'undefined') {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:4000`;
    }
    return 'http://localhost:4000';
})();

export default function ProbingModal({ open, initialType, onClose }: Props) {
    const [step, setStep] = useState<Step>(initialType ? 2 : 1);
    const [probeType, setProbeType] = useState<ProbeType | null>(initialType);
    const [bitDiameter, setBitDiameter] = useState<number>(6);
    const [runState, setRunState] = useState<RunState>('idle');
    const [runError, setRunError] = useState<string | null>(null);
    const [finalizeState, setFinalizeState] = useState<RunState>('idle');
    const [finalizeError, setFinalizeError] = useState<string | null>(null);

    const machinePosition = useCNCStore((s) => s.machinePosition);

    // When the modal opens (or initialType changes between launches), reset
    // internal state. Without this, opening from the File-Management Probe
    // button (initialType = null) after a previous sidebar-tile launch would
    // reuse stale step + probeType — looked like "nothing happened" to the
    // user because the modal would render an old jog screen instead of the
    // type-picker (Tawfiq msg 7378).
    useEffect(() => {
        if (!open) return;
        setStep(initialType ? 2 : 1);
        setProbeType(initialType);
        setBitDiameter(6);
        setRunState('idle');
        setRunError(null);
        setFinalizeState('idle');
        setFinalizeError(null);
    }, [open, initialType]);

    if (!open) return null;

    function reset() {
        setStep(initialType ? 2 : 1);
        setProbeType(initialType);
        setBitDiameter(6);
        setRunState('idle');
        setRunError(null);
        setFinalizeState('idle');
        setFinalizeError(null);
    }
    function close() {
        reset();
        onClose();
    }
    function pickType(t: ProbeType) {
        setProbeType(t);
        setStep(2);
    }
    async function startProbe() {
        if (!probeType) return;
        setRunState('running');
        setRunError(null);
        try {
            const r = await fetch(`${BACKEND_BASE}/api/probing/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...remoteAuthHeaders() },
                body: JSON.stringify({
                    strategy: probeType === 'z' ? 'z-only' : 'xyz-corner-front-left',
                    settings: { bitDiameter, wcs: 'G54' },
                }),
            });
            // backend/index.js's /api/probing/run returns 400 + {error: msg}
            // on ProbingService.run() throwing (e.g. "No active controller",
            // "controller not idle", "X probe did not contact", "probe
            // rejected: ..."). !r.ok discarded that body and showed a bare
            // "Backend returned 400" -- exactly the RSP-specific reason
            // Tawfiq needs to see was being thrown away silently.
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.success === false) {
                throw new Error(data.error || `Backend returned ${r.status}`);
            }
            setRunState('success');
        } catch (err) {
            setRunError(err instanceof Error ? err.message : String(err));
            setRunState('error');
        }
    }
    // msg11601 item 4: separate, human-triggered step. WCS zero after the
    // xyz-corner routine still sits at the touch-plate TOP -- this call
    // only happens after the operator confirms the probe device is
    // physically removed, then drops Z by plateThickness and re-zeros.
    async function finalizeCorner() {
        setFinalizeState('running');
        setFinalizeError(null);
        try {
            const r = await fetch(`${BACKEND_BASE}/api/probing/finalize-corner`, { method: 'POST', headers: remoteAuthHeaders() });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.success === false) {
                throw new Error(data.error || `Backend returned ${r.status}`);
            }
            setFinalizeState('success');
        } catch (err) {
            setFinalizeError(err instanceof Error ? err.message : String(err));
            setFinalizeState('error');
        }
    }

    return (
        <div className="pm-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
            <div className="pm-modal" role="dialog" aria-modal="true" aria-labelledby="pm-title">
                <header className="pm-header">
                    <div className="pm-title-row">
                        <Crosshair size={18} />
                        <h2 id="pm-title">Probing</h2>
                    </div>
                    <button className="pm-close" onClick={close} aria-label="Close">
                        <X size={18} />
                    </button>
                </header>

                <div className="pm-steps">
                    {[1, 2, 3].map((n) => (
                        <div key={n} className={`pm-step ${step === n ? 'on' : ''} ${step > n ? 'done' : ''}`}>
                            <span className="pm-step-num">{step > n ? <Check size={12} /> : n}</span>
                            <span className="pm-step-lbl">{n === 1 ? 'TYPE' : n === 2 ? 'JOG + BIT' : 'PROBE'}</span>
                        </div>
                    ))}
                </div>

                <div className="pm-body">
                    {step === 1 && (
                        <Step1Type onPick={pickType} selected={probeType} />
                    )}
                    {step === 2 && probeType && (
                        <Step2Jog
                            bitDiameter={bitDiameter}
                            setBitDiameter={setBitDiameter}
                            machinePosition={machinePosition}
                        />
                    )}
                    {step === 3 && probeType && (
                        <Step3Run
                            probeType={probeType}
                            bitDiameter={bitDiameter}
                            runState={runState}
                            runError={runError}
                            onStart={startProbe}
                            onClose={close}
                            finalizeState={finalizeState}
                            finalizeError={finalizeError}
                            onFinalize={finalizeCorner}
                        />
                    )}
                </div>

                <footer className="pm-footer">
                    {step > 1 && runState !== 'running' && !initialType && (
                        <button className="pm-btn" onClick={() => setStep((step - 1) as Step)}>
                            <ArrowLeft size={14} /> Back
                        </button>
                    )}
                    {step > 2 && runState !== 'running' && initialType && (
                        <button className="pm-btn" onClick={() => setStep(2)}>
                            <ArrowLeft size={14} /> Back
                        </button>
                    )}
                    <div className="pm-spacer" />
                    {step === 2 && (
                        <button className="pm-btn pm-btn-primary" onClick={() => setStep(3)}>
                            Done <ArrowRight size={14} />
                        </button>
                    )}
                </footer>
            </div>
        </div>
    );
}

// ─── Step 1: choose probe type ────────────────────────────────────
function Step1Type({ onPick, selected }: { onPick: (t: ProbeType) => void; selected: ProbeType | null }) {
    return (
        <div className="pm-step1">
            <p className="pm-prompt">Which probing routine?</p>
            <div className="pm-type-grid">
                <button
                    className={`pm-type-card ${selected === 'z' ? 'on' : ''}`}
                    onClick={() => onPick('z')}>
                    <img src={zProbeImg} alt="Z probe — bit descending onto touch plate" className="pm-diagram-img" />
                    <div className="pm-type-name">Z Probe</div>
                    <div className="pm-type-desc">
                        Lower the bit onto a Z touch plate. Sets the Z zero.
                    </div>
                </button>
                <button
                    className={`pm-type-card ${selected === 'xyz' ? 'on' : ''}`}
                    onClick={() => onPick('xyz')}>
                    <img src={xyzProbeImg} alt="XYZ probe — bit touching corner block in X, Y, Z" className="pm-diagram-img" />
                    <div className="pm-type-name">XYZ Probe</div>
                    <div className="pm-type-desc">
                        Touch a corner block on three sides. Sets X, Y, and Z zero in one routine.
                    </div>
                </button>
            </div>
        </div>
    );
}

// ─── Step 2: jog + bit size ────────────────────────────────────────
function Step2Jog({
    bitDiameter, setBitDiameter, machinePosition,
}: {
    bitDiameter: number;
    setBitDiameter: (v: number) => void;
    machinePosition: { x: number; y: number; z: number };
}) {
    // MED#12: this wizard can reach step 2 without an active connection
    // (e.g. port dropped mid-session) -- unlike Sidebar's jog controls,
    // these buttons had no connected guard, so pressing them silently
    // no-op'd deep inside backendJog/controller.jog with no feedback.
    const connected = useCNCStore((s) => s.connected);

    // Was sending a raw GRBL '$J=...' string as args[0]; RSPController's
    // 'jog' handler expects an {x,y,z,feedRate} object (same shape Sidebar's
    // handleJog -> backendJog uses) so the string was silently ignored --
    // no axis key matched and nothing moved. Route through backendJog like
    // every other working jog control in the app.
    const jog = (axis: 'X' | 'Y' | 'Z', dir: 1 | -1, step: number) => {
        if (!connected) return;
        const dist = dir * step;
        const feedRate = 2000;
        if (axis === 'X') backendJog(dist, undefined, undefined, feedRate);
        else if (axis === 'Y') backendJog(undefined, dist, undefined, feedRate);
        else backendJog(undefined, undefined, dist, feedRate);
    };
    const [step, setStep] = useState(1);

    return (
        <div className="pm-step2">
            <p className="pm-prompt">Jog the bit to the probing position, then enter the bit diameter.</p>

            <div className="pm-jog-pos">
                <span><b>X</b> {machinePosition.x.toFixed(3)}</span>
                <span><b>Y</b> {machinePosition.y.toFixed(3)}</span>
                <span><b>Z</b> {machinePosition.z.toFixed(3)}</span>
                <span className="pm-jog-unit">mm</span>
            </div>

            <div className="pm-jog-wheel">
                <button className="pm-jog-btn jw-y-plus" onClick={() => jog('Y', 1, step)} disabled={!connected}>Y+</button>
                <button className="pm-jog-btn jw-x-minus" onClick={() => jog('X', -1, step)} disabled={!connected}>X−</button>
                <button className="pm-jog-btn jw-x-plus" onClick={() => jog('X', 1, step)} disabled={!connected}>X+</button>
                <button className="pm-jog-btn jw-y-minus" onClick={() => jog('Y', -1, step)} disabled={!connected}>Y−</button>
                <div className="pm-jog-z">
                    <button className="pm-jog-btn" onClick={() => jog('Z', 1, step)} disabled={!connected}>Z+</button>
                    <button className="pm-jog-btn" onClick={() => jog('Z', -1, step)} disabled={!connected}>Z−</button>
                </div>
            </div>

            <div className="pm-jog-step">
                <span className="pm-jog-step-lbl">Step (mm)</span>
                {[0.1, 1, 10, 50, 100].map((s) => (
                    <button key={s}
                        className={`pm-step-btn ${step === s ? 'on' : ''}`}
                        onClick={() => setStep(s)}>
                        {s}
                    </button>
                ))}
            </div>

            <label className="pm-bit-row">
                <span className="pm-bit-lbl">Bit diameter (mm)</span>
                <input
                    type="number"
                    min={0.1}
                    max={20}
                    step={0.1}
                    value={bitDiameter}
                    onChange={(e) => {
                        // MED#12: the min/max attrs only affect the spinner
                        // arrows and native validity state, not typed input --
                        // a bare Number() cast let negative/zero/oversized
                        // values through into a probe-offset calculation.
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) { setBitDiameter(6); return; }
                        setBitDiameter(Math.min(20, Math.max(0.1, v)));
                    }}
                    className="pm-bit-input"
                />
            </label>
        </div>
    );
}

// ─── Step 3: run ───────────────────────────────────────────────────
function Step3Run({
    probeType, bitDiameter, runState, runError, onStart, onClose,
    finalizeState, finalizeError, onFinalize,
}: {
    probeType: ProbeType;
    bitDiameter: number;
    runState: RunState;
    runError: string | null;
    onStart: () => void;
    onClose: () => void;
    finalizeState: RunState;
    finalizeError: string | null;
    onFinalize: () => void;
}) {
    return (
        <div className="pm-step3">
            {runState === 'idle' && (
                <>
                    <p className="pm-prompt">Ready to probe.</p>
                    <div className="pm-summary">
                        <div><span className="pm-summary-lbl">Routine</span>{probeType === 'z' ? 'Z Probe' : 'XYZ Probe'}</div>
                        <div><span className="pm-summary-lbl">Bit Ø</span>{bitDiameter} mm</div>
                    </div>
                    <button className="pm-btn pm-btn-primary pm-btn-big" onClick={onStart}>
                        <Play size={16} /> Start Probing
                    </button>
                    <p className="pm-warn">⚠ Make sure the touch plate is connected and the bit is positioned above it before starting.</p>
                </>
            )}
            {runState === 'running' && (
                <div className="pm-running">
                    <div className="pm-spinner" />
                    <div className="pm-running-lbl">Probing…</div>
                    <div className="pm-running-sub">Do not jog or move the machine. Hit E-Stop to abort.</div>
                </div>
            )}
            {runState === 'success' && probeType === 'xyz' && finalizeState === 'idle' && (
                <div className="pm-success">
                    <div className="pm-success-icon"><Check size={32} /></div>
                    <div className="pm-success-lbl">Probing complete</div>
                    <div className="pm-success-sub">
                        X/Y are true zero. Z is still zeroed at the touch-plate top —
                        remove the probe device from the corner, then confirm to drop
                        Z to the real surface.
                    </div>
                    <button className="pm-btn pm-btn-primary pm-btn-big" onClick={onFinalize}>
                        Probe device removed — finalize zero
                    </button>
                    <button className="pm-btn" onClick={onClose}>Close without finalizing</button>
                </div>
            )}
            {runState === 'success' && probeType === 'xyz' && finalizeState === 'running' && (
                <div className="pm-running">
                    <div className="pm-spinner" />
                    <div className="pm-running-lbl">Finalizing corner zero…</div>
                    <div className="pm-running-sub">Dropping Z to the true surface. Do not jog.</div>
                </div>
            )}
            {runState === 'success' && probeType === 'xyz' && finalizeState === 'success' && (
                <div className="pm-success">
                    <div className="pm-success-icon"><Check size={32} /></div>
                    <div className="pm-success-lbl">Corner zero finalized</div>
                    <div className="pm-success-sub">X, Y, and Z are all at true zero.</div>
                    <button className="pm-btn pm-btn-primary pm-btn-big" onClick={onClose}>OK</button>
                </div>
            )}
            {runState === 'success' && probeType === 'xyz' && finalizeState === 'error' && (
                <div className="pm-error">
                    <div className="pm-error-icon">⚠</div>
                    <div className="pm-error-lbl">Finalize failed</div>
                    <div className="pm-error-msg">{finalizeError}</div>
                    <button className="pm-btn" onClick={onFinalize}>Retry</button>
                    <button className="pm-btn" onClick={onClose}>Close</button>
                </div>
            )}
            {runState === 'success' && probeType === 'z' && (
                <div className="pm-success">
                    <div className="pm-success-icon"><Check size={32} /></div>
                    <div className="pm-success-lbl">Probing complete</div>
                    <div className="pm-success-sub">Work coordinate system updated.</div>
                    <button className="pm-btn pm-btn-primary pm-btn-big" onClick={onClose}>OK</button>
                </div>
            )}
            {runState === 'error' && (
                <div className="pm-error">
                    <div className="pm-error-icon">⚠</div>
                    <div className="pm-error-lbl">Probing failed</div>
                    <div className="pm-error-msg">{runError}</div>
                    <button className="pm-btn" onClick={onStart}>Retry</button>
                </div>
            )}
        </div>
    );
}

