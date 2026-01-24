import { init, exportNavMesh, getNavMeshPositionsAndIndices } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';

// Web worker context
const ctx: Worker = self as any;

let isInitialized = false;

async function initialize() {
    if (isInitialized) return;
    console.log('[WORKER] Initializing Recast WASM...');
    await init();
    isInitialized = true;
    console.log('[WORKER] Recast WASM initialized.');
}

ctx.onmessage = async (e: MessageEvent) => {
    const { type, payload } = e.data;

    if (type === 'init') {
        await initialize();
        ctx.postMessage({ type: 'ready' });
        return;
    }

    if (type === 'generate') {
        const { positions, indices, params } = payload;

        try {
            await initialize();

            // 1. Geometry Sanitization
            let nanCount = 0;
            let infCount = 0;
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

            for (let i = 0; i < positions.length; i += 3) {
                const x = positions[i], y = positions[i + 1], z = positions[i + 2];

                if (isNaN(x) || isNaN(y) || isNaN(z)) nanCount++;
                if (!isFinite(x) || !isFinite(y) || !isFinite(z)) infCount++;

                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }

            if (nanCount > 0 || infCount > 0) {
                const error = `Geometry corrupted: ${nanCount} NaNs, ${infCount} Infinities found.`;
                console.error(`[WORKER] ${error}`);
                ctx.postMessage({ type: 'error', payload: error });
                return;
            }

            const width = maxX - minX;
            const height = maxY - minY;
            const depth = maxZ - minZ;

            // 2. Vertical Headroom Padding
            // Recast needs vertical space to check agent height. If the mesh is too shallow,
            // we must pad the bounding box upwards.
            let paddedMaxY = maxY;
            if (height < params.walkableHeight + 0.5) {
                const padding = (params.walkableHeight + 0.5) - height;
                paddedMaxY += padding;
                console.log(`[WORKER] Applying vertical headroom padding: +${padding.toFixed(2)}m`);
            }

            // 3. Smart Cell Size Override
            // If the grid is too coarse (e.g. < 40 cells), Recast fails opaquely.
            let finalCS = params.cs;
            const maxDimension = Math.max(width, depth);
            const minResolution = 50; // We want at least 50 cells across the longest side

            if (maxDimension / finalCS < minResolution) {
                const recommendedCS = Number((maxDimension / minResolution).toFixed(3));
                console.warn(`[WORKER] Cell Size (${finalCS}) too coarse for mesh size (${width.toFixed(1)}x${depth.toFixed(1)}). Overriding to ${recommendedCS}.`);
                finalCS = recommendedCS;
            }

            const gridW = Math.ceil(width / finalCS);
            const gridD = Math.ceil(depth / finalCS);
            const gridH = Math.ceil((paddedMaxY - minY) / params.ch);

            const activeParams = { ...params, cs: finalCS };

            console.log(`[WORKER] Pre-flight Diagnostics:`);
            console.log(`[WORKER]   - Size: ${width.toFixed(2)}x${height.toFixed(2)}x${depth.toFixed(2)}`);
            console.log(`[WORKER]   - Grid: ${gridW}x${gridD}x${gridH} (Total Cells: ${gridW * gridD * gridH})`);
            console.log(`[WORKER]   - Override: ${finalCS === params.cs ? 'None' : 'AUTO-SCALED to ' + finalCS}`);

            if (gridW * gridD > 10000000) {
                const error = `Voxel grid too dense (${gridW}x${gridD}). Increase Cell Size (cs).`;
                ctx.postMessage({ type: 'error', payload: error });
                return;
            }

            if (gridW === 0 || gridD === 0) {
                const error = `Invalid grid dimensions. Check mesh scale.`;
                ctx.postMessage({ type: 'error', payload: error });
                return;
            }

            // 4. Normal Orientation Diagnostic
            // Recast right-handed: +Y is UP. If mesh normals face -Y, nothing is walkable.
            let upDotSum = 0;
            let sampleCount = Math.min(indices.length / 3, 50);
            for (let i = 0; i < sampleCount; i++) {
                const i1 = indices[i * 3] * 3;
                const i2 = indices[i * 3 + 1] * 3;
                const i3 = indices[i * 3 + 2] * 3;

                // Edge vectors
                const ax = positions[i2] - positions[i1], ay = positions[i2 + 1] - positions[i1 + 1], az = positions[i2 + 2] - positions[i1 + 2];
                const bx = positions[i3] - positions[i1], by = positions[i3 + 1] - positions[i1 + 1], bz = positions[i3 + 2] - positions[i1 + 2];

                // Normal (Cross product)
                const nx = ay * bz - az * by;
                const ny = az * bx - ax * bz;
                const nz = ax * by - ay * bx;

                const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (len > 0) {
                    upDotSum += ny / len; // Dot with (0, 1, 0)
                }
            }
            const avgUpDot = sampleCount > 0 ? upDotSum / sampleCount : 0;
            console.log(`[WORKER] Geometric Normal Check: Average Up-Dot = ${avgUpDot.toFixed(3)}`);

            if (avgUpDot < -0.5) {
                console.warn(`[WORKER] DETECTED INVERTED MESH (Normal: ${avgUpDot.toFixed(3)}). Applying Automatic Winding Flip...`);
            }

            // 5. Automatic Winding Correction
            // Recast needs CCW or CW depending on coordinate hand. If normals face down, 
            // flipping index winding order effectively flips the normal for Recast.
            let finalIndices = indices;
            let wasFlipped = false;

            if (avgUpDot < -0.5) {
                const flipped = new Uint32Array(indices.length);
                for (let i = 0; i < indices.length; i += 3) {
                    flipped[i] = indices[i];
                    flipped[i + 1] = indices[i + 2]; // Swap 1 and 2
                    flipped[i + 2] = indices[i + 1];
                }
                finalIndices = flipped;
                wasFlipped = true;
                console.log(`[WORKER] Winding flip applied to ${indices.length / 3} triangles.`);
            }

            console.log(`[WORKER] Generating navmesh via generateSoloNavMesh...`);

            // We need to manually calculate the bounding box for parameters to ensure our padding is used
            const bmin: [number, number, number] = [minX, minY, minZ];
            const bmax: [number, number, number] = [maxX, paddedMaxY, maxZ];

            const { success, navMesh, intermediates } = generateSoloNavMesh(
                positions,
                finalIndices,
                { ...activeParams, bmin, bmax },
                true // keepIntermediates
            );

            // Capture build logs
            const buildLogs = intermediates.buildContext.logs || [];

            // High-level pipeline tracing
            const hasHeightfield = !!intermediates.heightfield;
            const hasCompactHf = !!intermediates.compactHeightfield;
            const hasContours = !!intermediates.contourSet;

            if (!success || !navMesh) {
                let errorAdvice = "";
                if (avgUpDot < -0.5) {
                    errorAdvice = "\nADVICE: Mesh normals were INVERTED. An automatic winding flip was attempted but failed to yield walkable areas. Please check if your 'Max Slope' is too restrictive.";
                } else if (!hasHeightfield) {
                    errorAdvice = "\nADVICE: Voxelization yielded zero data. Check if your mesh scale is in meters or centimeters.";
                } else if (!hasCompactHf) {
                    errorAdvice = "\nADVICE: Could not build compact heightfield. Agent Height might be too large for the space.";
                } else if (!hasContours) {
                    errorAdvice = "\nADVICE: No walkable areas found. Try reducing 'Max Slope' or checking for thin vertical spikes.";
                }

                const lastLog = buildLogs.length > 0 ? buildLogs[buildLogs.length - 1].msg : 'No internal Recast messages.';
                const errorMsg = `Navmesh generation failed: Recast Error: ${lastLog}${errorAdvice}\nFull Diagnostics: - Grid: ${gridW}x${gridD}x${gridH} - Bounds: ${width.toFixed(1)}x${height.toFixed(1)}x${depth.toFixed(1)} - Normal: ${avgUpDot.toFixed(2)} (Flipped=${wasFlipped})`;

                console.error(`[WORKER] ${errorMsg}`);
                ctx.postMessage({ type: 'error', payload: errorMsg });
                return;
            }

            console.log('[WORKER] Navmesh generated. Extracting debug visualization...');
            const [rawDebugPositions, rawDebugIndices] = getNavMeshPositionsAndIndices(navMesh);
            const debugPositions = new Float32Array(rawDebugPositions);
            const debugIndices = new Uint32Array(rawDebugIndices);

            // Serialize navmesh for transfer
            console.log('[WORKER] Serializing NavMesh binary data...');
            const navMeshData = exportNavMesh(navMesh);

            ctx.postMessage({
                type: 'done',
                payload: {
                    navMeshData,
                    debugPositions,
                    debugIndices,
                    report: {
                        originalCS: params.cs,
                        activeCS: finalCS,
                        isOverride: finalCS !== params.cs,
                        headroomPadding: paddedMaxY - maxY,
                        gridDim: [gridW, gridD, gridH],
                        avgUpDot,
                        wasFlipped
                    }
                }
            }, [navMeshData.buffer, debugPositions.buffer, debugIndices.buffer] as any);

            // Clean up
            navMesh.destroy();

        } catch (error: any) {
            console.error('[WORKER] Internal failure:', error);
            ctx.postMessage({ type: 'error', payload: `Internal worker error: ${error.message}` });
        }
    }
};
