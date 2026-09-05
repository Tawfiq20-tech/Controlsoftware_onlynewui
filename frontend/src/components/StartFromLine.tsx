import { useState, useEffect, useRef } from 'react';
import { X, AlertTriangle, Play, ChevronUp, ChevronDown } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { backendJobStartFromLine } from '../utils/backendConnection';
import controller from '../utils/controller';
import './StartFromLine.css';

interface StartFromLineProps {
    onClose: () => void;
}

// Extract modal states required to resume at a given line
function extractModalStates(lines: string[], targetLine: number): string[] {
    const modals: Record<string, string> = {
        units: 'G21',          // default mm
        plane: 'G17',          // default XY
        distance: 'G90',       // default absolute
        feed: 'G94',           // default feed per minute
        wcs: 'G54',            // default WCS
        cutter: '',            // G40 cutter comp off
        tool_length: '',       // G49 tool length offset cancel
        spindle: '',           // G97 spindle speed mode
        coolant: 'M9',         // coolant off
    };

    // Scan all lines before target to track modal state changes
    for (let i = 0; i < Math.min(targetLine, lines.length); i++) {
        const line = lines[i].toUpperCase().replace(/;.*$/, '').trim();
        if (!line) continue;

        // Units
        if (line.includes('G20')) modals.units = 'G20';
        if (line.includes('G21')) modals.units = 'G21';
        // Plane selection
        if (line.includes('G17')) modals.plane = 'G17';
        if (line.includes('G18')) modals.plane = 'G18';
        if (line.includes('G19')) modals.plane = 'G19';
        // Distance mode
        if (line.includes('G90')) modals.distance = 'G90';
        if (line.includes('G91')) modals.distance = 'G91';
        // Feed rate mode
        if (line.includes('G93')) modals.feed = 'G93';
        if (line.includes('G94')) modals.feed = 'G94';
        // WCS
        if (line.includes('G54')) modals.wcs = 'G54';
        if (line.includes('G55')) modals.wcs = 'G55';
        if (line.includes('G56')) modals.wcs = 'G56';
        if (line.includes('G57')) modals.wcs = 'G57';
        if (line.includes('G58')) modals.wcs = 'G58';
        if (line.includes('G59')) modals.wcs = 'G59';
        // Coolant
        if (line.includes('M7') || line.includes('M8')) modals.coolant = line.includes('M7') ? 'M7' : 'M8';
        if (line.includes('M9')) modals.coolant = 'M9';
    }

    // Return as setup lines
    const setup: string[] = [];
    setup.push(`${modals.units} ${modals.plane} ${modals.distance} ${modals.feed} ${modals.wcs}`.trim());
    setup.push('G40 G49'); // cutter comp off, tool length offset cancel
    if (modals.coolant && modals.coolant !== 'M9') {
        setup.push(modals.coolant);
    } else {
        setup.push('M9'); // ensure coolant off
    }
    return setup;
}

export default function StartFromLine({ onClose }: StartFromLineProps) {
    const { gcode, rawGcodeContent, connected, fileInfo, addConsoleLog, appPreferences } = useCNCStore();
    const appPrefs = appPreferences;

    const [lineNumber, setLineNumber] = useState(1);
    const [safeHeight, setSafeHeight] = useState(appPrefs?.safeHeight ?? 10);
    const [contextLines, setContextLines] = useState<Array<{ num: number; text: string; isTarget: boolean }>>([]);
    const lineInputRef = useRef<HTMLInputElement>(null);

    const totalLines = gcode.length;

    // Update context window whenever line changes
    useEffect(() => {
        if (!rawGcodeContent) return;
        const allLines = rawGcodeContent.split(/\r?\n/);
        const idx = Math.max(0, Math.min(lineNumber - 1, allLines.length - 1));
        const start = Math.max(0, idx - 5);
        const end = Math.min(allLines.length - 1, idx + 5);
        const ctx = [];
        for (let i = start; i <= end; i++) {
            ctx.push({ num: i + 1, text: allLines[i] || '', isTarget: i === idx });
        }
        setContextLines(ctx);
    }, [lineNumber, rawGcodeContent]);

    const handleLineChange = (val: number) => {
        const clamped = Math.max(1, Math.min(totalLines, val));
        setLineNumber(clamped);
    };

    const handleStart = () => {
        if (!connected || !rawGcodeContent) return;

        const allLines = rawGcodeContent.split(/\r?\n/);
        const gcodeLines = allLines.map(l => l.trim()).filter(l => l.length > 0);
        const targetIdx = lineNumber - 1;

        // Extract modal preamble
        const modalSetup = extractModalStates(gcodeLines, targetIdx);

        // Build safe start sequence:
        // 1. Lift Z to safe height
        // 2. Apply modal states
        // 3. Move to position of first line (optional)
        // 4. Send G-code from target line
        const preamble = [
            `G53 G0 Z${safeHeight < 0 ? safeHeight : -Math.abs(safeHeight)}`, // lift to safe Z (machine coords)
            ...modalSetup,
        ].join('\n');

        addConsoleLog('info', `Starting from line ${lineNumber} with safe height ${safeHeight}mm`);
        addConsoleLog('warning', 'Ensure spindle/tool is at correct height before continuing');

        // Load modified gcode starting from target line
        const gcodeFromLine = gcodeLines.slice(targetIdx).join('\n');
        const fullContent = preamble + '\n' + gcodeFromLine;

        controller.loadFile(fileInfo?.name || 'resume.gcode', fullContent);
        setTimeout(() => {
            backendJobStartFromLine(0); // start from beginning of new content (which begins at target)
            addConsoleLog('success', `Job resumed from line ${lineNumber}`);
        }, 200);

        onClose();
    };

    const warnings: string[] = [];
    if (lineNumber > 1) {
        warnings.push('Spindle speed and tool state may differ from beginning of file');
        warnings.push('Verify work coordinate zero (G54/WCS) is still set correctly');
        warnings.push('Check coolant state before resuming');
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
                    {/* Line number input */}
                    <div className="sfl-field">
                        <label className="sfl-label">Line Number</label>
                        <div className="sfl-line-input-row">
                            <button
                                className="sfl-stepper"
                                onClick={() => handleLineChange(lineNumber - 1)}
                                disabled={lineNumber <= 1}
                            >
                                <ChevronDown size={14} />
                            </button>
                            <input
                                ref={lineInputRef}
                                type="number"
                                className="sfl-number-input"
                                value={lineNumber}
                                min={1}
                                max={totalLines}
                                onChange={(e) => handleLineChange(parseInt(e.target.value) || 1)}
                            />
                            <button
                                className="sfl-stepper"
                                onClick={() => handleLineChange(lineNumber + 1)}
                                disabled={lineNumber >= totalLines}
                            >
                                <ChevronUp size={14} />
                            </button>
                            <span className="sfl-total">/ {totalLines}</span>
                        </div>
                        <input
                            type="range"
                            className="sfl-slider"
                            min={1}
                            max={totalLines}
                            value={lineNumber}
                            onChange={(e) => handleLineChange(parseInt(e.target.value))}
                        />
                    </div>

                    {/* Safe height */}
                    <div className="sfl-field">
                        <label className="sfl-label">Safe Z Height (mm)</label>
                        <input
                            type="number"
                            className="sfl-number-input"
                            value={safeHeight}
                            onChange={(e) => setSafeHeight(parseFloat(e.target.value) || 10)}
                            step={0.5}
                        />
                        <span className="sfl-field-hint">Z will lift to this height before resuming</span>
                    </div>

                    {/* G-code context window */}
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

                    {/* Warnings */}
                    {warnings.length > 0 && (
                        <div className="sfl-warnings">
                            <div className="sfl-warn-header">
                                <AlertTriangle size={14} />
                                Warnings
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
                        disabled={!connected || !rawGcodeContent}
                    >
                        <Play size={14} />
                        Start from Line {lineNumber}
                    </button>
                </div>
            </div>
        </div>
    );
}
