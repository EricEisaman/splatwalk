/// <reference lib="webworker" />
import init, {
    init_splatwalk,
    build_walkable_ground_field,
    convert_splat_to_mesh,
    convert_splat_to_navmesh_basis,
    get_splat_bounds,
    suggest_region,
} from '../../pkg/wasm_splatwalk/wasm_splatwalk.js';

const ctx: Worker = self as unknown as Worker;

// The Rust side emits diagnostics via `console::log`. Forward all worker console
// output to the main thread so existing log capture (homepage System Logs) keeps
// working now that the WASM runs off the main thread.
const forward = (level: 'log' | 'warn' | 'error', args: unknown[]): void => {
    const message = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    // Progress ticks are emitted by Rust as "@progress <stage> [<fraction>]" and
    // routed to a dedicated channel so they drive the indicator, not the log panel.
    if (message.startsWith('@progress ')) {
        const parts = message.slice('@progress '.length).trim().split(/\s+/);
        const stage = parts[0] ?? 'processing';
        const fraction = parts.length > 1 ? Number(parts[1]) : NaN;
        ctx.postMessage({ kind: 'progress', stage, fraction: Number.isFinite(fraction) ? fraction : null });
        return;
    }
    ctx.postMessage({ kind: 'log', level, message });
};
console.log = (...args: unknown[]): void => forward('log', args);
console.warn = (...args: unknown[]): void => forward('warn', args);
console.error = (...args: unknown[]): void => forward('error', args);

let ready = false;
// The active splat bytes are sent once per file (transferred) and reused for
// every subsequent op, so we never re-copy the (potentially huge) buffer.
let currentData: Uint8Array | null = null;

ctx.onmessage = async (e: MessageEvent): Promise<void> => {
    const { id, type, payload } = e.data;
    try {
        if (type === 'init') {
            if (!ready) {
                await init();
                init_splatwalk();
                ready = true;
            }
            ctx.postMessage({ kind: 'result', id, ok: true, result: null });
            return;
        }

        if (!ready) throw new Error('SplatWalk WASM not initialized');

        if (type === 'loadSplat') {
            currentData = new Uint8Array(payload.data as ArrayBuffer);
            ctx.postMessage({ kind: 'result', id, ok: true, result: null });
            return;
        }

        if (!currentData) throw new Error('No splat loaded in worker');

        const settings = payload.settings;
        let result: unknown;
        switch (type) {
            case 'getSplatBounds':
                result = get_splat_bounds(currentData, settings);
                break;
            case 'suggestRegion':
                result = suggest_region(currentData, settings);
                break;
            case 'convertSplatToMesh':
                result = convert_splat_to_mesh(currentData, settings);
                break;
            case 'convertSplatToNavmeshBasis':
                result = convert_splat_to_navmesh_basis(currentData, settings);
                break;
            case 'buildWalkableGroundField':
                result = build_walkable_ground_field(currentData, settings);
                break;
            default:
                throw new Error(`Unknown splat worker op: ${type}`);
        }
        ctx.postMessage({ kind: 'result', id, ok: true, result });
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.postMessage({ kind: 'result', id, ok: false, error });
    }
};
