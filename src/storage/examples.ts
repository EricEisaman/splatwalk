/**
 * SOG LOD Storage Adapter System - Usage Examples
 * 
 * This file demonstrates how to use the storage adapter system for streaming
 * SOG bundles from different backends with secure credential management.
 */

import type {
  StorageConfig,
  LocalStorageConfig,
  CloudinaryStorageConfig,
  StorageAdapter,
  GitHubSecretReference,
  RenderSecretReference,
  NetlifySecretReference,
} from './index';
import {
  createStorageAdapter,
  validateStorageConfig,
  getStorageRegistry,
  initializeGlobalSecretsResolver,
} from './index';

// ============================================================================
// EXAMPLE 1: Local ZIP Upload
// ============================================================================

/**
 * Stream a SOG bundle from a user-uploaded ZIP file.
 */
export async function exampleLocalZipUpload(file: File) {
  console.log('Loading SOG bundle from ZIP file:', file.name);

  const config: LocalStorageConfig = {
    type: 'local',
    source: file, // File object from <input type="file">
  };

  const { adapter, manifestUrl } = await createStorageAdapter(config);
  const registry = getStorageRegistry();
  registry.register(adapter);

  // Get manifest
  const manifest = await adapter.getManifest();
  console.log('Bundle manifest:', manifest);

  // Access storage info
  const info = await adapter.getInfo();
  console.log('Storage info:', info);

  // Fetch a specific chunk
  const chunkResponse = await adapter.fetchChunk('0_0/means_l.webp');
  console.log('Fetched chunk:', chunkResponse.data.length, 'bytes');

  // For preview/caching, extract the entire bundle
  const bundleMap = await adapter.extractBundle?.();
  console.log('Extracted bundle with', bundleMap?.size, 'files');

  return { adapter, manifestUrl };
}

// ============================================================================
// EXAMPLE 2: Cloudinary with Plain Credentials
// ============================================================================

/**
 * Stream SOG bundles from Cloudinary (for testing/development only).
 * WARNING: Hardcoding credentials is insecure. Use secret references in production.
 */
export async function exampleCloudinaryDirect() {
  console.log('Setting up Cloudinary storage (plain credentials - dev only)');

  const config: CloudinaryStorageConfig = {
    type: 'cloudinary',
    cloudName: 'demo', // Replace with your cloud name
    folder: 'sog-bundles',
    bundleId: 'my-scene',
  };

  validateStorageConfig(config);

  const { adapter, manifestUrl } = await createStorageAdapter(config);
  const registry = getStorageRegistry();
  registry.register(adapter);

  const manifest = await adapter.getManifest();
  console.log('Fetched manifest from Cloudinary:', manifest);

  return { adapter, manifestUrl };
}

// ============================================================================
// EXAMPLE 3: GitHub Secrets (GitHub Actions)
// ============================================================================

/**
 * Stream SOG bundles from Cloudinary using credentials stored in GitHub Secrets.
 * Works in GitHub Actions environments.
 * 
 * @example Setup in GitHub:
 * 1. Go to your repository Settings > Secrets and variables > Actions
 * 2. Create secrets:
 *    - CLOUDINARY_CLOUD_NAME: your cloud name
 *    - CLOUDINARY_API_KEY: your API key (optional, for admin features)
 */
export async function exampleGitHubSecrets() {
  console.log('Setting up Cloudinary with GitHub Secrets');

  // Initialize secrets resolver with your GitHub token if needed
  // (usually automatic in GitHub Actions)
  initializeGlobalSecretsResolver({
    autoDetect: true,
  });

  const cloudNameRef: GitHubSecretReference = {
    type: 'github',
    key: 'CLOUDINARY_CLOUD_NAME',
  };

  const config: CloudinaryStorageConfig = {
    type: 'cloudinary',
    cloudName: cloudNameRef, // Reference to GitHub Secret
    folder: 'sog-bundles',
    apiKey: {
      type: 'github',
      key: 'CLOUDINARY_API_KEY',
    },
  };

  const { adapter, manifestUrl } = await createStorageAdapter(config);
  const registry = getStorageRegistry();
  registry.register(adapter);

  console.log('Connected to Cloudinary via GitHub Secrets');
  return { adapter, manifestUrl };
}

// ============================================================================
// EXAMPLE 4: Render.com Environment Variables
// ============================================================================

/**
 * Stream SOG bundles from Cloudinary using credentials from Render.com env vars.
 * Works when deployed on Render.com.
 * 
 * @example Setup on Render:
 * 1. In your Render service, go to Environment
 * 2. Add environment variables:
 *    - CLOUDINARY_CLOUD_NAME
 *    - CLOUDINARY_API_KEY (optional)
 */
export async function exampleRenderEnvVars() {
  console.log('Setting up Cloudinary with Render.com environment variables');

  // Initialize secrets resolver with auto-detection
  initializeGlobalSecretsResolver({
    autoDetect: true,
  });

  const cloudNameRef: RenderSecretReference = {
    type: 'render',
    key: 'CLOUDINARY_CLOUD_NAME',
  };

  const config: CloudinaryStorageConfig = {
    type: 'cloudinary',
    cloudName: cloudNameRef, // Reference to Render env var
    folder: 'sog-bundles',
  };

  const { adapter, manifestUrl } = await createStorageAdapter(config);
  const registry = getStorageRegistry();
  registry.register(adapter);

  console.log('Connected to Cloudinary via Render.com environment');
  return { adapter, manifestUrl };
}

// ============================================================================
// EXAMPLE 5: Netlify Environment Variables
// ============================================================================

/**
 * Stream SOG bundles from Cloudinary using credentials from Netlify env vars.
 * Works when deployed on Netlify.
 * 
 * @example Setup on Netlify:
 * 1. In your Netlify site, go to Site settings > Environment
 * 2. Add environment variables:
 *    - CLOUDINARY_CLOUD_NAME
 *    - CLOUDINARY_API_KEY (optional)
 */
export async function exampleNetlifyEnvVars() {
  console.log('Setting up Cloudinary with Netlify environment variables');

  // Initialize secrets resolver
  initializeGlobalSecretsResolver({
    // Provide your Netlify personal access token for API access (optional)
    netlifyToken: process.env.NETLIFY_TOKEN,
  });

  const cloudNameRef: NetlifySecretReference = {
    type: 'netlify',
    key: 'CLOUDINARY_CLOUD_NAME',
  };

  const config: CloudinaryStorageConfig = {
    type: 'cloudinary',
    cloudName: cloudNameRef, // Reference to Netlify env var
    folder: 'sog-bundles',
  };

  const { adapter, manifestUrl } = await createStorageAdapter(config);
  const registry = getStorageRegistry();
  registry.register(adapter);

  console.log('Connected to Cloudinary via Netlify environment');
  return { adapter, manifestUrl };
}

// ============================================================================
// EXAMPLE 6: Mixed Configuration (Recommended Production Pattern)
// ============================================================================

/**
 * Production-ready pattern:
 * - Use secret references for all credentials
 * - Support multiple deployment environments
 * - Graceful fallback for development
 */
export async function exampleProductionSetup(
  environment: 'github' | 'render' | 'netlify' | 'local'
) {
  console.log(`Setting up storage for ${environment} environment`);

  // Initialize secrets resolver with all optional tokens
  initializeGlobalSecretsResolver({
    githubToken: process.env.GITHUB_TOKEN,
    renderApiKey: process.env.RENDER_API_KEY,
    netlifyToken: process.env.NETLIFY_TOKEN,
    autoDetect: true,
  });

  let config: StorageConfig;

  switch (environment) {
    case 'local': {
      // For local development, use a file upload
      // In a real app, this would come from a file input
      const fileInput = document.querySelector(
        'input[type="file"]'
      ) as HTMLInputElement;
      if (!fileInput?.files?.[0]) {
        throw new Error('Please select a SOG bundle ZIP file');
      }

      config = {
        type: 'local',
        source: fileInput.files[0],
      };
      break;
    }

    case 'github': {
      config = {
        type: 'cloudinary',
        cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
        folder: 'sog-bundles',
        apiKey: { type: 'github', key: 'CLOUDINARY_API_KEY' },
      };
      break;
    }

    case 'render': {
      config = {
        type: 'cloudinary',
        cloudName: { type: 'render', key: 'CLOUDINARY_CLOUD_NAME' },
        folder: 'sog-bundles',
      };
      break;
    }

    case 'netlify': {
      config = {
        type: 'cloudinary',
        cloudName: { type: 'netlify', key: 'CLOUDINARY_CLOUD_NAME' },
        folder: 'sog-bundles',
      };
      break;
    }
  }

  validateStorageConfig(config);

  const { adapter, manifestUrl } = await createStorageAdapter(config);
  const registry = getStorageRegistry();
  registry.register(adapter);

  console.log('Storage adapter ready:', {
    type: config.type,
    environment,
    manifestUrl,
  });

  return { adapter, manifestUrl };
}

// ============================================================================
// EXAMPLE 7: Streaming with Chunk Loading
// ============================================================================

/**
 * Efficiently stream chunks from storage, with caching.
 */
export async function exampleStreamingChunks(
  adapter: StorageAdapter
) {
  console.log('Fetching manifest...');
  const manifest = (await adapter.getManifest()) as {
    lods?: Array<{ chunks?: string[] }>;
  };

  if (!manifest.lods?.[0]?.chunks) {
    console.warn('No chunks found in manifest');
    return;
  }

  const firstLodChunks = manifest.lods[0].chunks.slice(0, 3);
  console.log(`Fetching ${firstLodChunks.length} chunks from LOD 0...`);

  // Fetch multiple chunks in parallel
  const responses = await adapter.fetchChunks(firstLodChunks);

  for (let i = 0; i < responses.length; i++) {
    console.log(
      `Chunk ${i}: ${responses[i].data.length} bytes (${responses[i].contentType})`
    );
  }

  return responses;
}

// ============================================================================
// EXAMPLE 8: Cleanup and Disposal
// ============================================================================

/**
 * Clean up all active storage adapters (typically on app unload).
 */
export function exampleCleanup() {
  const registry = getStorageRegistry();

  console.log(`Disposing ${registry.size} active storage adapters...`);

  // This will clean up all blob URLs, connections, etc.
  registry.disposeAll();

  console.log('All storage adapters cleaned up');
}

// ============================================================================
// Integration with supersplat viewer pattern
// ============================================================================

/**
 * Example integration showing how this connects to the supersplat streaming pattern.
 */
export async function exampleSupersplatIntegration() {
  const environment = detectDeploymentEnvironment();

  // Set up storage based on environment
  const { adapter, manifestUrl } = await exampleProductionSetup(environment);

  // Fetch experience settings (similar to supersplat flow)
  const manifest = await adapter.getManifest();
  console.log('Supersplat integration manifest:', manifest);

  // Stream chunks similar to supersplat's streaming loader:
  // 1. Fetch lowest LOD first
  // 2. Decode chunked splat data
  // 3. Dequantize packed attributes
  // 4. Upload to GPU
  // ... (GPU rendering pipeline)

  return {
    manifestUrl,
    adapter,
    // Ready for integration with GPU rendering pipeline
  };
}

/**
 * Detect which deployment environment we're in.
 */
function detectDeploymentEnvironment(): 'github' | 'render' | 'netlify' | 'local' {
  if (typeof process !== 'undefined') {
    if (process.env.GITHUB_ACTIONS === 'true') return 'github';
    if (process.env.RENDER === 'true') return 'render';
    if (process.env.NETLIFY === 'true') return 'netlify';
  }
  return 'local';
}
