/**
 * SOG LOD Storage Adapter System - Configuration Guide
 * 
 * Clean, unified interface for streaming SOG LOD splats from various backends
 * with secure credential management.
 */

/**
 * ## Demo renderer (Babylon host)
 *
 * Storage Adapter playground: prefer WebGPU or WebGL via Stream settings, or
 * `?renderer=webgpu` / `?renderer=webgl`. WebGPU uses `setMaximumLimits` for the
 * GS work-buffer MRT and falls back to WebGL when unsupported
 * (`src/scene/createBabylonEngine.ts`). Not a WASM concern. Download the Storage
 * Adapter kit from the demo UI (`/integration-kits/`, v0.6.4). Oval may arm
 * `cameraSelect` (view + offsets → AABB). Region/prune can **Apply select region
 * from camera** with editable offsets; see `regionBoundsFromCameraSelect`.
 *
 * ## Storage Adapter System
 *
 * The storage adapter system provides a unified interface for streaming SOG LOD bundles
 * from different backends while securely managing credentials through platform-specific
 * secret systems.
 *
 * ### Supported Backends
 *
 * 1. **Local Storage** - ZIP uploads and local file serving
 * 2. **Cloudinary** - CDN delivery with optional API integration
 * 3. **Extensible** - Framework for adding S3, Azure Blob, Google Cloud Storage, etc.
 *
 * ### Supported Secret Platforms
 *
 * 1. **GitHub Secrets** - GitHub Actions and Codespaces environments
 * 2. **Render.com** - Render environment variables
 * 3. **Netlify** - Netlify environment variables
 *
 * ---
 *
 * ## Quick Start
 *
 * ### Local ZIP Upload (Browser)
 *
 * ```typescript
 * import { createStorageAdapter } from '@splatwalk/storage';
 *
 * // User selects a SOG bundle ZIP file
 * const fileInput = document.querySelector('input[type="file"]');
 * const file = fileInput.files[0];
 *
 * const { adapter, manifestUrl } = await createStorageAdapter({
 *   type: 'local',
 *   source: file,
 * });
 *
 * // Stream chunks
 * const manifest = await adapter.getManifest();
 * const chunk = await adapter.fetchChunk('0_0/means_l.webp');
 * ```
 *
 * ### Cloudinary with GitHub Secrets (Production)
 *
 * ```typescript
 * // GitHub Actions environment automatically provides secrets
 * const { adapter, manifestUrl } = await createStorageAdapter({
 *   type: 'cloudinary',
 *   cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
 *   folder: 'sog-bundles',
 *   apiKey: { type: 'github', key: 'CLOUDINARY_API_KEY' },
 * });
 * ```
 *
 * ---
 *
 * ## Configuration Patterns
 *
 * ### Pattern 1: Environment-Specific Configuration
 *
 * ```typescript
 * const environment = process.env.NODE_ENV || 'development';
 * const storageConfig = environment === 'production'
 *   ? {
 *       type: 'cloudinary',
 *       cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
 *       folder: 'prod/sog-bundles',
 *     }
 *   : {
 *       type: 'local',
 *       source: await fetchLocalBundle(),
 *     };
 *
 * const { adapter } = await createStorageAdapter(storageConfig);
 * ```
 *
 * ### Pattern 2: Multi-Platform Deployment
 *
 * ```typescript
 * function getStorageConfig() {
 *   if (process.env.GITHUB_ACTIONS === 'true') {
 *     return {
 *       type: 'cloudinary',
 *       cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
 *       folder: 'sog-bundles',
 *     };
 *   }
 *
 *   if (process.env.RENDER === 'true') {
 *     return {
 *       type: 'cloudinary',
 *       cloudName: { type: 'render', key: 'CLOUDINARY_CLOUD_NAME' },
 *       folder: 'sog-bundles',
 *     };
 *   }
 *
 *   if (process.env.NETLIFY === 'true') {
 *     return {
 *       type: 'cloudinary',
 *       cloudName: { type: 'netlify', key: 'CLOUDINARY_CLOUD_NAME' },
 *       folder: 'sog-bundles',
 *     };
 *   }
 *
 *   // Local fallback
 *   return {
 *     type: 'local',
 *     source: '/bundles/my-sog.zip',
 *   };
 * }
 *
 * const { adapter } = await createStorageAdapter(getStorageConfig());
 * ```
 *
 * ### Pattern 3: Hybrid Configuration (UI-Driven)
 *
 * ```typescript
 * async function setupStorageFromUI() {
 *   const storageType = document.querySelector('input[name="storage-type"]:checked')
 *     .value;
 *
 *   if (storageType === 'upload') {
 *     // User uploads a ZIP
 *     const file = document.querySelector('input[type="file"]').files[0];
 *     return { type: 'local', source: file };
 *   } else {
 *     // Use configured CDN
 *     return {
 *       type: 'cloudinary',
 *       cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
 *       folder: 'sog-bundles',
 *     };
 *   }
 * }
 * ```
 *
 * ---
 *
 * ## Secret Resolution
 *
 * ### How It Works
 *
 * 1. **References** are not actual secrets—they're identifiers pointing to secret storage
 * 2. **Resolver** fetches the actual value from the specified platform at runtime
 * 3. **Caching** stores resolved values to avoid redundant fetches
 * 4. **Auto-detection** identifies available platforms in the current environment
 *
 * ### Available Secret Types
 *
 * #### GitHub Secrets\n *\n * ```typescript\n * {\n *   type: 'github',\n *   key: 'CLOUDINARY_CLOUD_NAME',  // Name of the secret in GitHub\n *   token?: 'ghp_...',              // Optional: GitHub token (auto-provided in Actions)\n * }\n * ```\n *\n * **Setup:**\n * 1. Go to Repository Settings > Secrets and variables > Actions\n * 2. Create new secret: `CLOUDINARY_CLOUD_NAME = your-cloud-name`\n * 3. Use in workflow automatically\n *\n * #### Render.com Secrets\n *\n * ```typescript\n * {\n *   type: 'render',\n *   key: 'CLOUDINARY_CLOUD_NAME',    // Name of env var on Render\n *   apiKey?: 'rnd_...',              // Optional: Render API key\n *   serviceId?: 'srv_...',           // Optional: Specific service ID\n * }\n * ```\n *\n * **Setup:**\n * 1. Go to your Render service dashboard\n * 2. Environment tab > Add environment variable\n * 3. Set: `CLOUDINARY_CLOUD_NAME = your-cloud-name`\n *\n * #### Netlify Secrets\n *\n * ```typescript\n * {\n *   type: 'netlify',\n *   key: 'CLOUDINARY_CLOUD_NAME',    // Name of env var on Netlify\n *   token?: 'nf_...',                // Optional: Netlify personal access token\n *   siteId?: 'abc123...',            // Optional: Specific site ID\n * }\n * ```\n *\n * **Setup:**\n * 1. Go to your Netlify site settings > Environment\n * 2. Add environment variable: `CLOUDINARY_CLOUD_NAME = your-cloud-name`\n *\n * ---\n *\n * ## API Reference\n *\n * ### `createStorageAdapter(config, options?)`\n *\n * Creates and initializes a storage adapter.\n *\n * **Parameters:**\n * - `config`: Storage configuration (local or cloudinary)\n * - `options`: Optional configuration (timeout, caching, fetch function)\n *\n * **Returns:** `Promise<ResolvedStorageConfig>`\n *\n * **Example:**\n * ```typescript\n * const { adapter, manifestUrl } = await createStorageAdapter({\n *   type: 'cloudinary',\n *   cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },\n *   folder: 'sog-bundles',\n * });\n * ```\n *\n * ### `adapter.getManifest()`\n *\n * Fetch the root manifest file (`lod-meta.json` or `meta.json`).\n *\n * **Returns:** `Promise<unknown>` - Parsed JSON manifest\n *\n * ### `adapter.fetchChunk(path)`\n *\n * Fetch a specific chunk file by relative path.\n *\n * **Parameters:**\n * - `path`: Bundle-relative path (e.g., `lod0/chunk0/means_l.webp`)\n *\n * **Returns:** `Promise<StorageFetchResponse>` - Chunk data and metadata\n *\n * ### `adapter.fetchChunks(paths)`\n *\n * Fetch multiple chunks in parallel.\n *\n * **Parameters:**\n * - `paths`: Array of bundle-relative paths\n *\n * **Returns:** `Promise<StorageFetchResponse[]>` - Array of chunk responses\n *\n * ### `adapter.resolveUrl(path)`\n *\n * Resolve a bundle-relative path to an absolute URL.\n *\n * **Parameters:**\n * - `path`: Bundle-relative path\n *\n * **Returns:** `string` - Absolute URL\n *\n * ### `adapter.extractBundle()`\n *\n * Extract the entire bundle as a file map (for local/preview use).\n *\n * **Returns:** `Promise<Map<string, Uint8Array> | undefined>`\n *\n * ### `adapter.getInfo()`\n *\n * Get metadata about the storage source.\n *\n * **Returns:** `Promise<StorageInfo>` - Storage metadata\n *\n * ### `adapter.dispose()`\n *\n * Clean up resources (revoke URLs, close connections).\n *\n * ---\n *\n * ## Secrets API\n *\n * ### `initializeGlobalSecretsResolver(config)`\n *\n * Initialize the global secrets resolver with credentials for different platforms.\n *\n * **Parameters:**\n * - `githubToken`: GitHub token (usually auto-provided)\n * - `renderApiKey`: Render.com API key\n * - `netlifyToken`: Netlify personal access token\n * - `autoDetect`: Auto-detect available platforms (default: true)\n *\n * **Example:**\n * ```typescript\n * initializeGlobalSecretsResolver({\n *   githubToken: process.env.GITHUB_TOKEN,\n *   renderApiKey: process.env.RENDER_API_KEY,\n *   netlifyToken: process.env.NETLIFY_TOKEN,\n *   autoDetect: true,\n * });\n * ```\n *\n * ### `getGlobalSecretsResolver()`\n *\n * Get the global secrets resolver instance.\n *\n * **Returns:** `SecretsResolver`\n *\n * ---\n *\n * ## Deployment Examples\n *\n * ### GitHub Actions\n *\n * ```yaml\n * name: Deploy Splatwalk Viewer\n *\n * on: [push]\n *\n * jobs:\n *   build:\n *     runs-on: ubuntu-latest\n *     steps:\n *       - uses: actions/checkout@v3\n *       - name: Install\n *         run: npm ci\n *       - name: Build\n *         run: npm run build\n *         env:\n *           CLOUDINARY_CLOUD_NAME: ${{ secrets.CLOUDINARY_CLOUD_NAME }}\n *           CLOUDINARY_API_KEY: ${{ secrets.CLOUDINARY_API_KEY }}\n *       - name: Deploy\n *         run: npm run deploy\n * ```\n *\n * ### Render.com\n *\n * Set environment variables in Render dashboard:\n * - `CLOUDINARY_CLOUD_NAME`\n * - `CLOUDINARY_API_KEY`\n *\n * Application automatically uses these in production.\n *\n * ### Netlify\n *\n * Set environment variables in Netlify site settings:\n * - `CLOUDINARY_CLOUD_NAME`\n * - `CLOUDINARY_API_KEY`\n *\n * Build process uses these during deployment.\n *\n * ---\n *\n * ## Best Practices\n *\n * 1. **Never hardcode secrets** - Always use secret references\n * 2. **Use environment-appropriate backends** - Local for dev, CDN for production\n * 3. **Cache strategically** - Let the adapter handle caching\n * 4. **Dispose properly** - Call `dispose()` on cleanup\n * 5. **Validate configuration** - Use `validateStorageConfig()`\n * 6. **Handle errors gracefully** - Use try/catch for async operations\n *\n * ---\n *\n * ## Integration with Supersplat Pattern\n *\n * This storage system mirrors the supersplat architecture:\n *\n * ```\n * Authoring → Export → Publish → Runtime Streaming\n *   ↓            ↓         ↓           ↓\n * SplatWalk   SOG LOD   Cloudinary  Storage Adapter\n *          meta.json    CDN        fetchChunks()\n *   LOD chunks  ←────────────────────────\n * ```\n *\n * The adapter provides the runtime streaming layer, automatically handling\n * multiple backends and secret sources while maintaining compatibility with\n * the GPU rendering pipeline.\n */

export {}; // This file is documentation only
