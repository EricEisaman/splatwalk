# Multi-stage Dockerfile for Rust WASM + Vite build
# Stage 1: Rust WASM Builder
# Using rust:alpine (smallest image, ~500MB) instead of rust:1-alpine
FROM rust:alpine AS rust-builder

# Install build dependencies
RUN apk add --no-cache \
    musl-dev \
    perl \
    make \
    git \
    bash

# Install wasm-bindgen-cli
# Version must match wasm-bindgen crate version in Cargo.toml
# Using 0.2.106 which is compatible with Rust 1.71+ and matches "0.2" in Cargo.toml
RUN cargo install wasm-bindgen-cli --version 0.2.106

# Ensure wasm-bindgen is in PATH (cargo install puts it in ~/.cargo/bin)
ENV PATH="/root/.cargo/bin:${PATH}"

# Verify wasm-bindgen is accessible and correct version
RUN wasm-bindgen --version || (echo "ERROR: wasm-bindgen not found in PATH" && exit 1)

# Install wasm-opt from binaryen
RUN apk add --no-cache binaryen

# Set working directory
WORKDIR /app

# Copy workspace Cargo.toml and member Cargo.toml files for dependency caching
# **Learning Point**: Add new WASM crate Cargo.toml files here for Docker build caching.
# This allows Docker to cache dependencies separately from source code changes.
COPY Cargo.toml ./
COPY wasm-splatwalk/Cargo.toml ./wasm-splatwalk/

# Add wasm32 target (must be done before building for wasm32-unknown-unknown)
RUN rustup target add wasm32-unknown-unknown

# Create dummy src files to cache dependencies
# **Learning Point**: These dummy files allow Docker to cache compiled dependencies
# separately from source code. When you change source, only source needs rebuilding.
# Add new crates here when creating new WASM modules.
RUN mkdir -p wasm-splatwalk/src && \
    echo "fn main() {}" > wasm-splatwalk/src/lib.rs || true


# Build dependencies only (for caching)
RUN cargo build --target wasm32-unknown-unknown --release --workspace || true

# Copy actual source code
# **Learning Point**: After dependencies are cached, copy the real source code.
# Docker will only rebuild from this point if source files change.
COPY wasm-splatwalk ./wasm-splatwalk
COPY scripts ./scripts

# Make build scripts executable
RUN chmod +x scripts/build.sh scripts/build-wasm.sh

# Clean target directory to ensure fresh build with real source files
# This is critical because the dependency build step (#27) built with dummy files
# and cargo may use cached artifacts if we don't clean
RUN cargo clean --target wasm32-unknown-unknown || true

# Build WASM modules
RUN ./scripts/build.sh

# Verify all WASM modules were built correctly (build.sh already does this, but add extra verification)
# This catches any issues before copying to next stage
RUN echo "Verifying WASM module files in pkg/..." && \
    for js_file in pkg/*/wasm_*.js; do \
      if [ ! -f "$js_file" ]; then \
        echo "ERROR: Missing JS file: $js_file" >&2; \
        exit 1; \
      fi; \
      size=$(stat -c%s "$js_file" 2>/dev/null || echo "0"); \
      if [ "$size" -lt 8000 ]; then \
        echo "ERROR: JS file too small: $js_file ($size bytes)" >&2; \
        exit 1; \
      fi; \
      if ! grep -q "export" "$js_file"; then \
        echo "ERROR: JS file has no exports: $js_file" >&2; \
        exit 1; \
      fi; \
    done && \
    echo "✓ All WASM module files verified successfully"

# Stage 2: Node.js Frontend Builder
# Using node:22-alpine to meet Vite 7 requirements (>=22.12.0) and align with local dev environment
FROM node:22-alpine AS node-builder

WORKDIR /app

# Copy package files for dependency caching
COPY package.json ./

# Install dependencies
# Using npm install instead of npm ci since package-lock.json is gitignored
# This will generate a new package-lock.json during build
RUN npm install

# Copy Rust build output (all WASM modules)
COPY --from=rust-builder /app/pkg ./pkg

# Copy frontend source
COPY src ./src
COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./
COPY public ./public

# Build frontend
# WASM is already built in stage 1, so just run vite build (skip build:wasm)
RUN npx vite build

# After vite build, verify workers exist
RUN echo "Verifying workers in dist/..." && \
    find dist -name "*.worker.js" -exec sh -c 'echo "✓ {} ($(stat -c%s {}))"' \; || \
    { echo "ERROR: No worker.js files found!"; ls -la dist/; exit 1; } && \
    echo "✓ Workers verified"


# Manually copy public directory to dist/ as fallback
# Vite's default public directory copying may not work with rollupOptions.input
# This ensures icons and other public assets are always present
# Explicitly copy each known directory/file (most reliable in busybox/Alpine)
RUN if [ -d "public" ] && [ -d "dist" ]; then \
      echo "Copying public/ directory to dist/ as fallback..." && \
      [ -d "public/icons" ] && cp -r public/icons dist/ || true && \
      [ -f "public/manifest.json" ] && cp public/manifest.json dist/ || true && \
      [ -f "public/sw.js" ] && cp public/sw.js dist/ || true && \
      [ -f "public/favicon.ico" ] && cp public/favicon.ico dist/ || true && \
      [ -f "public/rustacean.webp" ] && cp public/rustacean.webp dist/ || true && \
      echo "✓ Public assets copied to dist/" && \
      echo "Verifying icons directory..." && \
      if [ -d "dist/icons" ]; then \
        icon_count=$(find dist/icons -type f -name "*.png" 2>/dev/null | wc -l) && \
        echo "Found $icon_count icon files in dist/icons/"; \
      else \
        echo "ERROR: dist/icons/ still not found after explicit copy!" >&2; \
        echo "Listing dist/ contents:" && \
        ls -la dist/ || true; \
        echo "Listing public/ contents:" && \
        ls -la public/ || true; \
        exit 1; \
      fi; \
    else \
      echo "Warning: public/ or dist/ directory not found"; \
    fi

# Verify public assets were copied to dist/ (icons, manifest.json, etc.)
# This catches issues before copying to runtime stage
RUN echo "Verifying public assets in dist/..." && \
    if [ ! -d "dist/icons" ]; then \
      echo "ERROR: dist/icons/ directory not found" >&2; \
      exit 1; \
    fi && \
    if [ ! -f "dist/icons/icon-144x144.png" ]; then \
      echo "ERROR: dist/icons/icon-144x144.png not found" >&2; \
      exit 1; \
    fi && \
    if [ ! -f "dist/manifest.json" ]; then \
      echo "ERROR: dist/manifest.json not found" >&2; \
      exit 1; \
    fi && \
    icon_count=$(find dist/icons -type f -name "*.png" | wc -l) && \
    if [ "$icon_count" -lt 10 ]; then \
      echo "ERROR: Expected at least 10 icon files, found $icon_count" >&2; \
      exit 1; \
    fi && \
    echo "✓ All public assets verified successfully (found $icon_count icon files)"

# Stage 3: Runtime (nginx for static files)
FROM nginx:alpine AS runtime

# Install gettext for envsubst (dynamic port substitution) and wget for health checks
RUN apk add --no-cache gettext wget

# Copy built static files
COPY --from=node-builder /app/dist /usr/share/nginx/html

# Copy main nginx configuration with performance optimizations
COPY nginx-main.conf /etc/nginx/nginx.conf

# Copy nginx server configuration template (will be processed with envsubst)
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Copy custom entrypoint script to handle PORT default
COPY docker-entrypoint.sh /docker-entrypoint-custom.sh
RUN chmod +x /docker-entrypoint-custom.sh

# nginx:alpine processes templates in /etc/nginx/templates/ automatically
# Our custom entrypoint ensures PORT has a default value for local testing
# Render.com will always provide PORT environment variable

# Expose port (Render.com will set PORT env var)
EXPOSE 80

# Health check endpoint at /health (Render.com uses healthCheckPath: /)
# Using /health endpoint for Docker HEALTHCHECK, Render.com uses / from render.yaml
# Note: PORT env var is set by Render.com, health check uses default 80 if not set
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD sh -c 'PORT=${PORT:-80}; wget --no-verbose --tries=1 --spider http://localhost:$PORT/health 2>/dev/null || exit 1'

# Use custom entrypoint that handles PORT default, then calls nginx:alpine's entrypoint
ENTRYPOINT ["/docker-entrypoint-custom.sh"]
CMD ["nginx", "-g", "daemon off;"]

