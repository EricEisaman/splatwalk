// Type definitions for WASM modules

// A* Pathfinding module types
export interface WasmModuleAstar {
  memory: WebAssembly.Memory;
  wasm_init(debug: number, renderIntervalMs: number, windowWidth: number, windowHeight: number): void;
  tick(elapsedTime: number): void;
  key_down(keyCode: number): void;
  key_up(keyCode: number): void;
  mouse_move(x: number, y: number): void;
}

export interface Layer {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  setSize(width: number, height: number, quality: number): void;
  clearScreen(): void;
  drawRect(px: number, py: number, sx: number, sy: number, ch: number, cs: number, cl: number, ca: number): void;
  drawCircle(px: number, py: number, r: number, ch: number, cs: number, cl: number, ca: number): void;
  drawText(text: string, fontSize: number, px: number, py: number): void;
}

export interface WasmAstar {
  wasmModule: WasmModuleAstar | null;
  wasmModulePath: string;
  debug: boolean;
  renderIntervalMs: number;
  layers: Map<number, Layer>;
  layerWrapperEl: HTMLElement | null;
}

// Preprocessing module types
export interface WasmModulePreprocess {
  memory: WebAssembly.Memory;
  preprocess_image(
    imageData: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Uint8Array;
  preprocess_image_crop(
    imageData: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Uint8Array;
  preprocess_image_for_smolvlm(
    imageData: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Float32Array;
  apply_contrast(
    imageData: Uint8Array,
    width: number,
    height: number,
    contrast: number
  ): Uint8Array;
  apply_cinematic_filter(
    imageData: Uint8Array,
    width: number,
    height: number,
    intensity: number
  ): Uint8Array;
  get_preprocess_stats(originalSize: number, targetSize: number): PreprocessStats;
  set_contrast(contrast: number): void;
  set_cinematic(intensity: number): void;
  get_contrast(): number;
  get_cinematic(): number;
}

// Preprocessing module types for image-captioning
export interface WasmModulePreprocessImageCaptioning {
  memory: WebAssembly.Memory;
  preprocess_image(
    imageData: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Uint8Array;
  preprocess_image_crop(
    imageData: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Uint8Array;
  apply_contrast(
    imageData: Uint8Array,
    width: number,
    height: number,
    contrast: number
  ): Uint8Array;
  apply_cinematic_filter(
    imageData: Uint8Array,
    width: number,
    height: number,
    intensity: number
  ): Uint8Array;
  apply_sepia_filter(
    imageData: Uint8Array,
    width: number,
    height: number,
    intensity: number
  ): Uint8Array;
  get_preprocess_stats(originalSize: number, targetSize: number): PreprocessStats;
  set_contrast(contrast: number): void;
  set_cinematic(intensity: number): void;
  set_sepia(intensity: number): void;
  get_contrast(): number;
  get_cinematic(): number;
  get_sepia(): number;
}

export interface PreprocessStats {
  original_size: number;
  target_size: number;
  scale_factor: number;
}

// Preprocessing module types for 256M
export interface WasmModulePreprocess256M {
  memory: WebAssembly.Memory;
  preprocess_image(
    imageData: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Uint8Array;
  preprocess_image_crop(
    imageData: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Uint8Array;
  preprocess_image_for_smolvlm_256m(
    imageData: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Float32Array;
  apply_contrast(
    imageData: Uint8Array,
    width: number,
    height: number,
    contrast: number
  ): Uint8Array;
  apply_cinematic_filter(
    imageData: Uint8Array,
    width: number,
    height: number,
    intensity: number
  ): Uint8Array;
  get_preprocess_stats(originalSize: number, targetSize: number): PreprocessStats;
  set_contrast(contrast: number): void;
  set_cinematic(intensity: number): void;
  get_contrast(): number;
  get_cinematic(): number;
}

// Agent tools module types
export interface WasmModuleAgentTools {
  memory: WebAssembly.Memory;
  calculate(expression: string): string;
  process_text(text: string, operation: string): string;
  get_stats(data: Uint8Array): string;
}

// Fractal chat module types
export interface WasmModuleFractalChat {
  memory: WebAssembly.Memory;
  generate_mandelbrot(width: number, height: number): Uint8Array;
  generate_julia(width: number, height: number): Uint8Array;
  generate_buddhabrot(width: number, height: number): Uint8Array;
  generate_orbit_trap(width: number, height: number): Uint8Array;
  generate_gray_scott(width: number, height: number): Uint8Array;
  generate_lsystem(width: number, height: number): Uint8Array;
  generate_fractal_flame(width: number, height: number): Uint8Array;
  generate_strange_attractor(width: number, height: number): Uint8Array;
}

// Hello WASM template module types
// This is a simplified template for students to learn from
export interface WasmModuleHello {
  memory: WebAssembly.Memory;
  wasm_init(initialCounter: number): void;
  get_counter(): number;
  increment_counter(): void;
  get_message(): string;
  set_message(message: string): void;
}

export interface WasmHello {
  wasmModule: WasmModuleHello | null;
  wasmModulePath: string;
}

// Babylon WFC module types
// Comprehensive type definitions for Wave Function Collapse algorithm

/**
 * Tile type discriminated union for 5 simple tile types
 */
export type TileType =
  | { type: 'grass' }
  | { type: 'building' }
  | { type: 'road' }
  | { type: 'forest' }
  | { type: 'water' };


/**
 * Voronoi seed configuration for region generation
 */
export interface VoronoiSeeds {
  forest: number;
  water: number;
  grass: number;
}

/**
 * Building placement rules
 */
export interface BuildingRules {
  minAdjacentRoads?: number;
  sizeConstraints?: {
    min: number;
    max: number;
  };
}

/**
 * Layout constraints interface for text-to-layout generation
 * 
 * **Learning Point**: This interface represents the parsed output from Qwen
 * chat model. It defines the high-level layout characteristics that will be
 * converted into specific tile pre-constraints for the WFC algorithm.
 * 
 * Extended with function calling support for fine-grained parameter control
 * and specific numeric requests (e.g., "4 buildings", "no forest").
 */
export interface LayoutConstraints {
  buildingDensity: 'sparse' | 'medium' | 'dense';
  clustering: 'clustered' | 'distributed' | 'random';
  grassRatio: number;
  buildingSizeHint: 'small' | 'medium' | 'large';
  voronoiSeeds?: VoronoiSeeds;
  roadDensity?: number;
  rings?: number;
  /** @deprecated Use rings instead */
  maxLayer?: number;
  buildingRules?: BuildingRules;
  buildingCount?: number;
  excludeTileTypes?: Array<TileType['type']>;
  primaryTileType?: TileType['type'];
}

/**
 * WASM module interface for Babylon WFC
 * 
 * **Learning Point**: This interface defines the contract between TypeScript
 * and the Rust WASM module. All functions must match the Rust #[wasm_bindgen]
 * exports exactly.
 */
export interface WasmModuleBabylonWfc {
  memory: WebAssembly.Memory;
  generate_layout(): void;
  get_tile_at(q: number, r: number): number;
  set_pre_constraint(q: number, r: number, tile_type: number): boolean;
  clear_pre_constraints(): void;
  clear_layout(): void;
  get_stats(): string;
  generate_voronoi_regions(
    max_layer: number,
    center_q: number,
    center_r: number,
    forest_seeds: number,
    water_seeds: number,
    grass_seeds: number
  ): string;
  validate_road_connectivity(roads_json: string): boolean;
  hex_astar(
    start_q: number,
    start_r: number,
    goal_q: number,
    goal_r: number,
    valid_terrain_json: string
  ): string;
  build_path_between_roads(
    start_q: number,
    start_r: number,
    end_q: number,
    end_r: number,
    valid_terrain_json: string
  ): string;
  generate_road_network_growing_tree(
    seeds_json: string,
    valid_terrain_json: string,
    occupied_json: string,
    target_count: number
  ): string;
}

/**
 * WASM module interface for babylon-chunks (extends WasmModuleBabylonWfc with version info)
 */
export interface WasmModuleBabylonChunks extends WasmModuleBabylonWfc {
  get_wasm_version(): string;
  calculate_chunk_radius(rings: number): number;
  calculate_chunk_neighbors(center_q: number, center_r: number, rings: number): string;
  find_nearest_neighbor_chunk(
    current_chunk_q: number,
    current_chunk_r: number,
    current_tile_q: number,
    current_tile_r: number,
    rings: number,
    existing_chunks_json: string
  ): string;
  disable_distant_chunks(
    current_chunk_q: number,
    current_chunk_r: number,
    all_chunks_json: string,
    max_distance: number
  ): string;
  batch_get_tile_types(hex_coords_json: string): string;
  calculate_chunk_for_tile(
    tile_q: number,
    tile_r: number,
    rings: number,
    chunk_positions_json: string
  ): string;
  shuffle_array(array_json: string): string;
  count_adjacent_roads(hex_q: number, hex_r: number, road_network_json: string): number;
  get_adjacent_valid_terrain(
    road_network_json: string,
    valid_terrain_json: string,
    occupied_json: string
  ): string;
  generate_building_placement(
    valid_terrain_json: string,
    road_network_json: string,
    occupied_json: string,
    building_rules_json: string,
    target_count: number
  ): string;
  batch_hex_to_world(hex_coords_json: string, hex_size: number): string;
}

/**
 * State management interface for Babylon WFC route handler
 * 
 * **Learning Point**: This follows the same pattern as other route handlers
 * (like WASM_ASTAR). It stores the loaded WASM module and any UI references
 * needed for the route.
 */
export interface WasmBabylonWfc {
  wasmModule: WasmModuleBabylonWfc | null;
  wasmModulePath: string;
}

// Multilingual chat module types
export interface WasmModuleMultilingualChat {
  memory: WebAssembly.Memory;
  detect_language(text: string): string;
  get_text_stats(text: string): string;
  normalize_text(text: string, language: string): string;
}

export interface TextStats {
  wordCount: number;
  characterCount: number;
  characterCountNoSpaces: number;
  sentenceCount: number;
  averageWordLength: number;
}

