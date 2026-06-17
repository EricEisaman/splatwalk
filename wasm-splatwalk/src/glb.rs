//! Minimal, dependency-free binary glTF (GLB) writer.
//!
//! Serializes a positions + indices triangle mesh (no materials, no normals) into
//! a single-buffer GLB so a binary integrator can turn vertex/index buffers into
//! GLB bytes without standing up a full 3D engine per call. This is intentionally
//! tiny: one buffer, two buffer views (indices + positions), two accessors, one
//! mesh/node/scene.

use serde_json::json;

const GLB_MAGIC: u32 = 0x46546C67; // "glTF"
const GLB_VERSION: u32 = 2;
const CHUNK_JSON: u32 = 0x4E4F534A; // "JSON"
const CHUNK_BIN: u32 = 0x004E4942; // "BIN\0"

const COMPONENT_TYPE_FLOAT: u32 = 5126;
const COMPONENT_TYPE_UNSIGNED_INT: u32 = 5125;
const TARGET_ARRAY_BUFFER: u32 = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER: u32 = 34963;
const MODE_TRIANGLES: u32 = 4;

/// Serialize `positions` (xyz triplets) and `indices` (`u32`) into GLB bytes.
///
/// Errors when the inputs are empty or malformed (positions length not a multiple
/// of 3, indices length not a multiple of 3, or an index out of range).
pub fn mesh_to_glb(positions: &[f32], indices: &[u32]) -> Result<Vec<u8>, String> {
    if positions.is_empty() || indices.is_empty() {
        return Err("mesh_to_glb: empty positions or indices".to_string());
    }
    if positions.len() % 3 != 0 {
        return Err(format!(
            "mesh_to_glb: positions length {} is not a multiple of 3",
            positions.len()
        ));
    }
    if indices.len() % 3 != 0 {
        return Err(format!(
            "mesh_to_glb: indices length {} is not a multiple of 3",
            indices.len()
        ));
    }

    let vertex_count = positions.len() / 3;
    for &i in indices {
        if (i as usize) >= vertex_count {
            return Err(format!(
                "mesh_to_glb: index {} out of range (vertex_count {})",
                i, vertex_count
            ));
        }
    }

    // Bounding box (glTF requires min/max on a POSITION accessor).
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for v in positions.chunks_exact(3) {
        for axis in 0..3 {
            if v[axis] < min[axis] {
                min[axis] = v[axis];
            }
            if v[axis] > max[axis] {
                max[axis] = v[axis];
            }
        }
    }

    // BIN: indices first (already 4-byte aligned), then positions.
    let indices_byte_len = indices.len() * 4;
    let positions_byte_len = positions.len() * 4;
    let mut bin: Vec<u8> = Vec::with_capacity(indices_byte_len + positions_byte_len);
    for &i in indices {
        bin.extend_from_slice(&i.to_le_bytes());
    }
    let positions_offset = bin.len();
    for &p in positions {
        bin.extend_from_slice(&p.to_le_bytes());
    }
    pad_to_4(&mut bin, 0x00);

    let gltf = json!({
        "asset": { "version": "2.0", "generator": "splatwalk" },
        "buffers": [ { "byteLength": bin.len() } ],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": 0,
                "byteLength": indices_byte_len,
                "target": TARGET_ELEMENT_ARRAY_BUFFER
            },
            {
                "buffer": 0,
                "byteOffset": positions_offset,
                "byteLength": positions_byte_len,
                "target": TARGET_ARRAY_BUFFER
            }
        ],
        "accessors": [
            {
                "bufferView": 0,
                "byteOffset": 0,
                "componentType": COMPONENT_TYPE_UNSIGNED_INT,
                "count": indices.len(),
                "type": "SCALAR"
            },
            {
                "bufferView": 1,
                "byteOffset": 0,
                "componentType": COMPONENT_TYPE_FLOAT,
                "count": vertex_count,
                "type": "VEC3",
                "min": [min[0], min[1], min[2]],
                "max": [max[0], max[1], max[2]]
            }
        ],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": { "POSITION": 1 },
                        "indices": 0,
                        "mode": MODE_TRIANGLES
                    }
                ]
            }
        ],
        "nodes": [ { "mesh": 0 } ],
        "scenes": [ { "nodes": [0] } ],
        "scene": 0
    });

    let mut json_bytes = serde_json::to_vec(&gltf).map_err(|e| e.to_string())?;
    pad_to_4(&mut json_bytes, b' ');

    let total_len = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut out: Vec<u8> = Vec::with_capacity(total_len);

    // Header.
    out.extend_from_slice(&GLB_MAGIC.to_le_bytes());
    out.extend_from_slice(&GLB_VERSION.to_le_bytes());
    out.extend_from_slice(&(total_len as u32).to_le_bytes());

    // JSON chunk.
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
    out.extend_from_slice(&json_bytes);

    // BIN chunk.
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_BIN.to_le_bytes());
    out.extend_from_slice(&bin);

    Ok(out)
}

/// Pad a buffer up to the next 4-byte boundary with `fill`.
fn pad_to_4(buf: &mut Vec<u8>, fill: u8) {
    while buf.len() % 4 != 0 {
        buf.push(fill);
    }
}
