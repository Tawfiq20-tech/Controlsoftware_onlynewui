import { useState, useEffect, useRef } from 'react';
import { X, AlertTriangle, Play, ChevronUp, ChevronDown, RotateCcw } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { backendJobStartFromLine } from '../utils/backendConnection';
import controller from '../utils/controller';
import './StartFromLine.css';

interface StartFromLineProps {
    onClose: () => void;
}

/** Backend (RSP) resume point -- where the last stopped/alarmed job can continue. */
interface ResumePoint {
    line: number;
    total: number;
    name: string;
    reason: string;
    at: number;
    positionExact: boolean;
    positionWarning: string;
    /** the work zero was re-set after the job stopped */
    originChanged?: boolean;
}

/** Backend (RSP) preview of what Start From Line will do for a line. */
interface ResumePreview {
    line: number;
    total: number;
    context: Array<{ num: number; text: string }>;
    plan:
        | { ok: true; preamble: string[]; startMm: { x: number; y: number; z: number | null }; retractMm: number; inPlace?: boolean; inPlaceZ?: 'lower' | 'raise' | 'none' | null; units: string; warnings: string[] }
        | { ok: false; error: string };
    resumePoint: ResumePoint;
}

/* ---------------------------------------------------------------------------
 * Local fallback for non-RSP controllers (GRBL/RTS have homed machine
 * coordinates, so the G53 lift is valid there). RSP boards use the backend
 * builder instead -- the backend runs arc-linearized G-code, so its line
 * numbers and start position can't be recomputed from the raw file here.
 * ------------------------------------------------------------------------- */
const hasWord = (line: string, re: RegExp) => re.test(line);

function extractModalStates(lines: string[], targetLine: number): string[] {
    const modals = {
        units: 'G21', plane: 'G17', distance: 'G90', feed: 'G94', wcs: 'G54',
        motion: 'G0', feedRate: '', spindleSpeed: '', spindleState: '', coolant: 'M9',
    };
    for (let i = 0; i < Math.min(targetLine, lines.length); i++) {
        const line = lines[i].toUpperCase().replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '').trim();
        if (!line) continue;
        if (hasWord(line, /\bG20\b/)) modals.units = 'G20';
        if (hasWord(line, /\bG21\b/)) modals.units = 'G21';
        const plane = line.match(/\bG(17|18|19)\b/); if (plane) modals.plane = `G${plane[1]}`;
        if (hasWord(line, /\bG90\b/)) modals.distance = 'G90';
        if (hasWord(line, /\bG91\b/)) modals.distance = 'G91';
        if (hasWord(line, /\bG93\b/)) modals.feed = 'G93';
        if (hasWord(line, /\bG94\b/)) modals.feed = 'G94';
        const wcs = line.match(/\bG(5[4-9])\b/); if (wcs) modals.wcs = `G${wcs[1]}`;
        const m = line.match(/\bG0?([0-3])(?![0-9.])/); if (m) modals.motion = 'G' + m[1];
        const f = line.match(/F\s*(-?[\d.]+)/); if (f) modals.feedRate = f[1];
        const s = line.match(/S\s*(\d+)/); if (s) modals.spindleSpeed = s[1];
        const sp = line.match(/\bM0?([345])(?![0-9])/); if (sp) modals.spindleState = `M${sp[1]}`;
        const c = line.match(/\bM0?([789])(?![0-9])/); if (c) modals.coolant = `M${c[1]}`;
    }
    const setup: string[] = [`${modals.units} ${modals.plane} ${modals.distance} ${modals.feed} ${modals.wcs}`, 'G40 G49'];
    if (modals.feedRate) setup.push(`F${modals.feedRate}`);
    if (modals.spindleSpeed && modals.spindleState && modals.spindleState !== 'M5') setup.push(`${modals.spindleState} S${modals.spindleSpeed}`);
    setup.push(modals.coolant !== 'M9' ? modals.coolant : 'M9');
    setup.push(modals.motion);
    return setup;
}

export default function StartFromLine({ onClose }: StartFromLineProps) {
    const { gcode, rawGcodeContent, connected, fileInfo, addConsoleLog, appPreferences, firmwareType } = useCNCStore();
    // A screen that joined after the port opened (reload, kiosk browser
    // restart, phone over the tunnel) never hears the controller type and
    // keeps 'unknown'. It used to take the local non-RSP fallback, which
    // uploaded a cut-down program under the design's own name. Now only a
    // controller KNOWN to be non-RSP uses the local path; everything else asks
    // the backend, which refuses cleanly when it cannot start from a line.
    const typeKnown = !!firmwareType && firmwareType !== 'unknown';
    const isRsp = !typeKnown || firmwareType === 'RSP';

    const [lineNumber, setLineNumber] = useState(1);
    const [safeHeight, setSafeHeight] = useState(Math.abs(appPreferences?.safeHeight ?? 5) || 5);
    const [resumePoint, setResumePoint] = useState<ResumePoint | null>(null);
    const [preview, setPreview] = useState<ResumePreview | null>(null);
    const prefilled = useRef(false);

    // Local (non-RSP) view of the file -- same trimmed/non-empty list is used
    // for display AND for slicing, so the number shown is the line that runs.
    const localLines = (rawGcodeContent || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const totalLines = isRsp ? (preview?.total ?? resumePoint?.total ?? gcode.length) : localLines.length;

    // RSP: fetch the resume point once, and default the line to it.
    useEffect(() => {
        if (!isRsp) return;
        const onPoint = (p: ResumePoint) => {
            setResumePoint(p);
            if (!prefilled.current && p && p.line > 1) {
                prefilled.current = true;
                setLineNumber(p.line);
            }
        };
        const onPreview = (p: ResumePreview) => {
            setPreview(p);
            if (p?.resumePoint) onPoint(p.resumePoint);
        };
        controller.on('job:resumePoint', onPoint);
        controller.on('job:resumePreview', onPreview);
        controller.requestResumePoint();
        return () => {
            controller.off('job:resumePoint', onPoint);
            controller.off('job:resumePreview', onPreview);
        };
    }, [isRsp]);

    // RSP: ask the backend what starting at this line will do (debounced).
    useEffect(() => {
        if (!isRsp || !connected) return;
        const t = setTimeout(() => controller.requestResumePreview(lineNumber, { safeZ: safeHeight }), 150);
        return () => clearTimeout(t);
    }, [isRsp, connected, lineNumber, safeHeight]);

    const contextLines = isRsp
        ? (preview?.context ?? []).map((c) => ({ num: c.num, text: c.text, isTarget: c.num === lineNumber }))
        : (() => {
            const idx = Math.max(0, Math.min(lineNumber - 1, localLines.length - 1));
            const out = [];
            for (let i = Math.max(0, idx - 5); i <= Math.min(localLines.length - 1, idx + 5); i++) {
                out.push({ num: i + 1, text: localLines[i] || '', isTarget: i === idx });
            }
            return out;
        })();

    const handleLineChange = (val: number) => {
        setLineNumber(Math.max(1, Math.min(totalLines || 1, val)));
    };

    const planOk = !isRsp || (preview?.line === lineNumber && preview.plan.ok);
    const positionBlocked = isRsp && resumePoint ? !resumePoint.positionExact : false;

    const handleStart = () => {
        if (!connected) return;
        if (isRsp) {
            controller.startFromLineSafe(lineNumber, { safeZ: safeHeight });
            addConsoleLog('info', `Start From Line ${lineNumber} (safe Z ${safeHeight} mm) sent`);
            onClose();
            return;
        }
        if (!rawGcodeContent) return;
        const targetIdx = lineNumber - 1;
        const modalSetup = extractModalStates(localLines, targetIdx);
        // G21 first: G53 G0 Z-<mm> must run in mm even if the file was in
        // inches (it used to inherit G20 and lift/plunge 25.4x too far).
        const preamble = ['G21', `G53 G0 Z${-Math.abs(safeHeight)}`, ...modalSetup].join('\n');
        const fullContent = preamble + '\n' + localLines.slice(targetIdx).join('\n');
        addConsoleLog('info', `Starting from line ${lineNumber} with safe height ${safeHeight}mm`);
        controller.loadFile(fileInfo?.name || 'resume.gcode', fullContent);
        setTimeout(() => {
            backendJobStartFromLine(0);
            addConsoleLog('success', `Job resumed from line ${lineNumber}`);
        }, 200);
        onClose();
    };

    const warnings: string[] = [];
    if (isRsp && preview?.line === lineNumber) {
        if (preview.plan.ok) {
            const { startMm, retractMm, inPlace, inPlaceZ } = preview.plan;
            if (inPlace && startMm.z !== null) {
                // The tool already stands at this line's X/Y: no lift, no travel.
                const how = inPlaceZ === 'lower' ? `no lift or travel, lower slowly to Z${startMm.z.toFixed(3)}`
                    : inPlaceZ === 'raise' ? `no travel, straight up to Z${startMm.z.toFixed(3)}`
                        : 'no lift, travel or Z move';
                warnings.push(`Tool is already at X${startMm.x.toFixed(3)} Y${startMm.y.toFixed(3)}: ${how} (mm, work zero), then run from line ${lineNumber}.`);
            } else {
                warnings.push(`Machine will raise Z to ${retractMm.toFixed(2)} mm, move to X${startMm.x.toFixed(3)} Y${startMm.y.toFixed(3)}${startMm.z === null ? '' : `, lower slowly to Z${startMm.z.toFixed(3)}`} (mm, work zero), then run from line ${lineNumber}.`);
            }
            preview.plan.warnings.forEach((w) => warnings.push(w));
        } else {
            warnings.push(preview.plan.error);
        }
    }
    if (positionBlocked && resumePoint) warnings.push(`${resumePoint.positionWarning} Re-zero X/Y/Z at the job's original origin (or home) before starting.`);
    if (resumePoint?.originChanged) {
        warnings.push('The work zero was changed after this job stopped. Continue only if it is the SAME zero the job started from — otherwise the rest of the cut will be in the wrong place.');
    }
    if (lineNumber > 1) {
        warnings.push('Spindle must be running before the tool goes back down');
        if (!positionBlocked) warnings.push('Keep the existing zero -- re-zeroing now would shift the rest of the cut');
    }

    return (
        <div className="sfl-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label="Start job from line">
            <div className="sfl-modal">
                <div className="sfl-header">
                    <div className="sfl-title">
                        <Play size={16} />
                        Start From Line
                    </div>
                    <button className="sfl-close" onClick={onClose} aria-label="Close dialog">
                        <X size={16} />
                    </button>
                </div>

                <div className="sfl-body">
                    {isRsp && resumePoint && resumePoint.line > 1 && (
                        <div className="sfl-resume">
                            <div className="sfl-resume-text">
                                Last stop: <strong>line {resumePoint.line}</strong>
                                {resumePoint.reason ? ` — ${resumePoint.reason}` : ''}
                                {resumePoint.at ? ` (${new Date(resumePoint.at).toLocaleTimeString()})` : ''}
                            </div>
                            {lineNumber !== resumePoint.line && (
                                <button className="sfl-resume-btn" onClick={() => setLineNumber(resumePoint.line)}>
                                    <RotateCcw size={12} /> Use line {resumePoint.line}
                                </button>
                            )}
                        </div>
                    )}

                    <div className="sfl-field">
                        <label className="sfl-label">Line Number</label>
                        <div className="sfl-line-input-row">
                            <button className="sfl-stepper" onClick={() => handleLineChange(lineNumber - 1)} disabled={lineNumber <= 1}>
                                <ChevronDown size={14} />
                            </button>
                            <input
                                type="number"
                                className="sfl-number-input"
                                value={lineNumber}
                                min={1}
                                max={totalLines}
                                onChange={(e) => handleLineChange(parseInt(e.target.value) || 1)}
                            />
                            <button className="sfl-stepper" onClick={() => handleLineChange(lineNumber + 1)} disabled={lineNumber >= totalLines}>
                                <ChevronUp size={14} />
                            </button>
                            <span className="sfl-total">/ {totalLines}</span>
                        </div>
                        <input
                            type="range"
                            className="sfl-slider"
                            min={1}
                            max={Math.max(1, totalLines)}
                            value={lineNumber}
                            onChange={(e) => handleLineChange(parseInt(e.target.value))}
                        />
                    </div>

                    <div className="sfl-field">
                        <label className="sfl-label">Safe Z Height (mm)</label>
                        <input
                            type="number"
                            className="sfl-number-input"
                            value={safeHeight}
                            onChange={(e) => {
                                const parsed = parseFloat(e.target.value);
                                // Clamped: an absurd typed value (stray extra
                                // digit) would otherwise be a full-speed rapid.
                                setSafeHeight(Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.abs(parsed))) : 5);
                            }}
                            min={1}
                            max={100}
                            step={0.5}
                        />
                        <span className="sfl-field-hint">
                            {isRsp ? 'Height above the work zero (Z0) to travel at before lowering back into the cut' : 'Z will lift to this height (machine coordinates) before resuming'}
                        </span>
                    </div>

                    <div className="sfl-field">
                        <label className="sfl-label">G-code Context</label>
                        <div className="sfl-context">
                            {contextLines.map((cl) => (
                                <div key={cl.num} className={`sfl-context-line ${cl.isTarget ? 'target' : ''}`}>
                                    <span className="sfl-context-num">{cl.num}</span>
                                    <span className="sfl-context-text">{cl.text || '(empty)'}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {warnings.length > 0 && (
                        <div className="sfl-warnings">
                            <div className="sfl-warn-header">
                                <AlertTriangle size={14} />
                                Before you start
                            </div>
                            {warnings.map((w, i) => (
                                <div key={i} className="sfl-warn-item">{w}</div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="sfl-footer">
                    <button className="sfl-btn-cancel" onClick={onClose}>Cancel</button>
                    <button
                        className="sfl-btn-start"
                        onClick={handleStart}
                        disabled={!connected || !rawGcodeContent || !planOk || positionBlocked}
                    >
                        <Play size={14} />
                        Start from Line {lineNumber}
                    </button>
                </div>
            </div>
        </div>
    );
}
