/**
 * ProbeWizard — Step-by-step probing wizard for CNC touch plate operations.
 *
 * Supports Standard Block, AutoZero, and Z Probe touch plates.
 * Routines: Z only, XY, XYZ.
 * Wizard steps: Select Type → Configure → Connectivity Test → Run Probe.
 */
import { useState, useCallback } from 'react';
import {
    ChevronRight, ChevronLeft,
    Zap, ZapOff, CheckCircle2, Circle, AlertTriangle,
    Settings2, Play, RotateCcw, Info, X,
} from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import {
    sendBackendCommand,
    backendProbeXY,
    backendProbeXYZ,
    backendTestProbePin,
} from '../utils/backendConnection';
import './ProbeWizard.css';

// ── Types ─────────────────────────────────────────────────────────────────────

type TouchPlateType = 'Standard Block' | 'AutoZero' | 'Z Probe';
type ProbeRoutine = 'Z' | 'XY' | 'XYZ';
type ProbeCorner = 'front-left' | 'front-right' | 'back-left' | 'back-right';
type WizardStep = 'select-type' | 'select-routine' | 'configure' | 'connectivity' | 'run';

interface WizardState {
    step: WizardStep;
    touchPlateType: TouchPlateType;
    probeRoutine: ProbeRoutine;
    corner: ProbeCorner;
    blockThickness: number;
    xyThickness: number;
    fastFeedrate: number;
    slowFeedrate: number;
    retractDistance: number;
    probeDepth: number;
}

interface ConnectivityState {
    status: 'idle' | 'testing' | 'pass' | 'fail';
    message: string;
}

interface ProbeRunState {
    status: 'idle' | 'running' | 'success' | 'error' | 'cancelled';
    message: string;
    gcodeLines: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOUCH_PLATE_TYPES: Array<{
    type: TouchPlateType;
    label: string;
    description: string;
    icon: string;
    supportsXY: boolean;
}> = [
    {
        type: 'Standard Block',
        label: 'Standard Block',
        description: 'Rectangular touch plate with known Z thickness. Best for Z-only probing.',
        icon: '▭',
        supportsXY: false,
    },
    {
        type: 'AutoZero',
        label: 'AutoZero (3-Axis)',
        description: 'Corner touch plate with known XY and Z dimensions. Supports full XYZ probing.',
        icon: '⬜',
        supportsXY: true,
    },
    {
        type: 'Z Probe',
        label: 'Z Probe Pin',
        description: 'Simple probe pin or wire. Z-only probing with minimal setup.',
        icon: '⬇',
        supportsXY: false,
    },
];

const PROBE_ROUTINES: Array<{
    routine: ProbeRoutine;
    label: string;
    description: string;
    requiresXY: boolean;
}> = [
    {
        routine: 'Z',
        label: 'Z Only',
        description: 'Set Z work offset. Place touch plate on workpiece surface.',
        requiresXY: false,
    },
    {
        routine: 'XY',
        label: 'XY Corner',
        description: 'Set XY work offsets from a corner. AutoZero plate required.',
        requiresXY: true,
    },
    {
        routine: 'XYZ',
        label: 'XYZ Full',
        description: 'Set all three axes at once from a corner. Fastest full setup.',
        requiresXY: true,
    },
];

const CORNERS: Array<{ id: ProbeCorner; label: string; x: number; y: number }> = [
    { id: 'front-left',  label: 'Front Left',  x: 0, y: 0 },
    { id: 'front-right', label: 'Front Right', x: 1, y: 0 },
    { id: 'back-left',   label: 'Back Left',   x: 0, y: 1 },
    { id: 'back-right',  label: 'Back Right',  x: 1, y: 1 },
];

const WIZARD_STEPS: WizardStep[] = ['select-type', 'select-routine', 'configure', 'connectivity', 'run'];

const STEP_LABELS: Record<WizardStep, string> = {
    'select-type':    'Plate Type',
    'select-routine': 'Routine',
    'configure':      'Settings',
    'connectivity':   'Test',
    'run':            'Probe',
};

// ── G-code Generator ──────────────────────────────────────────────────────────

function generateProbeGcode(state: WizardState): string[] {
    const { probeRoutine, blockThickness, xyThickness, fastFeedrate, slowFeedrate, retractDistance, probeDepth, corner } = state;
    const lines: string[] = [];

    // X direction for corner
    const xDir = corner === 'front-right' || corner === 'back-right' ? -1 : 1;
    // Y direction for corner
    const yDir = corner === 'front-left' || corner === 'front-right' ? 1 : -1;

    lines.push('; === EasyCNC Probe Routine ===');
    lines.push(`; Plate: ${state.touchPlateType} | Routine: ${probeRoutine}`);
    lines.push(`; Block Z thickness: ${blockThickness}mm | XY thickness: ${xyThickness}mm`);
    lines.push('G21 ; ensure metric mode');
    lines.push('G91 ; incremental mode');

    if (probeRoutine === 'Z' || probeRoutine === 'XYZ') {
        lines.push('');
        lines.push('; --- Z Probe ---');
        lines.push(`G38.2 Z-${probeDepth} F${fastFeedrate} ; fast find`);
        lines.push(`G38.2 Z${retractDistance} F${slowFeedrate} ; retract`);
        lines.push(`G38.2 Z-${retractDistance + 2} F${slowFeedrate} ; slow precise`);
        lines.push(`G10 L20 P0 Z${blockThickness} ; set Z WCS offset`);
        lines.push(`G0 Z${retractDistance} ; lift off plate`);
    }

    if (probeRoutine === 'XY' || probeRoutine === 'XYZ') {
        lines.push('');
        lines.push('; --- X Probe ---');
        lines.push(`G38.2 X${xDir * probeDepth} F${fastFeedrate} ; fast find X`);
        lines.push(`G38.2 X${-xDir * retractDistance} F${slowFeedrate} ; retract X`);
        lines.push(`G38.2 X${xDir * (retractDistance + 2)} F${slowFeedrate} ; slow precise X`);
        lines.push(`G10 L20 P0 X${xDir > 0 ? xyThickness : -xyThickness} ; set X WCS offset`);
        lines.push(`G0 X${-xDir * retractDistance} ; move away`);
        lines.push('');
        lines.push('; --- Y Probe ---');
        lines.push(`G38.2 Y${yDir * probeDepth} F${fastFeedrate} ; fast find Y`);
        lines.push(`G38.2 Y${-yDir * retractDistance} F${slowFeedrate} ; retract Y`);
        lines.push(`G38.2 Y${yDir * (retractDistance + 2)} F${slowFeedrate} ; slow precise Y`);
        lines.push(`G10 L20 P0 Y${yDir > 0 ? xyThickness : -xyThickness} ; set Y WCS offset`);
        lines.push(`G0 Y${-yDir * retractDistance} ; move away`);
    }

    lines.push('');
    lines.push('G90 ; back to absolute mode');
    lines.push('; === Probe complete ===');

    return lines;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface StepIndicatorProps {
    currentStep: WizardStep;
}

function StepIndicator({ currentStep }: StepIndicatorProps) {
    const currentIndex = WIZARD_STEPS.indexOf(currentStep);
    return (
        <div className="pw-step-indicator" role="list" aria-label="Wizard steps">
            {WIZARD_STEPS.map((step, i) => {
                const isDone = i < currentIndex;
                const isActive = i === currentIndex;
                return (
                    <div
                        key={step}
                        className={`pw-step-dot ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}
                        role="listitem"
                        aria-current={isActive ? 'step' : undefined}
                    >
                        <div className="pw-step-node">
                            {isDone ? <CheckCircle2 size={12} /> : <span>{i + 1}</span>}
                        </div>
                        <span className="pw-step-label">{STEP_LABELS[step]}</span>
                        {i < WIZARD_STEPS.length - 1 && (
                            <div className={`pw-step-line ${isDone ? 'done' : ''}`} />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

interface TooltipProps {
    text: string;
    children: React.ReactNode;
}

function Tooltip({ text, children }: TooltipProps) {
    return (
        <span className="pw-tooltip-wrap" title={text}>
            {children}
            <span className="pw-tooltip-icon"><Info size={11} /></span>
        </span>
    );
}

// ── Main ProbeWizard Component ────────────────────────────────────────────────

export default function ProbeWizard() {
    const { connected, probeSettings, setProbeSettings, addConsoleLog, setProbeWizardStatus } = useCNCStore();

    const [wizard, setWizard] = useState<WizardState>({
        step: 'select-type',
        touchPlateType: (probeSettings.touchPlateType as TouchPlateType) ?? 'Standard Block',
        probeRoutine: 'Z',
        corner: 'front-left',
        blockThickness: probeSettings.blockThickness ?? 15,
        xyThickness: probeSettings.xyThickness ?? 10,
        fastFeedrate: probeSettings.fastFind ?? 150,
        slowFeedrate: probeSettings.slowFind ?? 75,
        retractDistance: probeSettings.retraction ?? 2,
        probeDepth: probeSettings.zProbeDistance ?? 30,
    });

    const [connectivity, setConnectivity] = useState<ConnectivityState>({
        status: 'idle',
        message: 'Press "Test Connection" to verify the probe pin is working before running.',
    });

    const [probeRun, setProbeRun] = useState<ProbeRunState>({
        status: 'idle',
        message: '',
        gcodeLines: [],
    });

    const [showGcode, setShowGcode] = useState(false);

    // ── Navigation ─────────────────────────────────────────────────────────

    const stepIndex = WIZARD_STEPS.indexOf(wizard.step);

    const canGoNext = useCallback((): boolean => {
        if (wizard.step === 'select-routine') {
            const plate = TOUCH_PLATE_TYPES.find(p => p.type === wizard.touchPlateType);
            if (!plate?.supportsXY && wizard.probeRoutine !== 'Z') return false;
        }
        if (wizard.step === 'connectivity') {
            // Allow skipping connectivity test (not required)
            return true;
        }
        return true;
    }, [wizard]);

    const goNext = useCallback(() => {
        if (stepIndex < WIZARD_STEPS.length - 1) {
            setWizard(prev => ({ ...prev, step: WIZARD_STEPS[stepIndex + 1] }));
        }
    }, [stepIndex]);

    const goBack = useCallback(() => {
        if (stepIndex > 0) {
            setWizard(prev => ({ ...prev, step: WIZARD_STEPS[stepIndex - 1] }));
        }
    }, [stepIndex]);

    const reset = useCallback(() => {
        setWizard(prev => ({ ...prev, step: 'select-type' }));
        setConnectivity({ status: 'idle', message: 'Press "Test Connection" to verify the probe pin is working before running.' });
        setProbeRun({ status: 'idle', message: '', gcodeLines: [] });
        setShowGcode(false);
    }, []);

    // ── Connectivity Test ───────────────────────────────────────────────────

    const handleTestConnectivity = useCallback(async () => {
        if (!connected) {
            setConnectivity({ status: 'fail', message: 'Machine not connected. Connect to your CNC controller first.' });
            return;
        }
        setConnectivity({ status: 'testing', message: 'Sending probe pin test command...' });
        try {
            const result = await backendTestProbePin();
            if (result) {
                setConnectivity({ status: 'pass', message: 'Probe pin detected — circuit is closed. If this is unexpected, check for shorts before continuing.' });
                addConsoleLog('success', 'Probe connectivity test: PASS (pin active)');
            } else {
                setConnectivity({ status: 'pass', message: 'Probe circuit is open — ready for probing. Touch the probe to workpiece to verify contact.' });
                addConsoleLog('success', 'Probe connectivity test: PASS (circuit open, normal ready state)');
            }
        } catch {
            setConnectivity({ status: 'fail', message: 'Could not read probe pin state. Check wiring and controller connection.' });
            addConsoleLog('error', 'Probe connectivity test: FAIL');
        }
    }, [connected, addConsoleLog]);

    // ── Run Probe ───────────────────────────────────────────────────────────

    const handleRunProbe = useCallback(async () => {
        if (!connected) {
            setProbeRun(prev => ({ ...prev, status: 'error', message: 'Machine not connected.' }));
            return;
        }

        // Persist settings to store + backend — read current state at call time
        const currentProbeSettings = useCNCStore.getState().probeSettings;
        setProbeSettings({
            ...currentProbeSettings,
            touchPlateType: wizard.touchPlateType,
            blockThickness: wizard.blockThickness,
            xyThickness: wizard.xyThickness,
            fastFind: wizard.fastFeedrate,
            slowFind: wizard.slowFeedrate,
            retraction: wizard.retractDistance,
            zProbeDistance: wizard.probeDepth,
        });

        const gcodeLines = generateProbeGcode(wizard);
        setProbeRun({ status: 'running', message: 'Probing in progress...', gcodeLines });
        setProbeWizardStatus('running');
        addConsoleLog('info', `Starting ${wizard.probeRoutine} probe routine (${wizard.touchPlateType})`);

        try {
            if (wizard.probeRoutine === 'Z') {
                await sendBackendCommand(gcodeLines.filter(l => !l.startsWith(';') && l.trim()).join('\n'));
            } else if (wizard.probeRoutine === 'XY') {
                await backendProbeXY({
                    thickness: wizard.xyThickness,
                    fastFeedrate: wizard.fastFeedrate,
                    slowFeedrate: wizard.slowFeedrate,
                    retract: wizard.retractDistance,
                    depth: wizard.probeDepth,
                    corner: wizard.corner,
                });
            } else {
                await backendProbeXYZ({
                    blockThickness: wizard.blockThickness,
                    xyThickness: wizard.xyThickness,
                    fastFeedrate: wizard.fastFeedrate,
                    slowFeedrate: wizard.slowFeedrate,
                    retract: wizard.retractDistance,
                    depth: wizard.probeDepth,
                    corner: wizard.corner,
                });
            }
            setProbeRun(prev => ({ ...prev, status: 'success', message: 'Probe complete. Work offsets have been set.' }));
            setProbeWizardStatus('success');
            addConsoleLog('success', `Probe routine complete: ${wizard.probeRoutine}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Probe failed';
            setProbeRun(prev => ({ ...prev, status: 'error', message: msg }));
            setProbeWizardStatus('error');
            addConsoleLog('error', `Probe failed: ${msg}`);
        }
    }, [connected, wizard, setProbeSettings, addConsoleLog, setProbeWizardStatus]);

    const handleCancelProbe = useCallback(() => {
        sendBackendCommand('!'); // feed hold
        setProbeRun(prev => ({ ...prev, status: 'cancelled', message: 'Probe cancelled. Machine stopped.' }));
        setProbeWizardStatus('idle');
        addConsoleLog('warning', 'Probe routine cancelled');
    }, [addConsoleLog, setProbeWizardStatus]);

    // ── Selected plate info ─────────────────────────────────────────────────

    const selectedPlate = TOUCH_PLATE_TYPES.find(p => p.type === wizard.touchPlateType)!;

    // ── Render Steps ────────────────────────────────────────────────────────

    const renderStep = () => {
        switch (wizard.step) {

            // ── Step 1: Select Touch Plate Type ────────────────────────────
            case 'select-type':
                return (
                    <div className="pw-step-content">
                        <p className="pw-step-desc">Choose the type of touch plate connected to your machine.</p>
                        <div className="pw-plate-grid" role="radiogroup" aria-label="Touch plate type">
                            {TOUCH_PLATE_TYPES.map(plate => (
                                <button
                                    key={plate.type}
                                    className={`pw-plate-card ${wizard.touchPlateType === plate.type ? 'selected' : ''}`}
                                    onClick={() => setWizard(prev => ({
                                        ...prev,
                                        touchPlateType: plate.type,
                                        // Reset routine if XY no longer supported
                                        probeRoutine: !plate.supportsXY ? 'Z' : prev.probeRoutine,
                                    }))}
                                    role="radio"
                                    aria-checked={wizard.touchPlateType === plate.type}
                                    title={plate.description}
                                >
                                    <span className="pw-plate-icon" aria-hidden>{plate.icon}</span>
                                    <span className="pw-plate-name">{plate.label}</span>
                                    <span className="pw-plate-desc">{plate.description}</span>
                                    {wizard.touchPlateType === plate.type && (
                                        <span className="pw-plate-check" aria-hidden><CheckCircle2 size={14} /></span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                );

            // ── Step 2: Select Probe Routine ───────────────────────────────
            case 'select-routine':
                return (
                    <div className="pw-step-content">
                        <p className="pw-step-desc">
                            Select which axes to probe.
                            {!selectedPlate.supportsXY && (
                                <span className="pw-note"> XY probing requires an AutoZero plate.</span>
                            )}
                        </p>
                        <div className="pw-routine-list" role="radiogroup" aria-label="Probe routine">
                            {PROBE_ROUTINES.map(r => {
                                const disabled = r.requiresXY && !selectedPlate.supportsXY;
                                return (
                                    <button
                                        key={r.routine}
                                        className={`pw-routine-card ${wizard.probeRoutine === r.routine ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
                                        onClick={() => !disabled && setWizard(prev => ({ ...prev, probeRoutine: r.routine }))}
                                        disabled={disabled}
                                        role="radio"
                                        aria-checked={wizard.probeRoutine === r.routine}
                                        aria-disabled={disabled}
                                        title={disabled ? 'Requires AutoZero plate' : r.description}
                                    >
                                        <div className="pw-routine-header">
                                            <span className="pw-routine-badge">{r.routine}</span>
                                            <span className="pw-routine-name">{r.label}</span>
                                            {wizard.probeRoutine === r.routine && !disabled && (
                                                <CheckCircle2 size={13} className="pw-routine-check" />
                                            )}
                                            {disabled && <span className="pw-routine-lock">AutoZero only</span>}
                                        </div>
                                        <span className="pw-routine-desc">{r.description}</span>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Corner selection (only for XY/XYZ) */}
                        {(wizard.probeRoutine === 'XY' || wizard.probeRoutine === 'XYZ') && (
                            <div className="pw-corner-section">
                                <label className="pw-field-label">
                                    <Tooltip text="Select which corner of the workpiece the touch plate is placed on.">
                                        Probe Corner
                                    </Tooltip>
                                </label>
                                <div className="pw-corner-grid" role="radiogroup" aria-label="Probe corner">
                                    {CORNERS.map(c => (
                                        <button
                                            key={c.id}
                                            className={`pw-corner-btn ${wizard.corner === c.id ? 'selected' : ''}`}
                                            style={{ gridColumn: c.x + 1, gridRow: c.y === 1 ? 1 : 2 }}
                                            onClick={() => setWizard(prev => ({ ...prev, corner: c.id }))}
                                            role="radio"
                                            aria-checked={wizard.corner === c.id}
                                            aria-label={c.label}
                                            title={c.label}
                                        >
                                            {wizard.corner === c.id ? <CheckCircle2 size={12} /> : <Circle size={12} />}
                                            <span>{c.label}</span>
                                        </button>
                                    ))}
                                    {/* Visual workpiece diagram */}
                                    <div className="pw-corner-workpiece" aria-hidden>
                                        <span>Workpiece</span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                );

            // ── Step 3: Configure Settings ─────────────────────────────────
            case 'configure':
                return (
                    <div className="pw-step-content">
                        <p className="pw-step-desc">Configure plate dimensions and probe feedrates.</p>

                        <div className="pw-config-grid">
                            {/* Z Block Thickness */}
                            {(wizard.probeRoutine === 'Z' || wizard.probeRoutine === 'XYZ') && (
                                <div className="pw-field-row">
                                    <label className="pw-field-label" htmlFor="pw-block-thickness">
                                        <Tooltip text="The physical height of the touch plate in millimetres. Measured from the workpiece surface to the top of the plate.">
                                            Z Plate Thickness
                                        </Tooltip>
                                    </label>
                                    <div className="pw-field-input-wrap">
                                        <input
                                            id="pw-block-thickness"
                                            type="number"
                                            className="pw-number-input"
                                            value={wizard.blockThickness}
                                            min={0.1}
                                            max={50}
                                            step={0.1}
                                            onChange={e => setWizard(prev => ({ ...prev, blockThickness: parseFloat(e.target.value) || 0 }))}
                                            aria-label="Block thickness in mm"
                                        />
                                        <span className="pw-unit">mm</span>
                                    </div>
                                </div>
                            )}

                            {/* XY Thickness */}
                            {(wizard.probeRoutine === 'XY' || wizard.probeRoutine === 'XYZ') && (
                                <div className="pw-field-row">
                                    <label className="pw-field-label" htmlFor="pw-xy-thickness">
                                        <Tooltip text="The thickness of the touch plate wall used for X and Y probing. Usually 10mm for AutoZero plates.">
                                            XY Plate Thickness
                                        </Tooltip>
                                    </label>
                                    <div className="pw-field-input-wrap">
                                        <input
                                            id="pw-xy-thickness"
                                            type="number"
                                            className="pw-number-input"
                                            value={wizard.xyThickness}
                                            min={0.1}
                                            max={30}
                                            step={0.1}
                                            onChange={e => setWizard(prev => ({ ...prev, xyThickness: parseFloat(e.target.value) || 0 }))}
                                            aria-label="XY plate thickness in mm"
                                        />
                                        <span className="pw-unit">mm</span>
                                    </div>
                                </div>
                            )}

                            {/* Probe Depth */}
                            <div className="pw-field-row">
                                <label className="pw-field-label" htmlFor="pw-probe-depth">
                                    <Tooltip text="Maximum distance the tool travels downward (or sideways) while searching for the plate. Stop if not found within this distance.">
                                        Search Distance
                                    </Tooltip>
                                </label>
                                <div className="pw-field-input-wrap">
                                    <input
                                        id="pw-probe-depth"
                                        type="number"
                                        className="pw-number-input"
                                        value={wizard.probeDepth}
                                        min={1}
                                        max={100}
                                        step={1}
                                        onChange={e => setWizard(prev => ({ ...prev, probeDepth: parseFloat(e.target.value) || 30 }))}
                                        aria-label="Probe search distance in mm"
                                    />
                                    <span className="pw-unit">mm</span>
                                </div>
                            </div>

                            {/* Fast Feedrate */}
                            <div className="pw-field-row">
                                <label className="pw-field-label" htmlFor="pw-fast-feed">
                                    <Tooltip text="Fast approach speed. The tool moves at this speed until it first touches the plate.">
                                        Fast Feedrate
                                    </Tooltip>
                                </label>
                                <div className="pw-field-input-wrap">
                                    <input
                                        id="pw-fast-feed"
                                        type="number"
                                        className="pw-number-input"
                                        value={wizard.fastFeedrate}
                                        min={10}
                                        max={1000}
                                        step={10}
                                        onChange={e => setWizard(prev => ({ ...prev, fastFeedrate: parseFloat(e.target.value) || 150 }))}
                                        aria-label="Fast feedrate in mm/min"
                                    />
                                    <span className="pw-unit">mm/m</span>
                                </div>
                            </div>

                            {/* Slow Feedrate */}
                            <div className="pw-field-row">
                                <label className="pw-field-label" htmlFor="pw-slow-feed">
                                    <Tooltip text="Precise measurement speed. After initial contact, the tool retracts and re-probes at this slower speed for accuracy.">
                                        Slow Feedrate
                                    </Tooltip>
                                </label>
                                <div className="pw-field-input-wrap">
                                    <input
                                        id="pw-slow-feed"
                                        type="number"
                                        className="pw-number-input"
                                        value={wizard.slowFeedrate}
                                        min={1}
                                        max={500}
                                        step={5}
                                        onChange={e => setWizard(prev => ({ ...prev, slowFeedrate: parseFloat(e.target.value) || 75 }))}
                                        aria-label="Slow feedrate in mm/min"
                                    />
                                    <span className="pw-unit">mm/m</span>
                                </div>
                            </div>

                            {/* Retraction Distance */}
                            <div className="pw-field-row">
                                <label className="pw-field-label" htmlFor="pw-retract">
                                    <Tooltip text="How far the tool backs off after initial contact before the slow re-probe. Larger values are safer but slower.">
                                        Retraction Distance
                                    </Tooltip>
                                </label>
                                <div className="pw-field-input-wrap">
                                    <input
                                        id="pw-retract"
                                        type="number"
                                        className="pw-number-input"
                                        value={wizard.retractDistance}
                                        min={0.5}
                                        max={20}
                                        step={0.5}
                                        onChange={e => setWizard(prev => ({ ...prev, retractDistance: parseFloat(e.target.value) || 2 }))}
                                        aria-label="Retraction distance in mm"
                                    />
                                    <span className="pw-unit">mm</span>
                                </div>
                            </div>
                        </div>

                        {/* Preview G-code toggle */}
                        <button
                            className="pw-gcode-toggle"
                            onClick={() => setShowGcode(prev => !prev)}
                            aria-expanded={showGcode}
                        >
                            <Settings2 size={12} />
                            {showGcode ? 'Hide' : 'Preview'} G-code
                        </button>

                        {showGcode && (
                            <div className="pw-gcode-preview" aria-label="Preview G-code">
                                <pre>
                                    {generateProbeGcode(wizard).join('\n')}
                                </pre>
                            </div>
                        )}
                    </div>
                );

            // ── Step 4: Connectivity Test ──────────────────────────────────
            case 'connectivity':
                return (
                    <div className="pw-step-content">
                        <p className="pw-step-desc">
                            Verify the probe circuit is connected before running. Place the touch plate on your workpiece and touch the tool to the plate.
                        </p>

                        <div className={`pw-connectivity-card ${connectivity.status}`}>
                            <div className="pw-connectivity-icon">
                                {connectivity.status === 'idle' && <Circle size={28} />}
                                {connectivity.status === 'testing' && (
                                    <span className="pw-spinner" aria-label="Testing..." role="status">
                                        <Zap size={24} />
                                    </span>
                                )}
                                {connectivity.status === 'pass' && <CheckCircle2 size={28} />}
                                {connectivity.status === 'fail' && <ZapOff size={28} />}
                            </div>
                            <div className="pw-connectivity-body">
                                <span className="pw-connectivity-status-label">
                                    {connectivity.status === 'idle' && 'Not tested'}
                                    {connectivity.status === 'testing' && 'Testing…'}
                                    {connectivity.status === 'pass' && 'Connection OK'}
                                    {connectivity.status === 'fail' && 'Connection failed'}
                                </span>
                                <span className="pw-connectivity-message">{connectivity.message}</span>
                            </div>
                        </div>

                        <button
                            className="pw-test-btn"
                            onClick={handleTestConnectivity}
                            disabled={!connected || connectivity.status === 'testing'}
                            aria-label="Test probe pin connectivity"
                        >
                            <Zap size={14} />
                            {connectivity.status === 'testing' ? 'Testing…' : 'Test Connection'}
                        </button>

                        {!connected && (
                            <div className="pw-warn-banner">
                                <AlertTriangle size={13} />
                                <span>Connect to the CNC controller before testing.</span>
                            </div>
                        )}

                        <p className="pw-skip-note">
                            You can skip this step if you have already verified wiring, or your controller does not support pin reads.
                        </p>
                    </div>
                );

            // ── Step 5: Run Probe ──────────────────────────────────────────
            case 'run':
                return (
                    <div className="pw-step-content">
                        {probeRun.status === 'idle' && (
                            <>
                                <p className="pw-step-desc">
                                    Ready to probe. Make sure the touch plate is positioned correctly and your tool is above the plate.
                                </p>

                                {/* Summary card */}
                                <div className="pw-summary-card">
                                    <div className="pw-summary-row">
                                        <span className="pw-summary-key">Plate</span>
                                        <span className="pw-summary-val">{wizard.touchPlateType}</span>
                                    </div>
                                    <div className="pw-summary-row">
                                        <span className="pw-summary-key">Routine</span>
                                        <span className="pw-summary-val">{wizard.probeRoutine}</span>
                                    </div>
                                    {(wizard.probeRoutine === 'XY' || wizard.probeRoutine === 'XYZ') && (
                                        <div className="pw-summary-row">
                                            <span className="pw-summary-key">Corner</span>
                                            <span className="pw-summary-val">
                                                {CORNERS.find(c => c.id === wizard.corner)?.label}
                                            </span>
                                        </div>
                                    )}
                                    {(wizard.probeRoutine === 'Z' || wizard.probeRoutine === 'XYZ') && (
                                        <div className="pw-summary-row">
                                            <span className="pw-summary-key">Z Thickness</span>
                                            <span className="pw-summary-val">{wizard.blockThickness} mm</span>
                                        </div>
                                    )}
                                    {(wizard.probeRoutine === 'XY' || wizard.probeRoutine === 'XYZ') && (
                                        <div className="pw-summary-row">
                                            <span className="pw-summary-key">XY Thickness</span>
                                            <span className="pw-summary-val">{wizard.xyThickness} mm</span>
                                        </div>
                                    )}
                                    <div className="pw-summary-row">
                                        <span className="pw-summary-key">Fast / Slow</span>
                                        <span className="pw-summary-val">{wizard.fastFeedrate} / {wizard.slowFeedrate} mm/m</span>
                                    </div>
                                </div>

                                {connectivity.status !== 'pass' && (
                                    <div className="pw-warn-banner" role="alert">
                                        <AlertTriangle size={13} />
                                        <span>Connectivity not verified. We recommend testing the probe connection first.</span>
                                    </div>
                                )}

                                {!connected && (
                                    <div className="pw-error-banner" role="alert">
                                        <X size={13} />
                                        <span>Machine not connected. Cannot run probe routine.</span>
                                    </div>
                                )}

                                <button
                                    className="pw-run-btn"
                                    onClick={handleRunProbe}
                                    disabled={!connected}
                                    aria-label="Start probe routine"
                                >
                                    <Play size={16} />
                                    Start Probe Routine
                                </button>
                            </>
                        )}

                        {probeRun.status === 'running' && (
                            <div className="pw-running-state" role="status" aria-live="polite">
                                <div className="pw-running-spinner">
                                    <span className="pw-big-spinner" aria-hidden />
                                </div>
                                <p className="pw-running-label">Probing in progress…</p>
                                <p className="pw-running-sub">Do not move the machine manually.</p>
                                <button className="pw-cancel-btn" onClick={handleCancelProbe} aria-label="Cancel probe">
                                    <X size={14} />
                                    Cancel Probe
                                </button>
                            </div>
                        )}

                        {probeRun.status === 'success' && (
                            <div className="pw-result-state success" role="status" aria-live="polite">
                                <CheckCircle2 size={40} className="pw-result-icon" />
                                <p className="pw-result-label">Probe Complete</p>
                                <p className="pw-result-msg">{probeRun.message}</p>
                                <button className="pw-restart-btn" onClick={reset} aria-label="Run another probe">
                                    <RotateCcw size={13} />
                                    Run Another
                                </button>
                            </div>
                        )}

                        {(probeRun.status === 'error' || probeRun.status === 'cancelled') && (
                            <div className="pw-result-state error" role="alert">
                                <AlertTriangle size={40} className="pw-result-icon" />
                                <p className="pw-result-label">
                                    {probeRun.status === 'cancelled' ? 'Probe Cancelled' : 'Probe Failed'}
                                </p>
                                <p className="pw-result-msg">{probeRun.message}</p>
                                <button className="pw-restart-btn" onClick={reset} aria-label="Start over">
                                    <RotateCcw size={13} />
                                    Start Over
                                </button>
                            </div>
                        )}
                    </div>
                );
        }
    };

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div className="probe-wizard" role="region" aria-label="Probing Wizard">
            {/* Step indicator */}
            <StepIndicator currentStep={wizard.step} />

            {/* Step content */}
            <div className="pw-body">
                {renderStep()}
            </div>

            {/* Navigation bar */}
            {probeRun.status === 'idle' && (
                <div className="pw-nav">
                    <button
                        className="pw-nav-btn back"
                        onClick={goBack}
                        disabled={stepIndex === 0}
                        aria-label="Go to previous step"
                    >
                        <ChevronLeft size={15} />
                        Back
                    </button>

                    <span className="pw-nav-step-count" aria-live="polite">
                        {stepIndex + 1} / {WIZARD_STEPS.length}
                    </span>

                    {wizard.step !== 'run' && (
                        <button
                            className="pw-nav-btn next"
                            onClick={goNext}
                            disabled={!canGoNext()}
                            aria-label="Go to next step"
                        >
                            Next
                            <ChevronRight size={15} />
                        </button>
                    )}
                </div>
            )}

            {/* Reset from completed states */}
            {(probeRun.status === 'success' || probeRun.status === 'error' || probeRun.status === 'cancelled') && (
                <div className="pw-nav">
                    <button className="pw-nav-btn back" onClick={reset} aria-label="Start wizard over">
                        <RotateCcw size={14} />
                        Start Over
                    </button>
                </div>
            )}
        </div>
    );
}
