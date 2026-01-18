use wasm_bindgen::prelude::*;
use serde::Serialize;

mod splat;
mod mesh;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[wasm_bindgen]
pub fn init_splatwalk() -> String {
    console_error_panic_hook::set_once();
    log("G2M WASM Initialized with Parsing Support");
    "Ready".to_string()
}

#[derive(Serialize)]
pub struct MeshResult {
    vertices: Vec<f32>,
    indices: Vec<u32>,
    vertex_count: usize,
    face_count: usize,
}

#[wasm_bindgen]
pub fn convert_splat_to_mesh(data: &[u8], mode: u8) -> Result<JsValue, JsValue> {
    log(&format!("Received {} bytes for conversion (Mode: {})", data.len(), mode));
    
    let splats = splat::parse_ply(data).map_err(|e| JsValue::from_str(&e))?;
    log(&format!("Parsed {} splats", splats.len()));
    
    let mesh = mesh::reconstruct_mesh(&splats, mode);
    let vertices = mesh.vertices;
    let indices = mesh.indices;
    let vertex_count = vertices.len() / 3;
    let face_count = indices.len() / 3;
    log(&format!("Reconstructed mesh with {} vertices", vertex_count));
    
    let result = MeshResult {
        vertex_count,
        face_count,
        vertices,
        indices,
    };
    
    Ok(serde_wasm_bindgen::to_value(&result)?)
}
