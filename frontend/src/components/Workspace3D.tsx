import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
    Image, Grid3x3, Lock, Target, ZoomIn, ZoomOut, Upload,
    RotateCcw, Eye, Box
} from 'lucide-react';
import type { ViewPreset } from '../types/cnc';
import { useCNCStore } from '../stores/cncStore';
import JobControlBar from './JobControlBar';
import './Workspace3D.css';

// Default Onefinity X-50 travel envelope. Used when activeMachineProfile
// doesn't expose a parseable "WxDxH" workArea string.
const DEFAULT_ENVELOPE_MM = { x: 812, y: 812, z: 130 };

function parseEnvelope(workArea?: string): { x: number; y: number; z: number } {
    if (!workArea) return DEFAULT_ENVELOPE_MM;
    const m = workArea.match(/(\d+)\s*[×x×*]\s*(\d+)\s*[×x×*]\s*(\d+)/i);
    if (!m) return DEFAULT_ENVELOPE_MM;
    return { x: parseInt(m[1], 10), y: parseInt(m[2], 10), z: parseInt(m[3], 10) };
}

export default function Workspace3D() {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const bedRef = useRef<THREE.Mesh | null>(null);
    const gridRef = useRef<THREE.Group | null>(null);
    const toolpathRef = useRef<THREE.LineSegments | null>(null);
    const axisOverlayRef = useRef<THREE.Group | null>(null);
    const guideLinesRef = useRef<THREE.LineSegments | null>(null);
    const envelopeRef = useRef<THREE.LineSegments | null>(null);
    const spindleRef = useRef<THREE.Group | null>(null);

    const [showGrid, setShowGrid] = useState(true);
    const [isLocked, setIsLocked] = useState(false);
    const [showLabels, setShowLabels] = useState(true);
    const [showViewPresets, setShowViewPresets] = useState(false);
    const [showEnvelope, setShowEnvelope] = useState(true);

    const {
        viewPreset, setViewPreset,
        gcode, toolpathSegments, fileInfo, currentLine,
        machinePosition, machineProfiles, activeMachineProfile,
    } = useCNCStore();

    // Resolve current machine envelope (mm). Falls back to Onefinity X-50.
    const envelope = useMemo(() => {
        const profile = machineProfiles.find(p => p.id === activeMachineProfile);
        return parseEnvelope(profile?.workArea);
    }, [machineProfiles, activeMachineProfile]);

    // Derived stats for the overlay panel — total path length, rapid/cut counts,
    // bounding-box extents, estimated wall-clock at conservative 1200 mm/min cut + 6000 mm/min rapid.
    const pathStats = useMemo(() => {
        if (toolpathSegments.length === 0) {
            return { rapidLen: 0, cutLen: 0, totalLen: 0, rapidCount: 0, cutCount: 0,
                     extX: 0, extY: 0, extZ: 0, etaSec: 0,
                     minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
        }
        let rapidLen = 0, cutLen = 0, rapidCount = 0, cutCount = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const s of toolpathSegments) {
            const dx = s.end.x - s.start.x, dy = s.end.y - s.start.y, dz = s.end.z - s.start.z;
            const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (s.rapid) { rapidLen += len; rapidCount++; }
            else         { cutLen   += len; cutCount++;   }
            minX = Math.min(minX, s.start.x, s.end.x); maxX = Math.max(maxX, s.start.x, s.end.x);
            minY = Math.min(minY, s.start.y, s.end.y); maxY = Math.max(maxY, s.start.y, s.end.y);
            minZ = Math.min(minZ, s.start.z, s.end.z); maxZ = Math.max(maxZ, s.start.z, s.end.z);
        }
        // Conservative ETA (no accel model): cuts 1200 mm/min, rapids 6000 mm/min.
        const etaSec = (cutLen / 1200 + rapidLen / 6000) * 60;
        return {
            rapidLen, cutLen, totalLen: rapidLen + cutLen,
            rapidCount, cutCount,
            extX: maxX - minX, extY: maxY - minY, extZ: maxZ - minZ,
            etaSec,
            minX, maxX, minY, maxY, minZ, maxZ,
        };
    }, [toolpathSegments]);


    // ── View Presets: 7 camera angles with smooth 320ms transitions ──
    const VIEW_PRESET_LABELS: Record<ViewPreset, string> = {
        iso: 'ISO', top: 'Top', front: 'Front', right: 'Right',
        bottom: 'Bottom', left: 'Left', back: 'Back',
    };

    const getPresetCamera = useCallback((preset: ViewPreset, dist: number, target: THREE.Vector3) => {
        const d = dist || 150;
        switch (preset) {
            case 'iso':    return new THREE.Vector3(target.x + d * 0.4, target.y + d * 0.7, target.z + d * 0.4);
            case 'top':    return new THREE.Vector3(target.x, target.y + d, target.z);
            case 'front':  return new THREE.Vector3(target.x, target.y, target.z + d);
            case 'right':  return new THREE.Vector3(target.x + d, target.y, target.z);
            case 'bottom': return new THREE.Vector3(target.x, target.y - d, target.z);
            case 'left':   return new THREE.Vector3(target.x - d, target.y, target.z);
            case 'back':   return new THREE.Vector3(target.x, target.y, target.z - d);
            default:       return new THREE.Vector3(target.x + d * 0.4, target.y + d * 0.7, target.z + d * 0.4);
        }
    }, []);

    const animateCameraTo = useCallback((targetPos: THREE.Vector3, duration = 320) => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!camera || !controls) return;

        const startPos = camera.position.clone();
        const startTime = performance.now();

        const animate = (now: number) => {
            const elapsed = now - startTime;
            const t = Math.min(elapsed / duration, 1);
            const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

            camera.position.lerpVectors(startPos, targetPos, ease);
            controls.update();

            if (t < 1) requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }, []);

    const handleViewPreset = useCallback((preset: ViewPreset) => {
        setViewPreset(preset);
        setShowViewPresets(false);

        const camera = cameraRef.current;
        const controls = controlsRef.current;
        if (!camera || !controls) return;

        const target = controls.target.clone();
        const dist = camera.position.distanceTo(target);
        const newPos = getPresetCamera(preset, dist, target);
        animateCameraTo(newPos);
    }, [setViewPreset, getPresetCamera, animateCameraTo]);

    const handleCycleView = useCallback(() => {
        const presets: ViewPreset[] = ['iso', 'top', 'front', 'right', 'bottom', 'left', 'back'];
        const idx = presets.indexOf(viewPreset);
        const next = presets[(idx + 1) % presets.length];
        handleViewPreset(next);
    }, [viewPreset, handleViewPreset]);

    // Initialize 3D scene
    useEffect(() => {
        if (!mountRef.current) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#1a1a1a');
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(
            75,
            mountRef.current.clientWidth / mountRef.current.clientHeight,
            0.1,
            5000
        );
        camera.position.set(80, 120, 80);
        camera.lookAt(0, 0, 0);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        mountRef.current.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.maxPolarAngle = Math.PI / 2.2;
        controls.minDistance = 5;
        controls.maxDistance = 2000;
        controlsRef.current = controls;

        // Lighting – strong enough for solid shaded geometry
        const ambientLight = new THREE.AmbientLight(0x4477aa, 0.5);
        scene.add(ambientLight);

        const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
        keyLight.position.set(150, 200, 100);
        keyLight.castShadow = true;
        keyLight.shadow.camera.left = -300;
        keyLight.shadow.camera.right = 300;
        keyLight.shadow.camera.top = 300;
        keyLight.shadow.camera.bottom = -300;
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0x6699cc, 0.35);
        fillLight.position.set(-100, 80, -80);
        scene.add(fillLight);

        const rimLight = new THREE.DirectionalLight(0x88bbff, 0.25);
        rimLight.position.set(0, 50, -150);
        scene.add(rimLight);

        // Create bed surface – subtle dark plane below the toolpath
        const bedSize = 600;
        const bedGeometry = new THREE.PlaneGeometry(bedSize, bedSize);
        const bedMaterial = new THREE.MeshStandardMaterial({
            color: '#0f1a2a',
            roughness: 0.95,
            metalness: 0.05,
            side: THREE.DoubleSide,
        });
        const bed = new THREE.Mesh(bedGeometry, bedMaterial);
        bed.rotation.x = -Math.PI / 2;
        bed.position.y = -0.5;
        bed.receiveShadow = true;
        bedRef.current = bed;
        scene.add(bed);

        // Grid – subtle lines matching the dark navy background
        const createBedGrid = () => {
            const gridGroup = new THREE.Group();
            const half = bedSize / 2;
            
            const majorGridMaterial = new THREE.LineBasicMaterial({ 
                color: 0x1a2d45, 
                transparent: true, 
                opacity: 0.7 
            });
            const minorGridMaterial = new THREE.LineBasicMaterial({ 
                color: 0x142338, 
                transparent: true, 
                opacity: 0.4 
            });

            for (let i = -half; i <= half; i += 5) {
                const isMajor = i % 10 === 0;
                const material = isMajor ? majorGridMaterial : minorGridMaterial;
                
                const xGeometry = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(-half, -0.4, i),
                    new THREE.Vector3(half, -0.4, i)
                ]);
                gridGroup.add(new THREE.Line(xGeometry, material));
                
                const zGeometry = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(i, -0.4, -half),
                    new THREE.Vector3(i, -0.4, half)
                ]);
                gridGroup.add(new THREE.Line(zGeometry, material));
            }
            
            return gridGroup;
        };

        const bedGrid = createBedGrid();
        gridRef.current = bedGrid;
        if (showGrid) {
            scene.add(bedGrid);
        }

        // Axis overlay (XY on bed plane => X is world X, Y is world Z)
        const createAxisOverlay = () => {
            const group = new THREE.Group();

            const axisLength = 160;
            const tickStep = 10;  // Labels every 10 units
            const tickSizeMinor = 1.2;
            const tickSizeMajor = 2.4;

            const makeTextSprite = (text: string, position: THREE.Vector3, color: string) => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;

                canvas.width = 256;
                canvas.height = 128;

                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.font = 'Bold 44px Arial';
                ctx.fillStyle = color;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
                ctx.shadowBlur = 6;
                ctx.shadowOffsetX = 2;
                ctx.shadowOffsetY = 2;
                ctx.fillText(text, canvas.width / 2, canvas.height / 2);

                const texture = new THREE.CanvasTexture(canvas);
                texture.anisotropy = 4;
                const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.9 });
                const sprite = new THREE.Sprite(material);
                sprite.position.copy(position);
                sprite.scale.set(10, 5, 1);
                return sprite;
            };

            // Dashed X axis (red)
            const xAxisGeom = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(-axisLength, 1.05, 0),
                new THREE.Vector3(axisLength, 1.05, 0),
            ]);
            const xAxisMat = new THREE.LineDashedMaterial({
                color: 0xff4040,
                dashSize: 4,
                gapSize: 3,
                transparent: true,
                opacity: 0.9,
            });
            const xAxis = new THREE.Line(xAxisGeom, xAxisMat);
            xAxis.computeLineDistances();
            group.add(xAxis);

            // Dashed Y axis on bed plane (green) => world Z
            const yAxisGeom = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 1.05, -axisLength),
                new THREE.Vector3(0, 1.05, axisLength),
            ]);
            const yAxisMat = new THREE.LineDashedMaterial({
                color: 0x34d399,
                dashSize: 4,
                gapSize: 3,
                transparent: true,
                opacity: 0.9,
            });
            const yAxis = new THREE.Line(yAxisGeom, yAxisMat);
            yAxis.computeLineDistances();
            group.add(yAxis);

            // Ticks + numeric labels (every 10 units)
            const ticks: THREE.Vector3[] = [];
            for (let v = -axisLength; v <= axisLength; v += tickStep) {
                const isLabeled = v % 10 === 0;  // Label at 0, ±10, ±20, ±30, ...
                const t = isLabeled ? tickSizeMajor : tickSizeMinor;

                // X ticks (perpendicular along Z)
                ticks.push(new THREE.Vector3(v, 1.05, -t), new THREE.Vector3(v, 1.05, t));
                // Y ticks (perpendicular along X)
                ticks.push(new THREE.Vector3(-t, 1.05, v), new THREE.Vector3(t, 1.05, v));

                if (isLabeled && v !== 0) {
                    const xLabel = makeTextSprite(`${v}`, new THREE.Vector3(v, 1.2, 6), '#ff4040');
                    if (xLabel) group.add(xLabel);

                    const yLabel = makeTextSprite(`${v}`, new THREE.Vector3(6, 1.2, v), '#34d399');
                    if (yLabel) group.add(yLabel);
                }
            }

            const tickGeom = new THREE.BufferGeometry().setFromPoints(ticks);
            const tickMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });
            const tickLines = new THREE.LineSegments(tickGeom, tickMat);
            group.add(tickLines);

            // Axis letters near origin (match screenshot feel)
            const zLabel = makeTextSprite('Z', new THREE.Vector3(-8, 1.2, -8), 'rgba(255,255,255,0.65)');
            if (zLabel) group.add(zLabel);

            return group;
        };

        const axisOverlay = createAxisOverlay();
        axisOverlayRef.current = axisOverlay;
        scene.add(axisOverlay);

        // Small origin crosshair (no obstructive text)
        const originSize = 2;
        const originMat = new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.5 });
        const oX = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-originSize, 0.05, 0), new THREE.Vector3(originSize, 0.05, 0)]);
        const oZ = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.05, -originSize), new THREE.Vector3(0, 0.05, originSize)]);
        scene.add(new THREE.Line(oX, originMat));
        scene.add(new THREE.Line(oZ, originMat));

        // ── Live spindle marker — cylinder body + cone bit, tracks machinePosition ──
        const spindleGroup = new THREE.Group();
        spindleGroup.name = 'spindleMarker';
        {
            const bodyMat = new THREE.MeshStandardMaterial({
                color: 0xffaa55, roughness: 0.4, metalness: 0.3,
                transparent: true, opacity: 0.85,
            });
            const tipMat = new THREE.MeshStandardMaterial({
                color: 0xff6622, roughness: 0.3, metalness: 0.5,
                emissive: 0x441100, emissiveIntensity: 0.4,
            });
            const body = new THREE.Mesh(
                new THREE.CylinderGeometry(4, 4, 24, 16, 1),
                bodyMat,
            );
            body.position.y = 18; // sits above bit tip
            spindleGroup.add(body);
            const collar = new THREE.Mesh(
                new THREE.CylinderGeometry(5.5, 5.5, 3, 16, 1),
                new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 }),
            );
            collar.position.y = 6;
            spindleGroup.add(collar);
            const bit = new THREE.Mesh(
                new THREE.ConeGeometry(1.4, 8, 12, 1),
                tipMat,
            );
            // Cone tip should point DOWN (toward bed at y=0). Cone defaults pointing +Y.
            bit.rotation.x = Math.PI; // flip
            bit.position.y = 4; // base of cone at y=8, tip at y=0
            spindleGroup.add(bit);
            // Small glow disc at the bit tip — makes it pop in dark backgrounds.
            const glow = new THREE.Mesh(
                new THREE.RingGeometry(0.5, 3, 24),
                new THREE.MeshBasicMaterial({
                    color: 0xff7733, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
                }),
            );
            glow.rotation.x = -Math.PI / 2;
            glow.position.y = 0.02;
            spindleGroup.add(glow);
        }
        spindleGroup.visible = false; // shown only once machinePosition has a real value
        spindleRef.current = spindleGroup;
        scene.add(spindleGroup);

        // Animation loop
        const animate = () => {
            requestAnimationFrame(animate);
            
            if (controlsRef.current && !isLocked) {
                controlsRef.current.update();
            }
            
            if (rendererRef.current && sceneRef.current && cameraRef.current) {
                rendererRef.current.render(sceneRef.current, cameraRef.current);
            }
        };
        
        animate();

        // Handle window resize
        const handleResize = () => {
            if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
            
            const width = mountRef.current.clientWidth;
            const height = mountRef.current.clientHeight;
            
            cameraRef.current.aspect = width / height;
            cameraRef.current.updateProjectionMatrix();
            rendererRef.current.setSize(width, height);
        };
        
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (mountRef.current && renderer.domElement) {
                mountRef.current.removeChild(renderer.domElement);
            }
            renderer.dispose();
        };
    }, []);

    // Update grid visibility
    useEffect(() => {
        if (gridRef.current && sceneRef.current) {
            if (showGrid) {
                sceneRef.current.add(gridRef.current);
            } else {
                sceneRef.current.remove(gridRef.current);
            }
        }
    }, [showGrid]);

    // ── Live spindle marker — moves with machinePosition at every store update ──
    // World mapping: G-code X→world X, Y→-world Z, Z→world Y.
    useEffect(() => {
        const grp = spindleRef.current;
        if (!grp) return;
        const { x, y, z } = machinePosition;
        // Hide while machinePosition is still 0/0/0 (means: no live data yet).
        const hasReal = !(x === 0 && y === 0 && z === 0);
        grp.visible = hasReal;
        grp.position.set(x, z, -y);
    }, [machinePosition]);

    // ── Machine envelope wireframe — translucent box showing travel limits ──
    // Onefinity homes at the max corner with all axes going negative; we draw
    // the box from [-envX, -envZ, -envY] to [0, 0, 0] in world coords (G-code
    // X→world X, Y→-world Z, Z→world Y).
    useEffect(() => {
        if (!sceneRef.current) return;
        // Tear down previous
        if (envelopeRef.current) {
            sceneRef.current.remove(envelopeRef.current);
            envelopeRef.current.geometry.dispose();
            if (envelopeRef.current.material instanceof THREE.Material) envelopeRef.current.material.dispose();
            envelopeRef.current = null;
        }
        if (!showEnvelope) return;

        const eX = envelope.x;
        const eY = envelope.y;
        const eZ = envelope.z;
        // Onefinity-style home: max-corner, all travel into negative G-code coords.
        // World mapping: G-code X→world X, Y→-world Z, Z→world Y. So envelope spans:
        //   world X: 0 to -eX, world Y: 0 to -eZ, world Z: 0 to +eY.
        const c = [
            new THREE.Vector3(  0,   0,   0),
            new THREE.Vector3(-eX,   0,   0),
            new THREE.Vector3(  0,   0,  eY),
            new THREE.Vector3(-eX,   0,  eY),
            new THREE.Vector3(  0, -eZ,   0),
            new THREE.Vector3(-eX, -eZ,   0),
            new THREE.Vector3(  0, -eZ,  eY),
            new THREE.Vector3(-eX, -eZ,  eY),
        ];
        // 12 edges of a cuboid
        const edges: [number, number][] = [
            [0,1],[2,3],[4,5],[6,7],
            [0,2],[1,3],[4,6],[5,7],
            [0,4],[1,5],[2,6],[3,7],
        ];
        const pts: THREE.Vector3[] = [];
        edges.forEach(([a, b]) => { pts.push(c[a], c[b]); });
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineDashedMaterial({
            color: 0x77ccff,
            dashSize: 3,
            gapSize: 2,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
        });
        const lines = new THREE.LineSegments(geom, mat);
        lines.computeLineDistances();
        envelopeRef.current = lines;
        sceneRef.current.add(lines);
    }, [showEnvelope, envelope]);

    // Update G-code visualization
    useEffect(() => {
        if (toolpathSegments.length > 0 && sceneRef.current) {
            // Remove existing toolpath
            if (toolpathRef.current) {
                const obj = toolpathRef.current as any;
                sceneRef.current.remove(obj);
                // Handle Group (meshes) vs LineSegments
                if (obj.geometry) {
                    obj.geometry.dispose();
                    if (obj.material?.dispose) obj.material.dispose();
                } else if (obj.children?.length > 0) {
                    obj.traverse((child: any) => {
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) {
                            if (Array.isArray(child.material)) child.material.forEach((m: any) => m.dispose?.());
                            else child.material.dispose?.();
                        }
                    });
                }
                toolpathRef.current = null;
            }

            // Remove existing guide line
            if (guideLinesRef.current) {
                sceneRef.current.remove(guideLinesRef.current);
                guideLinesRef.current.geometry.dispose();
                if (guideLinesRef.current.material instanceof THREE.Material) {
                    guideLinesRef.current.material.dispose();
                }
                guideLinesRef.current = null;
            }

            const cutSegments = toolpathSegments.filter(s => !s.rapid);
            const toolpathGroup = new THREE.Group();

            // ── Compute true XYZ bounds across ALL segments (cuts + rapids) ──
            let bMinX = Infinity, bMaxX = -Infinity;
            let bMinY = Infinity, bMaxY = -Infinity;
            let bMinZ = Infinity, bMaxZ = -Infinity;
            toolpathSegments.forEach(s => {
                bMinX = Math.min(bMinX, s.start.x, s.end.x);
                bMaxX = Math.max(bMaxX, s.start.x, s.end.x);
                bMinY = Math.min(bMinY, s.start.y, s.end.y);
                bMaxY = Math.max(bMaxY, s.start.y, s.end.y);
                bMinZ = Math.min(bMinZ, s.start.z, s.end.z);
                bMaxZ = Math.max(bMaxZ, s.start.z, s.end.z);
            });
            if (!isFinite(bMinX)) { bMinX = 0; bMaxX = 10; bMinY = 0; bMaxY = 10; bMinZ = 0; bMaxZ = 0; }

            const spanX = bMaxX - bMinX;
            const spanY = bMaxY - bMinY;
            const maxSpan = Math.max(spanX, spanY, 1);

            // ── Tube radius (thinner = cleaner). Used for both cut tubes and chains. ──
            const tubeRadius = maxSpan * 0.002;

            // ── Z-depth gradient ──
            // Higher Z (closer to stock top) renders brighter. Lower Z (deeper cut) renders darker.
            // Brightness is a 0.45..1.0 multiplier on a base green color.
            const zMin = bMinZ;
            const zMax = bMaxZ;
            const zRange = (zMax - zMin) || 1;
            const cutBaseR = 0.20, cutBaseG = 0.85, cutBaseB = 0.40;
            const depthBrightness = (worldY: number): number => {
                // worldY corresponds to G-code Z (height). Normalize 0..1.
                const t = (worldY - zMin) / zRange;
                return 0.45 + Math.max(0, Math.min(1, t)) * 0.55;
            };
            const chainColor = (avgWorldY: number) => {
                const b = depthBrightness(avgWorldY);
                return new THREE.Color(cutBaseR * b, cutBaseG * b, cutBaseB * b);
            };

            // Build tubes for CUT segments — group consecutive moves into polylines,
            // each chain gets its own material so Z-depth gradient applies per chain.
            const buildTubes = () => {
                const chains: THREE.Vector3[][] = [];
                let currentChain: THREE.Vector3[] = [];
                const continuityTol = maxSpan * 0.001;

                cutSegments.forEach((seg) => {
                    const startPt = new THREE.Vector3(seg.start.x, seg.start.z, -seg.start.y);
                    const endPt = new THREE.Vector3(seg.end.x, seg.end.z, -seg.end.y);
                    if (currentChain.length === 0) {
                        currentChain.push(startPt, endPt);
                    } else {
                        const lastPt = currentChain[currentChain.length - 1];
                        if (lastPt.distanceTo(startPt) < continuityTol) {
                            currentChain.push(endPt);
                        } else {
                            if (currentChain.length >= 2) chains.push(currentChain);
                            currentChain = [startPt, endPt];
                        }
                    }
                });
                if (currentChain.length >= 2) chains.push(currentChain);

                chains.forEach(pts => {
                    if (pts.length < 2) return;
                    const avgY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                    const mat = new THREE.MeshStandardMaterial({
                        color: chainColor(avgY),
                        roughness: 0.35,
                        metalness: 0.10,
                        side: THREE.DoubleSide,
                    });
                    if (pts.length === 2) {
                        const dir = new THREE.Vector3().subVectors(pts[1], pts[0]);
                        const len = dir.length();
                        if (len < 0.001) return;
                        const cyl = new THREE.CylinderGeometry(tubeRadius, tubeRadius, len, 6, 1);
                        const mesh = new THREE.Mesh(cyl, mat);
                        mesh.position.copy(pts[0]).add(dir.clone().multiplyScalar(0.5));
                        mesh.quaternion.setFromUnitVectors(
                            new THREE.Vector3(0, 1, 0),
                            dir.clone().normalize()
                        );
                        toolpathGroup.add(mesh);
                        return;
                    }
                    try {
                        const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.1);
                        const tubeSegs = Math.max(pts.length * 3, 12);
                        const tubeGeom = new THREE.TubeGeometry(curve, tubeSegs, tubeRadius, 6, false);
                        toolpathGroup.add(new THREE.Mesh(tubeGeom, mat));
                    } catch {
                        for (let j = 0; j < pts.length - 1; j++) {
                            const dir = new THREE.Vector3().subVectors(pts[j + 1], pts[j]);
                            const len = dir.length();
                            if (len < 0.001) continue;
                            const cyl = new THREE.CylinderGeometry(tubeRadius, tubeRadius, len, 6, 1);
                            const mesh = new THREE.Mesh(cyl, mat);
                            mesh.position.copy(pts[j]).add(dir.clone().multiplyScalar(0.5));
                            mesh.quaternion.setFromUnitVectors(
                                new THREE.Vector3(0, 1, 0),
                                dir.clone().normalize()
                            );
                            toolpathGroup.add(mesh);
                        }
                    }
                });
            };

            buildTubes();

            // ── Rapids (travel moves) — dim blue dashed line, behind cuts ──
            const rapidSegments = toolpathSegments.filter(s => s.rapid);
            if (rapidSegments.length > 0) {
                const rapidPoints: THREE.Vector3[] = [];
                rapidSegments.forEach(seg => {
                    rapidPoints.push(
                        new THREE.Vector3(seg.start.x, seg.start.z, -seg.start.y),
                        new THREE.Vector3(seg.end.x, seg.end.z, -seg.end.y)
                    );
                });
                const rapidGeom = new THREE.BufferGeometry().setFromPoints(rapidPoints);
                const rapidMat = new THREE.LineDashedMaterial({
                    color: 0x4a7fff,         // dim blue
                    dashSize: 2,
                    gapSize: 4,
                    transparent: true,
                    opacity: 0.35,
                });
                const rapidLines = new THREE.LineSegments(rapidGeom, rapidMat);
                rapidLines.computeLineDistances();
                toolpathGroup.add(rapidLines);
            }

            if (toolpathGroup.children.length > 0) {
                toolpathRef.current = toolpathGroup as any;
                sceneRef.current.add(toolpathGroup);

                // ── Auto-fit camera to true XYZ bounding box with 10% margin ──
                // World mapping: G-code X→world X, Y→-world Z, Z→world Y.
                if (cameraRef.current && controlsRef.current) {
                    const margin = 1.10;
                    // Include origin so the X/Y axis indicators stay in view.
                    const wMinX = Math.min(bMinX, 0);
                    const wMaxX = Math.max(bMaxX, 0);
                    const wMinZ = Math.min(-bMaxY, 0);    // -Y becomes world Z (negated)
                    const wMaxZ = Math.max(-bMinY, 0);
                    const wMinY = Math.min(bMinZ, 0);     // Z becomes world Y
                    const wMaxY = Math.max(bMaxZ, 5);     // ensure non-zero vertical span

                    const spanX = (wMaxX - wMinX) * margin;
                    const spanY = (wMaxY - wMinY) * margin;
                    const spanZ = (wMaxZ - wMinZ) * margin;
                    const span = Math.max(spanX, spanY, spanZ, 10);

                    const fov = cameraRef.current.fov * (Math.PI / 180);
                    const aspect = cameraRef.current.aspect || 1;
                    // Use the smaller of horizontal/vertical FOV to ensure full fit.
                    const vFov = fov;
                    const hFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
                    const distV = (span / (2 * Math.tan(vFov / 2))) * 1.15;
                    const distH = (span / (2 * Math.tan(hFov / 2))) * 1.15;
                    const dist = Math.max(distV, distH);

                    const cx = (wMinX + wMaxX) / 2;
                    const cy = (wMinY + wMaxY) / 2;
                    const cz = (wMinZ + wMaxZ) / 2;

                    controlsRef.current.target.set(cx, cy, cz);
                    cameraRef.current.position.set(
                        cx + dist * 0.45,
                        cy + dist * 0.75,
                        cz + dist * 0.45
                    );
                    cameraRef.current.near = Math.max(0.1, dist * 0.001);
                    cameraRef.current.far = dist * 10;
                    cameraRef.current.updateProjectionMatrix();
                    controlsRef.current.update();
                }
            }
        }
    }, [toolpathSegments]);


    const handleResetView = () => {
        if (cameraRef.current && controlsRef.current) {
            cameraRef.current.position.set(80, 120, 80);
            cameraRef.current.lookAt(0, 0, 0);
            controlsRef.current.target.set(0, 0, 0);
            controlsRef.current.update();
        }
    };

    const handleZoomIn = () => {
        if (cameraRef.current && controlsRef.current) {
            const distance = cameraRef.current.position.distanceTo(controlsRef.current.target);
            const newDistance = Math.max(5, distance * 0.8);
            const direction = cameraRef.current.position.clone().sub(controlsRef.current.target).normalize();
            cameraRef.current.position.copy(controlsRef.current.target).add(direction.multiplyScalar(newDistance));
            controlsRef.current.update();
        }
    };

    const handleZoomOut = () => {
        if (cameraRef.current && controlsRef.current) {
            const distance = cameraRef.current.position.distanceTo(controlsRef.current.target);
            const newDistance = Math.min(2000, distance * 1.2);
            const direction = cameraRef.current.position.clone().sub(controlsRef.current.target).normalize();
            cameraRef.current.position.copy(controlsRef.current.target).add(direction.multiplyScalar(newDistance));
            controlsRef.current.update();
        }
    };

    return (
        <div className="workspace-3d">
            <div 
                className="workspace-viewport"
                ref={mountRef}
            >


                {/* No file message */}
                {gcode.length === 0 && (
                    <div className="no-file-message">
                        <Upload size={48} />
                        <span>Load G-code from FILE MANAGEMENT sidebar</span>
                    </div>
                )}
                
                {/* Top-right control panel */}
                <div className="workspace-controls">
                    <button 
                        className="control-btn"
                        onClick={() => setShowLabels(!showLabels)}
                        title="Toggle Labels"
                    >
                        <Image size={16} />
                    </button>
                    <button 
                        className={`control-btn ${showGrid ? 'active' : ''}`}
                        onClick={() => setShowGrid(!showGrid)}
                        title="Toggle Grid"
                    >
                        <Grid3x3 size={16} />
                    </button>
                    <button
                        className={`control-btn ${showEnvelope ? 'active' : ''}`}
                        onClick={() => setShowEnvelope(!showEnvelope)}
                        title="Toggle Machine Envelope"
                    >
                        <Box size={16} />
                    </button>
                    <button
                        className={`control-btn ${isLocked ? 'active' : ''}`}
                        onClick={() => setIsLocked(!isLocked)}
                        title="Lock Camera"
                    >
                        <Lock size={16} />
                    </button>
                    <button 
                        className="control-btn"
                        onClick={handleResetView}
                        title="Reset View"
                    >
                        <Target size={16} />
                    </button>
                    <button 
                        className="control-btn"
                        onClick={handleZoomIn}
                        title="Zoom In"
                    >
                        <ZoomIn size={16} />
                    </button>
                    <button 
                        className="control-btn"
                        onClick={handleZoomOut}
                        title="Zoom Out"
                    >
                        <ZoomOut size={16} />
                    </button>
                    <div className="control-divider" />
                    <button
                        className="control-btn"
                        onClick={handleCycleView}
                        title={`Cycle View (${VIEW_PRESET_LABELS[viewPreset]})`}
                    >
                        <RotateCcw size={16} />
                    </button>
                    <button
                        className={`control-btn ${showViewPresets ? 'active' : ''}`}
                        onClick={() => setShowViewPresets(!showViewPresets)}
                        title="View Presets"
                    >
                        <Eye size={16} />
                    </button>
                </div>

                {/* View Presets Panel */}
                {showViewPresets && (
                    <div className="view-presets-panel">
                        {(Object.keys(VIEW_PRESET_LABELS) as ViewPreset[]).map(preset => (
                            <button
                                key={preset}
                                className={`view-preset-btn ${viewPreset === preset ? 'active' : ''}`}
                                onClick={() => handleViewPreset(preset)}
                            >
                                {VIEW_PRESET_LABELS[preset]}
                            </button>
                        ))}
                    </div>
                )}

                {/* Job Control Bar - positioned above info panel */}
                <JobControlBar />

                {/* Bottom info panel */}
                <div className="workspace-info">
                    <div className="info-section">
                        <span className="info-label">Position:</span>
                        <span className="info-value">
                            X: {machinePosition.x.toFixed(1)}  Y: {machinePosition.y.toFixed(1)}  Z: {machinePosition.z.toFixed(1)}
                        </span>
                    </div>
                    {gcode.length > 0 && (
                        <>
                            <div className="info-section">
                                <span className="info-label">Lines:</span>
                                <span className="info-value">{gcode.length}</span>
                            </div>
                            <div className="info-section">
                                <span className="info-label">Current:</span>
                                <span className="info-value">{currentLine}</span>
                            </div>
                            <div className="info-section">
                                <span className="info-label">Progress:</span>
                                <span className="info-value">
                                    {gcode.length > 0 ? Math.round((currentLine / gcode.length) * 100) : 0}%
                                </span>
                            </div>
                        </>
                    )}
                </div>

                {/* Toolpath stats overlay — top-left, only when a file is loaded */}
                {toolpathSegments.length > 0 && (
                    <div className="workspace-stats">
                        <div className="stats-title">Toolpath</div>
                        <div className="stats-row">
                            <span className="stats-label">Extents</span>
                            <span className="stats-value">
                                {pathStats.extX.toFixed(1)} × {pathStats.extY.toFixed(1)} × {pathStats.extZ.toFixed(1)} mm
                            </span>
                        </div>
                        <div className="stats-row">
                            <span className="stats-label">Z range</span>
                            <span className="stats-value">
                                {pathStats.minZ.toFixed(1)} → {pathStats.maxZ.toFixed(1)} mm
                            </span>
                        </div>
                        <div className="stats-row">
                            <span className="stats-label">Cuts / Rapids</span>
                            <span className="stats-value">
                                {pathStats.cutCount} / {pathStats.rapidCount}
                            </span>
                        </div>
                        <div className="stats-row">
                            <span className="stats-label">Path length</span>
                            <span className="stats-value">{pathStats.totalLen.toFixed(0)} mm</span>
                        </div>
                        <div className="stats-row">
                            <span className="stats-label">Est. time</span>
                            <span className="stats-value">
                                {pathStats.etaSec >= 3600
                                    ? `${(pathStats.etaSec / 3600).toFixed(1)} h`
                                    : pathStats.etaSec >= 60
                                        ? `${(pathStats.etaSec / 60).toFixed(0)} min`
                                        : `${pathStats.etaSec.toFixed(0)} s`}
                            </span>
                        </div>
                        <div className="stats-row stats-envelope">
                            <span className="stats-label">Envelope</span>
                            <span className="stats-value">
                                {envelope.x} × {envelope.y} × {envelope.z} mm
                            </span>
                        </div>
                    </div>
                )}

                {/* File management panel */}
                {fileInfo && (
                    <div className="file-management">
                        <div className="file-info">
                            <div className="file-name">{fileInfo.name}</div>
                            <div className="file-details">
                                {fileInfo.lines} lines • {(fileInfo.size / 1024).toFixed(2)} KB
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
