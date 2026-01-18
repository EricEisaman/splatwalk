# G2M: Gaussian to Mesh Converter

## Overview
G2M is a Progressive Web Application (PWA) that allows users to convert Gaussian Splat files (.spz, .ply) into standard 3D Mesh files (.glb). The application leverages the performance of Rust via WebAssembly (WASM) for the heavy computational tasks of geometry processing and uses BabylonJS for real-time 3D visualization.

## Core Features
1.  **File Input**:
    -   Drag and drop interface.
    -   Supports `.ply` (standard Gaussian Splatting format) and `.spz` (compressed Gaussian Splats).

2.  **Processing (Rust WASM)**:
    -   **Parsing**: efficiently read Splat data.
    -   **Conversion Algorithms**:
        -   Delaunay Triangulation.
        -   Poisson Reconstruction.
    -   **Output Generation**: Create a mesh buffer compatible with .glb export.

3.  **Visualization (BabylonJS)**:
    -   Interactive 3D viewer.
    -   Preview the input Splats (optional/if feasible) or the resulting Mesh.
    -   Visual feedback during processing.

4.  **Export**:
    -   Simple "Download .glb" button for the converted mesh.

5.  **Deployment & Architecture**:
    -   **Local Dev**: Vite + Custom WASM build scripts.
    -   **Production**: Dockerized deployment on Render.com (multi-stage build: Rust Builder -> Node Builder -> Nginx).
    -   **PWA**: Offline valid, service worker caching.

## Tech Stack
-   **Frontend**: TypeScript, Vite, BabylonJS.
-   **Backend/Compute**: Rust, wasm-bindgen.
-   **Infrastructure**: Docker, Nginx, Render.com.
