/**
 * Shared player marker solid: triangular prism (wedge) with tip along +Z.
 *
 * Yaw 0 faces +Z (same convention as {@link integratePlayerWasdMove}); the pointed
 * end reads as front from a top-down view.
 */

/** Full height of the wedge (m); mesh is centered so feet sit at center − half height. */
export const PLAYER_MARKER_HEIGHT_M = 0.5;

/** Half height — used when syncing agent feet → mesh center. */
export const PLAYER_MARKER_HALF_HEIGHT_M = PLAYER_MARKER_HEIGHT_M * 0.5;

/** Tip of the triangle along +Z from center (m). */
const TIP_Z_M = 0.28;

/** Base of the triangle along −Z from center (m). */
const BASE_Z_M = -0.22;

/** Half-width of the base along ±X (m). */
const BASE_HALF_WIDTH_M = 0.25;

export interface PlayerMarkerWedgeBuffers {
  readonly positions: Float32Array;
  readonly indices: Uint16Array;
}

/**
 * Vertex buffers for a closed triangular prism centered at the origin.
 * Tip at +Z, flat base at −Z; Y from −halfH…+halfH.
 */
export const playerMarkerWedgeBuffers = (): PlayerMarkerWedgeBuffers => {
  const y0 = -PLAYER_MARKER_HALF_HEIGHT_M;
  const y1 = PLAYER_MARKER_HALF_HEIGHT_M;
  // Bottom tip, baseL, baseR; top tip, baseL, baseR.
  const positions = new Float32Array([
    0,
    y0,
    TIP_Z_M,
    -BASE_HALF_WIDTH_M,
    y0,
    BASE_Z_M,
    BASE_HALF_WIDTH_M,
    y0,
    BASE_Z_M,
    0,
    y1,
    TIP_Z_M,
    -BASE_HALF_WIDTH_M,
    y1,
    BASE_Z_M,
    BASE_HALF_WIDTH_M,
    y1,
    BASE_Z_M,
  ]);
  // CCW winding with outward normals (tip = +Z edge; flat base = −Z).
  const indices = new Uint16Array([
    // bottom (y−)
    0, 2, 1,
    // top (y+)
    3, 4, 5,
    // right side (tip → baseR)
    0, 3, 5, 0, 5, 2,
    // base face (−Z)
    1, 2, 5, 1, 5, 4,
    // left side (tip → baseL)
    0, 4, 3, 0, 1, 4,
  ]);
  return { positions, indices };
};
