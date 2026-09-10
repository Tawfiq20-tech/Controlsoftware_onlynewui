import * as THREE from 'three';
import type { ParsedToolpath } from './gcodeParser';

/**
 * Enhanced Color Template:
 * Authentic Natural Wood & CNC Milling Palette
 */
export const CNC_PALETTE = {
    stock:     new THREE.Color('#C99A62'),
    highlight: new THREE.Color('#E8C496'),
    shadow:    new THREE.Color('#8B5A2B'),
    milled:    new THREE.Color('#DDB88C'),
    toolpath:  '#F28C28',
};

/**
 * Creates high-resolution, photorealistic procedural wood grain canvas textures.
 * 512x512 with multi-octave wood grain fibers, growth rings, organic knots, and micro-bump.
 */
function createWoodTextures(): { diffuse: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
    const size = 512;
    const canvasDiffuse = document.createElement('canvas');
    canvasDiffuse.width = size;
    canvasDiffuse.height = size;
    const ctxD = canvasDiffuse.getContext('2d')!;

    const canvasBump = document.createElement('canvas');
    canvasBump.width = size;
    canvasBump.height = size;
    const ctxB = canvasBump.getContext('2d')!;

    const imgDataD = ctxD.createImageData(size, size);
    const imgDataB = ctxB.createImageData(size, size);
    const dataD = imgDataD.data;
    const dataB = imgDataB.data;

    const hash = (x: number, y: number) => {
        const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return h - Math.floor(h);
    };

    const noise = (x: number, y: number) => {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const fx = x - ix;
        const fy = y - iy;
        const ux = fx * fx * (3.0 - 2.0 * fx);
        const uy = fy * fy * (3.0 - 2.0 * fy);

        return (
            hash(ix, iy) * (1 - ux) * (1 - uy) +
            hash(ix + 1, iy) * ux * (1 - uy) +
            hash(ix, iy + 1) * (1 - ux) * uy +
            hash(ix + 1, iy + 1) * ux * uy
        );
    };

    const fbm = (x: number, y: number) => {
        let v = 0.0;
        let a = 0.5;
        let shift = 100.0;
        for (let i = 0; i < 4; ++i) {
            v += a * noise(x, y);
            x = x * 2.0 + shift;
            y = y * 2.0 + shift;
            a *= 0.5;
        }
        return v;
    };

    // Authentic Golden-Amber Oak / Honey Timber Tones (matching reference image)
    const colShadow = { r: 184, g: 121, b: 59 };   // Warm caramel grain #B8793B
    const colStock  = { r: 218, g: 156, b: 86 };   // Warm golden honey oak #DA9C56
    const colLight  = { r: 238, g: 185, b: 120 };  // Light amber highlight #EEB978

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;

            // Staggered parquet / butcher-block plank strips (matching reference image)
            const plankWidth = 48;
            const plankId = Math.floor(x / plankWidth);
            const plankShiftY = hash(plankId, 17) * 220;
            const plankTint = 1.0 + (hash(plankId, 43) - 0.5) * 0.08;

            const nx = (x + plankId * 2.5) * 0.022;
            const ny = (y + plankShiftY) * 0.006;

            // Wood ring distortion and organic flow
            const warp = fbm(nx * 1.5, ny * 2.0) * 1.8;
            const ringPos = (x * 0.028 + warp * 2.0);
            const ring = Math.sin(ringPos) * 0.5 + 0.5;
            const ringSharp = Math.pow(ring, 1.35);

            // Fine longitudinal wood fiber lines
            const fiber = noise(nx * 16.0, ny * 1.6) * 0.22;
            const microFiber = noise(x * 0.28, (y + plankShiftY) * 0.06) * 0.07;
            const t = Math.max(0, Math.min(1, ringSharp * 0.60 + fiber + microFiber));

            let r: number, g: number, b: number;
            if (t < 0.45) {
                const k = t / 0.45;
                r = (colShadow.r * (1 - k) + colStock.r * k) * plankTint;
                g = (colShadow.g * (1 - k) + colStock.g * k) * plankTint;
                b = (colShadow.b * (1 - k) + colStock.b * k) * plankTint;
            } else {
                const k = (t - 0.45) / 0.55;
                r = (colStock.r * (1 - k) + colLight.r * k) * plankTint;
                g = (colStock.g * (1 - k) + colLight.g * k) * plankTint;
                b = (colStock.b * (1 - k) + colLight.b * k) * plankTint;
            }

            dataD[idx]     = Math.min(255, Math.max(0, Math.round(r)));
            dataD[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
            dataD[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
            dataD[idx + 3] = 255;

            // Tactile bump mapping
            const bump = Math.round((1 - t) * 170 + microFiber * 40);
            dataB[idx]     = bump;
            dataB[idx + 1] = bump;
            dataB[idx + 2] = bump;
            dataB[idx + 3] = 255;
        }
    }

    ctxD.putImageData(imgDataD, 0, 0);
    ctxB.putImageData(imgDataB, 0, 0);

    const diffuse = new THREE.CanvasTexture(canvasDiffuse);
    diffuse.wrapS = THREE.RepeatWrapping;
    diffuse.wrapT = THREE.RepeatWrapping;
    diffuse.repeat.set(2.0, 2.0);
    diffuse.generateMipmaps = true;
    diffuse.minFilter = THREE.LinearMipmapLinearFilter;

    const bump = new THREE.CanvasTexture(canvasBump);
    bump.wrapS = THREE.RepeatWrapping;
    bump.wrapT = THREE.RepeatWrapping;
    bump.repeat.set(2.0, 2.0);
    bump.generateMipmaps = true;
    bump.minFilter = THREE.LinearMipmapLinearFilter;

    return { diffuse, bump };
}

let cachedTextures: { diffuse: THREE.CanvasTexture; bump: THREE.CanvasTexture } | null = null;
function getWoodTextures() {
    if (!cachedTextures) {
        cachedTextures = createWoodTextures();
    }
    return cachedTextures;
}

export interface RealisticWorkpieceResult {
    meshGroup: THREE.Group;
    lightsGroup: THREE.Group;
}

/**
 * Builds a smooth, photorealistic 3D carved wood relief stock mesh.
 * - Sub-pixel continuous distance line/arc carving eliminating staircase aliasing on circles & diagonals.
 * - 256x256 high-resolution heightfield for razor-clean pocket walls without staircasing.
 * - Natural freshly-cut wood interior pocket shading (eliminates harsh orange clamping).
 * - Multi-light studio setup with warm key light, cool fill, and subtle rim highlights.
 */
export function createRealisticWorkpiece(parsed: ParsedToolpath): RealisticWorkpieceResult {
    const meshGroup = new THREE.Group();
    const lightsGroup = new THREE.Group();

    const { min, max } = parsed.bbox;
    const spanX = Math.max(1, max[0] - min[0]);
    const spanY = Math.max(1, max[1] - min[1]);
    const spanZ = Math.max(0.1, max[2] - min[2]);

    // Stock dimensions with 4% padding
    const padX = Math.max(spanX * 0.04, 5.0);
    const padY = Math.max(spanY * 0.04, 5.0);
    const stockMinX = min[0] - padX;
    const stockMaxX = max[0] + padX;
    const stockMinY = min[1] - padY;
    const stockMaxY = max[1] + padY;
    const stockWidth = stockMaxX - stockMinX;
    const stockHeight = stockMaxY - stockMinY;

    const stockTopZ = Math.max(0, max[2]);
    const stockDepth = Math.max(spanZ * 1.5, 12.0);
    const stockBottomZ = stockTopZ - stockDepth;

    // High resolution grid (240-256): ensures smooth, circular pocket walls without jagged edges
    const maxDim = Math.max(stockWidth, stockHeight);
    const maxGrid = 256;
    const gridResX = Math.max(120, Math.min(maxGrid, Math.round((stockWidth / maxDim) * maxGrid)));
    const gridResY = Math.max(120, Math.min(maxGrid, Math.round((stockHeight / maxDim) * maxGrid)));

    const heightGrid = new Float32Array(gridResX * gridResY);
    heightGrid.fill(stockTopZ);

    const cellW = stockWidth / (gridResX - 1);
    const cellH = stockHeight / (gridResY - 1);
    const invCellW = 1 / cellW;
    const invCellH = 1 / cellH;

    // Continuous sub-pixel carving tool radius
    const toolRadius = Math.max(Math.min(cellW, cellH) * 1.15, Math.min(2.5, spanX * 0.012));
    const toolRadiusSq = toolRadius * toolRadius;

    /**
     * Continuous sub-pixel orthogonal line segment distance carving.
     * Evaluates true Euclidean distance from grid nodes to segment (x0,y0)->(x1,y1).
     * Completely eliminates staircase jaggedness on circles and curves.
     */
    const carveContinuousSegment = (
        x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number
    ) => {
        const segDx = x1 - x0;
        const segDy = y1 - y0;
        const segLenSq = segDx * segDx + segDy * segDy;

        // Bounding box in grid space
        const minX = Math.min(x0, x1) - toolRadius;
        const maxX = Math.max(x0, x1) + toolRadius;
        const minY = Math.min(y0, y1) - toolRadius;
        const maxY = Math.max(y0, y1) + toolRadius;

        const gx0 = Math.max(0, Math.floor((minX - stockMinX) * invCellW));
        const gx1 = Math.min(gridResX - 1, Math.ceil((maxX - stockMinX) * invCellW));
        const gy0 = Math.max(0, Math.floor((minY - stockMinY) * invCellH));
        const gy1 = Math.min(gridResY - 1, Math.ceil((maxY - stockMinY) * invCellH));

        if (gx0 > gx1 || gy0 > gy1) return;

        for (let gy = gy0; gy <= gy1; gy++) {
            const cy = stockMinY + gy * cellH;
            const rowOffset = gy * gridResX;

            for (let gx = gx0; gx <= gx1; gx++) {
                const cx = stockMinX + gx * cellW;

                // Orthogonal projection along segment
                let t = 0;
                if (segLenSq > 1e-6) {
                    t = Math.max(0, Math.min(1, ((cx - x0) * segDx + (cy - y0) * segDy) / segLenSq));
                }
                const projX = x0 + t * segDx;
                const projY = y0 + t * segDy;
                const distSq = (cx - projX) * (cx - projX) + (cy - projY) * (cy - projY);

                if (distSq < toolRadiusSq) {
                    const rNorm = Math.sqrt(distSq) / toolRadius;
                    // Flat-end/bullnose tool profile with slight corner radius for realistic milling
                    const toolProfile = (1.0 - Math.sqrt(Math.max(0, 1.0 - rNorm * rNorm))) * (toolRadius * 0.28);
                    const zTarget = (z0 + t * (z1 - z0)) + toolProfile;

                    const idx = rowOffset + gx;
                    if (zTarget < heightGrid[idx]) {
                        heightGrid[idx] = zTarget;
                    }
                }
            }
        }
    };

    const cuts = parsed.cuts;
    const cutStride = Math.max(1, Math.ceil((cuts.length / 6) / 25000));
    for (let i = 0; i < cuts.length; i += 6 * cutStride) {
        carveContinuousSegment(cuts[i], cuts[i + 1], cuts[i + 2], cuts[i + 3], cuts[i + 4], cuts[i + 5]);
    }

    const arcs = parsed.arcs;
    const arcStride = Math.max(1, Math.ceil((arcs.length / 6) / 15000));
    for (let i = 0; i < arcs.length; i += 6 * arcStride) {
        carveContinuousSegment(arcs[i], arcs[i + 1], arcs[i + 2], arcs[i + 3], arcs[i + 4], arcs[i + 5]);
    }

    // ─── 2-Pass Smoothing Filter to Perfect Smooth Pocket Floors ────
    const smoothedGrid = new Float32Array(heightGrid.length);
    smoothedGrid.set(heightGrid);

    for (let pass = 0; pass < 2; pass++) {
        for (let gy = 1; gy < gridResY - 1; gy++) {
            const row = gy * gridResX;
            for (let gx = 1; gx < gridResX - 1; gx++) {
                const idx = row + gx;
                const curZ = smoothedGrid[idx];
                // Smooth carved areas (below stock top surface)
                if (curZ < stockTopZ - 0.02) {
                    const zCenter = curZ * 4;
                    const zSides = smoothedGrid[idx - 1] + smoothedGrid[idx + 1] + smoothedGrid[idx - gridResX] + smoothedGrid[idx + gridResX];
                    const zDiag = smoothedGrid[idx - gridResX - 1] + smoothedGrid[idx - gridResX + 1] +
                                  smoothedGrid[idx + gridResX - 1] + smoothedGrid[idx + gridResX + 1];
                    smoothedGrid[idx] = (zCenter * 2 + zSides * 2 + zDiag) / 16;
                }
            }
        }
    }

    // ─── Build Watertight Mesh ───────────────────────────────────
    const vertices: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const maxCutDepth = Math.max(0.01, stockTopZ - min[2]);

    // 1. Top Relief Surface Grid with Authentic Natural Wood & Cavity Shading
    for (let gy = 0; gy < gridResY; gy++) {
        const yFrac = gy / (gridResY - 1);
        const py = stockMinY + yFrac * stockHeight;

        for (let gx = 0; gx < gridResX; gx++) {
            const xFrac = gx / (gridResX - 1);
            const px = stockMinX + xFrac * stockWidth;
            const pz = smoothedGrid[gy * gridResX + gx];

            vertices.push(px, py, pz);
            uvs.push(xFrac * 2.5, yFrac * 2.5);

            // Shading:
            // Uncarved surface = clean wood tone (1.0, 1.0, 1.0)
            // Carved pocket interior = rich warm chocolate / walnut brown with concentric tool swirl rings (matching reference image)
            const depth = stockTopZ - pz;

            if (depth < 0.04) {
                // Top surface untouched
                colors.push(1.0, 1.0, 1.0);
            } else {
                // Rich warm roasted chocolate / walnut brown cavity shading matching reference image
                const dNorm = Math.min(1.0, depth / Math.max(0.1, maxCutDepth));
                const cavityR = 0.50 + (1.0 - dNorm) * 0.24;
                const cavityG = 0.36 + (1.0 - dNorm) * 0.19;
                const cavityB = 0.24 + (1.0 - dNorm) * 0.15;

                // Authentic concentric circular tool swirls & stepover marks inside recessed pockets
                const swirlFreq = 1.35;
                const localSwirl = Math.sin(Math.sqrt(((px - stockMinX) % 32 - 16) ** 2 + ((py - stockMinY) % 32 - 16) ** 2) * swirlFreq);
                const ringFactor = 0.93 + 0.07 * (localSwirl * 0.5 + 0.5);

                // Soft ambient contact darkening
                const ao = 0.88 + 0.12 * (1.0 - dNorm);

                colors.push(
                    Math.max(0, Math.min(1, cavityR * ringFactor * ao)),
                    Math.max(0, Math.min(1, cavityG * ringFactor * ao)),
                    Math.max(0, Math.min(1, cavityB * ringFactor * ao))
                );
            }
        }
    }

    for (let gy = 0; gy < gridResY - 1; gy++) {
        for (let gx = 0; gx < gridResX - 1; gx++) {
            const i0 = gy * gridResX + gx;
            const i1 = i0 + 1;
            const i2 = (gy + 1) * gridResX + gx;
            const i3 = i2 + 1;

            indices.push(i0, i1, i2);
            indices.push(i1, i3, i2);
        }
    }

    // 2. Skirt Side Walls
    const addWallQuad = (
        x0: number, y0: number, zTop0: number, zBot0: number,
        x1: number, y1: number, zTop1: number, zBot1: number
    ) => {
        const baseIdx = vertices.length / 3;
        vertices.push(
            x0, y0, zTop0,
            x1, y1, zTop1,
            x0, y0, zBot0,
            x1, y1, zBot1
        );
        for (let i = 0; i < 4; i++) colors.push(0.85, 0.82, 0.78);
        uvs.push(0, 1, 1, 1, 0, 0, 1, 0);
        indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
        indices.push(baseIdx + 1, baseIdx + 3, baseIdx + 2);
    };

    // Front edge
    for (let gx = 0; gx < gridResX - 1; gx++) {
        const x0 = stockMinX + (gx / (gridResX - 1)) * stockWidth;
        const x1 = stockMinX + ((gx + 1) / (gridResX - 1)) * stockWidth;
        const z0 = smoothedGrid[0 * gridResX + gx];
        const z1 = smoothedGrid[0 * gridResX + gx + 1];
        addWallQuad(x0, stockMinY, z0, stockBottomZ, x1, stockMinY, z1, stockBottomZ);
    }

    // Back edge
    const lastRow = (gridResY - 1) * gridResX;
    for (let gx = 0; gx < gridResX - 1; gx++) {
        const x0 = stockMinX + (gx / (gridResX - 1)) * stockWidth;
        const x1 = stockMinX + ((gx + 1) / (gridResX - 1)) * stockWidth;
        const z0 = smoothedGrid[lastRow + gx];
        const z1 = smoothedGrid[lastRow + gx + 1];
        addWallQuad(x1, stockMaxY, z1, stockBottomZ, x0, stockMaxY, z0, stockBottomZ);
    }

    // Left edge
    for (let gy = 0; gy < gridResY - 1; gy++) {
        const y0 = stockMinY + (gy / (gridResY - 1)) * stockHeight;
        const y1 = stockMinY + ((gy + 1) / (gridResY - 1)) * stockHeight;
        const z0 = smoothedGrid[gy * gridResX];
        const z1 = smoothedGrid[(gy + 1) * gridResX];
        addWallQuad(stockMinX, y1, z1, stockBottomZ, stockMinX, y0, z0, stockBottomZ);
    }

    // Right edge
    for (let gy = 0; gy < gridResY - 1; gy++) {
        const y0 = stockMinY + (gy / (gridResY - 1)) * stockHeight;
        const y1 = stockMinY + ((gy + 1) / (gridResY - 1)) * stockHeight;
        const z0 = smoothedGrid[gy * gridResX + (gridResX - 1)];
        const z1 = smoothedGrid[(gy + 1) * gridResX + (gridResX - 1)];
        addWallQuad(stockMaxX, y0, z0, stockBottomZ, stockMaxX, y1, z1, stockBottomZ);
    }

    // 3. Bottom Base Plate
    const basePlateIdx = vertices.length / 3;
    vertices.push(
        stockMinX, stockMinY, stockBottomZ,
        stockMaxX, stockMinY, stockBottomZ,
        stockMinX, stockMaxY, stockBottomZ,
        stockMaxX, stockMaxY, stockBottomZ
    );
    for (let i = 0; i < 4; i++) colors.push(0.7, 0.65, 0.6);
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    indices.push(basePlateIdx, basePlateIdx + 2, basePlateIdx + 1);
    indices.push(basePlateIdx + 1, basePlateIdx + 2, basePlateIdx + 3);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const { diffuse, bump } = getWoodTextures();
    const woodMaterial = new THREE.MeshStandardMaterial({
        map: diffuse,
        bumpMap: bump,
        bumpScale: 0.38,
        roughness: 0.42,
        metalness: 0.03,
        vertexColors: true,
        side: THREE.DoubleSide,
    });

    const stockMesh = new THREE.Mesh(geometry, woodMaterial);
    stockMesh.castShadow = true;
    stockMesh.receiveShadow = true;
    meshGroup.add(stockMesh);

    // 4. Soft Contact Shadow on Spoilboard
    const shadowGeo = new THREE.PlaneGeometry(stockWidth * 1.15, stockHeight * 1.15);
    const canvasShadow = document.createElement('canvas');
    canvasShadow.width = 128;
    canvasShadow.height = 128;
    const sCtx = canvasShadow.getContext('2d')!;
    const grad = sCtx.createRadialGradient(64, 64, 24, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.22)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    sCtx.fillStyle = grad;
    sCtx.fillRect(0, 0, 128, 128);
    const shadowTex = new THREE.CanvasTexture(canvasShadow);
    const shadowMat = new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
    });
    const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    shadowMesh.position.set(
        (stockMinX + stockMaxX) / 2,
        (stockMinY + stockMaxY) / 2,
        stockBottomZ - 0.2
    );
    meshGroup.add(shadowMesh);

    // 5. Studio Lighting Setup (Rich, warm key highlight, cool sky fill & rim light)
    const ambientLight = new THREE.AmbientLight(0xffeedb, 0.90);

    const keyLight = new THREE.DirectionalLight(0xfff8ee, 1.45);
    keyLight.position.set(
        stockMinX - stockWidth * 0.4,
        stockMinY - stockHeight * 0.6,
        stockTopZ + Math.max(stockWidth, stockHeight) * 1.6
    );

    const fillLight = new THREE.DirectionalLight(0xdce7f5, 0.45);
    fillLight.position.set(
        stockMaxX + stockWidth * 0.6,
        stockMaxY + stockHeight * 0.6,
        stockTopZ + Math.max(stockWidth, stockHeight) * 0.8
    );

    const rimLight = new THREE.DirectionalLight(0xffedd5, 0.35);
    rimLight.position.set(
        (stockMinX + stockMaxX) / 2,
        stockMaxY + stockHeight * 0.8,
        stockTopZ + Math.max(stockWidth, stockHeight) * 1.1
    );

    lightsGroup.add(ambientLight, keyLight, fillLight, rimLight);

    return { meshGroup, lightsGroup };
}

export function disposeRealisticWorkpiece(res: RealisticWorkpieceResult | null): void {
    if (!res) return;
    if (res.meshGroup) {
        res.meshGroup.traverse((obj) => {
            if ((obj as THREE.Mesh).isMesh) {
                const m = obj as THREE.Mesh;
                if (m.geometry) {
                    const pos = m.geometry.getAttribute('position');
                    if (pos && typeof (pos as any).dispose === 'function') (pos as any).dispose();
                    const uv = m.geometry.getAttribute('uv');
                    if (uv && typeof (uv as any).dispose === 'function') (uv as any).dispose();
                    const norm = m.geometry.getAttribute('normal');
                    if (norm && typeof (norm as any).dispose === 'function') (norm as any).dispose();
                    m.geometry.dispose();
                }
                if (Array.isArray(m.material)) {
                    m.material.forEach((mat) => {
                        if ((mat as any).map) (mat as any).map.dispose();
                        if ((mat as any).bumpMap) (mat as any).bumpMap.dispose();
                        mat.dispose();
                    });
                } else if (m.material) {
                    if ((m.material as any).map) (m.material as any).map.dispose();
                    if ((m.material as any).bumpMap) (m.material as any).bumpMap.dispose();
                    m.material.dispose();
                }
            }
        });
    }
    if (res.lightsGroup) {
        res.lightsGroup.traverse((obj) => {
            if ((obj as THREE.Light).isLight) {
                (obj as THREE.Light).dispose?.();
            }
        });
    }
}
