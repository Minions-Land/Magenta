//! Visual Inspector Library
//! Provides visual inspection and feedback tools for scientific plots.

pub mod analysis;
pub mod screenshot;

use serde::{Deserialize, Serialize};

/// Result of image analysis
#[derive(Debug, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub quality_score: f64,
    pub has_axes: bool,
    pub has_labels: bool,
    pub edge_density: f64,
    pub color_diversity: f64,
    pub issues: Vec<String>,
    pub suggestions: Vec<String>,
}

/// Result of image comparison
#[derive(Debug, Serialize, Deserialize)]
pub struct CompareResult {
    pub similarity: f64,
    pub changed_regions: usize,
    pub improved: bool,
    pub summary: String,
}

/// Input for analyze_plot tool
#[derive(Debug, Deserialize)]
pub struct AnalyzePlotInput {
    pub image_path: String,
    pub plot_type: Option<String>,
}

/// Input for compare_images tool
#[derive(Debug, Deserialize)]
pub struct CompareImagesInput {
    pub before_path: String,
    pub after_path: String,
}

/// Input for capture_screenshot tool
#[derive(Debug, Deserialize)]
pub struct CaptureScreenshotInput {
    pub output_path: String,
    pub window_title: Option<String>,
}

/// Input for validate_render tool
#[derive(Debug, Deserialize)]
pub struct ValidateRenderInput {
    pub image_path: String,
    pub min_quality_score: Option<f64>,
}
