import { Mesh, Vector3 } from '@babylonjs/core';

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
 * Extracts and sanitizes raw geometry from a Babylon.js mesh in world space.
 */
export function extractGeometry(mesh: Mesh): NavGeometry {
    const indices = mesh.getIndices();
    const positions = mesh.getVerticesData('position');

    if (!indices || !positions) {
        throw new Error("Mesh does not have valid geometry data");
    }

    const worldMatrix = mesh.getWorldMatrix();
    const posArray = new Float32Array(positions.length);
    const indArray = indices instanceof Uint32Array ? indices : new Uint32Array(indices);

    // Transform to world space
    const tempPos = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < positions.length; i += 3) {
        tempPos.x = positions[i];
        tempPos.y = positions[i + 1];
        tempPos.z = positions[i + 2];

        // Apply world matrix transformation
        const worldPos = Vector3.TransformCoordinatesFromFloatsToRef(tempPos.x, tempPos.y, tempPos.z, worldMatrix, new Vector3());

        posArray[i] = worldPos.x;
        posArray[i + 1] = worldPos.y;
        posArray[i + 2] = worldPos.z;
    }

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
