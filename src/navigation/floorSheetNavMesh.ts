import {
  NavMesh,
  NavMeshCreateParams,
  Recast,
  RecastBuildContext,
  TriangleAreasArray,
  TrianglesArray,
  VerticesArray,
  allocCompactHeightfield,
  allocContourSet,
  allocHeightfield,
  allocPolyMesh,
  allocPolyMeshDetail,
  buildCompactHeightfield,
  buildContours,
  buildDistanceField,
  buildPolyMesh,
  buildPolyMeshDetail,
  buildRegions,
  calcGridSize,
  createHeightfield,
  createNavMeshData,
  createRcConfig,
  erodeWalkableArea,
  filterLowHangingWalkableObstacles,
  filterWalkableLowHeightSpans,
  freeCompactHeightfield,
  freeContourSet,
  freeHeightfield,
  freePolyMesh,
  freePolyMeshDetail,
  markWalkableTriangles,
  rasterizeTriangles,
  recastConfigDefaults,
  type RecastCompactHeightfield,
  type RecastContourSet,
  type RecastHeightfield,
  type RecastPolyMesh,
  type RecastPolyMeshDetail,
} from 'recast-navigation';

export interface FloorSheetNavMeshConfig {
  readonly bounds: readonly [readonly [number, number, number], readonly [number, number, number]];
  readonly buildBvTree?: boolean;
  readonly ch: number;
  readonly cs: number;
  readonly detailSampleDist: number;
  readonly detailSampleMaxError: number;
  readonly maxEdgeLen: number;
  readonly maxSimplificationError: number;
  readonly maxVertsPerPoly: number;
  readonly mergeRegionArea: number;
  readonly minRegionArea: number;
  readonly walkableClimb: number;
  readonly walkableHeight: number;
  readonly walkableRadius: number;
  readonly walkableSlopeAngle: number;
}

export interface FloorSheetNavMeshIntermediates {
  readonly buildContext: RecastBuildContext;
  compactHeightfield?: RecastCompactHeightfield;
  contourSet?: RecastContourSet;
  heightfield?: RecastHeightfield;
  polyMesh?: RecastPolyMesh;
  polyMeshDetail?: RecastPolyMeshDetail;
  readonly type: 'solo';
}

export interface FloorSheetNavMeshResult {
  readonly error?: string;
  readonly intermediates: FloorSheetNavMeshIntermediates;
  readonly navMesh?: NavMesh;
  readonly success: boolean;
}

/**
 * Solo navmesh bake for open-sky floor-field sheets.
 *
 * Unlike {@link generateSoloNavMesh}, this skips `filterLedgeSpans`. Floor-field
 * meshes are intentional thin sheets with holes/borders; Recast treats every
 * missing neighbor as a cliff and can cull the entire walkable surface.
 */
export const generateFloorSheetSoloNavMesh = (
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  config: FloorSheetNavMeshConfig,
  keepIntermediates = true
): FloorSheetNavMeshResult => {
  const buildContext = new RecastBuildContext();
  const intermediates: FloorSheetNavMeshIntermediates = {
    type: 'solo',
    buildContext,
  };

  const cleanup = (): void => {
    if (keepIntermediates) {
      return;
    }
    if (intermediates.heightfield) {
      freeHeightfield(intermediates.heightfield);
      intermediates.heightfield = undefined;
    }
    if (intermediates.compactHeightfield) {
      freeCompactHeightfield(intermediates.compactHeightfield);
      intermediates.compactHeightfield = undefined;
    }
    if (intermediates.contourSet) {
      freeContourSet(intermediates.contourSet);
      intermediates.contourSet = undefined;
    }
    if (intermediates.polyMesh) {
      freePolyMesh(intermediates.polyMesh);
      intermediates.polyMesh = undefined;
    }
    if (intermediates.polyMeshDetail) {
      freePolyMeshDetail(intermediates.polyMeshDetail);
      intermediates.polyMeshDetail = undefined;
    }
  };

  const fail = (error: string): FloorSheetNavMeshResult => {
    cleanup();
    return { success: false, intermediates, error };
  };

  const numVertices = Math.floor(positions.length / 3);
  const numTriangles = Math.floor(indices.length / 3);
  if (numVertices < 3 || numTriangles < 1) {
    return fail('Floor sheet geometry is empty.');
  }

  const verticesArray = new VerticesArray();
  verticesArray.copy(
    positions instanceof Float32Array ? positions : Float32Array.from(positions as ArrayLike<number>)
  );
  const trianglesArray = new TrianglesArray();
  const indexSource =
    indices instanceof Int32Array
      ? indices
      : Int32Array.from(indices as ArrayLike<number>);
  trianglesArray.copy(indexSource);

  const bbMin = [...config.bounds[0]] as [number, number, number];
  const bbMax = [...config.bounds[1]] as [number, number, number];

  const merged = {
    ...recastConfigDefaults,
    ...config,
    buildBvTree: config.buildBvTree ?? true,
  };
  const rcConfig = createRcConfig(merged);
  rcConfig.minRegionArea = rcConfig.minRegionArea * rcConfig.minRegionArea;
  rcConfig.mergeRegionArea = rcConfig.mergeRegionArea * rcConfig.mergeRegionArea;
  rcConfig.detailSampleDist =
    rcConfig.detailSampleDist < 0.9 ? 0 : rcConfig.cs * rcConfig.detailSampleDist;
  rcConfig.detailSampleMaxError = rcConfig.ch * rcConfig.detailSampleMaxError;

  const gridSize = calcGridSize(bbMin, bbMax, rcConfig.cs);
  rcConfig.width = gridSize.width;
  rcConfig.height = gridSize.height;

  const heightfield = allocHeightfield();
  intermediates.heightfield = heightfield;
  if (
    !createHeightfield(
      buildContext,
      heightfield,
      rcConfig.width,
      rcConfig.height,
      bbMin,
      bbMax,
      rcConfig.cs,
      rcConfig.ch
    )
  ) {
    verticesArray.destroy();
    trianglesArray.destroy();
    return fail('Could not create heightfield');
  }

  const triangleAreasArray = new TriangleAreasArray();
  triangleAreasArray.resize(numTriangles);
  markWalkableTriangles(
    buildContext,
    rcConfig.walkableSlopeAngle,
    verticesArray,
    numVertices,
    trianglesArray,
    numTriangles,
    triangleAreasArray
  );
  if (
    !rasterizeTriangles(
      buildContext,
      verticesArray,
      numVertices,
      trianglesArray,
      triangleAreasArray,
      numTriangles,
      heightfield,
      rcConfig.walkableClimb
    )
  ) {
    triangleAreasArray.destroy();
    verticesArray.destroy();
    trianglesArray.destroy();
    return fail('Could not rasterize triangles');
  }
  triangleAreasArray.destroy();
  verticesArray.destroy();
  trianglesArray.destroy();

  filterLowHangingWalkableObstacles(buildContext, rcConfig.walkableClimb, heightfield);
  // Intentionally skip filterLedgeSpans — open-sky floor sheets are not world colliders.
  filterWalkableLowHeightSpans(buildContext, rcConfig.walkableHeight, heightfield);

  const compactHeightfield = allocCompactHeightfield();
  intermediates.compactHeightfield = compactHeightfield;
  if (
    !buildCompactHeightfield(
      buildContext,
      rcConfig.walkableHeight,
      rcConfig.walkableClimb,
      heightfield,
      compactHeightfield
    )
  ) {
    return fail('Failed to build compact data');
  }
  if (!keepIntermediates) {
    freeHeightfield(heightfield);
    intermediates.heightfield = undefined;
  }

  if (!erodeWalkableArea(buildContext, rcConfig.walkableRadius, compactHeightfield)) {
    return fail('Failed to erode walkable area');
  }
  if (!buildDistanceField(buildContext, compactHeightfield)) {
    return fail('Failed to build distance field');
  }
  if (
    !buildRegions(
      buildContext,
      compactHeightfield,
      rcConfig.borderSize,
      rcConfig.minRegionArea,
      rcConfig.mergeRegionArea
    )
  ) {
    return fail('Failed to build regions');
  }

  const contourSet = allocContourSet();
  intermediates.contourSet = contourSet;
  if (
    !buildContours(
      buildContext,
      compactHeightfield,
      rcConfig.maxSimplificationError,
      rcConfig.maxEdgeLen,
      contourSet,
      Recast.RC_CONTOUR_TESS_WALL_EDGES
    )
  ) {
    return fail('Failed to create contours');
  }

  const polyMesh = allocPolyMesh();
  intermediates.polyMesh = polyMesh;
  if (!buildPolyMesh(buildContext, contourSet, rcConfig.maxVertsPerPoly, polyMesh)) {
    return fail('Failed to triangulate contours');
  }

  const polyMeshDetail = allocPolyMeshDetail();
  intermediates.polyMeshDetail = polyMeshDetail;
  if (
    !buildPolyMeshDetail(
      buildContext,
      polyMesh,
      compactHeightfield,
      rcConfig.detailSampleDist,
      rcConfig.detailSampleMaxError,
      polyMeshDetail
    )
  ) {
    return fail('Failed to build detail mesh');
  }
  if (!keepIntermediates) {
    freeCompactHeightfield(compactHeightfield);
    intermediates.compactHeightfield = undefined;
    freeContourSet(contourSet);
    intermediates.contourSet = undefined;
  }

  for (let i = 0; i < polyMesh.npolys(); i++) {
    if (polyMesh.areas(i) === Recast.RC_WALKABLE_AREA) {
      polyMesh.setAreas(i, 0);
    }
    if (polyMesh.areas(i) === 0) {
      polyMesh.setFlags(i, 1);
    }
  }

  const navMeshCreateParams = new NavMeshCreateParams();
  navMeshCreateParams.setPolyMeshCreateParams(polyMesh);
  navMeshCreateParams.setPolyMeshDetailCreateParams(polyMeshDetail);
  navMeshCreateParams.setWalkableHeight(rcConfig.walkableHeight * rcConfig.ch);
  navMeshCreateParams.setWalkableRadius(rcConfig.walkableRadius * rcConfig.cs);
  navMeshCreateParams.setWalkableClimb(rcConfig.walkableClimb * rcConfig.ch);
  navMeshCreateParams.setCellSize(rcConfig.cs);
  navMeshCreateParams.setCellHeight(rcConfig.ch);
  navMeshCreateParams.setBuildBvTree(merged.buildBvTree);

  const createNavMeshDataResult = createNavMeshData(navMeshCreateParams);
  if (!createNavMeshDataResult.success) {
    return fail('Failed to create Detour navmesh data');
  }

  const navMesh = new NavMesh();
  if (!navMesh.initSolo(createNavMeshDataResult.navMeshData)) {
    createNavMeshDataResult.navMeshData.destroy();
    return fail('Failed to initialize solo NavMesh');
  }

  cleanup();
  return { success: true, navMesh, intermediates };
};
