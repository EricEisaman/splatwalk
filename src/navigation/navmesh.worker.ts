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
            const vertexCount = positions.length / 3;
            const facesCount = indices.length / 3;

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

            const gridW = Math.ceil(width / params.cs);
            const gridD = Math.ceil(depth / params.cs);
            const gridH = Math.ceil(height / params.ch);

            console.log(`[WORKER] Pre-flight Diagnostics:`);
            console.log(`[WORKER]   - Verts: ${vertexCount}, Faces: ${facesCount}`);
            console.log(`[WORKER]   - Bounds: [${minX.toFixed(2)}, ${minY.toFixed(2)}, ${minZ.toFixed(2)}] to [${maxX.toFixed(2)}, ${maxY.toFixed(2)}, ${maxZ.toFixed(2)}]`);
            console.log(`[WORKER]   - Size: ${width.toFixed(2)}x${height.toFixed(2)}x${depth.toFixed(2)}`);
            console.log(`[WORKER]   - Grid: ${gridW}x${gridD}x${gridH} (Total Cells: ${gridW * gridD * gridH})`);

            // Safe parameter log
            try {
                console.log(`[WORKER]   - Params: ${JSON.stringify(params)}`);
            } catch (e) {
                console.log(`[WORKER]   - Params: [Object Unserializable]`);
            }

            if (gridW * gridD > 10000000) {
                const error = `Voxel grid too dense (${gridW}x${gridD}). Increase Cell Size (cs).`;
                ctx.postMessage({ type: 'error', payload: error });
                return;
            }

            if (gridW === 0 || gridD === 0) {
                const error = `Invalid grid dimensions (${gridW}x${gridD}). Check mesh size.`;
                console.error(`[WORKER] ${error}`);
                ctx.postMessage({ type: 'error', payload: error });
                return;
            }

            console.log(`[WORKER] Generating navmesh via generateSoloNavMesh...`);

            const { success, navMesh, intermediates } = generateSoloNavMesh(
                positions,
                indices,
                params,
                true // keepIntermediates
            );

            // Capture build logs
            const buildLogs = intermediates.buildContext.logs || [];
            if (buildLogs.length > 0) {
                console.log("[WORKER] Internal Recast Logs:");
                buildLogs.forEach(entry => console.log(`[WORKER] [RECAST] ${entry.msg}`));
            }

            if (!success || !navMesh) {
                const lastLog = buildLogs.length > 0 ? buildLogs[buildLogs.length - 1].msg : 'No internal Recast messages.';
                const errorMsg = `Navmesh generation failed: Recast Error: ${lastLog}\nFull Diagnostics:\n- Grid: ${gridW}x${gridD}x${gridH}\n- Bounds: ${width.toFixed(1)}x${height.toFixed(1)}x${depth.toFixed(1)}`;

                console.error(`[WORKER] ${errorMsg}`);
                ctx.postMessage({ type: 'error', payload: errorMsg });
                return;
            }

            console.log('[WORKER] Navmesh generated. Extracting debug visualization...');
            const [rawDebugPositions, rawDebugIndices] = getNavMeshPositionsAndIndices(navMesh);
            const debugPositions = new Float32Array(rawDebugPositions);
            const debugIndices = new Uint32Array(rawDebugIndices);

            console.log(`[WORKER] Debug mesh: ${debugPositions.length / 3} vertices.`);

            // Serialize navmesh for transfer
            console.log('[WORKER] Serializing NavMesh binary data...');
            const navMeshData = exportNavMesh(navMesh);

            ctx.postMessage({
                type: 'done',
                payload: {
                    navMeshData,
                    debugPositions,
                    debugIndices
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
