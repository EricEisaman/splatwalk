import { Mesh } from '@babylonjs/core';

export interface NavGeometry {
    positions: Float32Array;
    indices: Uint32Array;
}

export interface NavmeshParameters {
    cs: number; // cell size
    ch: number; // cell height
    walkableSlopeAngle: number;
    walkableHeight: number;
    walkableClimb: number;
    walkableRadius: number;
    maxEdgeLen: number;
    maxSimplificationError: number;
    minRegionArea: number;
    mergeRegionArea: number;
    maxVertsPerPoly: number;
    detailSampleDist: number;
    detailSampleMaxError: number;
}

/**
 * Extracts and sanitizes raw geometry from a Babylon.js mesh.
 */
export function extractGeometry(mesh: Mesh): NavGeometry {
    const indices = mesh.getIndices();
    const positions = mesh.getVerticesData('position');

    if (!indices || !positions) {
        throw new Error("Mesh does not have valid geometry data");
    }

    const posArray = positions instanceof Float32Array ? positions : new Float32Array(positions);
    const indArray = indices instanceof Uint32Array ? indices : new Uint32Array(indices);

    // Sanitization
    let nanCount = 0;
    let infCount = 0;
    for (let i = 0; i < posArray.length; i++) {
        const val = posArray[i];
        if (isNaN(val)) {
            posArray[i] = 0;
            nanCount++;
        } else if (!isFinite(val)) {
            posArray[i] = 0;
            infCount++;
        }
    }

    if (nanCount > 0 || infCount > 0) {
        console.warn(`[NAVIGATION] Sanitized geometry: replaced ${nanCount} NaNs and ${infCount} Infinities with 0.`);
    }

    return {
        positions: posArray,
        indices: indArray
    };
}
