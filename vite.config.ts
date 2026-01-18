import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync, existsSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

// Custom plugin for dev server routing
function devServerRouting(): Plugin {
  return {
    name: 'dev-server-routing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (!url) {
          next();
          return;
        }

        // Only handle HTML requests (not assets)
        // Check if URL is a file extension (ends with common asset extensions)
        const isAssetFile = /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|wasm|json|webp|mjs)$/i.test(url);
        if (url.endsWith('.html') || (!isAssetFile && !url.startsWith('/@'))) {
          // Rewrite /splatwalk to /index.html (or handle root)
          // Since we moved from g2m.html to index.html, we use root.
          // But keep for safety if users use old link? No, we are rebranding.
          // Let's just remove the rewrite or update it if we want /app
          if (url === '/app' || url.startsWith('/app?')) {
            req.url = '/index.html' + (url.includes('?') ? url.substring(url.indexOf('?')) : '');
          }
        }
        next();
      });
    },
  };
}

// Recursively copy directory and rewrite import.meta.url in JS files to use absolute paths
function copyDir(src: string, dest: string, moduleName: string): void {
  if (!existsSync(src)) {
    return;
  }

  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, moduleName);
    } else if (entry.name.endsWith('.js')) {
      // For JS files, read, rewrite import.meta.url to use absolute paths, then write
      let content = readFileSync(srcPath, 'utf-8');

      // Verify source file has content before processing
      if (!content || content.length === 0) {
        throw new Error(`Empty source file: ${srcPath}`);
      }

      // Verify source file size is reasonable (should be at least 8KB for WASM modules)
      // Files around 3.5KB are incomplete (only have initialization code, no exports)
      // This catches incomplete files from the rust-builder stage
      if (content.length < 8000 && entry.name.includes('wasm_') && !entry.name.includes('.d.ts')) {
        const sourceExports = content.match(/export\s+(function|const|let|var)\s+(\w+)\s*[=(]/g) || [];
        const sourceExportNames = sourceExports.map(exp => {
          const match = exp.match(/export\s+(?:function|const|let|var)\s+(\w+)/);
          return match ? match[1] : '';
        }).filter(Boolean);

        // Check if file has exports - if it's small but has exports, it might be OK
        // But if it's small AND has no exports, it's definitely incomplete
        if (sourceExportNames.length === 0) {
          throw new Error(
            `Source file ${srcPath} is incomplete from rust-builder stage: ` +
            `size ${content.length} bytes (expected ~10KB), no exports found. ` +
            `File appears to only contain initialization code. ` +
            `First 300 chars: ${content.substring(0, 300)}`
          );
        }

        // If it has exports but is small, log a warning but allow it
        console.warn(
          `[copy-wasm-modules] Warning: Source file ${srcPath} is smaller than expected ` +
          `(${content.length} bytes, expected ~10KB) but has ${sourceExportNames.length} exports: ${sourceExportNames.join(', ')}`
        );
      }

      // Verify source file has exports before processing (critical check)
      const sourceExportCount = (content.match(/export\s+(function|const|let|var|default|{)/g) || []).length;
      if (sourceExportCount === 0 && entry.name.includes('wasm_')) {
        throw new Error(
          `Source file ${srcPath} has no exports. This indicates the file from rust-builder stage is incomplete. ` +
          `File size: ${content.length} bytes. ` +
          `Expected: ~10KB with exports like calculate, process_text, get_stats, etc. ` +
          `First 500 chars: ${content.substring(0, 500)}`
        );
      }

      // Rewrite: new URL('wasm_module_bg.wasm', import.meta.url)
      // To: '/pkg/wasm_module/wasm_module_bg.wasm'
      // This ensures WASM binaries load correctly regardless of where the script is located
      content = content.replace(
        /new URL\((['"])([^'"]+)\1,\s*import\.meta\.url\)/g,
        (match, quote, wasmPath) => {
          const absolutePath = `/pkg/${moduleName}/${wasmPath}`;
          return quote + absolutePath + quote;
        }
      );

      // Verify exports are preserved after processing (check for export statements)
      const exportCount = (content.match(/export\s+(function|const|let|var|default|{)/g) || []).length;
      if (exportCount === 0 && entry.name.includes('wasm_')) {
        throw new Error(
          `File ${destPath} appears to have no exports after processing. ` +
          `Source had ${sourceExportCount} exports, processed has ${exportCount}. ` +
          `This suggests the regex replacement broke the file.`
        );
      }

      // Verify file size is reasonable after processing (should be at least 3KB for WASM modules)
      if (content.length < 3000 && entry.name.includes('wasm_') && !entry.name.includes('.d.ts')) {
        throw new Error(
          `File ${destPath} is suspiciously small after processing (${content.length} bytes). ` +
          `Source was ${readFileSync(srcPath, 'utf-8').length} bytes.`
        );
      }

      writeFileSync(destPath, content, 'utf-8');

      // Verify the written file
      const writtenContent = readFileSync(destPath, 'utf-8');
      if (writtenContent.length !== content.length) {
        throw new Error(`File write verification failed for ${destPath}. Expected ${content.length} bytes, got ${writtenContent.length}`);
      }
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// Plugin to remove __vitePreload wrapper for external pkg/ imports
// Vite's __vitePreload wrapper can interfere with external module loading
// This plugin rewrites __vitePreload(()=>import("/pkg/...")) to direct import("/pkg/...")
// Note: This must run AFTER Vite's internal plugins that add __vitePreload
function removeVitePreload(): Plugin {
  return {
    name: 'remove-vite-preload',
    enforce: 'post', // Run after Vite's internal plugins
    renderChunk(code, chunk) {
      // Check if this chunk contains pkg/ imports
      if (!code.includes('/pkg/')) {
        return null;
      }

      // Check if it contains __vitePreload with pkg/
      const hasVitePreload = code.includes('__vitePreload') && code.includes('/pkg/');
      if (!hasVitePreload) {
        return null;
      }

      let modifiedCode = code;

      // Try multiple patterns to catch all variations
      let totalReplacements = 0;

      // Pattern 1: Match with []: __vitePreload(()=>import("/pkg/..."),[])
      const pattern1 = /__vitePreload\s*\(\s*\(\)\s*=>\s*import\s*\((['"])\/pkg\/([^'"]+)\1\)\s*,\s*\[\]\s*\)/g;
      modifiedCode = modifiedCode.replace(pattern1, (match, quote, path) => {
        totalReplacements++;
        return `import(${quote}/pkg/${path}${quote})`;
      });

      // Pattern 2: Match with __VITE_IS_MODERN__ condition: __vitePreload(() => import('/pkg/...'),__VITE_IS_MODERN__?__VITE_PRELOAD__:void)
      // This is the actual pattern Vite uses in production builds
      const pattern2 = /__vitePreload\s*\(\s*\(\)\s*=>\s*import\s*\((['"])\/pkg\/([^'"]+)\1\)\s*,\s*[^)]+\)/g;
      modifiedCode = modifiedCode.replace(pattern2, (match, quote, path) => {
        totalReplacements++;
        return `import(${quote}/pkg/${path}${quote})`;
      });

      if (totalReplacements === 0) {
        return null;
      }

      return modifiedCode !== code ? { code: modifiedCode, map: null } : null;
    },
    generateBundle(options, bundle) {
      // Also process in generateBundle as fallback (runs after renderChunk)
      let totalReplacements = 0;
      for (const [fileName, chunkOrAsset] of Object.entries(bundle)) {
        if (chunkOrAsset.type === 'chunk' && chunkOrAsset.code) {
          let code = chunkOrAsset.code;
          const beforeCount = (code.match(/__vitePreload[^)]*import[^)]*\/pkg[^)]*\)/g) || []).length;

          if (beforeCount === 0) {
            continue;
          }

          // Remove __vitePreload wrapper - match both patterns
          // Pattern 1: with []
          code = code.replace(
            /__vitePreload\s*\(\s*\(\)\s*=>\s*import\s*\((['"])\/pkg\/([^'"]+)\1\)\s*,\s*\[\]\s*\)/g,
            (match, quote, path) => {
              totalReplacements++;
              return `import(${quote}/pkg/${path}${quote})`;
            }
          );

          // Pattern 2: with __VITE_IS_MODERN__ condition
          code = code.replace(
            /__vitePreload\s*\(\s*\(\)\s*=>\s*import\s*\((['"])\/pkg\/([^'"]+)\1\)\s*,\s*[^)]+\)/g,
            (match, quote, path) => {
              totalReplacements++;
              return `import(${quote}/pkg/${path}${quote})`;
            }
          );

          const afterCount = (code.match(/__vitePreload[^)]*import[^)]*\/pkg[^)]*\)/g) || []).length;
          if (beforeCount > afterCount) {
            console.log(`[remove-vite-preload] generateBundle: Replaced ${beforeCount - afterCount} occurrences in ${fileName}`);
          }

          chunkOrAsset.code = code;
        }
      }
      if (totalReplacements > 0) {
        console.log(`[remove-vite-preload] generateBundle: Total replacements: ${totalReplacements}`);
      }
    },
  };
}

// Plugin to rewrite pkg/ import paths to absolute paths
function rewriteWasmImports(): Plugin {
  return {
    name: 'rewrite-wasm-imports',
    renderChunk(code, chunk) {
      // renderChunk processes chunks after they're generated, including external imports
      // This ensures we catch dynamic imports even when modules are marked external
      // Rewrite relative pkg/ imports to absolute /pkg/ paths
      let modifiedCode = code;

      // Pattern 1: import('../../pkg/...') or import("../pkg/...")
      modifiedCode = modifiedCode.replace(
        /import\s*\((['"])(\.\.\/)+pkg\/([^'"]+)\1\)/g,
        (match, quote, dots, path) => {
          return `import(${quote}/pkg/${path}${quote})`;
        }
      );

      // Pattern 2: Single level relative ../pkg/...
      modifiedCode = modifiedCode.replace(
        /import\s*\((['"])\.\.\/pkg\/([^'"]+)\1\)/g,
        (match, quote, path) => {
          return `import(${quote}/pkg/${path}${quote})`;
        }
      );

      // Pattern 3: Already absolute but might need fixing (shouldn't happen, but just in case)
      // This is a no-op but ensures consistency

      return modifiedCode !== code ? { code: modifiedCode, map: null } : null;
    },
    generateBundle(options, bundle) {
      // Also process in generateBundle as fallback for any chunks that weren't processed
      for (const [fileName, chunkOrAsset] of Object.entries(bundle)) {
        if (chunkOrAsset.type === 'chunk' && chunkOrAsset.code) {
          let code = chunkOrAsset.code;

          // Same patterns as renderChunk
          code = code.replace(
            /import\s*\((['"])(\.\.\/)+pkg\/([^'"]+)\1\)/g,
            (match, quote, dots, path) => {
              return `import(${quote}/pkg/${path}${quote})`;
            }
          );

          code = code.replace(
            /import\s*\((['"])\.\.\/pkg\/([^'"]+)\1\)/g,
            (match, quote, path) => {
              return `import(${quote}/pkg/${path}${quote})`;
            }
          );

          chunkOrAsset.code = code;
        }
      }
    },
  };
}

// Validate that a copied WASM module file has all expected exports
function validateWasmModuleExports(filePath: string, moduleName: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Module ${moduleName} validation failed: File does not exist at ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');

  // Verify file has content
  if (!content || content.length === 0) {
    throw new Error(`Module ${moduleName} validation failed: File is empty at ${filePath}`);
  }

  // Define expected exports for each module
  const expectedExports: Record<string, string[]> = {
    wasm_splatwalk: ['init_splatwalk'],
  };

  const expected = expectedExports[moduleName];
  if (!expected) {
    // Module not in our list, skip validation
    return;
  }

  const missingExports: string[] = [];
  for (const exportName of expected) {
    // Check for export function exportName or export const exportName
    // Don't use global flag with test() - create new regex each time to avoid state issues
    // Pattern: export function exportName( or export const exportName = or export let exportName =
    const exportPattern = new RegExp(`export\\s+(function|const|let|var)\\s+${exportName}\\s*[=(]`);
    if (!exportPattern.test(content)) {
      missingExports.push(exportName);
    }
  }

  if (missingExports.length > 0) {
    // Find what exports are actually present for better debugging
    const actualExports = content.match(/export\s+(function|const|let|var)\s+(\w+)\s*[=(]/g) || [];
    const actualExportNames = actualExports.map(exp => {
      const match = exp.match(/export\s+(?:function|const|let|var)\s+(\w+)/);
      return match ? match[1] : '';
    }).filter(Boolean);

    throw new Error(
      `Module ${moduleName} is missing required exports: ${missingExports.join(', ')}. ` +
      `File: ${filePath}. ` +
      `File size: ${content.length} bytes. ` +
      `Actual exports found: ${actualExportNames.join(', ') || 'none'}`
    );
  }

  console.log(`[copy-wasm-modules] ✓ Validated ${moduleName}: all ${expected.length} exports present`);
}

// Plugin to copy public directory to dist during build
// Vite should copy public/ automatically, but we ensure it happens explicitly
function copyPublicAssets(): Plugin {
  const copyPublicDir = (src: string, dest: string): void => {
    if (!existsSync(src)) {
      return;
    }

    mkdirSync(dest, { recursive: true });

    const entries = readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        copyPublicDir(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  };

  return {
    name: 'copy-public-assets',
    writeBundle() {
      const publicDir = resolve(__dirname, 'public');
      const distDir = resolve(__dirname, 'dist');

      if (!existsSync(publicDir)) {
        console.warn(`[copy-public-assets] Warning: public/ directory not found at ${publicDir}`);
        return;
      }

      if (!existsSync(distDir)) {
        console.warn(`[copy-public-assets] Warning: dist/ directory not found at ${distDir}`);
        return;
      }

      console.log(`[copy-public-assets] Copying public/ directory to dist/`);

      copyPublicDir(publicDir, distDir);
      console.log(`[copy-public-assets] ✓ Copy complete`);
    },
    buildEnd() {
      // Also run in buildEnd as a fallback to ensure copy happens
      // This is needed in case writeBundle didn't run or dist/ wasn't created yet
      const publicDir = resolve(__dirname, 'public');
      const distDir = resolve(__dirname, 'dist');

      if (!existsSync(publicDir)) {
        console.warn(`[copy-public-assets] Warning: public/ directory not found at ${publicDir} in buildEnd hook`);
        return;
      }

      // Check for expected public assets
      const iconsDir = join(distDir, 'icons');
      const manifestPath = join(distDir, 'manifest.json');
      const swPath = join(distDir, 'sw.js');
      const faviconPath = join(distDir, 'favicon.ico');

      const iconsExists = existsSync(iconsDir);
      const manifestExists = existsSync(manifestPath);
      const swExists = existsSync(swPath);
      const faviconExists = existsSync(faviconPath);

      console.log(`[copy-public-assets] buildEnd: Checking public assets in dist/`);
      console.log(`[copy-public-assets] buildEnd: icons/ exists: ${iconsExists}`);
      console.log(`[copy-public-assets] buildEnd: manifest.json exists: ${manifestExists}`);
      console.log(`[copy-public-assets] buildEnd: sw.js exists: ${swExists}`);
      console.log(`[copy-public-assets] buildEnd: favicon.ico exists: ${faviconExists}`);

      // Check if icons directory has content
      let iconsHasContent = false;
      if (iconsExists) {
        try {
          const iconEntries = readdirSync(iconsDir, { withFileTypes: true });
          iconsHasContent = iconEntries.length > 0;
          console.log(`[copy-public-assets] buildEnd: icons/ has ${iconEntries.length} files`);
        } catch {
          iconsHasContent = false;
          console.warn(`[copy-public-assets] buildEnd: Could not read icons/ directory`);
        }
      }

      // Determine if we need to copy
      const needsCopy = !iconsExists || !iconsHasContent || !manifestExists || !swExists || !faviconExists;

      if (needsCopy) {
        if (!existsSync(distDir)) {
          console.log(`[copy-public-assets] Fallback: dist/ doesn't exist, creating and copying in buildEnd hook`);
          mkdirSync(distDir, { recursive: true });
        } else {
          console.log(`[copy-public-assets] Fallback: Missing public assets detected, copying in buildEnd hook`);
          if (iconsExists && !iconsHasContent) {
            console.log(`[copy-public-assets] Fallback: icons/ exists but is empty, will be overwritten`);
          }
        }

        try {
          copyPublicDir(publicDir, distDir);
          console.log(`[copy-public-assets] Fallback: ✓ Copy complete`);

          // Verify after copy
          const iconsExistsAfter = existsSync(iconsDir);
          const manifestExistsAfter = existsSync(manifestPath);
          const swExistsAfter = existsSync(swPath);
          const faviconExistsAfter = existsSync(faviconPath);

          console.log(`[copy-public-assets] Fallback: Verification after copy:`);
          console.log(`[copy-public-assets] Fallback: icons/ exists: ${iconsExistsAfter}`);
          console.log(`[copy-public-assets] Fallback: manifest.json exists: ${manifestExistsAfter}`);
          console.log(`[copy-public-assets] Fallback: sw.js exists: ${swExistsAfter}`);
          console.log(`[copy-public-assets] Fallback: favicon.ico exists: ${faviconExistsAfter}`);

          if (iconsExistsAfter) {
            try {
              const iconEntries = readdirSync(iconsDir, { withFileTypes: true });
              console.log(`[copy-public-assets] Fallback: icons/ now has ${iconEntries.length} files`);
            } catch {
              console.warn(`[copy-public-assets] Fallback: Warning: Could not read icons/ after copy`);
            }
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`[copy-public-assets] Fallback: Error copying public assets: ${errorMsg}`);
        }
      } else {
        console.log(`[copy-public-assets] buildEnd: All public assets present, skipping fallback copy`);
      }
    },
    closeBundle() {
      // Final fallback - runs after all bundles are closed
      // This ensures copy happens even if writeBundle and buildEnd didn't run
      const publicDir = resolve(__dirname, 'public');
      const distDir = resolve(__dirname, 'dist');
      const iconsDir = join(distDir, 'icons');

      if (!existsSync(publicDir)) {
        return;
      }

      // Only copy if icons are still missing
      if (!existsSync(iconsDir)) {
        console.log(`[copy-public-assets] closeBundle: Icons missing, copying public/ directory`);
        try {
          const copyPublicDir = (src: string, dest: string): void => {
            if (!existsSync(src)) {
              return;
            }
            mkdirSync(dest, { recursive: true });
            const entries = readdirSync(src, { withFileTypes: true });
            for (const entry of entries) {
              const srcPath = join(src, entry.name);
              const destPath = join(dest, entry.name);
              if (entry.isDirectory()) {
                copyPublicDir(srcPath, destPath);
              } else {
                copyFileSync(srcPath, destPath);
              }
            }
          };
          copyPublicDir(publicDir, distDir);
          console.log(`[copy-public-assets] closeBundle: ✓ Copy complete`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`[copy-public-assets] closeBundle: Error: ${errorMsg}`);
        }
      }
    },
  };
}

// Plugin to copy pkg directory to dist/pkg during build
function copyWasmModules(): Plugin {
  return {
    name: 'copy-wasm-modules',
    writeBundle() {
      // Use writeBundle instead of buildEnd to ensure dist/ exists
      // This hook is called after all files are written to disk
      const pkgDir = resolve(__dirname, 'pkg');
      const distPkgDir = resolve(__dirname, 'dist', 'pkg');

      if (existsSync(pkgDir)) {
        console.log(`[copy-wasm-modules] Copying pkg/ directory from ${pkgDir} to ${distPkgDir}`);

        // Remove existing dist/pkg if it exists to ensure clean copy
        if (existsSync(distPkgDir)) {
          rmSync(distPkgDir, { recursive: true, force: true });
        }

        // Copy with base path for import.meta.url rewriting
        const entries = readdirSync(pkgDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const moduleName = entry.name;
            console.log(`[copy-wasm-modules] Copying module: ${moduleName}`);
            copyDir(
              join(pkgDir, moduleName),
              join(distPkgDir, moduleName),
              moduleName
            );

            // Validate the copied JS file has all expected exports
            const jsFilePath = join(distPkgDir, moduleName, `${moduleName}.js`);
            if (existsSync(jsFilePath)) {
              validateWasmModuleExports(jsFilePath, moduleName);
            }
          }
        }

        console.log(`[copy-wasm-modules] ✓ Copy complete`);
      } else {
        console.warn(`[copy-wasm-modules] Warning: pkg/ directory not found at ${pkgDir}`);
      }
    },
    buildEnd() {
      // Also run in buildEnd as a fallback to ensure copy happens
      // This is needed in case writeBundle didn't run or dist/ wasn't created yet
      // Note: This is a fallback, so we're more lenient with validation here
      const pkgDir = resolve(__dirname, 'pkg');
      const distPkgDir = resolve(__dirname, 'dist', 'pkg');

      // Only run if pkg exists but dist/pkg doesn't (writeBundle didn't copy)
      // OR if dist/pkg exists but is empty (writeBundle may have failed)
      if (existsSync(pkgDir)) {
        const distPkgExists = existsSync(distPkgDir);
        let distPkgEmpty = false;

        if (distPkgExists) {
          try {
            const entries = readdirSync(distPkgDir, { withFileTypes: true });
            distPkgEmpty = entries.length === 0;
          } catch {
            // If we can't read the directory, treat it as if it doesn't exist
            distPkgEmpty = true;
          }
        }

        if (!distPkgExists || distPkgEmpty) {
          if (distPkgEmpty && distPkgExists) {
            console.log(`[copy-wasm-modules] Fallback: dist/pkg exists but is empty, copying in buildEnd hook`);
            try {
              rmSync(distPkgDir, { recursive: true, force: true });
            } catch {
              // Ignore errors when removing - might not exist or be empty
            }
          } else {
            console.log(`[copy-wasm-modules] Fallback: dist/pkg doesn't exist, copying in buildEnd hook`);
          }

          const entries = readdirSync(pkgDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const moduleName = entry.name;
              try {
                copyDir(
                  join(pkgDir, moduleName),
                  join(distPkgDir, moduleName),
                  moduleName
                );

                // Validate the copied JS file - but only if it exists and has content
                // In buildEnd (fallback), we log warnings instead of throwing errors
                const jsFilePath = join(distPkgDir, moduleName, `${moduleName}.js`);
                if (existsSync(jsFilePath)) {
                  try {
                    validateWasmModuleExports(jsFilePath, moduleName);
                    console.log(`[copy-wasm-modules] Fallback: ✓ Validated ${moduleName}`);
                  } catch (error) {
                    // In fallback mode, log as warning but don't fail the build
                    // The writeBundle hook should have already validated if it ran
                    const fileContent = readFileSync(jsFilePath, 'utf-8');
                    console.warn(`[copy-wasm-modules] Fallback: Validation warning for ${moduleName}. File size: ${fileContent.length} bytes`);
                    console.warn(`[copy-wasm-modules] Fallback: First 500 chars: ${fileContent.substring(0, 500)}`);
                    // Don't throw - this is a fallback, and writeBundle should have already validated
                  }
                } else {
                  console.warn(`[copy-wasm-modules] Fallback: Warning: JS file not found at ${jsFilePath} after copy`);
                }
              } catch (error) {
                // Log but don't fail - writeBundle should have handled this
                console.warn(`[copy-wasm-modules] Fallback: Error copying ${moduleName}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        } else {
          // dist/pkg exists and is not empty - writeBundle likely already copied and validated
          console.log(`[copy-wasm-modules] buildEnd: dist/pkg already exists with content, skipping fallback copy`);
        }
      } else {
        console.warn(`[copy-wasm-modules] Warning: pkg/ directory not found at ${pkgDir} in buildEnd hook`);
      }
    },
  };
}

export default defineConfig({
  publicDir: 'public', // Explicitly enable public directory copying
  plugins: [devServerRouting(), removeVitePreload(), rewriteWasmImports(), copyPublicAssets(), copyWasmModules()],
  build: {
    copyPublicDir: true, // Explicitly enable copying public directory (may be disabled with rollupOptions.input)
    target: 'esnext',
    assetsInlineLimit: 0, // Prevent WASM from being inlined as data URIs
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        format: 'es',
      },
      external: (id) => {
        // Mark pkg/ directory imports as external - they should be loaded at runtime, not bundled
        // This preserves:
        // 1. All exports (no tree-shaking removes calculate, process_text, get_stats)
        // 2. import.meta.url (so WASM binary paths work correctly)
        // The rewriteWasmImports plugin rewrites import paths to absolute /pkg/ paths
        // The copyWasmModules plugin copies files to dist/pkg/ with rewritten WASM paths

        // Handle various path formats:
        // - /pkg/... (absolute)
        // - ./pkg/... or ../pkg/... (relative)
        // - pkg/... (no leading slash)
        // - Windows paths with backslashes
        const isExternal =
          id.includes('/pkg/') ||
          id.includes('\\pkg\\') ||
          id.startsWith('pkg/') ||
          id.startsWith('./pkg/') ||
          id.startsWith('../pkg/') ||
          /^\.\.\/.*pkg\//.test(id) ||
          /^\.\/.*pkg\//.test(id);

        if (isExternal) {
          console.log(`[vite-external] Marking as external: ${id}`);
        }

        return isExternal;
      },
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
  optimizeDeps: {
    exclude: ['../pkg'],
  },
  // Ensure WASM files are treated as static assets
  assetsInclude: ['**/*.wasm'],
});

