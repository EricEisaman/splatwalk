# Babylon FastNav Playground harness

Local harness for [`babylon-fast-nav.ts`](./babylon-fast-nav.ts). Use **Download FastNav playground** to get a Babylon Playground V2 `playground.json`.

## Renderer (WebGL / WebGPU)

The **Playground host** owns the `Engine`. This paste does not create or toggle the renderer.

- In [Babylon Playground](https://playground.babylonjs.com), pick WebGPU or WebGL in the host settings when available.
- For SplatWalk’s Vue demos, use the in-app WebGPU / WebGL toggle or `?renderer=webgpu|webgl`.
- Gaussian splat work-buffer MRT on WebGPU needs a raised `maxColorAttachmentBytesPerSample` (SplatWalk’s `createBabylonEngine` uses `setMaximumLimits: true`).
