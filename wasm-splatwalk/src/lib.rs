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

#[derive(serde::Deserialize)]
pub struct MeshSettings {
    pub mode: u8,
    pub voxel_target: Option<f64>,
    pub min_alpha: Option<f64>,
    pub max_scale: Option<f64>,
    pub normal_align: Option<f64>,
    pub ransac_thresh: Option<f64>,
}

#[wasm_bindgen]
pub fn convert_splat_to_mesh(data: &[u8], settings: JsValue) -> Result<JsValue, JsValue> {
    let settings: MeshSettings = serde_wasm_bindgen::from_value(settings)?;
    let mode = settings.mode;
    
    log(&format!("Received {} bytes (Mode: {})", data.len(), mode));
    
    let splats = splat::parse_ply(data).map_err(|e| JsValue::from_str(&e))?;
    log(&format!("Parsed {} splats", splats.len()));
    
    let mesh = mesh::reconstruct_mesh(&splats, &settings);
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
