import { useState, useMemo } from 'react';
import { Square, Maximize2, AlertTriangle, Play, X } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import controller from '../utils/controller';
import './RunOutline.css';

interface BoundingBox {
    minX: number; maxX: number;
    minY: number; maxY: number;
    minZ: number; maxZ: number;
}

// Parse G-code and extract bounding box from XY moves
function calculateBoundingBox(rawGcode: string): BoundingBox | null {
    const lines = rawGcode.split(/\r?\n/);
    let x = 0, y = 0, z = 0;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let isAbsolute = true;
    let hasMove = false;

    const numRe = /([XYZF])\s*(-?[\d.]+)/gi;

    for (const raw of lines) {
        const line = raw.replace(/;.*$/, '').trim().toUpperCase();
        if (!line) continue;

        if (line.includes('G90')) isAbsolute = true;
        if (line.includes('G91')) isAbsolute = false;

        // G0, G1, G2, G3 moves
        if (/^G[0-3]\b/.test(line) || /^G0[0-3]\b/.test(line)) {
            const coords: Record<string, number> = {};
            let m: RegExpExecArray | null;
            numRe.lastIndex = 0;
            while ((m = numRe.exec(line)) !== null) {
                coords[m[1]] = parseFloat(m[2]);
            }

            if (isAbsolute) {
                if (coords.X !== undefined) x = coords.X;
                if (coords.Y !== undefined) y = coords.Y;
                if (coords.Z !== undefined) z = coords.Z;
            } else {
                if (coords.X !== undefined) x += coords.X;
                if (coords.Y !== undefined) y += coords.Y;
                if (coords.Z !== undefined) z += coords.Z;
            }

            if (coords.X !== undefined || coords.Y !== undefined) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
                hasMove = true;
            }
            if (coords.Z !== undefined) {
                minZ = Math.min(minZ, z);
                maxZ = Math.max(maxZ, z);
            }
        }
    }

    if (!hasMove) return null;

    return {
        minX: isFinite(minX) ? minX : 0,
        maxX: isFinite(maxX) ? maxX : 0,
        minY: isFinite(minY) ? minY : 0,
        maxY: isFinite(maxY) ? maxY : 0,
        minZ: isFinite(minZ) ? minZ : 0,
        maxZ: isFinite(maxZ) ? maxZ : 0,
    };
}

// Generate square outline G-code (rectangle at safe height)
function generateSquareOutline(bb: BoundingBox, safeZ: number, feedRate: number): string {
    const lines = [
        'G90',
        `G0 Z${safeZ.toFixed(3)}`,
        `G0 X${bb.minX.toFixed(3)} Y${bb.minY.toFixed(3)}`,
        `G1 X${bb.maxX.toFixed(3)} Y${bb.minY.toFixed(3)} F${feedRate}`,
        `G1 X${bb.maxX.toFixed(3)} Y${bb.maxY.toFixed(3)}`,
        `G1 X${bb.minX.toFixed(3)} Y${bb.maxY.toFixed(3)}`,
        `G1 X${bb.minX.toFixed(3)} Y${bb.minY.toFixed(3)}`,
        `G0 Z${safeZ.toFixed(3)}`,
    ];
    return lines.join('\n');
}

// Generate detailed outline (follows toolpath XY at safe Z)
function generateDetailedOutline(rawGcode: string, safeZ: number, feedRate: number): string {
    const lines = rawGcode.split(/\r?\n/);
    const moves: Array<[number, number]> = [];
    let x = 0, y = 0;
    let isAbsolute = true;
    const numRe = /([XY])\s*(-?[\d.]+)/gi;

    for (const raw of lines) {
        const line = raw.replace(/;.*$/, '').trim().toUpperCase();
        if (!line) continue;
        if (line.includes('G90')) isAbsolute = true;
        if (line.includes('G91')) isAbsolute = false;

        if (/^G[0-3]\b/.test(line) || /^G0[0-3]\b/.test(line)) {
            const coords: Record<string, number> = {};
            let m: RegExpExecArray | null;
            numRe.lastIndex = 0;
            while ((m = numRe.exec(line)) !== null) {
                coords[m[1]] = parseFloat(m[2]);
            }
            if (coords.X !== undefined || coords.Y !== undefined) {
                if (isAbsolute) {
                    if (coords.X !== undefined) x = coords.X;
                    if (coords.Y !== undefined) y = coords.Y;
                } else {
                    if (coords.X !== undefined) x += coords.X;
                    if (coords.Y !== undefined) y += coords.Y;
                }
                moves.push([x, y]);
            }
        }
    }

    // Downsample to max 200 points
    const maxPts = 200;
    const step = Math.max(1, Math.floor(moves.length / maxPts));
    const sampled = moves.filter((_, i) => i % step === 0);
    if (sampled.length === 0) {
        const bb = calculateBoundingBox(rawGcode);
        if (!bb) return '';
        return generateSquareOutline(bb, safeZ, feedRate);
    }

    const outLines = [
        'G90',
        `G0 Z${safeZ.toFixed(3)}`,
        `G0 X${sampled[0][0].toFixed(3)} Y${sampled[0][1].toFixed(3)}`,
    ];

    for (let i = 1; i < sampled.length; i++) {
        outLines.push(`G1 X${sampled[i][0].toFixed(3)} Y${sampled[i][1].toFixed(3)} F${feedRate}`);
    }
    outLines.push(`G0 Z${safeZ.toFixed(3)}`);
    return outLines.join('\n');
}

interface RunOutlineProps {
    onClose: () => void;
}

export default function RunOutline({ onClose }: RunOutlineProps) {
    const { rawGcodeContent, connected, addConsoleLog, appPreferences } = useCNCStore();
    const [mode, setMode] = useState<'square' | 'detailed'>(
        (appPreferences?.outlineStyle?.toLowerCase() as 'square' | 'detailed') ?? 'square'
    );
    const [safeZ, setSafeZ] = useState(appPreferences?.safeHeight ?? 10);
    const [feedRate, setFeedRate] = useState(2000);

    const boundingBox = useMemo(() => {
        if (!rawGcodeContent) return null;
        return calculateBoundingBox(rawGcodeContent);
    }, [rawGcodeContent]);

    const handleRun = () => {
        if (!connected || !rawGcodeContent || !boundingBox) return;

        let outlineGcode: string;
        if (mode === 'square') {
            outlineGcode = generateSquareOutline(boundingBox, safeZ, feedRate);
        } else {
            outlineGcode = generateDetailedOutline(rawGcodeContent, safeZ, feedRate);
        }

        addConsoleLog('info', `Running ${mode} outline at Z=${safeZ}mm, F=${feedRate}`);
        controller.loadFile('outline.gcode', outlineGcode);
        setTimeout(() => {
            controller.command('gcode:start');
            addConsoleLog('success', 'Outline run started');
        }, 200);

        onClose();
    };

    const dims = boundingBox ? {
        w: (boundingBox.maxX - boundingBox.minX).toFixed(2),
        h: (boundingBox.maxY - boundingBox.minY).toFixed(2),
    } : null;

    return (
        <div className="ro-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label="Run outline">
            <div className="ro-modal">
                <div className="ro-header">
                    <div className="ro-title">
                        <Maximize2 size={16} />
                        Run Outline
                    </div>
                    <button className="ro-close" onClick={onClose} aria-label="Close dialog">
                        <X size={16} />
                    </button>
                </div>

                <div className="ro-body">
                    {!rawGcodeContent && (
                        <div className="ro-no-file">
                            <AlertTriangle size={20} />
                            No G-code file loaded
                        </div>
                    )}

                    {boundingBox && (
                        <div className="ro-bbox">
                            <div className="ro-bbox-title">Bounding Box</div>
                            <div className="ro-bbox-grid">
                                <div className="ro-bbox-item">
                                    <span className="ro-bbox-label">Width (X)</span>
                                    <span className="ro-bbox-val">{dims?.w} mm</span>
                                </div>
                                <div className="ro-bbox-item">
                                    <span className="ro-bbox-label">Height (Y)</span>
                                    <span className="ro-bbox-val">{dims?.h} mm</span>
                                </div>
                                <div className="ro-bbox-item">
                                    <span className="ro-bbox-label">X range</span>
                                    <span className="ro-bbox-val">{boundingBox.minX.toFixed(1)} → {boundingBox.maxX.toFixed(1)}</span>
                                </div>
                                <div className="ro-bbox-item">
                                    <span className="ro-bbox-label">Y range</span>
                                    <span className="ro-bbox-val">{boundingBox.minY.toFixed(1)} → {boundingBox.maxY.toFixed(1)}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Mode selection */}
                    <div className="ro-field">
                        <label className="ro-label">Outline Mode</label>
                        <div className="ro-mode-row">
                            <button
                                className={`ro-mode-btn ${mode === 'square' ? 'active' : ''}`}
                                onClick={() => setMode('square')}
                            >
                                <Square size={14} />
                                <div>
                                    <div className="ro-mode-name">Square</div>
                                    <div className="ro-mode-desc">Rectangle bounding box</div>
                                </div>
                            </button>
                            <button
                                className={`ro-mode-btn ${mode === 'detailed' ? 'active' : ''}`}
                                onClick={() => setMode('detailed')}
                            >
                                <Maximize2 size={14} />
                                <div>
                                    <div className="ro-mode-name">Detailed</div>
                                    <div className="ro-mode-desc">Follow toolpath shape</div>
                                </div>
                            </button>
                        </div>
                    </div>

                    {/* Safe height */}
                    <div className="ro-field">
                        <label className="ro-label">Safe Z Height (mm)</label>
                        <div className="ro-input-row">
                            <input
                                type="number"
                                className="ro-input"
                                value={safeZ}
                                onChange={(e) => setSafeZ(parseFloat(e.target.value) || 5)}
                                step={0.5}
                            />
                            <span className="ro-unit">mm</span>
                        </div>
                    </div>

                    {/* Feed rate */}
                    <div className="ro-field">
                        <label className="ro-label">Feed Rate</label>
                        <div className="ro-input-row">
                            <input
                                type="number"
                                className="ro-input"
                                value={feedRate}
                                onChange={(e) => setFeedRate(parseInt(e.target.value) || 1000)}
                                min={100}
                                max={10000}
                                step={100}
                            />
                            <span className="ro-unit">mm/min</span>
                        </div>
                    </div>

                    <div className="ro-info">
                        <AlertTriangle size={12} />
                        Spindle will NOT start. Outline runs at safe Z height only.
                    </div>
                </div>

                <div className="ro-footer">
                    <button className="ro-btn-cancel" onClick={onClose}>Cancel</button>
                    <button
                        className="ro-btn-run"
                        onClick={handleRun}
                        disabled={!connected || !boundingBox}
                    >
                        <Play size={14} />
                        Run {mode === 'square' ? 'Square' : 'Detailed'} Outline
                    </button>
                </div>
            </div>
        </div>
    );
}
