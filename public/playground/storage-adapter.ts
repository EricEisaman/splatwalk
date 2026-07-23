/**
 * Babylon.js Playground (TypeScript) — streamed SOG via CDN lod-meta.json.
 *
 * Paste into https://playground.babylonjs.com (TypeScript mode).
 * Requires a Babylon build with SPLAT / GaussianSplattingStream (9.16+).
 *
 * Always pass maxResidentSplats / memoryBudgetMb so city-scale catalogs
 * (35M–200M+) do not allocate a full-dataset GPU work buffer. AppendSceneAsync
 * alone cannot pass those options through SPLATFileLoader.
 *
 * Options mirror SplatWalk Storage Adapter → Stream settings (PlayCanvas Medium).
 * The Playground host owns `engine` (WebGL or WebGPU); this paste does not toggle it.
 */
class Playground {
  public static CreateScene(engine: BABYLON.Engine, canvas: HTMLCanvasElement): BABYLON.Scene {
    var scene = new BABYLON.Scene(engine);
    var camera = new BABYLON.FreeCamera('camera1', new BABYLON.Vector3(0, 5, -10), scene);
    camera.setTarget(BABYLON.Vector3.Zero());
    camera.attachControl(canvas, true);

    var light = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), scene);
    light.intensity = 0.7;

    const rootUrl = 'https://code.playcanvas.com/examples_data/example_roman_parish_02/';
    void fetch(`${rootUrl}lod-meta.json`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`lod-meta fetch failed (${response.status})`);
        }
        return response.json();
      })
      .then((meta) => {
        new BABYLON.GaussianSplattingStream('GaussianSplattingStream', meta, rootUrl, scene, {
          maxResidentSplats: 4_000_000,
          memoryBudgetMb: 384,
          maxDetailLod: 0,
          lodBaseDistance: 5,
          lodMultiplier: 3,
          lodBehindPenalty: 1,
          frustumCulling: true,
          maxConcurrentDownloads: 2,
          maxDecodesPerFrame: 1,
          evictionCooldownFrames: 100,
        });
      })
      .catch((error) => {
        console.error(error);
      });

    return scene;
  }
}
export { Playground };
