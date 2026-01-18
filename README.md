# SplatWalk

![SplatWalk Logo](public/splatwalk.png)

**SplatWalk** is a convenient one-stop shop for generating optimized **.glb meshes** from **.spz** or **.ply** Gaussian splats.

The primary goal of the application is to provide high-quality mesh reconstruction suited for **downstream navigation applications**, allowing for rapid environment generation from 3D capture data.

## Key Features

- **Instant Visualization**: Load and view Gaussian Splat files immediately.
- **Orientation Control**: Rotate and align splats visually before conversion (90° increments).
- **Ground Plane Detection**: High-performance RANSAC-based ground plane extraction.
- **Mesh Reconstruction**: Integrated Poisson reconstruction for full geometry.
- **One-Click Export**: Download production-ready `.glb` files.

## Technology Stack

- **Core**: Rust (compiled to WASM) for heavy geometry processing.
- **Rendering**: Babylon.js for high-performance 3D visualization.
- **Frontend**: TypeScript + Vite for a modern, responsive web experience.

## License

This project is licensed under the **AGPLv3**.