import { useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
    Plus, LayoutGrid, Move, RotateCw, Maximize2, Scissors, Palette,
    Box, Video, Crosshair, Grid3x3, Layers
} from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import { calculateBoundingBox } from '../utils/toolpathBuilder';
import './GCodeVisualizer.css';

export default function GCodeVisualizer() {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const toolpathGroupRef = useRef<THREE.Group | null>(null);
    const gridRef = useRef<THREE.GridHelper | null>(null);

    const { toolpathSegments, viewMode3D, showGrid3D, setShowGrid3D } = useCNCStore();

    // Initialize 3D scene
    useEffect(() => {
        if (!mountRef.current) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#1a1a1e');
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(
            75,
            mountRef.current.clientWidth / mountRef.current.clientHeight,
            0.1,
            1000
        );
        camera.position.set(100, 100, 100);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        mountRef.current.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controlsRef.current = controls;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
        directionalLight.position.set(50, 50, 50);
        scene.add(directionalLight);

        // Grid
        const gridHelper = new THREE.GridHelper(600, 300, 0x555555, 0x333333);
        gridHelper.material.opacity = 0.3;
        gridHelper.material.transparent = true;
        gridRef.current = gridHelper;
        if (showGrid3D) scene.add(gridHelper);

        // Axes
        const axes = new THREE.AxesHelper(80);
        scene.add(axes);

        // Scale markers
        const createScaleMarkers = () => {
            const scaleGroup = new THREE.Group();
            const markerInterval = 5;
            const maxDistance = 300;
            const markerHeight = 2;

            const createTextSprite = (text: string, color: string) => {
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                if (!context) return null;
                canvas.width = 128;
                canvas.height = 64;
                context.font = 'Bold 32px Arial';
                context.fillStyle = color;
                context.textAlign = 'center';
                context.fillText(text, 64, 40);
                const texture = new THREE.CanvasTexture(canvas);
                const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
                const sprite = new THREE.Sprite(spriteMaterial);
                sprite.scale.set(8, 4, 1);
                return sprite;
            };

            // X-axis markers
            for (let i = markerInterval; i <= maxDistance; i += markerInterval) {
                const markerGeom = new THREE.BoxGeometry(0.5, markerHeight, 0.5);
                const markerMat = new THREE.MeshBasicMaterial({ color: 0xff4444 });
                const marker = new THREE.Mesh(markerGeom, markerMat);
                marker.position.set(i, 0, 0);
                scaleGroup.add(marker);
                const label = createTextSprite(i.toString(), '#aaaaaa');
                if (label) { label.position.set(i, -2.5, 0); scaleGroup.add(label); }
                const markerNeg = new THREE.Mesh(markerGeom, markerMat);
                markerNeg.position.set(-i, 0, 0);
                scaleGroup.add(markerNeg);
                const labelNeg = createTextSprite((-i).toString(), '#aaaaaa');
                if (labelNeg) { labelNeg.position.set(-i, -2.5, 0); scaleGroup.add(labelNeg); }
            }

            // Y-axis markers
            for (let i = markerInterval; i <= maxDistance; i += markerInterval) {
                const markerGeom = new THREE.BoxGeometry(0.5, 0.5, markerHeight);
                const markerMat = new THREE.MeshBasicMaterial({ color: 0x44ff44 });
                const marker = new THREE.Mesh(markerGeom, markerMat);
                marker.position.set(0, i, 0);
                scaleGroup.add(marker);
                const label = createTextSprite(i.toString(), '#aaaaaa');
                if (label) { label.position.set(-4, i, 0); scaleGroup.add(label); }
            }

            // Z-axis markers
            for (let i = markerInterval; i <= maxDistance; i += markerInterval) {
                const markerGeom = new THREE.BoxGeometry(markerHeight, 0.5, 0.5);
                const markerMat = new THREE.MeshBasicMaterial({ color: 0x4444ff });
                const marker = new THREE.Mesh(markerGeom, markerMat);
                marker.position.set(0, 0, i);
                scaleGroup.add(marker);
                const label = createTextSprite(i.toString(), '#aaaaaa');
                if (label) { label.position.set(0, -2.5, i); scaleGroup.add(label); }
                const markerNeg = new THREE.Mesh(markerGeom, markerMat);
                markerNeg.position.set(0, 0, -i);
                scaleGroup.add(markerNeg);
                const labelNeg = createTextSprite((-i).toString(), '#aaaaaa');
                if (labelNeg) { labelNeg.position.set(0, -2.5, -i); scaleGroup.add(labelNeg); }
            }

            return scaleGroup;
        };

        const scaleMarkers = createScaleMarkers();
        scene.add(scaleMarkers);

        const toolpathGroup = new THREE.Group();
        scene.add(toolpathGroup);
        toolpathGroupRef.current = toolpathGroup;

        const animate = () => {
            requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();

        const handleResize = () => {
            if (!mountRef.current) return;
            camera.aspect = mountRef.current.clientWidth / mountRef.current.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
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
        const scene = sceneRef.current;
        if (!scene || !gridRef.current) return;
        if (showGrid3D && !scene.children.includes(gridRef.current)) {
            scene.add(gridRef.current);
        }
        if (!showGrid3D && scene.children.includes(gridRef.current)) {
            scene.remove(gridRef.current);
        }
    }, [showGrid3D]);

    // Memoize merged geometry for better performance with large toolpaths
    const mergedGeometries = useMemo(() => {
        if (toolpathSegments.length === 0) return null;

        const cutPoints: THREE.Vector3[] = [];
        const rapidPoints: THREE.Vector3[] = [];
        const layerMap = new Map<number, THREE.Vector3[]>();

        for (const segment of toolpathSegments) {
            const start = new THREE.Vector3(segment.start.x, segment.start.z, -segment.start.y);
            const end = new THREE.Vector3(segment.end.x, segment.end.z, -segment.end.y);

            if (segment.rapid) {
                rapidPoints.push(start, end);
            } else if (viewMode3D === 'layers') {
                const layer = segment.layer;
                if (!layerMap.has(layer)) layerMap.set(layer, []);
                layerMap.get(layer)!.push(start, end);
            } else {
                cutPoints.push(start, end);
            }
        }

        return { cutPoints, rapidPoints, layerMap };
    }, [toolpathSegments, viewMode3D]);

    // Update toolpath visualization using merged geometry
    useEffect(() => {
        if (!toolpathGroupRef.current || !mergedGeometries) return;

        // Dispose old children
        while (toolpathGroupRef.current.children.length > 0) {
            const child = toolpathGroupRef.current.children[0];
            toolpathGroupRef.current.remove(child);
            if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else {
                    (child.material as THREE.Material).dispose();
                }
            }
        }

        const { cutPoints, rapidPoints, layerMap } = mergedGeometries;

        // Batch cut segments into a single LineSegments object
        if (cutPoints.length > 0) {
            const geom = new THREE.BufferGeometry().setFromPoints(cutPoints);
            const mat = new THREE.LineBasicMaterial({ color: 0x8db2dc, transparent: true, opacity: 0.95 });
            toolpathGroupRef.current.add(new THREE.LineSegments(geom, mat));
        }

        // Batch rapid segments
        if (rapidPoints.length > 0) {
            const geom = new THREE.BufferGeometry().setFromPoints(rapidPoints);
            const mat = new THREE.LineDashedMaterial({ color: 0xbccf5e, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.6 });
            const lines = new THREE.LineSegments(geom, mat);
            lines.computeLineDistances();
            toolpathGroupRef.current.add(lines);
        }

        // Layer-colored segments
        layerMap.forEach((pts, layer) => {
            if (pts.length === 0) return;
            const hue = (layer * 32) % 360;
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(`hsl(${hue}, 70%, 55%)`) });
            toolpathGroupRef.current!.add(new THREE.LineSegments(geom, mat));
        });

        // Auto-fit camera
        const camera = cameraRef.current;
        const controls = controlsRef.current;

        if (camera && controls && toolpathSegments.length > 0) {
            const bbox = calculateBoundingBox(toolpathSegments);
            const center = new THREE.Vector3(bbox.center.x, bbox.center.z, -bbox.center.y);
            const size = Math.max(bbox.size.x, bbox.size.y, bbox.size.z);
            const fov = (camera.fov * Math.PI) / 180;
            const dist = size > 0 ? size / (2 * Math.tan(fov / 2)) : 120;
            const d = dist * 1.5;
            const dir = new THREE.Vector3(1, 1, 1).normalize();
            camera.position.copy(center.clone().add(dir.multiplyScalar(d)));
            controls.target.copy(center);
            controls.update();
        }
    }, [mergedGeometries, toolpathSegments]);

    return (
        <div className="viewport-wrapper">
            {/* Top Toolbar */}
            <div className="viewport-toolbar">
                <button className="toolbar-btn" title="Add Part"><Plus size={15} /></button>
                <button className="toolbar-btn" title="Auto Layout"><LayoutGrid size={15} /></button>
                <div className="toolbar-divider" />
                <button className="toolbar-btn" title="Move"><Move size={15} /></button>
                <button className="toolbar-btn" title="Rotate"><RotateCw size={15} /></button>
                <button className="toolbar-btn" title="Scale"><Maximize2 size={15} /></button>
                <button className="toolbar-btn" title="Cut"><Scissors size={15} /></button>
                <button className="toolbar-btn" title="Paint"><Palette size={15} /></button>
                <div className="toolbar-divider" />
                <button
                    className={`toolbar-btn ${showGrid3D ? 'active' : ''}`}
                    title="Toggle Grid"
                    onClick={() => setShowGrid3D(!showGrid3D)}
                >
                    <Grid3x3 size={15} />
                </button>
            </div>

            {/* Right Floating Toolbar */}
            <div className="right-toolbar">
                <button className="right-tool-btn" title="3D View"><Box size={15} /></button>
                <button className="right-tool-btn" title="Camera"><Video size={15} /></button>
                <button className="right-tool-btn" title="Center View"><Crosshair size={15} /></button>
            </div>

            {/* 3D Canvas */}
            <div ref={mountRef} className="visualizer-canvas" />

            {/* Empty state */}
            {toolpathSegments.length === 0 && (
                <div className="visualizer-empty">
                    <div className="visualizer-empty-content">
                        <div className="visualizer-empty-icon">
                            <Layers size={24} />
                        </div>
                        <div className="visualizer-empty-text">Load a G-code file to visualize</div>
                        <div className="visualizer-empty-hint">Connect & upload from the sidebar</div>
                    </div>
                </div>
            )}

            {/* Bottom status */}
            {toolpathSegments.length > 0 && (
                <div className="viewport-status">
                    <div className="viewport-status-item">
                        Segments: <span className="viewport-status-val">{toolpathSegments.length}</span>
                    </div>
                    <div className="viewport-status-item">
                        Mode: <span className="viewport-status-val">{viewMode3D}</span>
                    </div>
                </div>
            )}
        </div>
    );
}
