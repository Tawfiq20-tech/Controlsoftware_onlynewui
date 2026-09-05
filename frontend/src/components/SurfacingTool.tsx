import { useState, useCallback } from 'react';
import { Layers, Play, Eye, EyeOff, RotateCcw, Download } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { GCodeParser } from '../utils/gcodeParser';
import './SurfacingTool.css';

// ─── Types ────────────────────────────────────────────────────────
type CutPattern = 'zigzag' | 'spiral';
type StartPosition = 'front-left' | 'front-right' | 'back-left' | 'back-right' | 'center';

interface SurfacingParams {
    width: number;
    length: number;
    bitDiameter: number;
    stepoverPct: number;
    feedRate: number;
    spindleRPM: number;
    safeHeight: number;
    maxDepth: number;
    depthPerPass: number;
    pattern: CutPattern;
    startPosition: StartPosition;
    units: 'mm' | 'inch';
}

// ─── G-code Generator ─────────────────────────────────────────────

function generateSurfacingGCode(params: SurfacingParams): string {
    const {
        width, length, bitDiameter, stepoverPct,
        feedRate, spindleRPM, safeHeight,
        maxDepth, depthPerPass, pattern, startPosition, units,
    } = params;

    const stepover = bitDiameter * (stepoverPct / 100);
    const passes = Math.ceil(maxDepth / depthPerPass);
    const unitCmd = units === 'mm' ? 'G21' : 'G20';
    const unitLabel = units === 'mm' ? 'mm' : 'in';

    const lines: string[] = [];

    // Header
    lines.push(`; ======================================`);
    lines.push(`; Surfacing Job`);
    lines.push(`; Pattern   : ${pattern.toUpperCase()}`);
    lines.push(`; Area      : ${width}${unitLabel} x ${length}${unitLabel}`);
    lines.push(`; Bit Dia.  : ${bitDiameter}${unitLabel}`);
    lines.push(`; Stepover  : ${stepoverPct}% (${stepover.toFixed(3)}${unitLabel})`);
    lines.push(`; Feed Rate : ${feedRate} ${unitLabel}/min`);
    lines.push(`; Spindle   : ${spindleRPM} RPM`);
    lines.push(`; Depth     : ${maxDepth}${unitLabel} in ${passes} pass(es) of ${depthPerPass}${unitLabel}`);
    lines.push(`; ======================================`);
    lines.push('');
    lines.push(unitCmd);           // Units
    lines.push('G90');             // Absolute positioning
    lines.push('G17');             // XY plane
    lines.push(`G0 Z${safeHeight}`);  // Safe height
    lines.push(`M3 S${spindleRPM}`);  // Spindle on
    lines.push('G4 P2');              // Dwell 2s for spindle spool-up
    lines.push('');

    // Compute origin offset from start position
    const half_w = width / 2;
    const half_l = length / 2;

    let originX = 0, originY = 0;
    switch (startPosition) {
        case 'front-left':   originX = 0;       originY = 0;       break;
        case 'front-right':  originX = -width;   originY = 0;       break;
        case 'back-left':    originX = 0;        originY = -length; break;
        case 'back-right':   originX = -width;   originY = -length; break;
        case 'center':       originX = -half_w;  originY = -half_l; break;
    }

    const f = (n: number) => n.toFixed(3);

    if (pattern === 'zigzag') {
        const rows = Math.ceil(width / stepover) + 1;

        for (let passIdx = 0; passIdx < passes; passIdx++) {
            const depth = -Math.min(depthPerPass * (passIdx + 1), maxDepth);
            lines.push(`; --- Pass ${passIdx + 1}/${passes} (Z=${depth.toFixed(3)}) ---`);

            for (let row = 0; row < rows; row++) {
                const x = originX + row * stepover;
                if (x > originX + width) break;

                const evenRow = row % 2 === 0;
                const yStart = evenRow ? originY : originY + length;
                const yEnd = evenRow ? originY + length : originY;

                if (row === 0) {
                    lines.push(`G0 X${f(x)} Y${f(yStart)}`);
                    lines.push(`G1 Z${f(depth)} F${feedRate}`);
                } else {
                    lines.push(`G0 Z${f(safeHeight)}`);
                    lines.push(`G0 X${f(x)} Y${f(yStart)}`);
                    lines.push(`G1 Z${f(depth)} F${feedRate}`);
                }
                lines.push(`G1 Y${f(yEnd)} F${feedRate}`);
            }

            lines.push(`G0 Z${f(safeHeight)}`);
            lines.push('');
        }
    } else {
        // Spiral pattern: inside-out concentric rectangles
        for (let passIdx = 0; passIdx < passes; passIdx++) {
            const depth = -Math.min(depthPerPass * (passIdx + 1), maxDepth);
            lines.push(`; --- Pass ${passIdx + 1}/${passes} (Z=${depth.toFixed(3)}) ---`);

            let stepNum = 0;
            let curW = width;
            let curL = length;
            let offX = originX;
            let offY = originY;

            // Move to start of first rectangle
            lines.push(`G0 X${f(offX)} Y${f(offY)}`);
            lines.push(`G1 Z${f(depth)} F${feedRate}`);

            while (curW > 0 && curL > 0) {
                // Cut rectangle
                lines.push(`G1 X${f(offX + curW)} Y${f(offY)} F${feedRate}`);
                lines.push(`G1 X${f(offX + curW)} Y${f(offY + curL)}`);
                lines.push(`G1 X${f(offX)} Y${f(offY + curL)}`);
                lines.push(`G1 X${f(offX)} Y${f(offY)}`);

                stepNum++;
                offX += stepover;
                offY += stepover;
                curW -= stepover * 2;
                curL -= stepover * 2;

                if (curW > 0 && curL > 0) {
                    lines.push(`G1 X${f(offX)} Y${f(offY)}`);
                }

                if (stepNum > 1000) break; // safety escape
            }

            lines.push(`G0 Z${f(safeHeight)}`);
            lines.push('');
        }
    }

    // Footer
    lines.push('; ---- Job Complete ----');
    lines.push(`G0 Z${safeHeight}`);
    lines.push('G0 X0 Y0');
    lines.push('M5');    // Spindle off
    lines.push('M30');   // End of program

    return lines.join('\n');
}

// ─── Validation ───────────────────────────────────────────────────

function validate(p: SurfacingParams): string[] {
    const errors: string[] = [];
    if (p.width <= 0)         errors.push('Width must be > 0');
    if (p.length <= 0)        errors.push('Length must be > 0');
    if (p.bitDiameter <= 0)   errors.push('Bit diameter must be > 0');
    if (p.bitDiameter > Math.min(p.width, p.length))
        errors.push('Bit diameter is larger than the surfacing area');
    if (p.stepoverPct <= 0 || p.stepoverPct > 100)
        errors.push('Stepover must be between 1% and 100%');
    if (p.feedRate <= 0)      errors.push('Feed rate must be > 0');
    if (p.spindleRPM <= 0)    errors.push('Spindle RPM must be > 0');
    if (p.maxDepth <= 0)      errors.push('Max depth must be > 0');
    if (p.depthPerPass <= 0)  errors.push('Depth per pass must be > 0');
    if (p.safeHeight <= 0)    errors.push('Safe height must be > 0');
    return errors;
}

// ─── Component ────────────────────────────────────────────────────

const DEFAULT_PARAMS: SurfacingParams = {
    width: 200,
    length: 300,
    bitDiameter: 25,
    stepoverPct: 40,
    feedRate: 2000,
    spindleRPM: 18000,
    safeHeight: 5,
    maxDepth: 1,
    depthPerPass: 0.5,
    pattern: 'zigzag',
    startPosition: 'front-left',
    units: 'mm',
};

export default function SurfacingTool() {
    const [params, setParams] = useState<SurfacingParams>(DEFAULT_PARAMS);
    const [gcode, setGcode] = useState<string | null>(null);
    const [showPreview, setShowPreview] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [loaded, setLoaded] = useState(false);

    const { setGcode: storeSetGcode, setToolpathSegments, setFileInfo, setRawGcodeContent, addConsoleLog } = useCNCStore();

    const setParam = <K extends keyof SurfacingParams>(key: K, value: SurfacingParams[K]) => {
        setParams(prev => ({ ...prev, [key]: value }));
        setLoaded(false);
    };

    const handleGenerate = useCallback(() => {
        const errs = validate(params);
        setErrors(errs);
        if (errs.length > 0) return;

        const code = generateSurfacingGCode(params);
        setGcode(code);
        setShowPreview(true);
        setLoaded(false);
        addConsoleLog('info', 'Surfacing G-code generated');
    }, [params, addConsoleLog]);

    const handleLoadToWorkspace = useCallback(() => {
        if (!gcode) return;
        try {
            const parser = new GCodeParser();
            const result = parser.parseGCode(gcode);
            const parsed = result.lines;
            const segments = result.segments;
            storeSetGcode(parsed);
            setToolpathSegments(segments);
            setRawGcodeContent(gcode);
            const lineCount = gcode.split('\n').length;
            setFileInfo({ name: 'surfacing.gcode', size: gcode.length, lines: lineCount });
            addConsoleLog('success', `Surfacing job loaded: ${parsed.length} lines, ${segments.length} segments`);
            setLoaded(true);
        } catch (e) {
            addConsoleLog('error', `Failed to load surfacing G-code: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
    }, [gcode, storeSetGcode, setToolpathSegments, setRawGcodeContent, setFileInfo, addConsoleLog]);

    const handleDownload = useCallback(() => {
        if (!gcode) return;
        const blob = new Blob([gcode], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'surfacing.gcode';
        a.click();
        URL.revokeObjectURL(url);
        addConsoleLog('info', 'Surfacing G-code downloaded');
    }, [gcode, addConsoleLog]);

    const handleReset = () => {
        setParams(DEFAULT_PARAMS);
        setGcode(null);
        setErrors([]);
        setLoaded(false);
        setShowPreview(false);
    };

    const stepover = params.bitDiameter * (params.stepoverPct / 100);
    const passes = params.depthPerPass > 0 ? Math.ceil(params.maxDepth / params.depthPerPass) : 1;
    const rows = Math.ceil(params.width / stepover) + 1;

    return (
        <div className="surfacing-tool">
            <div className="surfacing-header">
                <div className="surfacing-title">
                    <Layers size={16} />
                    <span>Surfacing Tool</span>
                </div>
                <button
                    className="surfacing-reset-btn"
                    onClick={handleReset}
                    title="Reset to defaults"
                >
                    <RotateCcw size={13} />
                </button>
            </div>

            <div className="surfacing-body">

                {/* Units & Pattern */}
                <div className="surf-row">
                    <div className="surf-field">
                        <label>Units</label>
                        <div className="surf-toggle-group">
                            {(['mm', 'inch'] as const).map(u => (
                                <button
                                    key={u}
                                    className={`surf-toggle-btn ${params.units === u ? 'active' : ''}`}
                                    onClick={() => setParam('units', u)}
                                >
                                    {u}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="surf-field">
                        <label>Cut Pattern</label>
                        <div className="surf-toggle-group">
                            {(['zigzag', 'spiral'] as const).map(p => (
                                <button
                                    key={p}
                                    className={`surf-toggle-btn ${params.pattern === p ? 'active' : ''}`}
                                    onClick={() => setParam('pattern', p)}
                                    title={p === 'zigzag' ? 'Raster/zigzag pattern — good for large flat areas' : 'Concentric spiral — good for finishing passes'}
                                >
                                    {p.charAt(0).toUpperCase() + p.slice(1)}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Area Dimensions */}
                <fieldset className="surf-fieldset">
                    <legend>Area Dimensions</legend>
                    <div className="surf-row">
                        <div className="surf-field">
                            <label>Width ({params.units})</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.width}
                                min={1}
                                step={params.units === 'mm' ? 1 : 0.1}
                                onChange={e => setParam('width', parseFloat(e.target.value) || 0)}
                                title="Width of the area to surface (X axis)"
                            />
                        </div>
                        <div className="surf-field">
                            <label>Length ({params.units})</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.length}
                                min={1}
                                step={params.units === 'mm' ? 1 : 0.1}
                                onChange={e => setParam('length', parseFloat(e.target.value) || 0)}
                                title="Length of the area to surface (Y axis)"
                            />
                        </div>
                    </div>
                </fieldset>

                {/* Tool & Feed */}
                <fieldset className="surf-fieldset">
                    <legend>Tool &amp; Feed</legend>
                    <div className="surf-row">
                        <div className="surf-field">
                            <label>Bit Diameter ({params.units})</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.bitDiameter}
                                min={0.1}
                                step={0.5}
                                onChange={e => setParam('bitDiameter', parseFloat(e.target.value) || 0)}
                                title="Diameter of the surfacing/fly-cutter bit"
                            />
                        </div>
                        <div className="surf-field">
                            <label>Stepover %</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.stepoverPct}
                                min={1}
                                max={100}
                                step={5}
                                onChange={e => setParam('stepoverPct', parseFloat(e.target.value) || 40)}
                                title="Percentage of bit diameter to move per pass (40% recommended)"
                            />
                        </div>
                    </div>
                    <div className="surf-row">
                        <div className="surf-field">
                            <label>Feed Rate ({params.units}/min)</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.feedRate}
                                min={1}
                                step={100}
                                onChange={e => setParam('feedRate', parseFloat(e.target.value) || 0)}
                                title="XY cutting feed rate"
                            />
                        </div>
                        <div className="surf-field">
                            <label>Spindle RPM</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.spindleRPM}
                                min={1}
                                step={500}
                                onChange={e => setParam('spindleRPM', parseInt(e.target.value) || 0)}
                                title="Spindle speed in RPM"
                            />
                        </div>
                    </div>
                </fieldset>

                {/* Depth */}
                <fieldset className="surf-fieldset">
                    <legend>Depth</legend>
                    <div className="surf-row">
                        <div className="surf-field">
                            <label>Max Depth ({params.units})</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.maxDepth}
                                min={0.01}
                                step={0.1}
                                onChange={e => setParam('maxDepth', parseFloat(e.target.value) || 0)}
                                title="Total material removal depth"
                            />
                        </div>
                        <div className="surf-field">
                            <label>Depth Per Pass ({params.units})</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.depthPerPass}
                                min={0.01}
                                step={0.1}
                                onChange={e => setParam('depthPerPass', parseFloat(e.target.value) || 0)}
                                title="How deep to cut per pass (shallower = better finish)"
                            />
                        </div>
                    </div>
                    <div className="surf-row">
                        <div className="surf-field">
                            <label>Safe Height ({params.units})</label>
                            <input
                                type="number"
                                className="surf-input"
                                value={params.safeHeight}
                                min={0.5}
                                step={1}
                                onChange={e => setParam('safeHeight', parseFloat(e.target.value) || 5)}
                                title="Z height for rapid moves between cuts"
                            />
                        </div>
                    </div>
                </fieldset>

                {/* Start Position */}
                <div className="surf-field">
                    <label>Start Position</label>
                    <div className="surf-start-grid" title="Choose where the tool starts cutting">
                        {([
                            ['back-left',  'back-right'],
                            ['center',     null],
                            ['front-left', 'front-right'],
                        ] as (StartPosition | null)[][]).map((rowItems, ri) => (
                            <div key={ri} className="surf-start-row">
                                {rowItems.map((pos, ci) => (
                                    pos ? (
                                        <button
                                            key={ci}
                                            className={`surf-start-btn ${params.startPosition === pos ? 'active' : ''}`}
                                            onClick={() => setParam('startPosition', pos)}
                                            title={pos.replace('-', ' ')}
                                        >
                                            {pos === 'center' ? '·' : '×'}
                                        </button>
                                    ) : (
                                        <div key={ci} className="surf-start-spacer" />
                                    )
                                ))}
                            </div>
                        ))}
                        <div className="surf-start-label">{params.startPosition.replace('-', ' ')}</div>
                    </div>
                </div>

                {/* Stats preview */}
                <div className="surf-stats">
                    <div className="surf-stat">
                        <span className="surf-stat-label">Stepover</span>
                        <span className="surf-stat-val">{stepover.toFixed(2)} {params.units}</span>
                    </div>
                    <div className="surf-stat">
                        <span className="surf-stat-label">Passes</span>
                        <span className="surf-stat-val">{passes}</span>
                    </div>
                    <div className="surf-stat">
                        <span className="surf-stat-label">Rows/pass</span>
                        <span className="surf-stat-val">{Math.max(rows, 1)}</span>
                    </div>
                    <div className="surf-stat">
                        <span className="surf-stat-label">Lines est.</span>
                        <span className="surf-stat-val">~{(rows * passes * 4).toLocaleString()}</span>
                    </div>
                </div>

                {/* Validation errors */}
                {errors.length > 0 && (
                    <div className="surf-errors">
                        {errors.map((err, i) => (
                            <div key={i} className="surf-error-item">{err}</div>
                        ))}
                    </div>
                )}

                {/* Actions */}
                <div className="surf-actions">
                    <button className="surf-btn primary" onClick={handleGenerate} title="Generate surfacing G-code">
                        <Play size={14} />
                        Generate G-code
                    </button>
                </div>

                {/* G-code Preview */}
                {gcode && (
                    <div className="surf-preview">
                        <div className="surf-preview-header">
                            <span className="surf-preview-title">G-code Preview</span>
                            <div className="surf-preview-actions">
                                <button
                                    className="surf-preview-btn"
                                    onClick={() => setShowPreview(v => !v)}
                                    title={showPreview ? 'Collapse preview' : 'Expand preview'}
                                >
                                    {showPreview ? <EyeOff size={13} /> : <Eye size={13} />}
                                    {showPreview ? 'Hide' : 'Show'}
                                </button>
                                <button
                                    className="surf-preview-btn"
                                    onClick={handleDownload}
                                    title="Download .gcode file"
                                >
                                    <Download size={13} />
                                    Download
                                </button>
                            </div>
                        </div>

                        {showPreview && (
                            <pre className="surf-gcode-box">
                                {gcode}
                            </pre>
                        )}

                        <button
                            className={`surf-btn load ${loaded ? 'loaded' : ''}`}
                            onClick={handleLoadToWorkspace}
                            title="Send this G-code to the 3D workspace visualizer"
                        >
                            <Layers size={14} />
                            {loaded ? 'Loaded to Workspace' : 'Load to Workspace'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
