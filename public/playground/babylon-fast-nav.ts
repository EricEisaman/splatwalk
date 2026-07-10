// SplatWalk x Babylon.js Playground - walkable Gaussian-splat worlds
// ---------------------------------------------------------------------------
// Paste this whole file into the TypeScript editor at
// https://playground.babylonjs.com (switch the language toggle to TS) and Run.
//
// This is a self-contained, interactive demo of @splatwalk/core
// (https://www.npmjs.com/package/@splatwalk/core) modelled on the SplatWalk
// homepage workbench, with its own in-scene UI (a la babylon-game-starter):
//
//   1. Dynamically import the published WASM core (ESM) from a CDN + init it.
//   2. Load a real Gaussian splat (.ply / .spz) and render it.
//   3. Run `build_room_floor_mesh` (the WASM-side FAST NAV floor path) to extract
//      the walkable floor, aligned to the splat via the flip_y contract.
//   4. Build a Babylon Recast navmesh from that floor, spawn a crowd agent, and
//      let the user click the floor to walk the agent around the splat world.
//
// The UI's "Full screen" toggle uses the babylon-game-starter idiom: inside the
// Playground it tags `#pg-split` so the editor + splitter collapse and the
// `#canvasZone` fills the view (pure CSS - the DOM overlay UI survives, unlike the
// browser Fullscreen API which only keeps the canvas). Outside the Playground it
// falls back to the Fullscreen API. `?fullscreen=true` enters full screen on load.
//
// Entry point: the file is an ES module exporting `class Playground` with a static
// async `CreateScene(engine, canvas)`. The Babylon Playground V2 runner resolves
// the scene factory from the entry module's exports (`Playground.CreateScene` /
// `default.CreateScene` / `createScene` / `default`) and awaits it.
//
// Coordinate contract (see docs/coordinate-alignment.md): the Babylon splat
// loader imports Y-down (negative Y scale) in this left-handed scene, so we read
// `flip_y` straight off the loaded mesh and pass that SAME value into the WASM
// call. The core emits `splatwalk_oriented` geometry (right-handed, +Y up) which,
// combined with the splat's Y-flip, lands directly in the left-handed scene with
// no extra mirror. Never patch alignment on the output - fix the input (flip_y).
//
// CDN / sandbox notes:
//   - The .wasm is served as `application/wasm` with `access-control-allow-origin: *`
//     by jsDelivr/unpkg; the splat + recast.js are fetched from CORS-enabled hosts.
// ---------------------------------------------------------------------------

interface DemoScene {
  readonly title: string;
  readonly url: string;
}

interface SwModule {
  default: () => Promise<unknown>;
  init_splatwalk: () => void;
  splatwalk_version: () => string;
  splatwalk_capabilities: () => string[];
  fast_nav_preset: () => Record<string, unknown>;
  spz_to_ply: (bytes: Uint8Array) => Uint8Array;
  build_room_floor_mesh: (
    bytes: Uint8Array,
    settings: Record<string, unknown>
  ) => {
    mesh: { vertices: Float32Array; indices: Uint32Array; vertex_count: number };
    selected_area: number;
    space: { space: string; handedness: string; up_axis: string };
  };
  build_collision_voxel_boundary?: (
    bytes: Uint8Array,
    settings: Record<string, unknown>
  ) => {
    glb?: Uint8Array;
    mesh: { vertices: Float32Array; indices: Uint32Array; vertex_count: number; face_count: number };
  };
  mesh_to_glb?: (positions: Float32Array, indices: Uint32Array) => Uint8Array;
}

export class Playground {
  private static readonly SPLATWALK_CORE_ESM =
    'https://cdn.jsdelivr.net/npm/@splatwalk/core@0.3.7/wasm_splatwalk.js';
  private static readonly RECAST_JS = 'https://cdn.babylonjs.com/recast.js';

  private static readonly SCENES: DemoScene[] = [
    { title: 'Bedroom', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/bedroom.ply' },
    { title: 'Tropical Compound', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/tropical_compound.ply' },
    { title: 'Industrial Warehouse', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/industrial_warehouse.ply' },
    { title: 'Stairs', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/stairs.spz' },
  ];

  private static readonly ACCENT = '#39ff14';

  public static async CreateScene(
    engine: BABYLON.Engine,
    canvas: HTMLCanvasElement
  ): Promise<BABYLON.Scene> {
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.04, 0.05, 0.07, 1);

    const camera = new BABYLON.ArcRotateCamera(
      'camera', -Math.PI / 2, Math.PI / 3.1, 16, BABYLON.Vector3.Zero(), scene
    );
    camera.attachControl(canvas, true);
    camera.wheelPrecision = 30;
    camera.lowerRadiusLimit = 2;
    camera.upperBetaLimit = Math.PI / 2.05;
    camera.minZ = 0.05;

    const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.95;

    // --- UI (in-scene, game-starter style) -------------------------------
    const ui = Playground.buildUi(canvas);

    // --- Load the WASM core + Recast in parallel -------------------------
    ui.setStatus('Loading SplatWalk core + Recast...', 'busy');
    const sw = (await import(/* webpackIgnore: true */ Playground.SPLATWALK_CORE_ESM)) as SwModule;
    await sw.default();
    sw.init_splatwalk();
    await BABYLON.Tools.LoadScriptAsync(Playground.RECAST_JS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recast = await (globalThis as any).Recast();
    const nav = new BABYLON.RecastJSPlugin(recast);
    console.log('[SplatWalk] core', sw.splatwalk_version(), 'caps:', sw.splatwalk_capabilities().join(','));

    // --- Mutable world state ---------------------------------------------
    const world: {
      splat: BABYLON.AbstractMesh | null;
      collision: BABYLON.Mesh | null;
      collisionGlb: Uint8Array | null;
      floor: BABYLON.Mesh | null;
      navDebug: BABYLON.Mesh | null;
      navData: Uint8Array | null;
      ply: Uint8Array | null;
      splatFlipY: boolean;
      agentRoot: BABYLON.TransformNode | null;
      crowd: BABYLON.ICrowd | null;
      agentIndex: number;
      loading: boolean;
    } = {
      splat: null,
      collision: null,
      collisionGlb: null,
      floor: null,
      navDebug: null,
      navData: null,
      ply: null,
      splatFlipY: false,
      agentRoot: null,
      crowd: null,
      agentIndex: -1,
      loading: false,
    };

    // dev/test hooks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__demo = { ready: false, status: '', sceneTitle: '', floorArea: 0, navTriangles: 0, agentSpawned: false };
    const setDemo = (patch: Record<string, unknown>): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.assign((globalThis as any).__demo, patch);
    };

    const disposeWorld = (): void => {
      if (world.crowd) { world.crowd.dispose(); world.crowd = null; }
      world.agentIndex = -1;
      world.agentRoot?.dispose(false, true); // disposes child capsule + ring
      for (const m of [world.splat, world.collision, world.floor, world.navDebug]) m?.dispose();
      world.splat = world.collision = world.floor = world.navDebug = null;
      world.collisionGlb = world.navData = world.ply = null;
      world.splatFlipY = false;
      world.agentRoot = null;
    };

    const downloadBytes = (bytes: Uint8Array, filename: string, type: string): void => {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };

    const generateCollisionBoundary = (): { mesh: { vertices: Float32Array; indices: Uint32Array; vertex_count: number; face_count: number }; glb?: Uint8Array } | null => {
      if (!world.ply) {
        ui.setStatus('Load a scene before generating collision.', 'warn');
        return null;
      }
      if (!sw.build_collision_voxel_boundary) {
        ui.setStatus('This published @splatwalk/core build does not expose collision boundary export yet.', 'warn');
        return null;
      }
      world.collision?.dispose();
      ui.setStatus('Generating collision voxel boundary...', 'busy');
      const settings = Object.assign({}, sw.fast_nav_preset(), {
        mode: 2,
        flip_y: world.splatFlipY,
        emit_glb: true,
        collision_mesh_mode: 'faces',
      });
      const result = sw.build_collision_voxel_boundary(world.ply, settings);
      const mesh = new BABYLON.Mesh('collision_boundary', scene);
      const vd = new BABYLON.VertexData();
      vd.positions = result.mesh.vertices;
      vd.indices = result.mesh.indices;
      vd.applyToMesh(mesh);
      const mat = new BABYLON.StandardMaterial('collisionMat', scene);
      mat.diffuseColor = new BABYLON.Color3(0, 0.85, 1);
      mat.emissiveColor = new BABYLON.Color3(0, 0.2, 0.3);
      mat.alpha = 0.28;
      mat.backFaceCulling = false;
      mesh.material = mat;
      mesh.setEnabled(ui.toggles.collision.checked);
      mesh.isPickable = false;
      world.collision = mesh;
      world.collisionGlb = result.glb ?? null;
      ui.setStatus(`Collision boundary ready (${result.mesh.face_count} faces).`, 'ok');
      return result;
    };

    const frameWorld = (mesh: BABYLON.AbstractMesh): void => {
      mesh.computeWorldMatrix(true);
      const ext = scene.getWorldExtends();
      const center = ext.min.add(ext.max).scale(0.5);
      camera.setTarget(center);
      camera.radius = Math.max(6, ext.max.subtract(ext.min).length() * 0.65);
    };

    // Top-down-over-the-agent framing (like the workbench's focusOnPlayer): drops
    // the camera just BELOW the splat ceiling looking straight down, so we see the
    // room interior (floor, navmesh, agent) instead of the roof from outside.
    const framePlayer = (): void => {
      if (!world.crowd || world.agentIndex < 0 || !world.splat) return;
      const p = world.crowd.getAgentPosition(world.agentIndex);
      world.splat.computeWorldMatrix(true);
      const ceilingY = world.splat.getBoundingInfo().boundingBox.maximumWorld.y;
      const camHeight = Math.min(Math.max(ceilingY - 0.35, p.y + 1.8), p.y + 5);
      camera.alpha = -Math.PI / 2;
      camera.beta = 0.12; // near top-down so walls/ceiling don't occlude
      camera.setTarget(new BABYLON.Vector3(p.x, p.y, p.z));
      camera.radius = Math.max(2.5, camHeight - p.y);
    };

    const loadScene = async (sceneDef: DemoScene): Promise<void> => {
      if (world.loading) return;
      world.loading = true;
      ui.setControlsEnabled(false);
      try {
        disposeWorld();
        ui.setStatus(`Loading "${sceneDef.title}"...`, 'busy');
        setDemo({ ready: false, sceneTitle: sceneDef.title, agentSpawned: false, floorArea: 0, navTriangles: 0 });

        // 1) Fetch + normalize to PLY (Babylon's loader only ingests PLY). `.spz`
        //    is gzip-compressed, so gunzip in-browser before the WASM spz->ply.
        const raw = new Uint8Array(await (await fetch(sceneDef.url)).arrayBuffer());
        const isSpz = sceneDef.url.toLowerCase().endsWith('.spz');
        // Keep the PLY bytes backed by a plain ArrayBuffer (never SharedArrayBuffer)
        // so they satisfy `BlobPart` under TS 5.7+'s generic typed arrays: `raw` is
        // already ArrayBuffer-backed, and we copy `spz_to_ply`'s output into a fresh
        // Uint8Array. `ply` is then inferred as `Uint8Array<ArrayBuffer>` with no
        // version-specific generic annotation (the Playground may run an older TS).
        let ply = raw;
        if (isSpz) {
          const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
          const spzBytes = new Uint8Array(await new Response(stream).arrayBuffer());
          ply = new Uint8Array(sw.spz_to_ply(spzBytes));
        }
        world.ply = ply;

        // 2) Render the Gaussian splat.
        ui.setStatus('Rendering splat...', 'busy');
        const objectUrl = URL.createObjectURL(new Blob([ply], { type: 'application/octet-stream' }));
        const loaded = await BABYLON.SceneLoader.ImportMeshAsync('', '', objectUrl, scene, null, '.ply');
        URL.revokeObjectURL(objectUrl);
        const splat = loaded.meshes[0];
        splat.computeWorldMatrix(true);
        world.splat = splat;
        splat.setEnabled(ui.toggles.splat.checked);
        splat.isPickable = false; // never block floor/navmesh picks for click-to-move
        frameWorld(splat);

        // 3) FAST NAV floor. flip_y comes straight off the loaded splat.
        const flip_y = !!splat.scaling && splat.scaling.y < 0;
        world.splatFlipY = flip_y;
        ui.setStatus('Extracting walkable floor (FAST NAV)...', 'busy');
        const settings = Object.assign({}, sw.fast_nav_preset(), { mode: 2, flip_y });
        const floorResult = sw.build_room_floor_mesh(ply, settings);
        console.log('[SplatWalk] floor area =', floorResult.selected_area.toFixed(2), 'm2 - verts =', floorResult.mesh.vertex_count);

        const floor = new BABYLON.Mesh('splatwalk_floor', scene);
        const vd = new BABYLON.VertexData();
        vd.positions = floorResult.mesh.vertices;
        vd.indices = floorResult.mesh.indices;
        vd.applyToMesh(floor);
        const floorMat = new BABYLON.StandardMaterial('floorMat', scene);
        floorMat.diffuseColor = new BABYLON.Color3(0.13, 0.85, 0.05);
        floorMat.emissiveColor = new BABYLON.Color3(0.04, 0.26, 0.02);
        floorMat.alpha = 0.45;
        floorMat.backFaceCulling = false;
        floor.material = floorMat;
        // Keep the floor enabled + pickable always (it is the click-to-move target);
        // the toggle only controls its visibility.
        floor.isVisible = ui.toggles.floor.checked;
        floor.isPickable = true;
        world.floor = floor;
        ui.setHud('area', `${floorResult.selected_area.toFixed(1)} m2`);
        setDemo({ floorArea: floorResult.selected_area });

        // 4) Recast navmesh from the floor mesh.
        ui.setStatus('Building navmesh...', 'busy');
        nav.createNavMesh([floor], {
          cs: 0.2, ch: 0.2, walkableSlopeAngle: 45, walkableHeight: 1.0,
          walkableClimb: 1, walkableRadius: 1, maxEdgeLen: 12, maxSimplificationError: 1.3,
          minRegionArea: 2, mergeRegionArea: 20, maxVertsPerPoly: 6,
          detailSampleDist: 6, detailSampleMaxError: 1,
        });
        const navDebug = nav.createDebugNavMesh(scene);
        navDebug.name = 'navmesh_debug';
        navDebug.position.y += 0.02;
        const navMat = new BABYLON.StandardMaterial('navMat', scene);
        navMat.emissiveColor = new BABYLON.Color3(0.1, 0.55, 1.0);
        navMat.diffuseColor = new BABYLON.Color3(0.1, 0.4, 1.0);
        navMat.alpha = 0.35;
        navMat.backFaceCulling = false;
        navDebug.material = navMat;
        navDebug.setEnabled(ui.toggles.navmesh.checked);
        navDebug.isPickable = true;
        world.navDebug = navDebug;
        world.navData = typeof (nav as unknown as { getNavmeshData?: () => Uint8Array }).getNavmeshData === 'function'
          ? (nav as unknown as { getNavmeshData: () => Uint8Array }).getNavmeshData()
          : null;
        const navTris = (navDebug.getIndices()?.length ?? 0) / 3;
        setDemo({ navTriangles: navTris });

        if (navTris < 1) {
          ui.setStatus('Floor extracted, but navmesh was empty for this scene.', 'warn');
          setDemo({ ready: true });
          return;
        }

        // 5) Crowd + player agent. The agent is a TransformNode the crowd drives;
        //    the capsule/ring are children offset so the capsule rests ON the floor.
        const fext = floor.getBoundingInfo().boundingBox;
        const floorCenter = fext.centerWorld;
        const spawn = nav.getClosestPoint(floorCenter);
        const crowd = nav.createCrowd(8, 0.5, scene);
        world.crowd = crowd;

        const agentRoot = new BABYLON.TransformNode('agentRoot', scene);
        world.agentRoot = agentRoot;
        const agent = BABYLON.MeshBuilder.CreateCapsule('agent', { height: 1.6, radius: 0.35 }, scene);
        const agentMat = new BABYLON.StandardMaterial('agentMat', scene);
        agentMat.emissiveColor = BABYLON.Color3.FromHexString(Playground.ACCENT);
        agentMat.diffuseColor = BABYLON.Color3.FromHexString(Playground.ACCENT);
        agent.material = agentMat;
        agent.parent = agentRoot;
        agent.position.y = 0.8;
        const ring = BABYLON.MeshBuilder.CreateTorus('agentRing', { diameter: 1.3, thickness: 0.06, tessellation: 24 }, scene);
        const ringMat = new BABYLON.StandardMaterial('ringMat', scene);
        ringMat.emissiveColor = BABYLON.Color3.FromHexString(Playground.ACCENT);
        // Keep the ring OPAQUE (like the capsule): opaque meshes write depth, so
        // the Gaussian splat depth-tests against them and occludes correctly
        // (hidden behind splat walls/furniture, visible on the open floor).
        ring.material = ringMat;
        ring.parent = agentRoot;
        ring.position.y = 0.04;

        world.agentIndex = crowd.addAgent(spawn, {
          radius: 0.35, height: 1.6, maxAcceleration: 20, maxSpeed: 4.5,
          collisionQueryRange: 1.0, pathOptimizationRange: 0.6, separationWeight: 1.0,
        }, agentRoot);
        setDemo({ agentSpawned: true });

        framePlayer();
        ui.setStatus('Ready - click the floor to walk the agent.', 'ok');
        ui.showHint(true);
        setDemo({ ready: true });
      } catch (err) {
        const failure = err as { reason?: string; message?: string };
        console.error('[SplatWalk] scene load failed:', failure.reason ?? '', failure.message ?? err);
        ui.setStatus(`Failed: ${failure.reason ?? failure.message ?? String(err)}`, 'warn');
        setDemo({ ready: true });
      } finally {
        world.loading = false;
        ui.setControlsEnabled(true);
      }
    };

    // --- Per-frame: drive crowd, follow agent, update HUD ----------------
    scene.onBeforeRenderObservable.add(() => {
      const dt = engine.getDeltaTime() / 1000;
      if (world.crowd) world.crowd.update(dt);
      if (world.agentRoot && world.agentIndex >= 0 && world.crowd) {
        const p = world.crowd.getAgentPosition(world.agentIndex);
        camera.setTarget(BABYLON.Vector3.Lerp(camera.getTarget(), p, 0.06));
        ui.setHud('pos', `${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
      }
      ui.setHud('fps', `${engine.getFps().toFixed(0)}`);
    });

    // --- Click-to-move (pick only the navmesh / floor, never the splat) ---
    scene.onPointerObservable.add((pi) => {
      if (pi.type !== BABYLON.PointerEventTypes.POINTERTAP) return;
      if (!world.crowd || world.agentIndex < 0) return;
      const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === world.navDebug || m === world.floor);
      if (!pick?.hit || !pick.pickedPoint) return;
      const target = nav.getClosestPoint(pick.pickedPoint);
      world.crowd.agentGoto(world.agentIndex, target);
      ui.pingTarget(target, scene);
    });

    // --- Wire UI controls ------------------------------------------------
    ui.onSceneChange((index) => { void loadScene(Playground.SCENES[index]); });
    ui.toggles.splat.addEventListener('change', () => world.splat?.setEnabled(ui.toggles.splat.checked));
    ui.toggles.collision.addEventListener('change', () => world.collision?.setEnabled(ui.toggles.collision.checked));
    ui.toggles.floor.addEventListener('change', () => { if (world.floor) world.floor.isVisible = ui.toggles.floor.checked; });
    ui.toggles.navmesh.addEventListener('change', () => world.navDebug?.setEnabled(ui.toggles.navmesh.checked));
    ui.onRecenter(() => {
      if (world.crowd && world.agentIndex >= 0) framePlayer();
      else if (world.splat) frameWorld(world.splat);
    });
    ui.onExportNavmesh(() => {
      if (!world.navData) {
        ui.setStatus('No navmesh binary is available yet.', 'warn');
        return;
      }
      downloadBytes(world.navData, 'splatwalk.nav', 'application/octet-stream');
      ui.setStatus('Navmesh download started.', 'ok');
    });
    ui.onGenerateCollision(() => { generateCollisionBoundary(); });
    ui.onExportCollision(() => {
      const result = world.collision ? null : generateCollisionBoundary();
      const mesh = result?.mesh ?? (world.collision ? {
        vertices: world.collision.getVerticesData(BABYLON.VertexBuffer.PositionKind) as Float32Array,
        indices: new Uint32Array(world.collision.getIndices() ?? []),
        vertex_count: 0,
        face_count: 0,
      } : null);
      if (!mesh) return;
      const glb = world.collisionGlb ?? (sw.mesh_to_glb ? sw.mesh_to_glb(mesh.vertices, mesh.indices) : null);
      if (!glb) {
        ui.setStatus('This @splatwalk/core build cannot serialize collision GLB yet.', 'warn');
        return;
      }
      downloadBytes(glb, 'splatwalk.collision.glb', 'model/gltf-binary');
      ui.setStatus('Collision mesh download started.', 'ok');
    });

    // --- Full screen (babylon-game-starter idiom) ------------------------
    // Inside the Babylon Playground we "hijack" the split: tag #pg-split so the
    // editor + splitter collapse and #canvasZone fills the view (pure CSS, no
    // browser Fullscreen API, so this overlay UI survives). Outside the
    // Playground (the local harness / standalone) we fall back to the
    // Fullscreen API on the canvas container.
    const fsContainer = canvas.parentElement ?? document.body;
    const isFullscreen = (): boolean => {
      const pg = document.getElementById('pg-split');
      if (pg) return pg.classList.contains('sw-pg-fs');
      return document.fullscreenElement != null;
    };
    const resizeSoon = (): void => {
      const r = (): void => engine.resize();
      r();
      requestAnimationFrame(() => { r(); requestAnimationFrame(r); });
      setTimeout(r, 160);
    };
    const setFullscreen = async (on: boolean): Promise<void> => {
      const pg = document.getElementById('pg-split');
      if (pg) {
        pg.classList.toggle('sw-pg-fs', on);
      } else {
        try {
          if (on && !document.fullscreenElement) await fsContainer.requestFullscreen();
          else if (!on && document.fullscreenElement) await document.exitFullscreen();
        } catch (err) {
          console.warn('[SplatWalk] fullscreen needs a user gesture:', (err as Error).message);
        }
      }
      resizeSoon();
      ui.setFullscreenChecked(isFullscreen());
    };
    ui.onFullscreen((on) => { void setFullscreen(on); });
    document.addEventListener('fullscreenchange', () => ui.setFullscreenChecked(isFullscreen()));

    // ?fullscreen=true|1|yes -> enter full screen on load. The Playground split-
    // hijack is pure CSS (works on load); the Fullscreen API fallback needs a
    // user gesture, so arm a one-shot pointer handler if the browser blocks it.
    const fsParam = (new URLSearchParams(window.location.search).get('fullscreen') ?? '').toLowerCase();
    if (fsParam === '1' || fsParam === 'true' || fsParam === 'yes') {
      void setFullscreen(true).then(() => {
        if (!isFullscreen() && !document.getElementById('pg-split')) {
          const once = (): void => { window.removeEventListener('pointerdown', once); void setFullscreen(true); };
          window.addEventListener('pointerdown', once, { once: true });
        }
      });
    }

    // Kick off the first scene.
    void loadScene(Playground.SCENES[0]);
    return scene;
  }

  // =====================================================================
  // UI: dark glassy DOM overlay on the canvas parent (babylon-game-starter
  // idiom). Returns control element refs + small imperative helpers.
  // =====================================================================
  private static buildUi(canvas: HTMLCanvasElement): {
    setStatus: (text: string, kind?: 'busy' | 'ok' | 'warn') => void;
    setHud: (id: 'area' | 'pos' | 'fps', value: string) => void;
    showHint: (visible: boolean) => void;
    pingTarget: (p: BABYLON.Vector3, scene: BABYLON.Scene) => void;
    setControlsEnabled: (enabled: boolean) => void;
    onSceneChange: (cb: (index: number) => void) => void;
    onRecenter: (cb: () => void) => void;
    onExportNavmesh: (cb: () => void) => void;
    onGenerateCollision: (cb: () => void) => void;
    onExportCollision: (cb: () => void) => void;
    onFullscreen: (cb: (on: boolean) => void) => void;
    setFullscreenChecked: (on: boolean) => void;
    toggles: { splat: HTMLInputElement; collision: HTMLInputElement; floor: HTMLInputElement; navmesh: HTMLInputElement };
  } {
    const parent = canvas.parentElement ?? document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

    const ACCENT = Playground.ACCENT;
    const styleId = 'sw-demo-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .sw-panel{position:absolute;top:14px;left:14px;z-index:30;width:248px;
          font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8eefc;
          background:rgba(10,13,18,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
          border:1px solid rgba(255,255,255,.12);border-radius:14px;
          box-shadow:0 10px 34px rgba(0,0,0,.5);padding:14px;animation:sw-fade .35s ease-out}
        @keyframes sw-fade{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
        .sw-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;letter-spacing:.2px}
        .sw-dot{width:9px;height:9px;border-radius:50%;background:${ACCENT};box-shadow:0 0 10px ${ACCENT}}
        .sw-sub{font-size:10px;color:#8aa0c4;margin:2px 0 12px;letter-spacing:.3px;text-transform:uppercase}
        .sw-status{font-size:11.5px;line-height:1.4;min-height:30px;padding:8px 10px;border-radius:9px;
          background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);margin-bottom:12px}
        .sw-status.busy{color:#cfe0ff}.sw-status.ok{color:${ACCENT}}.sw-status.warn{color:#ff8f6b}
        .sw-status .sw-spin{display:inline-block;width:9px;height:9px;margin-right:7px;border-radius:50%;
          border:2px solid rgba(255,255,255,.25);border-top-color:${ACCENT};animation:sw-rot .7s linear infinite;vertical-align:-1px}
        @keyframes sw-rot{to{transform:rotate(360deg)}}
        .sw-hud{display:flex;gap:6px;margin-bottom:12px}
        .sw-chip{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);
          border-radius:9px;padding:6px 4px;text-align:center}
        .sw-chip .k{font-size:8.5px;color:#8aa0c4;text-transform:uppercase;letter-spacing:.4px}
        .sw-chip .v{font-size:13px;font-weight:700;color:#fff;margin-top:1px}
        .sw-label{font-size:9.5px;color:#8aa0c4;text-transform:uppercase;letter-spacing:.4px;margin:0 0 5px 2px}
        .sw-select{width:100%;background:rgba(255,255,255,.06);color:#fff;border:1px solid rgba(255,255,255,.14);
          border-radius:9px;padding:9px 10px;font-size:12.5px;font-weight:600;cursor:pointer;outline:none;margin-bottom:12px}
        .sw-select:disabled{opacity:.5;cursor:default}
        .sw-toggles{display:flex;flex-direction:column;gap:7px;margin-bottom:12px}
        .sw-toggle{display:flex;align-items:center;gap:8px;font-size:12px;color:#cfe0ff;cursor:pointer;user-select:none}
        .sw-toggle input{accent-color:${ACCENT};width:15px;height:15px;cursor:pointer}
        .sw-btn{width:100%;background:${ACCENT};color:#08120a;border:none;border-radius:9px;
          padding:9px;font-size:12px;font-weight:800;letter-spacing:.3px;cursor:pointer;transition:filter .15s}
        .sw-btn:hover{filter:brightness(1.08)}
        .sw-btn.secondary{background:rgba(255,255,255,.08);color:#e8eefc;border:1px solid rgba(255,255,255,.14);margin-top:7px}
        .sw-hint{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);z-index:30;
          background:rgba(10,13,18,.78);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);
          color:#e8eefc;font-family:system-ui,sans-serif;font-size:12px;font-weight:600;
          padding:8px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.45);display:none;
          animation:sw-fade .3s ease-out}
        .sw-hint b{color:${ACCENT}}
        /* Full-screen "hijack" of the Babylon Playground split (game-starter idiom).
           #pg-split is a CSS GRID with FIXED-PIXEL tracks (e.g. "597px 6px 597px"),
           so merely hiding the editor leaves its 597px track reserved and the canvas
           never grows. We instead drop the grid entirely (display:block), hide the
           editor + splitter, and let #canvasZone fill 100% - then engine.resize()
           matches the backing store. Pure CSS, so this DOM overlay UI stays visible
           (the panel lives inside #canvasZone, so it tracks the full render area). */
        #pg-split.sw-pg-fs{display:block !important}
        #pg-split.sw-pg-fs > :not(#canvasZone){display:none !important}
        #pg-split.sw-pg-fs > #canvasZone{width:100% !important;height:100% !important}
        @media (max-width:560px){.sw-panel{width:calc(100vw - 28px);max-height:60vh;overflow:auto}}
      `;
      document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.className = 'sw-panel';
    panel.innerHTML = `
      <div class="sw-brand"><span class="sw-dot"></span>SplatWalk &times; Babylon</div>
      <div class="sw-sub">Walkable Gaussian-splat world</div>
      <div class="sw-status busy" id="sw-status">Booting...</div>
      <div class="sw-hud">
        <div class="sw-chip"><div class="k">Floor</div><div class="v" id="sw-area">-</div></div>
        <div class="sw-chip"><div class="k">Agent</div><div class="v" id="sw-pos">-</div></div>
        <div class="sw-chip"><div class="k">FPS</div><div class="v" id="sw-fps">-</div></div>
      </div>
      <div class="sw-label">Scene</div>
      <select class="sw-select" id="sw-scene">${Playground.SCENES.map((s, i) => `<option value="${i}">${s.title}</option>`).join('')}</select>
      <div class="sw-toggles">
        <label class="sw-toggle"><input type="checkbox" id="sw-t-splat" checked> Gaussian splat</label>
        <label class="sw-toggle"><input type="checkbox" id="sw-t-collision" checked> Collision boundary</label>
        <label class="sw-toggle"><input type="checkbox" id="sw-t-floor"> Walkable floor</label>
        <label class="sw-toggle"><input type="checkbox" id="sw-t-nav" checked> Navmesh</label>
        <label class="sw-toggle"><input type="checkbox" id="sw-t-fs"> Full screen</label>
      </div>
      <button class="sw-btn" id="sw-recenter">RECENTER CAMERA</button>
      <button class="sw-btn secondary" id="sw-export-nav">EXPORT NAVMESH</button>
      <button class="sw-btn secondary" id="sw-generate-collision">GENERATE COLLISION</button>
      <button class="sw-btn secondary" id="sw-export-collision">EXPORT COLLISION GLB</button>
    `;
    parent.appendChild(panel);

    const hint = document.createElement('div');
    hint.className = 'sw-hint';
    hint.innerHTML = 'Click the <b>floor</b> to walk';
    parent.appendChild(hint);

    const $ = (id: string): HTMLElement => panel.querySelector(`#${id}`) as HTMLElement;
    const statusEl = $('sw-status');
    const sceneSel = $('sw-scene') as HTMLSelectElement;
    const toggles = {
      splat: $('sw-t-splat') as HTMLInputElement,
      collision: $('sw-t-collision') as HTMLInputElement,
      floor: $('sw-t-floor') as HTMLInputElement,
      navmesh: $('sw-t-nav') as HTMLInputElement,
    };
    const fsToggle = $('sw-t-fs') as HTMLInputElement;

    return {
      setStatus: (text, kind = 'busy') => {
        statusEl.className = `sw-status ${kind}`;
        statusEl.innerHTML = (kind === 'busy' ? '<span class="sw-spin"></span>' : '') + text;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__demo && ((globalThis as any).__demo.status = text);
      },
      setHud: (id, value) => { ($(`sw-${id}`)).textContent = value; },
      showHint: (visible) => { hint.style.display = visible ? 'block' : 'none'; },
      pingTarget: (p, scene) => {
        const disc = BABYLON.MeshBuilder.CreateDisc('ping', { radius: 0.45, tessellation: 24 }, scene);
        disc.rotation.x = Math.PI / 2;
        disc.position.set(p.x, p.y + 0.04, p.z);
        const m = new BABYLON.StandardMaterial('pingMat', scene);
        m.emissiveColor = BABYLON.Color3.FromHexString(Playground.ACCENT);
        m.alpha = 0.85; m.backFaceCulling = false; disc.material = m;
        let life = 0;
        const obs = scene.onBeforeRenderObservable.add(() => {
          life += scene.getEngine().getDeltaTime() / 1000;
          const k = Math.min(1, life / 0.6);
          disc.scaling.setAll(1 + k * 1.8);
          m.alpha = 0.85 * (1 - k);
          if (k >= 1) { scene.onBeforeRenderObservable.remove(obs); disc.dispose(); }
        });
      },
      setControlsEnabled: (enabled) => { sceneSel.disabled = !enabled; },
      onSceneChange: (cb) => sceneSel.addEventListener('change', () => cb(Number(sceneSel.value))),
      onRecenter: (cb) => $('sw-recenter').addEventListener('click', cb),
      onExportNavmesh: (cb) => $('sw-export-nav').addEventListener('click', cb),
      onGenerateCollision: (cb) => $('sw-generate-collision').addEventListener('click', cb),
      onExportCollision: (cb) => $('sw-export-collision').addEventListener('click', cb),
      onFullscreen: (cb) => fsToggle.addEventListener('change', () => cb(fsToggle.checked)),
      setFullscreenChecked: (on) => { fsToggle.checked = on; },
      toggles,
    };
  }
}
