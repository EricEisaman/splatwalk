# SOG LOD Storage Adapter System

A clean, unified interface for streaming Spatially Ordered Gaussians (SOG) LOD splats from various backends with secure credential management.

## Renderer (Babylon host)

The Storage Adapter playground can prefer **WebGPU** or **WebGL** (`Stream settings`
toggle, or `?renderer=webgpu|webgl`). WebGPU uses `setMaximumLimits` for the GS
work-buffer MRT and falls back to WebGL when unsupported or below the color-
attachment budget. Engine creation: `src/scene/createBabylonEngine.ts`. The WASM
core stays renderer-agnostic. Use **Download Storage Adapter kit** for the
Playground paste zip (`/integration-kits/splatwalk-storage-adapter.zip`, v0.6.4).
**Oval interior** arms `cameraSelect` (preset fly view + AABB offsets) after settle
and restores that view after nav. **Region and prune** exposes editable offsets and
**Apply select region from camera**. Other CDN examples do not force `cameraSelect`.

## Navigation from stream (collision / Fast Nav)

After a CDN or zip stream is loaded in the Storage Adapter playground
(`/storage-adapter`):

1. Expand **Navigation from stream**.
2. **Generate collision** — materializes coarsest-LOD PLY, runs
   `build_collision_voxel_boundary`, shows the boundary on the Viewer.
3. **Run Fast Nav** — same materialize step, then floor field → Recast → crowd /
   NPC / top-down player framing (same end as `/vuetify`).

### Deep-link query params

`/storage-adapter` accepts (order: mode → pose → load → Fast Nav):

| Param | Meaning |
|-------|---------|
| `stream` | CDN lod-meta URL or root (appends `/lod-meta.json`) |
| `autoload` | `true`/`1` — load after scene init |
| `mode` | `fly` \| `orbit` — camera before load |
| `pos` | `[x,y,z]` world meters (with `eulerDeg`; fly only) |
| `eulerDeg` | `[x,y,z]` degrees — same shape as **Copy pose** |
| `fastNav` | `true`/`1` — after load, run floor-field Fast Nav (keeps pose view) |

Helpers: `src/storage/storageAdapterDeepLink.ts`. Root URLs without
`lod-meta.json` resolve via `resolveLodMetaCdnUrl`.

Implementation:

- `src/storage/materializeNavSourceFromStreamedSog.ts` — LOD select → SOG decode → PLY
- `src/composables/useStorageAdapterDemo.ts` — stream load + Viewer handoff
- Fallback format switch: [splat-transform](https://github.com/playcanvas/splat-transform)

## Overview

The storage adapter system enables SplatWalk to serve SOG bundles from multiple sources:

- **Local Storage** - Zip file uploads for preview and testing
- **Cloudinary** - CDN delivery with global edge caching
- **Extensible** - Framework for S3, Azure Blob, Google Cloud Storage, etc.

All backends support secure credential management through:
- **GitHub Secrets** (GitHub Actions, Codespaces)
- **Render.com** Environment variables
- **Netlify** Environment variables

## Architecture

```mermaid
graph TB
    Config[Storage Config] --> Factory["Create Adapter"]
    Factory --> Type{Backend Type?}
    
    Type -->|local| Local["LocalStorageAdapter"]
    Type -->|cloudinary| CDN["CloudinaryStorageAdapter"]
    
    Config -->|Credentials| Secrets["Secrets Resolver"]
    Secrets -->|GitHub| GH["GitHub Secrets"]
    Secrets -->|Render| Render["Render.com Env"]
    Secrets -->|Netlify| Netlify["Netlify Env"]
    
    Local --> API["StorageAdapter API"]
    CDN --> API
    
    API --> Methods["getManifest()
    fetchChunk()
    fetchChunks()
    resolveUrl()"]
```

## Quick Start

### 1. Local ZIP Upload

```typescript
import { createStorageAdapter } from '@splatwalk/storage';

// User uploads a SOG bundle ZIP
const file = document.querySelector('input[type="file"]').files[0];

const { adapter, manifestUrl } = await createStorageAdapter({
  type: 'local',
  source: file,
});

// Stream chunks
const manifest = await adapter.getManifest();
const chunk = await adapter.fetchChunk('0_0/means_l.webp');
```

### 2. Cloudinary with GitHub Secrets

```typescript
// GitHub Actions automatically provides secrets
const { adapter } = await createStorageAdapter({
  type: 'cloudinary',
  cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
  folder: 'sog-bundles',
});

const manifest = await adapter.getManifest();
```

### 3. Setup GitHub Secrets

```bash
# In your GitHub repository:
# Settings → Secrets and variables → Actions → New repository secret

CLOUDINARY_CLOUD_NAME: my-cloud
CLOUDINARY_API_KEY: your-api-key
```

## Configuration Types

### LocalStorageConfig

```typescript
{
  type: 'local';
  source: File | Blob | string;  // ZIP file or URL
}
```

### CloudinaryStorageConfig

```typescript
{
  type: 'cloudinary';
  cloudName: string | SecretReference;  // e.g., { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' }
  folder: string;                        // e.g., 'sog-bundles'
  bundleId?: string;                     // Optional: specific bundle ID
  apiKey?: string | SecretReference;     // Optional: for admin operations
  apiSecret?: SecretReference;           // Optional: keep secure!
  transformations?: Record<string, any>; // Optional: Cloudinary transforms
}
```

## Secret References

### GitHub Secrets
```typescript
{ type: 'github', key: 'SECRET_NAME' }
```
Available in: GitHub Actions, Codespaces

### Render.com
```typescript
{ type: 'render', key: 'ENV_VAR_NAME' }
```
Available in: Render.com deployments

### Netlify
```typescript
{ type: 'netlify', key: 'ENV_VAR_NAME' }
```
Available in: Netlify deployments

## Storage Adapter API

### Methods

| Method | Returns | Purpose |
|--------|---------|---------|
| `getManifest()` | `Promise<unknown>` | Fetch root manifest (lod-meta.json) |
| `fetchChunk(path)` | `Promise<StorageFetchResponse>` | Fetch a single chunk |
| `fetchChunks(paths)` | `Promise<StorageFetchResponse[]>` | Fetch multiple chunks in parallel |
| `resolveUrl(path)` | `string` | Get absolute URL for a path |
| `extractBundle()` | `Promise<Map \| undefined>` | Extract entire bundle (local only) |
| `getInfo()` | `Promise<StorageInfo>` | Get storage metadata |
| `dispose()` | `void` | Clean up resources |

## Usage Patterns

### Pattern 1: Environment-Specific

```typescript
const config = process.env.NODE_ENV === 'production'
  ? {
      type: 'cloudinary',
      cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
      folder: 'prod/sog',
    }
  : {
      type: 'local',
      source: '/bundles/demo.zip',
    };

const { adapter } = await createStorageAdapter(config);
```

### Pattern 2: Multi-Platform

```typescript
function getConfig() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    return { type: 'cloudinary', ... }; // GitHub Secrets
  }
  if (process.env.RENDER === 'true') {
    return { type: 'cloudinary', ... }; // Render env vars
  }
  if (process.env.NETLIFY === 'true') {
    return { type: 'cloudinary', ... }; // Netlify env vars
  }
  return { type: 'local', ... }; // Local fallback
}
```

### Pattern 3: Cleanup

```typescript
import { getStorageRegistry } from '@splatwalk/storage';

// On app shutdown
getStorageRegistry().disposeAll();
```

## Deployment Guides

### GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on: [push]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Install
        run: npm ci
      - name: Build
        run: npm run build
        env:
          CLOUDINARY_CLOUD_NAME: ${{ secrets.CLOUDINARY_CLOUD_NAME }}
          CLOUDINARY_API_KEY: ${{ secrets.CLOUDINARY_API_KEY }}
```

### Render.com

1. Add environment variables in dashboard:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`

2. Deploy normally - variables are automatically available

### Netlify

1. Add environment variables in site settings:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`

2. Environment variables are available during build and at runtime

## Integration with GPU Streaming

The storage adapter provides the runtime streaming layer in the supersplat pattern:

```
SplatWalk Editor
    ↓
Export → SOG LOD Chunks
    ↓
Publish → Cloudinary CDN (or local)
    ↓
Runtime: Storage Adapter
  ├─ manifestUrl
  └─ fetchChunk() → GPU pipeline
      ├─ Dequantize
      ├─ Upload buffers
      ├─ GPU culling
      └─ Rasterize splats
```

## Best Practices

1. **Never hardcode secrets** - Always use `SecretReference`
2. **Use environment detection** - Let the system auto-detect available platforms
3. **Cache strategically** - The adapter handles caching automatically
4. **Dispose properly** - Call `dispose()` on cleanup
5. **Validate configuration** - Use `validateStorageConfig()` early
6. **Handle errors** - Use try/catch for async operations

## Examples

See [examples.ts](./examples.ts) for complete working examples:

- Local ZIP upload
- Cloudinary with plain credentials
- GitHub Secrets integration
- Render.com environment variables
- Netlify environment variables
- Production-ready multi-platform setup
- Streaming and chunk loading
- Cleanup and disposal

## Configuration Guide

See [CONFIGURATION.md](./CONFIGURATION.md) for detailed configuration documentation with more examples.

## Type Safety

Full TypeScript support with strict types for:
- Storage configurations
- Secret references
- Adapter APIs
- Resolved values

```typescript
import type {
  StorageConfig,
  StorageAdapter,
  SecretReference,
} from '@splatwalk/storage';
```

## License

Part of the SplatWalk project. See main repository for licensing details.
