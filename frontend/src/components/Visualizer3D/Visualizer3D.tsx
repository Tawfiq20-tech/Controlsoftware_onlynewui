/**
 * Visualizer3D — cncjs + gSender-inspired 3D toolpath viewer.
 *
 * Visual model:
 *   - Bed plane + grid
 *   - Work envelope wireframe (machine travel)
 *   - Toolpath: rapids cyan, feed amber, arcs orange (color-blind safe)
 *   - Cut-so-far overlay: green up to currentLine
 *   - Toolhead marker: cone + collet at live machinePosition
 *   - Origin trihedron (X red, Y green, Z blue) at WCS origin
 *
 * HUD overlay:
 *   - Live X / Y / Z (work + machine)
 *   - Feed override, spindle RPM
 *   - "Line m of n" + ETA
 *   - View preset row (ISO / Top / Front / Left / Right)
 *   - Toggle row (grid, envelope, rapids, progress, tool, axes)
 *
 * Camera:
 *   - OrbitControls with damping
 *   - Mouse wheel zoom, middle-drag pan, left-drag orbit
 *   - Auto-fit to part bbox on G-code load (with 1.4× padding)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
    Grid3x3, Box, Move3d, Crosshair, RotateCcw,
    Maximize2, Eye, EyeOff, Layers, Ruler,
    Play, Pause, Palette, Video,
} from 'lucide-react';
import { useCNCStore } from '../../stores/cncStore';
import type { GCodeLine, ToolpathSegment } from '../../types/cnc';
import { parseGcode, type ParsedToolpath } from './gcodeParser';
import ResizeHandle from '../ResizeHandle';
import JobControlBar from '../JobControlBar';
import './Visualizer3D.css';

/** Build a source string from the store's parsed GCodeLine[] so our richer
 *  parser (which knows arcs + units + feed) can re-derive segments. */
function stringifyGcode(lines: GCodeLine[]): string {
    return lines.map(l => {
        const parts = [l.command];
        if (l.x !== undefined) parts.push(`X${l.x}`);
        if (l.y !== undefined) parts.push(`Y${l.y}`);
        if (l.z !== undefined) parts.push(`Z${l.z}`);
        if (l.f !== undefined) parts.push(`F${l.f}`);
        if (l.comment) parts.push(`(${l.comment})`);
        return parts.join(' ');
    }).join('\n');
}

/** Fallback: build a Float32 segment array straight from the store's segments
 *  (used when we want a quick render before the rich parser finishes). */
function segmentsToFloats(segs: ToolpathSegment[], wantRapid: boolean): Float32Array {
    const out: number[] = [];
    for (const s of segs) {
        if (s.rapid !== wantRapid) continue;
        out.push(s.start.x, s.start.y, s.start.z, s.end.x, s.end.y, s.end.z);
    }
    return new Float32Array(out);
}

type ViewPreset = 'iso' | 'top' | 'front' | 'left' | 'right';
type ColorBy    = 'motion' | 'feed' | 'depth';

/** cyan(0) → yellow(0.5) → red(1) ramp — matches gSender heatmap. */
function rampColor(t: number, out: [number, number, number]) {
    const v = Math.max(0, Math.min(1, t));
    if (v < 0.5) {
        const k = v / 0.5;
        out[0] = k;            // 0 → 1
        out[1] = 0.7 + 0.3 * k; // 0.7 → 1
        out[2] = 1 - k;         // 1 → 0
    } else {
        const k = (v - 0.5) / 0.5;
        out[0] = 1;
        out[1] = 1 - k;
        out[2] = 0;
    }
}

/** Build per-vertex color BufferAttribute for the given segments.
 *  Each segment contributes 2 vertices, both colored by the segment value. */
function buildColors(
    feeds: Float32Array, zs: Float32Array,
    colorBy: ColorBy,
    feedRange: [number, number], zRange: [number, number],
    fallbackColor: THREE.Color,
): Float32Array {
    const segCount = feeds.length;
    const colors = new Float32Array(segCount * 6); // 2 verts × 3 floats
    const rgb: [number, number, number] = [0, 0, 0];
    const fMin = feedRange[0], fMax = feedRange[1], fSpan = Math.max(1, fMax - fMin);
    const zMin = zRange[0],    zMax = zRange[1],    zSpan = Math.max(0.001, zMax - zMin);
    for (let i = 0; i < segCount; i++) {
        if (colorBy === 'feed') {
            rampColor((feeds[i] - fMin) / fSpan, rgb);
        } else if (colorBy === 'depth') {
            // Deeper = warmer. Z near max → 0 (cool), Z near min → 1 (warm).
            rampColor(1 - (zs[i] - zMin) / zSpan, rgb);
        } else {
            rgb[0] = fallbackColor.r; rgb[1] = fallbackColor.g; rgb[2] = fallbackColor.b;
        }
        const base = i * 6;
        colors[base + 0] = rgb[0]; colors[base + 1] = rgb[1]; colors[base + 2] = rgb[2];
        colors[base + 3] = rgb[0]; colors[base + 4] = rgb[1]; colors[base + 5] = rgb[2];
    }
    return colors;
}

/** Lookup the segment active at time `t` seconds (binary search). */
function segmentAtTime(cumSec: Float32Array, positions: Float32Array, t: number) {
    if (cumSec.length === 0) return null;
    let lo = 0, hi = cumSec.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumSec[mid] < t) lo = mid + 1; else hi = mid;
    }
    const idx = lo;
    const tStart = idx === 0 ? 0 : cumSec[idx - 1];
    const tEnd   = cumSec[idx];
    const f = tEnd > tStart ? (t - tStart) / (tEnd - tStart) : 0;
    const b = idx * 6;
    return {
        x: positions[b + 0] + (positions[b + 3] - positions[b + 0]) * f,
        y: positions[b + 1] + (positions[b + 4] - positions[b + 1]) * f,
        z: positions[b + 2] + (positions[b + 5] - positions[b + 2]) * f,
        idx,
    };
}

function fmtClock(s: number) {
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60), rs = s - m * 60;
    if (m < 60) return `${m}:${String(rs).padStart(2, '0')}`;
    const h = Math.floor(m / 60), rm = m - h * 60;
    return `${h}:${String(rm).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

// Fallbacks — used only if a CSS variable is missing at read time.
const COLOR_FALLBACK = {
    bg:        '#14110d',
    grid:      '#3d2e1f',
    gridMajor: '#5a4429',
    envelope:  '#7a5e3d',
    bed:       '#2a1f17',
    rapid:     '#b09a78',
    cut:       '#e88a3c',
    arc:       '#d6772b',
    progress:  '#4ade80',
    toolhead:  '#f5e9d4',
    spindle:   '#ffb86b',
};

function readCssColor(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

function readColors() {
    return {
        bg:        readCssColor('--scene-bg',     COLOR_FALLBACK.bg),
        grid:      readCssColor('--scene-grid',   COLOR_FALLBACK.grid),
        gridMajor: readCssColor('--scene-grid',   COLOR_FALLBACK.gridMajor),
        envelope:  readCssColor('--text-mute',    COLOR_FALLBACK.envelope),
        bed:       readCssColor('--scene-bed',    COLOR_FALLBACK.bed),
        rapid:     readCssColor('--scene-rapid',  COLOR_FALLBACK.rapid),
        cut:       readCssColor('--scene-cut',    COLOR_FALLBACK.cut),
        arc:       readCssColor('--scene-arc',    COLOR_FALLBACK.arc),
        progress:  readCssColor('--status-ok',    COLOR_FALLBACK.progress),
        toolhead:  readCssColor('--text-main',    COLOR_FALLBACK.toolhead),
        spindle:   readCssColor('--scene-cursor', COLOR_FALLBACK.spindle),
        xAxis:     readCssColor('--axis-x', '#ef4444'),
        yAxis:     readCssColor('--axis-y', '#10b981'),
        zAxis:     readCssColor('--axis-z', '#3b82f6'),
    };
}

// Initial snapshot — refreshed on theme change via useEffect listener.
const COLORS = readColors();

const DEFAULT_ENVELOPE = { x: 812, y: 812, z: 130 };

function parseEnvelope(workArea?: string) {
    if (!workArea) return DEFAULT_ENVELOPE;
    const m = workArea.match(/(\d+)\s*[×x*]\s*(\d+)\s*[×x*]\s*(\d+)/i);
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : DEFAULT_ENVELOPE;
}

function fmtDistance(mm: number) {
    if (mm < 1) return `${(mm * 1000).toFixed(0)} μm`;
    if (mm < 1000) return `${mm.toFixed(1)} mm`;
    return `${(mm / 1000).toFixed(2)} m`;
}
function fmtTime(s: number) {
    if (s < 60) return `${s.toFixed(0)}s`;
    const m = Math.floor(s / 60), rs = s - m * 60;
    if (m < 60) return `${m}m ${rs.toFixed(0)}s`;
    const h = Math.floor(m / 60), rm = m - h * 60;
    return `${h}h ${rm}m`;
}

export type ViewerMode = 'prepare' | 'carve';

interface Visualizer3DProps {
    mode?: ViewerMode;
}

export default function Visualizer3D({ mode = 'prepare' }: Visualizer3DProps = {}) {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const camRef = useRef<THREE.PerspectiveCamera | null>(null);
    const ctrlRef = useRef<OrbitControls | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const groupRef = useRef<{
        bed: THREE.Mesh; grid: THREE.GridHelper;
        envelope: THREE.LineSegments;
        rapids: THREE.LineSegments; cuts: THREE.LineSegments; arcs: THREE.LineSegments;
        progress: THREE.LineSegments;
        toolhead: THREE.Group;
        axes: THREE.AxesHelper;
        scale: THREE.Group;
        cutsMaterial: THREE.LineBasicMaterial;
        arcsMaterial: THREE.LineBasicMaterial;
    } | null>(null);
    const parsedRef = useRef<ParsedToolpath | null>(null);
    // Refs read inside the RAF tick so the closure stays cheap and reactive.
    const cursorActiveRef = useRef(false);
    const cursorSecRef    = useRef(0);
    const cameraFollowRef = useRef(false);
    const livePosRef      = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });

    const [view, setView] = useState<ViewPreset>('iso');
    const [showGrid, setShowGrid] = useState(true);
    const [showEnv, setShowEnv]   = useState(true);
    const [showRapids, setShowRapids] = useState(true);
    const [showProgress, setShowProgress] = useState(true);
    const [showTool, setShowTool] = useState(true);
    const [showAxes, setShowAxes] = useState(true);
    const [showScale, setShowScale] = useState(true);

    // Phase: playback scrubber + camera-follow + color-by.
    const [playing, setPlaying] = useState(false);
    const [cursorSec, setCursorSec] = useState(0);
    const [playSpeed, setPlaySpeed] = useState(1);
    const [colorBy, setColorBy] = useState<ColorBy>('motion');
    const [cameraFollow, setCameraFollow] = useState(false);
    const playLastTickRef = useRef<number>(0);

    // Simulation toggle (only meaningful in 'prepare' mode).
    // 'prepare' default is LIVE view (toolhead = real machine). User presses
    // Simulate → switches to scrubber-driven preview without leaving the tab.
    // 'carve' mode never enters simulation (it's the execution view).
    const [simulating, setSimulating] = useState(false);
    const cursorActive = mode === 'prepare' && simulating && (playing || cursorSec > 0);
    // Show the bottom scrubber bar only while previewing in 'prepare'.
    const showPlaybackBar = mode === 'prepare' && simulating;
    // Show the Simulate launcher in 'prepare' when NOT simulating.
    const showSimulateLauncher = mode === 'prepare' && !simulating;
    // Show the Carve action bar in 'carve' mode.
    const showCarveBar = mode === 'carve';

    const {
        gcode, toolpathSegments, fileInfo, currentLine,
        machinePosition, machineState,
        activeMachineProfile, machineProfiles,
    } = useCNCStore();

    // machineState drives the Carve banner state pill; lock-behavior for
    // Header tabs + Sidebar Controls tab is wired in those components.

    const envelope = useMemo(() => {
        const prof = machineProfiles.find(p => p.id === activeMachineProfile);
        return parseEnvelope(prof?.workArea);
    }, [activeMachineProfile, machineProfiles]);

    // Re-parse G-code when it changes. Uses our rich parser for arcs/units/feed.
    const parsed = useMemo<ParsedToolpath | null>(() => {
        if (!gcode || gcode.length === 0) return null;
        try { return parseGcode(stringifyGcode(gcode)); }
        catch (e) { console.warn('[Visualizer3D] parse failed', e); return null; }
    }, [gcode]);

    // Fallback geometry from store's prebuilt segments — used if rich parser fails.
    const fallback = useMemo(() => ({
        rapids: segmentsToFloats(toolpathSegments, true),
        cuts:   segmentsToFloats(toolpathSegments, false),
    }), [toolpathSegments]);

    // ─── Init Three.js once ──────────────────────────────────────
    useEffect(() => {
        if (!mountRef.current) return;
        const mount = mountRef.current;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(COLORS.bg);
        sceneRef.current = scene;

        const cam = new THREE.PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 1, 5000);
        cam.up.set(0, 0, 1);
        camRef.current = cam;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        mount.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const ctrl = new OrbitControls(cam, renderer.domElement);
        ctrl.enableDamping = true;
        ctrl.dampingFactor = 0.08;
        ctrl.target.set(envelope.x / 2, envelope.y / 2, 0);
        ctrlRef.current = ctrl;

        // Lighting (subtle — we mostly render lines).
        scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        const dir = new THREE.DirectionalLight(0xffffff, 0.6);
        dir.position.set(envelope.x, envelope.y, envelope.z * 4);
        scene.add(dir);

        // Bed. We render it BELOW the workpiece (z = -workEnvelope.z * 0.5) and
        // disable depthWrite so it never occludes the toolpath lines that cut
        // INTO the stock (negative Z is the norm — Z=0 is the workpiece top
        // and cuts go to Z = -depth). Earlier this occlusion is what made the
        // toolpath "below the plane" — Tawfiq 2026-06-27 msg 7192.
        const bedGeo = new THREE.PlaneGeometry(envelope.x, envelope.y);
        const bedMat = new THREE.MeshBasicMaterial({
            color: COLORS.bed, side: THREE.DoubleSide,
            transparent: true, opacity: 0.5, depthWrite: false,
        });
        const bed = new THREE.Mesh(bedGeo, bedMat);
        bed.position.set(envelope.x / 2, envelope.y / 2, -envelope.z * 0.5);
        bed.renderOrder = -10;
        scene.add(bed);

        // Grid sits at Z=0 (workpiece top reference). depthWrite=false so the
        // grid never occludes the toolpath either.
        const grid = new THREE.GridHelper(Math.max(envelope.x, envelope.y), 32, COLORS.gridMajor, COLORS.grid);
        grid.rotation.x = Math.PI / 2;
        grid.position.set(envelope.x / 2, envelope.y / 2, 0);
        (grid.material as THREE.Material).depthWrite = false;
        if (Array.isArray(grid.material)) grid.material.forEach(m => (m.depthWrite = false));
        grid.renderOrder = -5;
        scene.add(grid);

        // Envelope (machine travel) wireframe.
        const envGeo = new THREE.BoxGeometry(envelope.x, envelope.y, envelope.z);
        const envEdges = new THREE.EdgesGeometry(envGeo);
        const envMat = new THREE.LineBasicMaterial({ color: COLORS.envelope });
        const envelopeMesh = new THREE.LineSegments(envEdges, envMat);
        envelopeMesh.position.set(envelope.x / 2, envelope.y / 2, envelope.z / 2);
        scene.add(envelopeMesh);

        // Toolpath line groups (will be filled when parsed changes).
        const rapidsMat = new THREE.LineBasicMaterial({ color: COLORS.rapid, transparent: true, opacity: 0.45 });
        const cutsMat   = new THREE.LineBasicMaterial({ color: COLORS.cut, vertexColors: false });
        const arcsMat   = new THREE.LineBasicMaterial({ color: COLORS.arc, vertexColors: false });
        const progMat   = new THREE.LineBasicMaterial({ color: COLORS.progress });

        const rapids = new THREE.LineSegments(new THREE.BufferGeometry(), rapidsMat);
        const cuts   = new THREE.LineSegments(new THREE.BufferGeometry(), cutsMat);
        const arcs   = new THREE.LineSegments(new THREE.BufferGeometry(), arcsMat);
        const progress = new THREE.LineSegments(new THREE.BufferGeometry(), progMat);
        scene.add(rapids, cuts, arcs, progress);

        // Toolhead — minimal modelled spindle (Tawfiq msg 7272: drop the grey
        // outer body, keep only the inner collet cylinder, extend it upward
        // to fill the height the body used to occupy). Two parts: a single
        // dark cylinder + a copper conical bit. Tip sits at Z=0.
        const toolhead = new THREE.Group();

        // Shaft — single dark cylinder (was "collet"); extended to 30 mm so
        // it's visually prominent. Sits directly on top of the bit's base.
        const shaftGeo = new THREE.CylinderGeometry(4.2, 4.2, 30, 32);
        shaftGeo.rotateX(Math.PI / 2);
        shaftGeo.translate(0, 0, 23);   // base at z=8, top at z=38
        const shaft = new THREE.Mesh(
            shaftGeo,
            new THREE.MeshLambertMaterial({ color: 0x434a55 }),
        );
        shaft.renderOrder = 100;

        // Bit — brown/copper conical cutting tool, axis along Z, tip at z=0.
        // rotateX(-π/2) swings the cone's +Y axis to world -Z so the tip
        // points DOWN; then translate +z by half-height to land tip at z=0.
        const bitGeo = new THREE.ConeGeometry(2.4, 8, 18);
        bitGeo.rotateX(-Math.PI / 2);
        bitGeo.translate(0, 0, 4);      // tip at z=0, base at z=+8
        const bit = new THREE.Mesh(
            bitGeo,
            new THREE.MeshLambertMaterial({ color: 0x8b5a2b }),
        );
        bit.renderOrder = 100;

        toolhead.add(shaft, bit);
        scene.add(toolhead);

        // Origin axes helper (X red, Y green, Z blue). The big floating X/Y/Z
        // text labels that used to sit at axis endpoints were removed per
        // Tawfiq msg 7341 — operators already know orientation from the
        // coloured lines + the on-screen X/Y/Z readouts in the sidebar.
        const axes = new THREE.AxesHelper(Math.min(envelope.x, envelope.y) * 0.15);
        scene.add(axes);

        // Distance ruler along the bed's X (red) and Y (green) edges — small
        // numbered ticks, not the big floating XYZ text that was removed per
        // Tawfiq msg 7341. Toggleable via showScale, off the same toolbar row
        // as the other overlay toggles. Requested msg11907/11912/11914.
        const scaleGroup = buildScaleGroup(envelope, COLORS);
        scene.add(scaleGroup);

        groupRef.current = {
            bed, grid, envelope: envelopeMesh,
            rapids, cuts, arcs, progress,
            toolhead, axes, scale: scaleGroup,
            cutsMaterial: cutsMat,
            arcsMaterial: arcsMat,
        };

        applyView(view, cam, ctrl, envelope);

        // Animation loop. Reads refs so cursor + camera-follow stay reactive
        // without re-creating the closure on every state change.
        let raf = 0;
        const tmpVec = new THREE.Vector3();
        const tick = () => {
            const p = parsedRef.current;
            // Decide toolhead position: scrubber/playback overrides live machine pos.
            let toolPos = livePosRef.current;
            if (cursorActiveRef.current && p) {
                const sec = Math.min(cursorSecRef.current, p.durationSec);
                const cursorOnCut = segmentAtTime(p.cutCumSec, p.cuts, sec);
                const cursorOnArc = segmentAtTime(p.arcCumSec, p.arcs, sec);
                // Pick whichever segment is "active" at this time. We prefer
                // the larger cum-sec idx so we follow the most recent motion.
                if (cursorOnCut && cursorOnArc) {
                    const cutEnd = p.cutCumSec[cursorOnCut.idx] || 0;
                    const arcEnd = p.arcCumSec[cursorOnArc.idx] || 0;
                    toolPos = cutEnd >= arcEnd ? cursorOnCut : cursorOnArc;
                } else if (cursorOnCut) toolPos = cursorOnCut;
                else if (cursorOnArc) toolPos = cursorOnArc;
            }
            const g = groupRef.current;
            if (g) g.toolhead.position.set(toolPos.x, toolPos.y, toolPos.z);

            // Camera-follow: lerp orbit target to toolhead.
            if (cameraFollowRef.current) {
                tmpVec.set(toolPos.x, toolPos.y, toolPos.z);
                ctrl.target.lerp(tmpVec, 0.08);
                cam.position.lerp(
                    tmpVec.clone().add(new THREE.Vector3(150, -150, 120)),
                    0.04,
                );
            }
            ctrl.update();
            renderer.render(scene, cam);
            raf = requestAnimationFrame(tick);
        };
        tick();

        // Resize.
        const onResize = () => {
            if (!mount) return;
            const w = mount.clientWidth, h = mount.clientHeight;
            renderer.setSize(w, h);
            cam.aspect = w / h;
            cam.updateProjectionMatrix();
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(mount);

        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            renderer.dispose();
            if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [envelope.x, envelope.y, envelope.z]);

    // ─── Theme re-color — listen for 'cnc:theme' and update scene/materials in-place ──
    useEffect(() => {
        const apply = () => {
            const scene = sceneRef.current;
            const g = groupRef.current;
            if (!scene || !g) return;
            const c = readColors();
            scene.background = new THREE.Color(c.bg);
            (g.bed.material as THREE.MeshBasicMaterial).color.set(c.bed);
            (g.bed.material as THREE.MeshBasicMaterial).needsUpdate = true;
            // GridHelper materials: 0=major, 1=minor
            const gridMats = Array.isArray(g.grid.material) ? g.grid.material : [g.grid.material];
            gridMats.forEach((m) => (m as THREE.LineBasicMaterial).color.set(c.grid));
            (g.envelope.material as THREE.LineBasicMaterial).color.set(c.envelope);
            (g.rapids.material as THREE.LineBasicMaterial).color.set(c.rapid);
            g.cutsMaterial.color.set(c.cut);
            g.arcsMaterial.color.set(c.arc);
            (g.progress.material as THREE.LineBasicMaterial).color.set(c.progress);
            // Spindle uses realistic material colors (grey body, dark collet,
            // copper bit) — independent of theme so it always reads as a real
            // tool. No traverse-recolor here.
        };
        apply();
        const handler = () => apply();
        window.addEventListener('cnc:theme', handler);
        return () => window.removeEventListener('cnc:theme', handler);
    }, []);

    // ─── Push parsed toolpath into BufferGeometry ────────────────
    useEffect(() => {
        const g = groupRef.current;
        if (!g) return;
        if (!parsed) {
            // Fall back to whatever toolpathSegments the store already has.
            g.rapids.geometry.setAttribute('position', new THREE.BufferAttribute(fallback.rapids, 3));
            g.cuts.geometry.setAttribute('position',   new THREE.BufferAttribute(fallback.cuts, 3));
            g.arcs.geometry.setAttribute('position',   new THREE.BufferAttribute(new Float32Array(0), 3));
            g.progress.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
            parsedRef.current = null;
            return;
        }
        parsedRef.current = parsed;
        g.rapids.geometry.setAttribute('position', new THREE.BufferAttribute(parsed.rapids, 3));
        g.cuts.geometry.setAttribute('position',   new THREE.BufferAttribute(parsed.cuts, 3));
        g.arcs.geometry.setAttribute('position',   new THREE.BufferAttribute(parsed.arcs, 3));
        g.rapids.geometry.computeBoundingSphere();
        g.cuts.geometry.computeBoundingSphere();
        g.arcs.geometry.computeBoundingSphere();

        // Auto-fit camera to bbox.
        if (camRef.current && ctrlRef.current) {
            fitToBox(parsed.bbox, camRef.current, ctrlRef.current);
        }
    }, [parsed]);

    // ─── Progress overlay (cut-so-far in green) ──────────────────
    // Uses cursorSec when scrubbed/playing; otherwise tracks the live
    // currentLine from the controller.
    useEffect(() => {
        const g = groupRef.current;
        const p = parsedRef.current;
        if (!g || !p) return;
        if (!showProgress) {
            g.progress.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
            return;
        }
        const acc: number[] = [];
        if (cursorActive) {
            // Time-based: include any segment whose end-time <= cursorSec.
            for (let i = 0; i < p.cutCumSec.length; i++) {
                if (p.cutCumSec[i] <= cursorSec) {
                    acc.push(
                        p.cuts[i*6+0], p.cuts[i*6+1], p.cuts[i*6+2],
                        p.cuts[i*6+3], p.cuts[i*6+4], p.cuts[i*6+5],
                    );
                }
            }
            for (let i = 0; i < p.arcCumSec.length; i++) {
                if (p.arcCumSec[i] <= cursorSec) {
                    acc.push(
                        p.arcs[i*6+0], p.arcs[i*6+1], p.arcs[i*6+2],
                        p.arcs[i*6+3], p.arcs[i*6+4], p.arcs[i*6+5],
                    );
                }
            }
        } else {
            // Line-based: include any segment whose source line <= currentLine.
            for (let i = 0; i < p.cutLines.length; i++) {
                if (p.cutLines[i] <= currentLine) {
                    acc.push(
                        p.cuts[i*6+0], p.cuts[i*6+1], p.cuts[i*6+2],
                        p.cuts[i*6+3], p.cuts[i*6+4], p.cuts[i*6+5],
                    );
                }
            }
            for (let i = 0; i < p.arcLines.length; i++) {
                if (p.arcLines[i] <= currentLine) {
                    acc.push(
                        p.arcs[i*6+0], p.arcs[i*6+1], p.arcs[i*6+2],
                        p.arcs[i*6+3], p.arcs[i*6+4], p.arcs[i*6+5],
                    );
                }
            }
        }
        g.progress.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(acc), 3));
    }, [currentLine, showProgress, parsed, cursorActive, cursorSec]);

    // ─── Toolhead live position → ref (read by RAF tick) ─────────
    useEffect(() => {
        livePosRef.current = { x: machinePosition.x, y: machinePosition.y, z: machinePosition.z };
    }, [machinePosition]);

    // ─── Sync cursor/follow state to refs the RAF tick reads ─────
    useEffect(() => { cursorActiveRef.current = cursorActive; }, [cursorActive]);
    useEffect(() => { cursorSecRef.current = cursorSec; }, [cursorSec]);
    useEffect(() => { cameraFollowRef.current = cameraFollow; }, [cameraFollow]);

    // ─── Playback advance loop ───────────────────────────────────
    useEffect(() => {
        if (!playing) return;
        const p = parsedRef.current;
        if (!p || p.durationSec <= 0) { setPlaying(false); return; }
        playLastTickRef.current = performance.now();
        let raf = 0;
        const step = () => {
            const now = performance.now();
            const dt = (now - playLastTickRef.current) / 1000;
            playLastTickRef.current = now;
            setCursorSec(prev => {
                const next = prev + dt * playSpeed;
                if (next >= p.durationSec) {
                    setPlaying(false);
                    return p.durationSec;
                }
                return next;
            });
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [playing, playSpeed]);

    // ─── Color-by — rebuild vertex colors when mode or parsed changes ─
    useEffect(() => {
        const g = groupRef.current;
        const p = parsedRef.current;
        if (!g || !p) return;
        if (colorBy === 'motion') {
            g.cutsMaterial.vertexColors = false;
            g.arcsMaterial.vertexColors = false;
            g.cutsMaterial.color.set(COLORS.cut);
            g.arcsMaterial.color.set(COLORS.arc);
            g.cutsMaterial.needsUpdate = true;
            g.arcsMaterial.needsUpdate = true;
            g.cuts.geometry.deleteAttribute('color');
            g.arcs.geometry.deleteAttribute('color');
            return;
        }
        const cutColors = buildColors(p.cutFeeds, p.cutZs, colorBy, p.feedRange, p.zRange, new THREE.Color(COLORS.cut));
        const arcColors = buildColors(p.arcFeeds, p.arcZs, colorBy, p.feedRange, p.zRange, new THREE.Color(COLORS.arc));
        g.cuts.geometry.setAttribute('color', new THREE.BufferAttribute(cutColors, 3));
        g.arcs.geometry.setAttribute('color', new THREE.BufferAttribute(arcColors, 3));
        g.cutsMaterial.vertexColors = true;
        g.arcsMaterial.vertexColors = true;
        g.cutsMaterial.needsUpdate = true;
        g.arcsMaterial.needsUpdate = true;
    }, [colorBy, parsed]);

    // Reset cursor when a new file loads (avoids stale playback state).
    useEffect(() => {
        setCursorSec(0); setPlaying(false);
    }, [parsed]);

    // ─── Visibility toggles ──────────────────────────────────────
    useEffect(() => {
        const g = groupRef.current; if (!g) return;
        g.grid.visible = showGrid;
        g.envelope.visible = showEnv;
        g.rapids.visible = showRapids;
        g.progress.visible = showProgress;
        g.toolhead.visible = showTool;
        g.axes.visible = showAxes;
        g.scale.visible = showScale;
    }, [showGrid, showEnv, showRapids, showProgress, showTool, showAxes, showScale]);

    // ─── View preset changes ─────────────────────────────────────
    useEffect(() => {
        if (!camRef.current || !ctrlRef.current) return;
        applyView(view, camRef.current, ctrlRef.current, envelope);
    }, [view, envelope]);

    // HUD computations.
    const eta = useMemo(() => {
        if (!parsed) return null;
        const frac = parsed.lineCount > 0 ? Math.min(1, currentLine / parsed.lineCount) : 0;
        const remaining = parsed.durationSec * (1 - frac);
        return { total: parsed.durationSec, remaining, frac };
    }, [parsed, currentLine]);

    // Carve-mode state pill content
    const carvePillTone = machineState === 'running' ? 'run'
        : machineState === 'paused' ? 'hold'
        : machineState === 'alarm' ? 'bad'
        : 'idle';
    const carvePillLabel = machineState === 'running' ? 'RUN'
        : machineState === 'paused' ? 'HOLD'
        : machineState === 'alarm' ? 'ALARM'
        : 'IDLE';

    return (
        <div className={`v3d-root ${mode === 'carve' ? 'v3d-root-carve' : ''}`}>
            <div className="v3d-canvas-area">
            {mode === 'carve' && (
                <div className="v3d-carve-banner">
                    <span className="v3d-cb-name">{fileInfo?.name || 'untitled.nc'}</span>
                    {parsed && <span className="v3d-cb-meta">· {parsed.lineCount} lines</span>}
                    <span className={`v3d-cb-pill ${carvePillTone}`}>
                        <span className="v3d-cb-dot" />{carvePillLabel}
                    </span>
                    <div className="v3d-cb-spacer" />
                    {parsed && (
                        <div className="v3d-cb-prog">
                            <div className="v3d-cb-prog-track">
                                <div className="v3d-cb-prog-fill"
                                    style={{ width: `${eta ? (eta.frac * 100).toFixed(1) : 0}%` }} />
                            </div>
                            <span className="v3d-cb-eta">
                                <b>{currentLine}</b>/{parsed.lineCount} · <b>{eta ? (eta.frac * 100).toFixed(0) : 0}</b>% ·
                                ETA <b>{eta ? fmtClock(eta.remaining) : fmtClock(parsed.durationSec)}</b>
                            </span>
                        </div>
                    )}
                </div>
            )}
            <div className="v3d-mount" ref={mountRef} />

            <div className="v3d-toolbar v3d-toolbar-top">
                {(['iso', 'top', 'front', 'left', 'right'] as ViewPreset[]).map(v => (
                    <button key={v} className={`v3d-btn ${view === v ? 'active' : ''}`}
                            onClick={() => setView(v)}>{v}</button>
                ))}
                <span className="v3d-divider" />
                <button className={`v3d-btn ${showGrid ? 'active' : ''}`} title="Grid"
                        onClick={() => setShowGrid(v => !v)}><Grid3x3 size={14} /></button>
                <button className={`v3d-btn ${showEnv ? 'active' : ''}`} title="Envelope"
                        onClick={() => setShowEnv(v => !v)}><Box size={14} /></button>
                <button className={`v3d-btn ${showRapids ? 'active' : ''}`} title="Rapids"
                        onClick={() => setShowRapids(v => !v)}><Move3d size={14} /></button>
                <button className={`v3d-btn ${showProgress ? 'active' : ''}`} title="Progress overlay"
                        onClick={() => setShowProgress(v => !v)}><Layers size={14} /></button>
                <button className={`v3d-btn ${showTool ? 'active' : ''}`} title="Toolhead"
                        onClick={() => setShowTool(v => !v)}><Crosshair size={14} /></button>
                <button className={`v3d-btn ${showAxes ? 'active' : ''}`} title="Axes"
                        onClick={() => setShowAxes(v => !v)}>{showAxes ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                <button className={`v3d-btn ${showScale ? 'active' : ''}`} title="Scale"
                        onClick={() => setShowScale(v => !v)}><Ruler size={14} /></button>
                <span className="v3d-divider" />
                <button className="v3d-btn" title="Fit to part"
                        onClick={() => {
                            if (parsedRef.current && camRef.current && ctrlRef.current) {
                                fitToBox(parsedRef.current.bbox, camRef.current, ctrlRef.current);
                            }
                        }}><Maximize2 size={14} /></button>
                <button className="v3d-btn" title="Reset view"
                        onClick={() => applyView('iso', camRef.current!, ctrlRef.current!, envelope)}>
                    <RotateCcw size={14} />
                </button>
            </div>

            {/* Prepare mode: file/job info card. Position chips removed per
                Tawfiq msg 7321 — X/Y/Z still lives in the sidebar POSITION
                tab and (in Carve mode) the top status banner. */}
            {mode !== 'carve' && parsed && (
                <div className="v3d-info-card v3d-hud-tr">
                    <div className="v3d-info-name">{fileInfo?.name || 'untitled.nc'}</div>
                    <div className="v3d-info-stats">
                        <div className="v3d-info-stat">
                            <span className="v3d-info-label">ETA</span>
                            <span className="v3d-info-val">{eta ? fmtTime(eta.remaining) : fmtTime(parsed.durationSec)}</span>
                        </div>
                        <div className="v3d-info-stat">
                            <span className="v3d-info-label">Line</span>
                            <span className="v3d-info-val">{currentLine}<span className="v3d-info-mut">/{parsed.lineCount}</span></span>
                        </div>
                        <div className="v3d-info-stat">
                            <span className="v3d-info-label">Done</span>
                            <span className="v3d-info-val">{eta ? (eta.frac * 100).toFixed(0) : 0}<span className="v3d-info-mut">%</span></span>
                        </div>
                    </div>
                    <div className="v3d-info-meta">
                        cut {fmtDistance(parsed.distance.cut + parsed.distance.arc)} · rapid {fmtDistance(parsed.distance.rapid)} · {parsed.units}
                        {parsed.tools.length > 0 && <> · {parsed.tools.map(t => `T${t}`).join(' ')}</>}
                    </div>
                </div>
            )}

            <div className="v3d-legend">
                {colorBy === 'motion' && <>
                    <span><i style={{ background: COLORS.rapid }} /> rapid</span>
                    <span><i style={{ background: COLORS.cut }} /> cut</span>
                    <span><i style={{ background: COLORS.arc }} /> arc</span>
                    <span><i style={{ background: COLORS.progress }} /> done</span>
                </>}
                {colorBy === 'feed' && parsed && <>
                    <span><i className="v3d-ramp" /> {parsed.feedRange[0].toFixed(0)} → {parsed.feedRange[1].toFixed(0)} mm/min</span>
                </>}
                {colorBy === 'depth' && parsed && <>
                    <span><i className="v3d-ramp" /> Z {parsed.zRange[1].toFixed(1)} → {parsed.zRange[0].toFixed(1)} mm (shallow → deep)</span>
                </>}
            </div>

            {/* PREPARE / no-sim: Simulate launcher BOTTOM bar (matches Carve position). */}
            {showSimulateLauncher && parsed && parsed.durationSec > 0 && (
                <div className="v3d-simulate-launcher">
                    <button className="v3d-sim-cta" onClick={() => {
                        setSimulating(true);
                        setCursorSec(0);
                        setPlaying(true);
                    }}>
                        <Play size={16} /> Simulate
                    </button>
                    <label className="v3d-speed-dd">
                        <span className="v3d-speed-dd-label">Speed</span>
                        <select className="v3d-speed-dd-sel"
                            value={playSpeed}
                            onChange={(e) => setPlaySpeed(Number(e.target.value))}>
                            <option value={0.5}>0.5×</option>
                            <option value={1}>1×</option>
                            <option value={2}>2×</option>
                            <option value={3}>3×</option>
                            <option value={6}>6×</option>
                            <option value={10}>10×</option>
                            <option value={14}>14×</option>
                        </select>
                    </label>
                    <div className="v3d-sim-spacer" />
                    <span className="v3d-sim-meta">
                        Est. time <b>{fmtClock(parsed.durationSec)}</b>
                        {parsed.tools.length > 0 && <> · Tools <b>{parsed.tools.map(t => `T${t}`).join(' ')}</b></>}
                        · <b>{parsed.lineCount}</b> lines
                    </span>
                </div>
            )}

            {/* PREPARE / simulating: scrubber bar + exit button. */}
            {showPlaybackBar && parsed && parsed.durationSec > 0 && (
                <div className="v3d-playback">
                    <button className="v3d-btn primary" onClick={() => {
                        if (playing) { setPlaying(false); return; }
                        if (cursorSec >= parsed.durationSec) setCursorSec(0);
                        setPlaying(true);
                    }} title={playing ? 'Pause' : 'Play'}>
                        {playing ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <span className="v3d-clock">{fmtClock(cursorSec)}</span>
                    <input
                        type="range"
                        className="v3d-slider"
                        min={0}
                        max={parsed.durationSec}
                        step={parsed.durationSec / 1000}
                        value={cursorSec}
                        onChange={e => { setPlaying(false); setCursorSec(+e.target.value); }}
                    />
                    <span className="v3d-clock">{fmtClock(parsed.durationSec)}</span>
                    <select className="v3d-speed-dd-sel"
                        value={playSpeed}
                        onChange={(e) => setPlaySpeed(Number(e.target.value))}
                        title="Playback speed">
                        <option value={0.5}>0.5×</option>
                        <option value={1}>1×</option>
                        <option value={2}>2×</option>
                        <option value={3}>3×</option>
                        <option value={6}>6×</option>
                        <option value={10}>10×</option>
                        <option value={14}>14×</option>
                    </select>
                    <button className="v3d-btn" onClick={() => setCursorSec(0)} title="Rewind to start">
                        <RotateCcw size={14} />
                    </button>
                    <span className="v3d-divider" />
                    <label className="v3d-color-by" title="Color toolpath by">
                        <Palette size={14} />
                        <select value={colorBy} onChange={e => setColorBy(e.target.value as ColorBy)}>
                            <option value="motion">motion</option>
                            <option value="feed">feed</option>
                            <option value="depth">depth</option>
                        </select>
                    </label>
                    <button className={`v3d-btn ${cameraFollow ? 'active' : ''}`}
                        onClick={() => setCameraFollow(v => !v)}
                        title="Camera follow toolhead">
                        <Video size={14} />
                    </button>
                    <span className="v3d-divider" />
                    <button className="v3d-btn danger" onClick={() => {
                        setSimulating(false);
                        setPlaying(false);
                        setCursorSec(0);
                        setColorBy('motion');
                        setCameraFollow(false);
                    }} title="Exit simulation">
                        ✕ Exit
                    </button>
                </div>
            )}

            {/* CARVE: live execution bar. Was a bespoke CarveBar with raw
                fetch('/api/command') calls and no safety gating (no
                connected/alarm/ECSS pre-flight checks) -- replaced with the
                real JobControlBar, which enforces those checks and was
                previously unmounted anywhere in the app. See CarveBar's old
                sendJob() comment: both paths call the same
                engine.controller.command(), so this is a straight swap, not
                a behavior change to what the backend receives. */}
            {showCarveBar && <JobControlBar />}
            </div>{/* /.v3d-canvas-area */}

            {mode === 'carve' && (
                <>
                    <ResizeHandle
                        targetSelector=".v3d-gp"
                        cssVar="--gp-w"
                        storageKey="cnc.gcodePanelW"
                        defaultPx={280}
                        minPx={180}
                        maxPx={520}
                        side="right"
                    />
                    <GcodePanel gcode={gcode} currentLine={currentLine} fileName={fileInfo?.name} />
                </>
            )}
        </div>
    );
}

// ─── Right-side G-code line list (Carve mode) ──────────────────────
function GcodePanel({ gcode, currentLine, fileName }: {
    gcode: GCodeLine[];
    currentLine: number;
    fileName?: string;
}) {
    const listRef = useRef<HTMLDivElement | null>(null);

    // Auto-scroll to keep the current line in view.
    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const cur = el.querySelector<HTMLDivElement>('.v3d-gp-row.current');
        if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [currentLine]);

    if (!gcode.length) {
        return (
            <div className="v3d-gp">
                <div className="v3d-gp-header">
                    <span>G-code</span>
                    <span className="v3d-gp-count">0 / 0</span>
                </div>
                <div className="v3d-gp-empty">No G-code loaded.</div>
            </div>
        );
    }

    return (
        <div className="v3d-gp">
            <div className="v3d-gp-header">
                <span title={fileName}>G-code · {fileName || 'untitled.nc'}</span>
                <span className="v3d-gp-count">{currentLine} / {gcode.length}</span>
            </div>
            <div className="v3d-gp-list" ref={listRef}>
                {gcode.map((line, i) => {
                    const cls = i < currentLine - 1 ? 'done'
                        : i === currentLine - 1 ? 'current'
                        : 'upcoming';
                    const parts = [line.command];
                    if (line.x !== undefined) parts.push(`X${line.x}`);
                    if (line.y !== undefined) parts.push(`Y${line.y}`);
                    if (line.z !== undefined) parts.push(`Z${line.z}`);
                    if (line.f !== undefined) parts.push(`F${line.f}`);
                    return (
                        <div key={i} className={`v3d-gp-row ${cls}`}>
                            <span className="v3d-gp-num">{i + 1}</span>
                            <span className="v3d-gp-code">{parts.join(' ')}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}


// ─── Helpers ────────────────────────────────────────────────────────

function applyView(
    v: ViewPreset,
    cam: THREE.PerspectiveCamera,
    ctrl: OrbitControls,
    env: { x: number; y: number; z: number },
) {
    const cx = env.x / 2, cy = env.y / 2, cz = env.z / 2;
    const D = Math.max(env.x, env.y, env.z) * 1.3;
    const positions: Record<ViewPreset, [number, number, number]> = {
        iso:   [cx + D * 0.8, cy - D * 0.8, cz + D * 0.7],
        top:   [cx, cy, cz + D * 1.4],
        front: [cx, cy - D, cz],
        left:  [cx - D, cy, cz],
        right: [cx + D, cy, cz],
    };
    cam.position.set(...positions[v]);
    ctrl.target.set(cx, cy, cz);
    ctrl.update();
}

/** Pick a "nice" tick spacing (1/2/5 × 10^n) that gives roughly 8 ticks
 *  across the given span. */
function niceStep(range: number): number {
    if (range <= 0) return 1;
    const target = range / 8;
    const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
    const residual = target / magnitude;
    if (residual > 5) return 10 * magnitude;
    if (residual > 2) return 5 * magnitude;
    if (residual > 1) return 2 * magnitude;
    return magnitude;
}

/** Small canvas-texture number label, billboarded via THREE.Sprite. Kept
 *  deliberately tiny — this is a ruler tick, not the big floating XYZ text
 *  Tawfiq had removed from the scene (msg 7341). */
function makeTickLabel(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 32, 16);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 40;
    return sprite;
}

/** Ruler overlay along the bed's X (red) and Y (green) edges — numbered
 *  ticks at a "nice" mm interval, mirroring the gSender reference Tawfiq
 *  sent (msg11907/11912). Z is left untickmarked to match that reference. */
function buildScaleGroup(
    envelope: { x: number; y: number; z: number },
    colors: ReturnType<typeof readColors>,
): THREE.Group {
    const group = new THREE.Group();
    const labelSize = Math.max(envelope.x, envelope.y) * 0.022;
    const tickLen = labelSize * 0.5;

    const stepX = niceStep(envelope.x);
    const xTickPts: number[] = [];
    for (let v = 0; v <= envelope.x + 1e-6; v += stepX) {
        const label = makeTickLabel(String(Math.round(v)), colors.xAxis);
        label.position.set(v, -labelSize * 0.9, 0.5);
        label.scale.set(labelSize * 2, labelSize, 1);
        group.add(label);
        xTickPts.push(v, 0, 0, v, -tickLen, 0);
    }
    const xTickGeo = new THREE.BufferGeometry();
    xTickGeo.setAttribute('position', new THREE.Float32BufferAttribute(xTickPts, 3));
    group.add(new THREE.LineSegments(xTickGeo, new THREE.LineBasicMaterial({ color: colors.xAxis })));

    const stepY = niceStep(envelope.y);
    const yTickPts: number[] = [];
    for (let v = stepY; v <= envelope.y + 1e-6; v += stepY) {
        // Skip 0 — the X-axis loop above already labels the shared origin.
        const label = makeTickLabel(String(Math.round(v)), colors.yAxis);
        label.position.set(-labelSize * 1.3, v, 0.5);
        label.scale.set(labelSize * 2, labelSize, 1);
        group.add(label);
        yTickPts.push(0, v, 0, -tickLen, v, 0);
    }
    const yTickGeo = new THREE.BufferGeometry();
    yTickGeo.setAttribute('position', new THREE.Float32BufferAttribute(yTickPts, 3));
    group.add(new THREE.LineSegments(yTickGeo, new THREE.LineBasicMaterial({ color: colors.yAxis })));

    group.renderOrder = 40;
    return group;
}

function fitToBox(
    box: { min: [number, number, number]; max: [number, number, number] },
    cam: THREE.PerspectiveCamera,
    ctrl: OrbitControls,
) {
    const cx = (box.min[0] + box.max[0]) / 2;
    const cy = (box.min[1] + box.max[1]) / 2;
    const cz = (box.min[2] + box.max[2]) / 2;
    const span = Math.max(
        box.max[0] - box.min[0],
        box.max[1] - box.min[1],
        box.max[2] - box.min[2],
        50,
    );
    const D = span * 1.4;
    cam.position.set(cx + D * 0.7, cy - D * 0.7, cz + D * 0.6);
    ctrl.target.set(cx, cy, cz);
    ctrl.update();
}
