//! Opt-in output coordinate-space conversion.
//!
//! The fixed binary contract is `splatwalk_oriented`: right-handed, `+Y` up, with
//! triangle indices wound counter-clockwise (front-facing) when viewed from the
//! `+` side of the face normal. Some engines want native-space output instead of
//! a boundary mirror/winding bake, so `MeshSettings.output_space` lets a caller
//! request a different `up_axis` / `handedness` / `winding`. When it is absent the
//! entry points skip this module entirely and every result is byte-for-byte
//! identical to the legacy output.
//!
//! Only geometric outputs are converted: mesh vertices (with a winding flip when
//! the basis is mirrored), `FieldBasis` vectors, `FloorPlane` normals, and the
//! top-level oriented bounds / region corners. Per-cell ground-field scalars and
//! the `diagnostics` bag stay in `splatwalk_oriented` space.

use serde::Deserialize;

use crate::{
    CoordinateSpace, FieldBasis, FloorPlane, MeshBuffers, MeshSettings, NavmeshBasisResult,
    ReconstructionResult, SplatBounds, SuggestedRegion, WalkableGroundFieldResult,
};

/// Requested output coordinate convention. All fields are optional and default to
/// the `splatwalk_oriented` contract (`up_axis: "y"`, `handedness: "right"`,
/// `winding: "auto"`).
#[derive(Deserialize, Clone, Default)]
pub struct OutputSpaceSettings {
    /// `"y"` (default) or `"z"`. `"z"` rotates `+Y`-up into `+Z`-up about X.
    pub up_axis: Option<String>,
    /// `"right"` (default) or `"left"`. `"left"` mirrors the Z axis.
    pub handedness: Option<String>,
    /// `"ccw"`, `"cw"`, or `"auto"` (default). `"auto"` flips winding only when the
    /// resolved basis is mirrored (negative determinant), keeping faces consistently
    /// front-facing in the requested space.
    pub winding: Option<String>,
}

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Resolved linear map from `splatwalk_oriented` to the requested convention plus
/// the winding decision and the reported space metadata.
pub struct OutputTransform {
    matrix: [[f64; 3]; 3],
    flip_winding: bool,
    up_axis: String,
    handedness: String,
}

fn mat_mul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for (r, out_row) in out.iter_mut().enumerate() {
        for (c, out_cell) in out_row.iter_mut().enumerate() {
            *out_cell = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
        }
    }
    out
}

fn det3(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn resolve(s: &OutputSpaceSettings) -> OutputTransform {
    let up = s.up_axis.as_deref().unwrap_or("y").to_ascii_lowercase();
    let hand = s.handedness.as_deref().unwrap_or("right").to_ascii_lowercase();

    // +Y-up -> +Z-up while preserving right-handedness (rotation of -90 deg about X):
    // (x, y, z) -> (x, -z, y).
    let m_up = if up == "z" {
        [[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]]
    } else {
        IDENTITY
    };
    // Right -> left handedness mirrors a single axis (Z), giving determinant -1.
    let m_hand = if hand == "left" {
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -1.0]]
    } else {
        IDENTITY
    };

    let matrix = mat_mul(&m_hand, &m_up);
    let mirrored = det3(&matrix) < 0.0;
    let flip_winding = match s.winding.as_deref().map(|w| w.to_ascii_lowercase()).as_deref() {
        Some("cw") => true,
        Some("ccw") => false,
        _ => mirrored,
    };

    OutputTransform {
        matrix,
        flip_winding,
        up_axis: if up == "z" { "z".to_string() } else { "y".to_string() },
        handedness: if hand == "left" {
            "left".to_string()
        } else {
            "right".to_string()
        },
    }
}

impl OutputTransform {
    /// Apply the linear map to a point or direction (the map fixes the origin, so
    /// the same routine is correct for both).
    fn apply(&self, v: [f64; 3]) -> [f64; 3] {
        let m = &self.matrix;
        [
            m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
        ]
    }

    /// Space metadata describing the requested output convention.
    pub fn coordinate_space(&self) -> CoordinateSpace {
        CoordinateSpace {
            space: "engine_output".to_string(),
            up_axis: self.up_axis.clone(),
            handedness: self.handedness.clone(),
        }
    }
}

/// Build the output transform for a settings object, or `None` when no conversion
/// was requested (the default, byte-identical path).
pub fn transform_for(settings: &MeshSettings) -> Option<OutputTransform> {
    settings.output_space.as_ref().map(resolve)
}

/// Transform mesh vertices in place and flip triangle winding when the basis is
/// mirrored.
pub fn apply_mesh_buffers(t: &OutputTransform, mesh: &mut MeshBuffers) {
    let vertex_count = mesh.vertices.len() / 3;
    for i in 0..vertex_count {
        let base = i * 3;
        let o = t.apply([
            mesh.vertices[base] as f64,
            mesh.vertices[base + 1] as f64,
            mesh.vertices[base + 2] as f64,
        ]);
        mesh.vertices[base] = o[0] as f32;
        mesh.vertices[base + 1] = o[1] as f32;
        mesh.vertices[base + 2] = o[2] as f32;
    }

    if t.flip_winding {
        let mut i = 0;
        while i + 3 <= mesh.indices.len() {
            mesh.indices.swap(i + 1, i + 2);
            i += 3;
        }
    }
}

/// Transform a field basis (origin + the three direction vectors) in place.
pub fn apply_basis(t: &OutputTransform, basis: &mut FieldBasis) {
    basis.origin = t.apply(basis.origin);
    basis.tangent = t.apply(basis.tangent);
    basis.bitangent = t.apply(basis.bitangent);
    basis.up = t.apply(basis.up);
}

/// Transform a floor-plane normal in place. The plane offset `d` is unchanged
/// because the map is orthogonal and fixes the origin.
pub fn apply_floor_plane(t: &OutputTransform, plane: &mut FloorPlane) {
    plane.normal = t.apply(plane.normal);
}

fn elementwise_minmax(a: [f64; 3], b: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let mut lo = [0.0; 3];
    let mut hi = [0.0; 3];
    for axis in 0..3 {
        lo[axis] = a[axis].min(b[axis]);
        hi[axis] = a[axis].max(b[axis]);
    }
    (lo, hi)
}

pub fn apply_reconstruction(settings: &MeshSettings, result: &mut ReconstructionResult) {
    if let Some(t) = transform_for(settings) {
        apply_mesh_buffers(&t, &mut result.mesh);
        result.space = t.coordinate_space();
    }
}

pub fn apply_navmesh_basis(settings: &MeshSettings, result: &mut NavmeshBasisResult) {
    if let Some(t) = transform_for(settings) {
        apply_mesh_buffers(&t, &mut result.mesh);
        apply_basis(&t, &mut result.basis);
        apply_floor_plane(&t, &mut result.floor_plane);
        result.space = t.coordinate_space();
    }
}

pub fn apply_ground_field(settings: &MeshSettings, result: &mut WalkableGroundFieldResult) {
    if let Some(t) = transform_for(settings) {
        apply_basis(&t, &mut result.basis);
        apply_floor_plane(&t, &mut result.floor_plane);
        result.space = t.coordinate_space();
    }
}

pub fn apply_bounds(settings: &MeshSettings, result: &mut SplatBounds) {
    if let Some(t) = transform_for(settings) {
        let (lo, hi) = elementwise_minmax(t.apply(result.oriented_min), t.apply(result.oriented_max));
        result.oriented_min = lo;
        result.oriented_max = hi;
        result.space = t.coordinate_space();
    }
}

pub fn apply_region(settings: &MeshSettings, result: &mut SuggestedRegion) {
    if let Some(t) = transform_for(settings) {
        let (lo, hi) = elementwise_minmax(t.apply(result.region_min), t.apply(result.region_max));
        result.region_min = lo;
        result.region_max = hi;
        result.space = t.coordinate_space();
    }
}
