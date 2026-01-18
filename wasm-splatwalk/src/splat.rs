use std::io::Cursor;
use ply_rs::parser::Parser;
use ply_rs::ply::{Property, PropertyAccess};
use nalgebra::{Point3, Vector3, Quaternion, UnitQuaternion};
use web_sys::console;

#[derive(Debug, Clone)]
pub struct Splat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub rot_0: f32,
    pub rot_1: f32,
    pub rot_2: f32,
    pub rot_3: f32,
}

impl PropertyAccess for Splat {
    fn new() -> Self {
        Splat {
            x: 0.0, y: 0.0, z: 0.0,
            rot_0: 1.0, rot_1: 0.0, rot_2: 0.0, rot_3: 0.0,
        }
    }

    fn set_property(&mut self, key: String, property: Property) {
        match (key.as_ref(), property) {
            ("x", Property::Float(v)) => self.x = v,
            ("y", Property::Float(v)) => self.y = v,
            ("z", Property::Float(v)) => self.z = v,
            ("rot_0", Property::Float(v)) => self.rot_0 = v,
            ("rot_1", Property::Float(v)) => self.rot_1 = v,
            ("rot_2", Property::Float(v)) => self.rot_2 = v,
            ("rot_3", Property::Float(v)) => self.rot_3 = v,
            _ => {} 
        }
    }
}

pub struct PointNormal {
    pub point: Point3<f64>,
    pub normal: Vector3<f64>,
}

pub fn parse_ply(data: &[u8]) -> Result<Vec<PointNormal>, String> {
        // Check for "NGSP" magic number (Niantic SPZ format)
    if data.len() >= 4 && &data[0..4] == b"NGSP" {
        console::log_1(&"Detected NGSP/SPZ format. Parsing with spz_rs...".into());
        let cursor = std::io::Cursor::new(data);
        match spz_rs::load_packed_gaussians_from_decompressed_buffer(cursor) {
            Ok(packed) => {
                let num_points = packed.num_points;
                console::log_1(&format!("Parsed {} points from SPZ", num_points).into());

                let mut points = Vec::with_capacity(num_points);

                for i in 0..num_points {
                    let g = packed.unpack(i);
                    
                    let pos = Point3::new(g.position[0] as f64, g.position[1] as f64, g.position[2] as f64);
                    
                    // rotation is [w, x, y, z]
                    let r0 = g.rotation[0] as f64; // w
                    let r1 = g.rotation[1] as f64; // x
                    let r2 = g.rotation[2] as f64; // y
                    let r3 = g.rotation[3] as f64; // z
                    
                    // Rotate Z-axis (0, 0, 1) by this quaternion
                    // nx = 2(xz + yw)
                    // ny = 2(yz - xw)
                    // nz = 1 - 2(x^2 + y^2)
                    
                    let nx = 2.0 * (r1 * r3 + r2 * r0);
                    let ny = 2.0 * (r2 * r3 - r1 * r0);
                    let nz = 1.0 - 2.0 * (r1 * r1 + r2 * r2);
                    
                    let normal = Vector3::new(nx, ny, nz);
                    
                    points.push(PointNormal { point: pos, normal });
                }
                
                return Ok(points);
            }
            Err(e) => {
                 let err_msg = format!("Failed to parse SPZ: {:?}", e);
                 console::log_1(&err_msg.clone().into());
                 return Err(err_msg);
            }
        }
    }

    // Default to PLY parser
    let mut cursor = Cursor::new(data);
    let parser = Parser::<Splat>::new();
    
    let header = parser.read_header(&mut cursor).map_err(|e| e.to_string())?;
    
    // Check if vertex element exists
    if !header.elements.contains_key("vertex") {
        return Err("PLY file missing 'vertex' element".to_string());
    }

    let mut splats = Vec::new();
    for (_key, element) in &header.elements {
        if _key == "vertex" {
             splats = parser.read_payload_for_element(&mut cursor, element, &header).map_err(|e| e.to_string())?;
        }
    }

    let mut points = Vec::with_capacity(splats.len());

    for splat in splats {
        let p = Point3::new(splat.x as f64, splat.y as f64, splat.z as f64);
        
        // Convert quaternion to normal (Z-axis rotated by quaternion)
        // Note: We might need to handle normalization carefully
        let q = UnitQuaternion::new_normalize(Quaternion::new(splat.rot_0, splat.rot_1, splat.rot_2, splat.rot_3));
        let normal = q.transform_vector(&Vector3::z_axis());

        points.push(PointNormal {
            point: p,
            normal: Vector3::new(normal.x as f64, normal.y as f64, normal.z as f64),
        });
    }

    Ok(points)
}
