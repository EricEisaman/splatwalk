# Storage Adapter Playground

Interactive demo and testing environment for the SOG LOD Storage Adapter system.

## Quick Start

### Option 1: Standalone HTML (Easiest)

Open [storage-adapter.html](./storage-adapter.html) in your browser:

```bash
# Serve locally
cd /workspaces/splatwalk
npm run dev
# Then open http://localhost:5173/public/playground/storage-adapter.html
```

### Option 2: Babylon Playground

Paste [storage-adapter.ts](./storage-adapter.ts) into [playground.babylonjs.com](https://playground.babylonjs.com):

1. Go to https://playground.babylonjs.com
2. Click the language toggle and select **TypeScript**
3. Copy the contents of `storage-adapter.ts`
4. Paste into the editor
5. Click **Run**

### Option 3: Local Development

Import directly in your project:

```typescript
import { createStorageAdapter } from '@splatwalk/storage';

const { adapter } = await createStorageAdapter({
  type: 'local',
  source: file,
});
```

## Features Demonstrated

### 📁 Local ZIP Upload
- Select a SOG bundle ZIP file from your computer
- Automatic extraction and in-memory streaming
- Perfect for local testing and preview

### ☁️ Cloudinary CDN
- **Direct**: Hardcoded credentials (development only)
- **GitHub Secrets**: For GitHub Actions workflows
- **Render.com**: For Render deployments
- **Netlify**: For Netlify deployments

### 🔐 Secure Credentials
- Store API keys in platform-specific secret stores
- Automatic credential discovery and resolution
- No hardcoded secrets in client code

### 📊 Real-Time Monitoring
- Live status panel showing connection and load progress
- Manifest preview
- Loaded chunks display with sizes
- Error reporting

## Workflow

1. **Select Backend** - Choose storage type from dropdown
2. **Configure** - Enter credentials or select file
3. **Connect** - Establish connection to storage
4. **Load Manifest** - Fetch SOG LOD metadata
5. **Stream Chunks** - Download sample chunks
6. **Monitor** - Watch real-time status updates

## Usage Examples

### Local ZIP (No Credentials)

```
1. Select: "📁 Local ZIP Upload"
2. Click: "Select ZIP File"
3. Choose: Your SOG bundle ZIP
4. Click: "Connect"
```

### Cloudinary with GitHub Secrets

```
1. Select: "🐙 Cloudinary (GitHub Secrets)"
2. Enter: "sog-bundles" (folder path)
3. Click: "Connect"
4. (Credentials auto-detected from GITHUB_ACTIONS environment)
```

### Cloudinary with Render

```
1. Select: "🎯 Cloudinary (Render.com)"
2. Enter: "sog-bundles"
3. Click: "Connect"
4. (Credentials auto-detected from RENDER environment)
```

## Key Concepts

### Storage Adapters
Unified interface for accessing SOG bundles from different sources:
- All adapters implement the same `StorageAdapter` interface
- Seamless switching between backends
- Same API regardless of source

### Manifest Loading
Each SOG bundle has a manifest (lod-meta.json or meta.json):
- Lists all LOD levels
- Maps chunks to file paths
- Provides compression metadata

### Chunk Streaming
Efficient loading of individual splat chunks:
- Parallel loading support
- Automatic caching
- On-demand fetch for low bandwidth
- Progressive LOD enhancement

### Secrets Resolution
Secure credential management:
1. Store secrets in platform-specific system
2. Reference by key name (not value)
3. Resolver auto-detects environment
4. Fetch secrets at runtime

## Environment Detection

The playground automatically detects your deployment environment:

| Platform | Environment Variable | Secret Method |
|----------|---------------------|---------------|
| GitHub Actions | `GITHUB_ACTIONS=true` | GitHub Secrets |
| Render | `RENDER=true` | Environment Variables |
| Netlify | `NETLIFY=true` | Environment Variables |
| Local/Browser | None | File Upload |

## Configuration

### Local Storage
```typescript
{
  type: 'local',
  source: file  // File object or Blob
}
```

### Cloudinary Direct
```typescript
{
  type: 'cloudinary',
  cloudName: 'my-cloud',
  folder: 'sog-bundles'
}
```

### Cloudinary with Secrets
```typescript
{
  type: 'cloudinary',
  cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
  folder: 'sog-bundles'
}
```

## Setup Instructions

### Create a SOG Bundle

Use SplatWalk to export a SOG bundle:

```bash
# From any splat file
splatwalk export --format sog --slice your-scene.ply
```

This creates a ZIP file with structure:
```
my-scene-sog.zip
├── lod-meta.json
├── lod0/
│   ├── chunk0/
│   │   ├── meta.json
│   │   ├── means_*.webp
│   │   └── ...
│   └── ...
└── lod1/
    └── ...
```

### Deploy to Cloudinary

1. Create [Cloudinary account](https://cloudinary.com) (free tier available)
2. Upload SOG bundle using CLI or dashboard
3. Store cloud name as environment variable
4. Reference in storage config

### Configure GitHub Secrets

1. Go to repository Settings
2. Secrets and variables → Actions
3. New repository secret: `CLOUDINARY_CLOUD_NAME = your-cloud`
4. New repository secret: `CLOUDINARY_API_KEY = your-api-key`

### Configure Render

1. Go to service dashboard
2. Environment tab
3. Add: `CLOUDINARY_CLOUD_NAME = your-cloud`
4. Add: `CLOUDINARY_API_KEY = your-api-key`

### Configure Netlify

1. Go to site settings
2. Environment section
3. Add: `CLOUDINARY_CLOUD_NAME = your-cloud`
4. Add: `CLOUDINARY_API_KEY = your-api-key`

## Troubleshooting

### "No manifest found"
- Check ZIP file structure
- Ensure `lod-meta.json` or `meta.json` exists at root
- Verify ZIP is not corrupted

### "Failed to fetch chunks"
- Check network connectivity
- Verify CORS headers on CDN
- Check file paths in manifest
- Inspect browser console for errors

### "Credentials not resolved"
- Verify environment variables are set
- Check secret name matches exactly
- Ensure you're in correct environment (GitHub Actions, Render, etc.)
- Try direct credentials first to isolate issue

### CORS Issues
- Ensure storage backend enables CORS
- Check `Access-Control-Allow-Origin` headers
- Local file URLs should work (file:// or blob://)
- CDN URLs must have proper CORS headers

## Advanced Usage

### Custom Fetch Function
```typescript
const adapter = await createStorageAdapter(config, {
  fetch: myCustomFetchFunction
});
```

### Progress Tracking
```typescript
const manifest = await adapter.getManifest();
for (const path of manifest.lods[0].chunks) {
  const response = await adapter.fetchChunk(path);
  console.log(`Loaded: ${path} (${response.data.length} bytes)`);
}
```

### Bandwidth Optimization
```typescript
// Detect bandwidth and adjust loading strategy
const adapter = await createStorageAdapter(config, {
  timeout: 10000,  // 10 second timeout
  enableCache: true,
  maxCacheBytes: 50 * 1024 * 1024  // 50MB cache
});
```

## Integration with GPU Rendering

The storage adapter integrates seamlessly with the GPU rendering pipeline:

1. **Fetch Manifest** → Determine LOD structure
2. **Load Low LOD** → Quick initial render
3. **Dequantize** → Unpack compressed attributes
4. **Upload GPU** → Transfer to VRAM
5. **Background Load** → Fetch higher LODs while rendering
6. **Progressive Enhance** → Swap in higher detail chunks

See [integrations.ts](../../src/storage/integrations.ts) for streaming patterns.

## Resources

- 📖 [Storage Module README](../../src/storage/README.md)
- ⚙️ [Configuration Guide](../../src/storage/CONFIGURATION.md)
- 💡 [Usage Examples](../../src/storage/examples.ts)
- 🔧 [Integration Patterns](../../src/storage/integrations.ts)
- 📚 [Main Repository](https://github.com/EricEisaman/splatwalk)

## Support

For issues, questions, or contributions:

- GitHub Issues: https://github.com/EricEisaman/splatwalk/issues
- Documentation: https://github.com/EricEisaman/splatwalk/tree/main/src/storage
- Examples: Check `src/storage/examples.ts`
