// SplatWalk Storage Adapter System Playground Demo
// ---------------------------------------------------------------------------
// Demonstrates the SOG LOD Storage Adapter system with multiple backends:
// - Local ZIP file uploads
// - Cloudinary CDN configuration
// - Secret credential management (GitHub, Render, Netlify)
//
// This is a self-contained, interactive demo of the @splatwalk/storage module
// showing how to:
//   1. Configure storage backends
//   2. Load SOG LOD bundles from different sources
//   3. Manage credentials securely
//   4. Stream chunks for GPU rendering
//
// Usage:
//   - Paste this file into https://playground.babylonjs.com (switch to TS mode)
//   - Or run in a modern browser with ES module support
//   - Upload a SOG bundle ZIP or configure Cloudinary access
//
// Entry point: `class StoragePlayground` with static `CreateScene(engine, canvas)`
// ---------------------------------------------------------------------------

import type { StorageConfig, StorageAdapter, SecretsResolver } from '@splatwalk/storage';
import {
  createStorageAdapter,
  validateStorageConfig,
  getStorageRegistry,
  getGlobalSecretsResolver,
  initializeGlobalSecretsResolver,
} from '@splatwalk/storage';

/**
 * Storage configuration templates for the playground.
 */
const STORAGE_TEMPLATES = {
  local: {
    name: 'Local ZIP Upload',
    description: 'Upload a SOG bundle ZIP file from your computer',
    config: (file?: File) => ({
      type: 'local' as const,
      source: file || new Blob(),
    }),
  },
  cloudinaryDirect: {
    name: 'Cloudinary (Direct)',
    description: 'Connect to Cloudinary with hardcoded credentials (dev only)',
    config: (cloudName: string, folder: string) => ({
      type: 'cloudinary' as const,
      cloudName,
      folder,
    }),
  },
  cloudinaryGitHub: {
    name: 'Cloudinary (GitHub Secrets)',
    description: 'Use GitHub Secrets for secure credential management',
    config: (folder: string) => ({
      type: 'cloudinary' as const,
      cloudName: { type: 'github' as const, key: 'CLOUDINARY_CLOUD_NAME' },
      folder,
    }),
  },
  cloudinaryRender: {
    name: 'Cloudinary (Render.com)',
    description: 'Use Render.com environment variables',
    config: (folder: string) => ({
      type: 'cloudinary' as const,
      cloudName: { type: 'render' as const, key: 'CLOUDINARY_CLOUD_NAME' },
      folder,
    }),
  },
  cloudinaryNetlify: {
    name: 'Cloudinary (Netlify)',
    description: 'Use Netlify environment variables',
    config: (folder: string) => ({
      type: 'cloudinary' as const,
      cloudName: { type: 'netlify' as const, key: 'CLOUDINARY_CLOUD_NAME' },
      folder,
    }),
  },
};

/**
 * UI state for the storage playground.
 */
interface PlaygroundState {
  currentAdapter: StorageAdapter | null;
  manifestUrl: string | null;
  manifest: unknown | null;
  loadedChunks: Map<string, Uint8Array>;
  selectedStorage: keyof typeof STORAGE_TEMPLATES;
  status: string[];
  error: string | null;
}

/**
 * Storage Playground - Interactive demo for the storage adapter system.
 */
export class StoragePlayground {
  private state: PlaygroundState = {
    currentAdapter: null,
    manifestUrl: null,
    manifest: null,
    loadedChunks: new Map(),
    selectedStorage: 'local',
    status: [],
    error: null,
  };

  private uiElements = {
    storageSelect: null as HTMLSelectElement | null,
    configInput: null as HTMLInputElement | null,
    fileInput: null as HTMLInputElement | null,
    connectButton: null as HTMLButtonElement | null,
    statusPanel: null as HTMLDivElement | null,
    manifestPanel: null as HTMLDivElement | null,
    chunksList: null as HTMLDivElement | null,
    errorPanel: null as HTMLDivElement | null,
  };

  public constructor(private canvas: HTMLCanvasElement) {}

  /**
   * Initialize the playground UI and scene.
   */
  static async CreateScene(engine: any, canvas: HTMLCanvasElement): Promise<any> {
    const playground = new StoragePlayground(canvas);
    await playground.initialize();
    return { playground };
  }

  /**
   * Initialize the playground.
   */
  private async initialize(): Promise<void> {
    this.addLog('Initializing Storage Adapter Playground...');

    // Create UI
    this.createUI();

    // Initialize secrets resolver
    try {
      initializeGlobalSecretsResolver({
        autoDetect: true,
      });
      this.addLog('Secrets resolver initialized with auto-detection');
    } catch (error) {
      this.addError(`Failed to initialize secrets resolver: ${error}`);
    }

    this.addLog('Playground ready. Select a storage backend and connect.');
  }

  /**
   * Create the playground UI.
   */
  private createUI(): void {
    // Create container
    const container = document.createElement('div');
    container.id = 'storage-playground';
    container.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      width: 420px;
      max-height: 90vh;
      background: rgba(10, 13, 18, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      padding: 16px;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      color: #e8eefc;
      z-index: 100;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(12px);
    `;

    // Title
    const title = document.createElement('h2');
    title.textContent = 'SOG Storage Adapter';
    title.style.cssText = `
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 700;
      color: #39ff14;
    `;
    container.appendChild(title);

    // Storage type selector
    const storageLabel = document.createElement('label');
    storageLabel.textContent = 'Storage Backend:';
    storageLabel.style.cssText = 'display: block; margin-bottom: 6px; font-weight: 600;';
    container.appendChild(storageLabel);

    this.uiElements.storageSelect = document.createElement('select');
    this.uiElements.storageSelect.style.cssText = `
      width: 100%;
      padding: 8px;
      margin-bottom: 12px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      color: #e8eefc;
      font-size: 11px;
    `;

    for (const [key, template] of Object.entries(STORAGE_TEMPLATES)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = `${template.name} - ${template.description}`;
      this.uiElements.storageSelect.appendChild(option);
    }

    this.uiElements.storageSelect.addEventListener('change', (e) => {
      this.state.selectedStorage = (e.target as HTMLSelectElement).value as keyof typeof STORAGE_TEMPLATES;
      this.updateUIForSelectedStorage();
    });

    container.appendChild(this.uiElements.storageSelect);

    // Dynamic input based on storage type
    this.uiElements.configInput = document.createElement('input');
    this.uiElements.configInput.type = 'text';
    this.uiElements.configInput.placeholder = 'Configuration (e.g., cloud name or folder)';
    this.uiElements.configInput.style.cssText = `
      width: 100%;
      padding: 8px;
      margin-bottom: 12px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      color: #e8eefc;
      font-size: 11px;
      box-sizing: border-box;
    `;
    container.appendChild(this.uiElements.configInput);

    // File input (hidden, for local uploads)
    this.uiElements.fileInput = document.createElement('input');
    this.uiElements.fileInput.type = 'file';
    this.uiElements.fileInput.accept = '.zip';
    this.uiElements.fileInput.style.display = 'none';

    // File upload button (shown for local storage)
    const uploadButton = document.createElement('button');
    uploadButton.textContent = 'Select ZIP File';
    uploadButton.style.cssText = `
      width: 100%;
      padding: 8px;
      margin-bottom: 12px;
      background: rgba(57, 255, 20, 0.2);
      border: 1px solid rgba(57, 255, 20, 0.4);
      border-radius: 6px;
      color: #39ff14;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    `;
    uploadButton.addEventListener('click', () => this.uiElements.fileInput!.click());
    uploadButton.addEventListener('mouseover', () => {
      uploadButton.style.background = 'rgba(57, 255, 20, 0.3)';
    });
    uploadButton.addEventListener('mouseout', () => {
      uploadButton.style.background = 'rgba(57, 255, 20, 0.2)';
    });
    uploadButton.id = 'uploadButton';
    uploadButton.style.display = 'none';
    container.appendChild(uploadButton);

    this.uiElements.fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        this.addLog(`Selected file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
      }
    });
    container.appendChild(this.uiElements.fileInput);

    // Connect button
    this.uiElements.connectButton = document.createElement('button');
    this.uiElements.connectButton.textContent = 'Connect';
    this.uiElements.connectButton.style.cssText = `
      width: 100%;
      padding: 10px;
      margin-bottom: 12px;
      background: rgba(57, 255, 20, 0.3);
      border: 1px solid rgba(57, 255, 20, 0.5);
      border-radius: 6px;
      color: #39ff14;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s;
    `;
    this.uiElements.connectButton.addEventListener('click', () => this.connectStorage());
    this.uiElements.connectButton.addEventListener('mouseover', () => {
      this.uiElements.connectButton!.style.background = 'rgba(57, 255, 20, 0.4)';
    });
    this.uiElements.connectButton.addEventListener('mouseout', () => {
      this.uiElements.connectButton!.style.background = 'rgba(57, 255, 20, 0.3)';
    });
    container.appendChild(this.uiElements.connectButton);

    // Status panel
    this.uiElements.statusPanel = document.createElement('div');
    this.uiElements.statusPanel.style.cssText = `
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 12px;
      font-size: 11px;
      max-height: 120px;
      overflow-y: auto;
      font-family: ui-monospace, monospace;
    `;
    container.appendChild(this.uiElements.statusPanel);

    // Manifest panel
    this.uiElements.manifestPanel = document.createElement('div');
    this.uiElements.manifestPanel.style.cssText = `
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 12px;
      font-size: 10px;
      max-height: 150px;
      overflow-y: auto;
      font-family: ui-monospace, monospace;
    `;
    this.uiElements.manifestPanel.textContent = 'No manifest loaded';
    container.appendChild(this.uiElements.manifestPanel);

    // Chunks list
    this.uiElements.chunksList = document.createElement('div');
    this.uiElements.chunksList.style.cssText = `
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 12px;
      font-size: 10px;
      max-height: 150px;
      overflow-y: auto;
      font-family: ui-monospace, monospace;
    `;
    this.uiElements.chunksList.textContent = 'No chunks loaded';
    container.appendChild(this.uiElements.chunksList);

    // Error panel
    this.uiElements.errorPanel = document.createElement('div');
    this.uiElements.errorPanel.style.cssText = `
      background: rgba(255, 90, 60, 0.15);
      border: 1px solid rgba(255, 90, 60, 0.4);
      border-radius: 6px;
      padding: 10px;
      font-size: 10px;
      color: #ff8f6b;
      font-family: ui-monospace, monospace;
      display: none;
      max-height: 100px;
      overflow-y: auto;
    `;
    container.appendChild(this.uiElements.errorPanel);

    document.body.appendChild(container);

    this.updateUIForSelectedStorage();
  }

  /**
   * Update UI based on selected storage type.
   */
  private updateUIForSelectedStorage(): void {
    const isLocal = this.state.selectedStorage === 'local';
    const uploadBtn = document.getElementById('uploadButton');

    if (uploadBtn) {
      uploadBtn.style.display = isLocal ? 'block' : 'none';
    }

    if (this.uiElements.configInput) {
      if (isLocal) {
        this.uiElements.configInput.style.display = 'none';
      } else {
        this.uiElements.configInput.style.display = 'block';
        this.uiElements.configInput.placeholder =
          this.state.selectedStorage === 'cloudinaryDirect'
            ? 'cloud-name (hit Enter after cloud-name to set folder)'
            : 'folder path (e.g., sog-bundles)';
      }
    }
  }

  /**
   * Connect to the selected storage backend.
   */
  private async connectStorage(): Promise<void> {
    try {
      this.state.error = null;
      this.addLog(`Connecting to ${this.state.selectedStorage}...`);

      const template = STORAGE_TEMPLATES[this.state.selectedStorage];
      let config: StorageConfig;

      if (this.state.selectedStorage === 'local') {
        const file = this.uiElements.fileInput?.files?.[0];
        if (!file) {
          throw new Error('Please select a ZIP file');
        }
        config = template.config(file);
      } else if (this.state.selectedStorage === 'cloudinaryDirect') {
        const input = this.uiElements.configInput?.value || '';
        const [cloudName, folder] = input.includes(' ')
          ? input.split(' ', 2)
          : [input, 'sog-bundles'];

        if (!cloudName) {
          throw new Error('Please enter a cloud name');
        }

        config = template.config(cloudName, folder);
      } else {
        const folder = this.uiElements.configInput?.value || 'sog-bundles';
        config = template.config(folder);
      }

      // Validate configuration
      validateStorageConfig(config);
      this.addLog('Configuration validated');

      // Create adapter
      this.addLog('Creating storage adapter...');
      const { adapter, manifestUrl } = await createStorageAdapter(config);

      this.state.currentAdapter = adapter;
      this.state.manifestUrl = manifestUrl;

      getStorageRegistry().register(adapter);
      this.addLog(`✓ Connected to ${this.state.selectedStorage}`);
      this.addLog(`Manifest URL: ${manifestUrl}`);

      // Load manifest
      await this.loadManifest();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addError(`Connection failed: ${message}`);
      this.addLog(`✗ Failed to connect`);
    }
  }

  /**
   * Load and display the manifest.
   */
  private async loadManifest(): Promise<void> {
    try {
      if (!this.state.currentAdapter) {
        throw new Error('No adapter connected');
      }

      this.addLog('Loading manifest...');
      const manifest = await this.state.currentAdapter.getManifest();

      this.state.manifest = manifest;
      this.addLog('✓ Manifest loaded');

      // Display manifest
      if (this.uiElements.manifestPanel) {
        const manifesto = JSON.stringify(manifest, null, 2);
        const preview = manifesto.length > 500 ? manifesto.substring(0, 500) + '...' : manifesto;
        this.uiElements.manifestPanel.textContent = preview;
      }

      // Extract chunks from manifest
      await this.loadChunksFromManifest(manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addError(`Failed to load manifest: ${message}`);
    }
  }

  /**
   * Load chunks from the manifest.
   */
  private async loadChunksFromManifest(manifest: unknown): Promise<void> {
    try {
      const m = manifest as any;

      if (!m.lods || m.lods.length === 0) {
        this.addLog('No LODs found in manifest');
        return;
      }

      const firstLod = m.lods[0];
      if (!firstLod.chunks || firstLod.chunks.length === 0) {
        this.addLog('No chunks in first LOD');
        return;
      }

      const chunkPaths = firstLod.chunks.slice(0, 3); // Load first 3 chunks
      this.addLog(`Loading ${chunkPaths.length} sample chunks from LOD 0...`);

      if (!this.state.currentAdapter) {
        throw new Error('No adapter connected');
      }

      const responses = await this.state.currentAdapter.fetchChunks(chunkPaths);

      for (let i = 0; i < responses.length; i++) {
        this.state.loadedChunks.set(chunkPaths[i], responses[i].data);
        this.addLog(
          `✓ Loaded chunk ${i + 1}: ${chunkPaths[i]} (${responses[i].data.length} bytes)`
        );
      }

      // Display chunks info
      if (this.uiElements.chunksList) {
        const chunkInfo = Array.from(this.state.loadedChunks.entries())
          .map(([path, data]) => `${path}: ${data.length} bytes`)
          .join('\n');
        this.uiElements.chunksList.textContent = chunkInfo || 'No chunks loaded';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addError(`Failed to load chunks: ${message}`);
    }
  }

  /**
   * Add a log message to the status panel.
   */
  private addLog(message: string): void {
    this.state.status.push(message);
    this.state.status = this.state.status.slice(-20); // Keep last 20 logs

    if (this.uiElements.statusPanel) {
      this.uiElements.statusPanel.textContent = this.state.status.join('\n');
      this.uiElements.statusPanel.scrollTop = this.uiElements.statusPanel.scrollHeight;
    }

    console.log('[Storage Adapter]', message);
  }

  /**
   * Add an error message.
   */
  private addError(message: string): void {
    this.state.error = message;
    this.addLog(`⚠ ${message}`);

    if (this.uiElements.errorPanel) {
      this.uiElements.errorPanel.textContent = message;
      this.uiElements.errorPanel.style.display = 'block';
      setTimeout(() => {
        if (this.uiElements.errorPanel) {
          this.uiElements.errorPanel.style.display = 'none';
        }
      }, 5000);
    }

    console.error('[Storage Adapter Error]', message);
  }

  /**
   * Cleanup on disposal.
   */
  public dispose(): void {
    getStorageRegistry().disposeAll();
    this.state.loadedChunks.clear();
    this.addLog('Playground cleaned up');
  }
}

// Export for Babylon Playground
export { StoragePlayground as default };
