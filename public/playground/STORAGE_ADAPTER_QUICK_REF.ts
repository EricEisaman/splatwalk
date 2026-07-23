// Quick Reference - Storage Adapter Playground
// ============================================
// Prefer the Vue demo at /storage-adapter and the Playground paste target
// public/playground/storage-adapter.ts (budgeted GaussianSplattingStream).
//
// Deep-link query API (chain: mode → pose → autoload settle → fastNav):
//   stream     https lod-meta.json or root (root appends /lod-meta.json)
//   autoload   true|1 — load CDN after init
//   mode       fly|orbit — set before load (pose requires fly)
//   pos        [x,y,z] world meters (with eulerDeg)
//   eulerDeg   [x,y,z] degrees (with pos) — matches Camera Information "Copy pose"
//   fastNav    true|1 — after successful load, run floor-field Fast Nav
//              (keeps deep-link view via cameraSelect; skips top-down focus)
//
// Example (Skatepark + pose + Fast Nav):
// /storage-adapter?stream=https://code.playcanvas.com/examples_data/example_skatepark_02/lod-meta.json&autoload=true&pos=[-2.255,4.854,-6.133]&eulerDeg=[-6.2,-263.5,0.0]&mode=fly&fastNav=true


// ============================================
// 0. CDN lod-meta.json (Babylon 9.16 / Playground TS)
// ============================================

// Always pass maxResidentSplats — AppendSceneAsync cannot.
// See public/playground/storage-adapter.ts for the full Playground snippet.
//
// In the Vite app:
// import { loadCdnLodMeta, loadLocalSogZip } from '@/storage/sogStreamLoader';
// import { streamOptionsForPreset } from '@/storage/streamMemoryBudget';
// await loadCdnLodMeta({ lodMetaUrl, scene, preset: 'medium' });

// ============================================
// 1. LOCAL ZIP UPLOAD (Browser - No Setup)
// ============================================

import { createStorageAdapter, getStorageRegistry } from '@splatwalk/storage';

async function loadLocalBundle(file: File) {
  const { adapter } = await createStorageAdapter({
    type: 'local',
    source: file,
  });
  
  getStorageRegistry().register(adapter);
  
  const manifest = await adapter.getManifest();
  console.log('Manifest:', manifest);
  
  return adapter;
}

// Usage in HTML:
// <input type="file" accept=".zip" id="bundleInput">
// <script>
//   document.getElementById('bundleInput').addEventListener('change', (e) => {
//     loadLocalBundle(e.target.files[0]);
//   });
// </script>

// ============================================
// 2. CLOUDINARY - DEVELOPMENT (Direct)
// ============================================

async function loadCloudinaryDev() {
  const { adapter } = await createStorageAdapter({
    type: 'cloudinary',
    cloudName: 'my-cloud-name',      // Replace with yours
    folder: 'sog-bundles',
  });
  
  getStorageRegistry().register(adapter);
  
  const manifest = await adapter.getManifest();
  return adapter;
}

// ============================================
// 3. CLOUDINARY - WITH GITHUB SECRETS
// ============================================

async function loadCloudinaryGitHub() {
  const { adapter } = await createStorageAdapter({
    type: 'cloudinary',
    cloudName: {
      type: 'github',
      key: 'CLOUDINARY_CLOUD_NAME',
    },
    folder: 'sog-bundles',
    apiKey: {
      type: 'github',
      key: 'CLOUDINARY_API_KEY',
    },
  });
  
  getStorageRegistry().register(adapter);
  return adapter;
}

// GitHub Setup:
// 1. Go to repo Settings > Secrets and variables > Actions
// 2. Create secrets:
//    - CLOUDINARY_CLOUD_NAME = your-cloud
//    - CLOUDINARY_API_KEY = your-api-key

// ============================================
// 4. CLOUDINARY - WITH RENDER
// ============================================

async function loadCloudinaryRender() {
  const { adapter } = await createStorageAdapter({
    type: 'cloudinary',
    cloudName: {
      type: 'render',
      key: 'CLOUDINARY_CLOUD_NAME',
    },
    folder: 'sog-bundles',
  });
  
  return adapter;
}

// Render Setup:
// 1. Go to service dashboard > Environment
// 2. Add: CLOUDINARY_CLOUD_NAME = your-cloud

// ============================================
// 5. CLOUDINARY - WITH NETLIFY
// ============================================

async function loadCloudinaryNetlify() {
  const { adapter } = await createStorageAdapter({
    type: 'cloudinary',
    cloudName: {
      type: 'netlify',
      key: 'CLOUDINARY_CLOUD_NAME',
    },
    folder: 'sog-bundles',
  });
  
  return adapter;
}

// Netlify Setup:
// 1. Go to site settings > Environment
// 2. Add: CLOUDINARY_CLOUD_NAME = your-cloud

// ============================================
// 6. STREAM CHUNKS
// ============================================

async function streamChunks(adapter: any) {
  const manifest = await adapter.getManifest();
  
  // Get first LOD chunks
  const chunks = manifest.lods[0].chunks.slice(0, 5);
  
  console.log(`Fetching ${chunks.length} chunks...`);
  const responses = await adapter.fetchChunks(chunks);
  
  responses.forEach((response, i) => {
    console.log(`Chunk ${i}: ${response.data.length} bytes`);
  });
  
  return responses;
}

// ============================================
// 7. FETCH INDIVIDUAL CHUNK
// ============================================

async function getChunk(adapter: any, path: string) {
  const response = await adapter.fetchChunk(path);
  console.log(`Fetched ${path}: ${response.data.length} bytes`);
  return response.data;
}

// ============================================
// 8. GET STORAGE INFO
// ============================================

async function getInfo(adapter: any) {
  const info = await adapter.getInfo();
  console.log('Storage Info:', info);
  return info;
}

// ============================================
// 9. AUTO-DETECT ENVIRONMENT & CONFIGURE
// ============================================

async function autoDetectAndConnect() {
  // Detect environment automatically
  let config: any;
  
  if (typeof process !== 'undefined' && process.env?.GITHUB_ACTIONS) {
    // GitHub Actions
    config = {
      type: 'cloudinary',
      cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' },
      folder: 'sog-bundles',
    };
  } else if (typeof process !== 'undefined' && process.env?.RENDER) {
    // Render
    config = {
      type: 'cloudinary',
      cloudName: { type: 'render', key: 'CLOUDINARY_CLOUD_NAME' },
      folder: 'sog-bundles',
    };
  } else if (typeof process !== 'undefined' && process.env?.NETLIFY) {
    // Netlify
    config = {
      type: 'cloudinary',
      cloudName: { type: 'netlify', key: 'CLOUDINARY_CLOUD_NAME' },
      folder: 'sog-bundles',
    };
  } else {
    throw new Error('No recognized deployment environment detected');
  }
  
  const { adapter } = await createStorageAdapter(config);
  getStorageRegistry().register(adapter);
  
  return adapter;
}

// ============================================
// 10. CLEANUP
// ============================================

import { cleanupAllStorageAdapters } from '@splatwalk/storage';

// On app shutdown or page unload:
window.addEventListener('beforeunload', () => {
  cleanupAllStorageAdapters();
});

// ============================================
// 11. COMPLETE STREAMING EXAMPLE
// ============================================

async function completeStreamingExample() {
  try {
    // Get file from user
    const fileInput = document.getElementById('bundleInput') as HTMLInputElement;
    const file = fileInput.files?.[0];
    
    if (!file) {
      console.error('Please select a file');
      return;
    }
    
    // Create adapter
    console.log('Creating adapter...');
    const { adapter } = await createStorageAdapter({
      type: 'local',
      source: file,
    });
    
    // Load manifest
    console.log('Loading manifest...');
    const manifest = await adapter.getManifest();
    console.log('Manifest loaded:', manifest);
    
    // Load LOD 0 chunks
    if (manifest.lods?.[0]) {
      const chunks = manifest.lods[0].chunks.slice(0, 3);
      console.log(`Loading ${chunks.length} chunks from LOD 0...`);
      
      const responses = await adapter.fetchChunks(chunks);
      responses.forEach((r, i) => {
        console.log(`  ✓ Chunk ${i}: ${r.data.length} bytes`);
      });
    }
    
    console.log('✓ Ready to render!');
    
  } catch (error) {
    console.error('Error:', error);
  }
}

// ============================================
// 12. PROGRESS TRACKING
// ============================================

async function trackProgress(adapter: any) {
  const manifest = await adapter.getManifest();
  const totalChunks = manifest.lods
    .reduce((sum: number, lod: any) => sum + (lod.chunks?.length || 0), 0);
  
  let loaded = 0;
  
  console.log(`Total chunks: ${totalChunks}`);
  
  for (const chunk of manifest.lods[0].chunks.slice(0, 5)) {
    await adapter.fetchChunk(chunk);
    loaded++;
    const progress = Math.round((loaded / totalChunks) * 100);
    console.log(`Progress: ${progress}% (${loaded}/${totalChunks})`);
  }
}

// ============================================
// 13. ERROR HANDLING
// ============================================

async function safeLoad(file: File) {
  try {
    const { adapter } = await createStorageAdapter({
      type: 'local',
      source: file,
    });
    
    const manifest = await adapter.getManifest();
    
    if (!manifest.lods || manifest.lods.length === 0) {
      throw new Error('Invalid manifest: no LODs found');
    }
    
    return adapter;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load: ${message}`);
    throw error;
  }
}

// ============================================
// TIPS
// ============================================

/*
✓ Always initialize secrets resolver early:
  initializeGlobalSecretsResolver({ autoDetect: true });

✓ Register adapters with the registry:
  getStorageRegistry().register(adapter);

✓ Clean up on app shutdown:
  cleanupAllStorageAdapters();

✓ Use secret references in production:
  cloudName: { type: 'github', key: 'CLOUDINARY_CLOUD_NAME' }

✓ Use direct credentials only for development:
  cloudName: 'my-cloud'

✓ Fetch multiple chunks in parallel:
  adapter.fetchChunks([path1, path2, path3])

✓ Handle errors gracefully:
  try { ... } catch (error) { ... }

✓ Monitor chunk loading progress
  for (const path of chunks) { ... }
*/
