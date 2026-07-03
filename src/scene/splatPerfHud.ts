/**
 * Minimal FPS / frame-time HUD for SplatWalk Babylon showcase perf isolation.
 * Enabled when URL contains ?perf=1 (perf/frame-sdp-7-2-baseline branch).
 */

export interface SplatPerfHudSnapshot {
  fps: number;
  frameMs: number;
  splatLoadMs: number | null;
  splatMeshCount: number;
}

export class SplatPerfHud {
  private _el: HTMLDivElement | null = null;
  private _enabled = false;
  private _lastFrameAt = performance.now();
  private _frameMsSamples: number[] = [];
  private _lastSplatLoadMs: number | null = null;
  private _splatMeshCount = 0;

  constructor() {
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    this._enabled = params.get("perf") === "1";
    if (!this._enabled) {
      return;
    }
    this._el = document.createElement("div");
    this._el.id = "splat-perf-hud";
    this._el.style.cssText =
      "position:fixed;top:8px;right:8px;z-index:9999;font:12px/1.4 monospace;color:#0f0;background:rgba(0,0,0,0.72);padding:8px 10px;border-radius:4px;pointer-events:none;white-space:pre;";
    document.body.appendChild(this._el);
  }

  recordFrame(): void {
    if (!this._enabled) {
      return;
    }
    const now = performance.now();
    const frameMs = now - this._lastFrameAt;
    this._lastFrameAt = now;
    this._frameMsSamples.push(frameMs);
    if (this._frameMsSamples.length > 60) {
      this._frameMsSamples.shift();
    }
    this._render();
  }

  recordSplatLoad(durationMs: number, meshCount: number): void {
    if (!this._enabled) {
      return;
    }
    this._lastSplatLoadMs = durationMs;
    this._splatMeshCount = meshCount;
    this._render();
  }

  snapshot(): SplatPerfHudSnapshot {
    const avgFrameMs =
      this._frameMsSamples.length > 0
        ? this._frameMsSamples.reduce((a, b) => a + b, 0) /
          this._frameMsSamples.length
        : 0;
    return {
      fps: avgFrameMs > 0 ? 1000 / avgFrameMs : 0,
      frameMs: avgFrameMs,
      splatLoadMs: this._lastSplatLoadMs,
      splatMeshCount: this._splatMeshCount,
    };
  }

  dispose(): void {
    this._el?.remove();
    this._el = null;
  }

  private _render(): void {
    if (!this._el) {
      return;
    }
    const snap = this.snapshot();
    const loadLine =
      snap.splatLoadMs !== null
        ? `load ${snap.splatLoadMs.toFixed(0)}ms meshes ${snap.splatMeshCount}`
        : "load —";
    this._el.textContent = [
      "SplatWalk perf",
      `fps ${snap.fps.toFixed(1)} (${snap.frameMs.toFixed(1)}ms)`,
      loadLine,
    ].join("\n");
  }
}

/** Expose snapshot for automated probes (same pattern as Frame __frameSplatPerf). */
export function installSplatWalkPerfProbe(hud: SplatPerfHud): void {
  (
    globalThis as { __splatWalkPerf?: () => SplatPerfHudSnapshot }
  ).__splatWalkPerf = () => hud.snapshot();
}
