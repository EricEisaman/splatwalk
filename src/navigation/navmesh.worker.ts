import { init, exportNavMesh, getNavMeshPositionsAndIndices } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { autoNavCellSize, DEFAULT_MAX_NAV_CELLS } from './floor';
import { generateFloorSheetSoloNavMesh } from './floorSheetNavMesh';

// Web worker context
const ctx: Worker = self as any;

let isInitialized = false;

function calculateBounds(positions: Float32Array | number[]): { min: [number, number, number], max: [number, number, number] } {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            continue;
        }

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
    }

    return {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
    };
}

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
        const { positions, indices, params, sourceLabel, splatBounds, colliderBounds } = payload;

        try {
            await initialize();

            const label = String(sourceLabel ?? '');
            const allowed =
                label.includes('collider') ||
                label.includes('floor_field') ||
                label.includes('voxel_volume');
            if (sourceLabel && !allowed) {
                ctx.postMessage({ type: 'error', payload: `Rejected non-collider Recast input source: ${sourceLabel}` });
                return;
            }

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
            const footprint = Math.min(width, depth);

            if (positions.length === 0 || indices.length === 0) {
                ctx.postMessage({ type: 'error', payload: 'Collision mesh is empty. Check voxel seed, fill/carve settings, and scene type.' });
                return;
            }

            // A perfectly flat floor (height === 0) is valid for navigation; the
            // vertical headroom padding below gives Recast the Y extent it needs.
            // Only the horizontal extents must be positive.
            if (![width, height, depth].every(Number.isFinite) || width <= 0 || depth <= 0 || height < 0) {
                ctx.postMessage({ type: 'error', payload: `Collision mesh bounds are invalid: ${width.toFixed(3)}x${height.toFixed(3)}x${depth.toFixed(3)}.` });
                return;
            }

            // 2. Vertical Headroom Padding
            // Recast culls any floor span that lacks `walkableHeight` of clear space
            // above it (filterWalkableLowHeightSpans). The floor-field mesh is an
            // open-sky sheet with no real overhead geometry, so we add headroom above
            // the HIGHEST floor cell (maxY), not just enough to make the sheet thickness
            // exceed walkableHeight. Padding above maxY guarantees every cell - including
            // the top deck level - keeps its clearance once walkableHeight is enforced
            // in voxels (see below). `params.walkableHeight` here is still in metres.
            const requiredHeadroom = params.walkableHeight + 0.5;
            const padding = requiredHeadroom;
            const paddedMaxY = maxY + padding;
            console.log(`[WORKER] Applying vertical headroom padding: +${padding.toFixed(2)}m above maxY`);

            // 3. Cell Size
            // Auto-size cs from the mesh extent + agent radius (Recast guideline
            // cs in [radius/3, radius/2]) bounded by a total-cell budget, so a large
            // scene is covered completely instead of being limited by a fixed cs.
            // Disabled (params.autoCellSize === false) for the manual path, which
            // honours the operator's literal cs input.
            let finalCS = params.cs;
            let walkableRadiusM = params.walkableRadius;
            if (footprint > 0 && walkableRadiusM > footprint * 0.45) {
                walkableRadiusM = Math.max(0.05, footprint * 0.35);
                console.warn(
                    `[WORKER] Clamping walkableRadius ${params.walkableRadius.toFixed(3)}m -> ` +
                    `${walkableRadiusM.toFixed(3)}m for ${footprint.toFixed(2)}m collider footprint`
                );
            }
            if (params.autoCellSize !== false) {
                const budget = params.maxNavCells && params.maxNavCells > 0 ? params.maxNavCells : DEFAULT_MAX_NAV_CELLS;
                finalCS = autoNavCellSize(width, depth, walkableRadiusM, budget);
                console.log(
                    `[WORKER] Auto cell size: cs=${finalCS.toFixed(3)} ` +
                    `(agentRadius=${params.walkableRadius}m -> [${(params.walkableRadius / 3).toFixed(3)}, ${(params.walkableRadius / 2).toFixed(3)}], ` +
                    `budget=${budget} cells, bounds=${width.toFixed(1)}x${depth.toFixed(1)})`
                );
            }
            const maxDimension = Math.max(width, depth);
            const minResolution = 50; // We want at least 50 cells across the longest side

            if (params.autoCellSize !== false && maxDimension >= 2.0 && maxDimension / finalCS < minResolution) {
                const recommendedCS = Number((maxDimension / minResolution).toFixed(3));
                console.warn(`[WORKER] Cell Size (${finalCS}) too coarse for mesh size (${width.toFixed(1)}x${depth.toFixed(1)}). Overriding to ${recommendedCS}.`);
                finalCS = recommendedCS;
            }

            const gridW = Math.ceil(width / finalCS);
            const gridD = Math.ceil(depth / finalCS);
            const gridH = Math.ceil((paddedMaxY - minY) / params.ch);

            const activeParams = { ...params, cs: finalCS, walkableRadius: walkableRadiusM };

            // Recast's rcConfig stores walkableHeight/Climb/Radius as INTEGER VOXEL
            // COUNTS, not world-space metres (see @recast-navigation createRcConfig: it
            // assigns these straight into the native rcConfig int fields). The rest of
            // SplatWalk specifies them in metres, so we MUST convert here using the
            // standard Recast convention. Without this, sub-1.0m values silently
            // truncate to 0 voxels: walkableClimb 0.25->0 (every step becomes an
            // impassable wall, splitting one level into disjoint islands) and
            // walkableRadius 0.45->0 (no erosion at all). This made slope/climb/radius
            // appear completely inert and was the true cause of the tropical
            // fragmentation. walkableHeight 1.7m -> ceil(1.7/0.1)=17 voxels.
            const chSafe = activeParams.ch > 0 ? activeParams.ch : 0.1;
            const csSafe = finalCS > 0 ? finalCS : 0.12;
            const voxelParams = {
                ...activeParams,
                walkableHeight: Math.max(1, Math.ceil(activeParams.walkableHeight / chSafe)),
                walkableClimb: Math.max(0, Math.floor(activeParams.walkableClimb / chSafe)),
                walkableRadius: Math.max(0, Math.ceil(activeParams.walkableRadius / csSafe)),
            };
            console.log(
                `[WORKER] Recast voxel params (from metres): walkableHeight=${voxelParams.walkableHeight}vx ` +
                `(${activeParams.walkableHeight}m), walkableClimb=${voxelParams.walkableClimb}vx ` +
                `(${activeParams.walkableClimb}m), walkableRadius=${voxelParams.walkableRadius}vx ` +
                `(${activeParams.walkableRadius}m) @ cs=${csSafe},ch=${chSafe}`
            );

            console.log(`[WORKER] Collider Pre-flight Diagnostics:`);
            console.log(`[WORKER]   - Source: ${sourceLabel ?? 'collider_mesh'}`);
            console.log(`[WORKER]   - Size: ${width.toFixed(2)}x${height.toFixed(2)}x${depth.toFixed(2)}`);
            console.log(`[WORKER]   - Geometry: ${positions.length / 3} vertices, ${indices.length / 3} triangles`);
            console.log(`[WORKER]   - Grid: ${gridW}x${gridD}x${gridH} (Total Cells: ${gridW * gridD * gridH})`);
            console.log(`[WORKER]   - Override: ${finalCS === params.cs ? 'None' : 'AUTO-SCALED to ' + finalCS}`);
            if (splatBounds) {
                console.log(`[WORKER]   - Splat Bounds: ${JSON.stringify(splatBounds.min)} to ${JSON.stringify(splatBounds.max)}`);
            }
            if (colliderBounds) {
                console.log(`[WORKER]   - Collider Bounds: ${JSON.stringify(colliderBounds.min)} to ${JSON.stringify(colliderBounds.max)}`);
            }

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

            const useFloorSheetBake =
                sourceLabel === 'fast_floor_field' ||
                sourceLabel === 'generated_voxel_collider' ||
                sourceLabel === 'generated_voxel_volume';
            if (sourceLabel === 'generated_voxel_volume') {
                console.log(
                    '[WORKER] Voxel volume spans — floor-sheet Recast bake (treads + step ramps from carve).'
                );
            } else if (sourceLabel === 'generated_voxel_collider') {
                console.log(
                    '[WORKER] Voxel collider — floor-sheet Recast bake (skip ledge filter) for stair connectivity.'
                );
            }
            if (sourceLabel === 'generated_voxel_collider' && height < 0.2) {
                console.log(
                    `[WORKER] Voxel collider height ${height.toFixed(3)}m — still using floor-sheet bake for multi-level connectivity.`
                );
            }

            console.log(`[WORKER] Generating navmesh via ${useFloorSheetBake ? 'floor-sheet (no ledge filter)' : 'generateSoloNavMesh'}...`);

            // Headroom must be applied via `bounds` (SoloNavMeshGeneratorConfig).
            // Passing legacy `bmin`/`bmax` is ignored by @recast-navigation — Recast then
            // uses the raw mesh AABB. Flat floor sheets (~1m tall) are shorter than
            // walkableHeight, so filterWalkableLowHeightSpans culls every span.
            const boundsMin: [number, number, number] = [minX, minY, minZ];
            const boundsMax: [number, number, number] = [maxX, paddedMaxY, maxZ];

            const {
                autoCellSize: _autoCellSize,
                maxNavCells: _maxNavCells,
                ...recastConfig
            } = voxelParams;

            const navConfig = { ...recastConfig, bounds: [boundsMin, boundsMax] as const };

            // Floor-field meshes are open-sky sheets: Recast's ledge filter treats every
            // hole/border as a cliff and can wipe the entire walkable surface. Use a
            // dedicated bake that keeps low-hanging + headroom filters but skips ledges.
            const { success, navMesh, intermediates, error: bakeError } =
                useFloorSheetBake
                    ? generateFloorSheetSoloNavMesh(
                          positions,
                          finalIndices,
                          {
                              bounds: [boundsMin, boundsMax],
                              ch: recastConfig.ch,
                              cs: recastConfig.cs,
                              detailSampleDist: recastConfig.detailSampleDist,
                              detailSampleMaxError: recastConfig.detailSampleMaxError,
                              maxEdgeLen: recastConfig.maxEdgeLen,
                              maxSimplificationError: recastConfig.maxSimplificationError,
                              maxVertsPerPoly: recastConfig.maxVertsPerPoly,
                              mergeRegionArea: recastConfig.mergeRegionArea,
                              minRegionArea: recastConfig.minRegionArea,
                              walkableClimb: recastConfig.walkableClimb,
                              walkableHeight: recastConfig.walkableHeight,
                              walkableRadius: recastConfig.walkableRadius,
                              walkableSlopeAngle: recastConfig.walkableSlopeAngle,
                          },
                          true
                      )
                    : {
                          ...generateSoloNavMesh(positions, finalIndices, navConfig, true),
                          error: undefined as string | undefined,
                      };

            // Capture build logs
            const buildLogs = intermediates?.buildContext?.logs || [];

            // High-level pipeline tracing
            const hasHeightfield = !!intermediates?.heightfield;
            const hasCompactHf = !!intermediates?.compactHeightfield;
            const hasContours = !!intermediates?.contourSet;
            const hasPolyMesh = !!intermediates?.polyMesh;
            const contourCount =
                typeof intermediates?.contourSet?.nconts === 'function'
                    ? intermediates.contourSet.nconts()
                    : -1;

            if (!success || !navMesh) {
                let errorAdvice = '';
                if (avgUpDot < -0.5) {
                    errorAdvice =
                        "\nADVICE: Mesh normals were INVERTED. An automatic winding flip was attempted but failed to yield walkable areas. Please check if your 'Max Slope' is too restrictive.";
                } else if (!hasHeightfield) {
                    errorAdvice =
                        '\nADVICE: Voxelization yielded zero data. Check if your mesh scale is in meters or centimeters.';
                } else if (!hasCompactHf) {
                    errorAdvice =
                        '\nADVICE: Could not build compact heightfield. Agent Height might be too large for the space.';
                } else if (!hasContours || contourCount === 0) {
                    errorAdvice =
                        '\nADVICE: No walkable areas found. Try reducing Max Slope, walkableRadius, or check for thin vertical spikes.';
                } else if (!hasPolyMesh) {
                    errorAdvice =
                        '\nADVICE: Contours existed but poly-mesh build failed. Try coarser cell size (cs) or higher maxSimplificationError.';
                } else if (height + 1e-3 < params.walkableHeight) {
                    errorAdvice =
                        `\nADVICE: Floor mesh height (${height.toFixed(2)}m) is below walkableHeight (${params.walkableHeight}m). Vertical headroom padding must be applied via Recast bounds.`;
                }

                const lastLog =
                    buildLogs.length > 0
                        ? buildLogs[buildLogs.length - 1].msg
                        : bakeError || 'No internal Recast messages.';
                const errorMsg = `Navmesh generation failed: Recast Error: ${lastLog}${errorAdvice}\nFull Diagnostics: - Grid: ${gridW}x${gridD}x${gridH} - Bounds: ${width.toFixed(1)}x${height.toFixed(1)}x${depth.toFixed(1)} - PaddedY: ${(paddedMaxY - minY).toFixed(1)} - Normal: ${avgUpDot.toFixed(2)} (Flipped=${wasFlipped})`;

                console.error(`[WORKER] ${errorMsg}`);
                ctx.postMessage({ type: 'error', payload: errorMsg });
                return;
            }

            console.log('[WORKER] Navmesh generated. Extracting debug visualization...');
            const [rawDebugPositions, rawDebugIndices] = getNavMeshPositionsAndIndices(navMesh);
            const debugPositions = new Float32Array(rawDebugPositions);
            const debugIndices = new Uint32Array(rawDebugIndices);
            const sourceBounds = {
                min: [minX, minY, minZ] as [number, number, number],
                max: [maxX, maxY, maxZ] as [number, number, number],
            };
            const debugBounds = calculateBounds(debugPositions);
            console.log(`[WORKER]   - NavMesh Bounds: ${JSON.stringify(debugBounds.min)} to ${JSON.stringify(debugBounds.max)}`);

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
                        wasFlipped,
                        sourceLabel: sourceLabel ?? 'collider_mesh',
                        splatBounds,
                        colliderBounds,
                        sourceBounds,
                        debugBounds
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
