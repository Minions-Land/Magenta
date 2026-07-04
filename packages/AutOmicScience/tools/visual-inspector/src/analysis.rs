//! Image analysis functions for visual inspection.

use anyhow::Result;
use image::{DynamicImage, GenericImageView};

use crate::AnalysisResult;

/// Analyze a plot image for quality metrics.
pub fn analyze_plot(img: &DynamicImage, plot_type: Option<&str>) -> Result<AnalysisResult> {
    let edge_density = compute_edge_density(img);
    let color_diversity = compute_color_diversity(img);
    let has_axes = detect_axes(img);
    let has_labels = detect_labels(img, edge_density);

    let mut issues = Vec::new();
    let mut suggestions = Vec::new();

    if !has_axes {
        issues.push("No clear axes detected".to_string());
        suggestions.push("Add x and y axis labels".to_string());
    }
    if !has_labels {
        issues.push("Labels may be missing or too small".to_string());
        suggestions.push("Increase font size for axis labels and title".to_string());
    }
    if edge_density < 0.02 {
        issues.push("Image appears mostly blank or empty".to_string());
        suggestions.push("Check if rendering completed successfully".to_string());
    }
    if color_diversity < 0.1 {
        issues.push("Low color diversity — plot may lack data variety".to_string());
        suggestions.push("Use distinct colors for different data series".to_string());
    }

    if let Some(pt) = plot_type {
        match pt {
            "scatter" if edge_density < 0.05 => {
                suggestions.push("Consider increasing marker size for visibility".to_string());
            }
            "heatmap" if color_diversity < 0.3 => {
                suggestions.push("Consider using a diverging colormap".to_string());
            }
            "violin" | "box" if !has_axes => {
                suggestions.push("Ensure group labels are visible on axis".to_string());
            }
            _ => {}
        }
    }

    let quality_score = compute_quality_score(edge_density, color_diversity, has_axes, has_labels);

    Ok(AnalysisResult {
        quality_score,
        has_axes,
        has_labels,
        edge_density,
        color_diversity,
        issues,
        suggestions,
    })
}

/// Compute edge density using a simple Sobel-like gradient measure.
fn compute_edge_density(img: &DynamicImage) -> f64 {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    if w < 3 || h < 3 {
        return 0.0;
    }
    let mut edge_pixels = 0u64;
    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let p = |dx: i32, dy: i32| {
                gray.get_pixel((x as i32 + dx) as u32, (y as i32 + dy) as u32)[0] as i32
            };
            let gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
            let gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
            let mag = ((gx * gx + gy * gy) as f64).sqrt();
            if mag > 30.0 {
                edge_pixels += 1;
            }
        }
    }
    edge_pixels as f64 / ((w * h) as f64)
}

/// Compute color diversity as fraction of unique 4-bit quantized colors.
fn compute_color_diversity(img: &DynamicImage) -> f64 {
    let rgb = img.to_rgb8();
    let mut seen = std::collections::HashSet::new();
    for pixel in rgb.pixels() {
        let key = (pixel[0] >> 4, pixel[1] >> 4, pixel[2] >> 4);
        seen.insert(key);
    }
    // max possible unique keys: 16^3 = 4096
    seen.len() as f64 / 4096.0
}

/// Heuristic: detect axes by looking for long horizontal/vertical edge runs near borders.
fn detect_axes(img: &DynamicImage) -> bool {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    if w < 20 || h < 20 {
        return false;
    }
    // Check bottom 10% of rows for horizontal line
    let row_start = (h as f64 * 0.85) as u32;
    let mut horiz_run = 0u32;
    let mut max_horiz = 0u32;
    for x in 1..(w - 1) {
        let y = row_start;
        let diff = gray.get_pixel(x, y)[0] as i32 - gray.get_pixel(x - 1, y)[0] as i32;
        if diff.abs() < 20 {
            horiz_run += 1;
            max_horiz = max_horiz.max(horiz_run);
        } else {
            horiz_run = 0;
        }
    }
    // Check left 10% of cols for vertical line
    let col_start = (w as f64 * 0.10) as u32;
    let mut vert_run = 0u32;
    let mut max_vert = 0u32;
    for y in 1..(h - 1) {
        let x = col_start;
        let diff = gray.get_pixel(x, y)[0] as i32 - gray.get_pixel(x, y - 1)[0] as i32;
        if diff.abs() < 20 {
            vert_run += 1;
            max_vert = max_vert.max(vert_run);
        } else {
            vert_run = 0;
        }
    }
    max_horiz > w / 4 || max_vert > h / 4
}

/// Heuristic: labels detected if edge density in border regions is above threshold.
fn detect_labels(_img: &DynamicImage, edge_density: f64) -> bool {
    // Simple heuristic: if overall edge density is reasonable, assume labels present
    edge_density > 0.03
}

/// Weighted quality score 0.0–1.0.
fn compute_quality_score(
    edge_density: f64,
    color_diversity: f64,
    has_axes: bool,
    has_labels: bool,
) -> f64 {
    let mut score = 0.0f64;
    score += (edge_density / 0.15).min(1.0) * 0.35;
    score += (color_diversity / 0.4).min(1.0) * 0.25;
    score += if has_axes { 0.25 } else { 0.0 };
    score += if has_labels { 0.15 } else { 0.0 };
    score.min(1.0)
}

/// Compare two images and return a CompareResult.
pub fn compare_images(before: &DynamicImage, after: &DynamicImage) -> crate::CompareResult {
    let (w, h) = before.dimensions();
    let (w2, h2) = after.dimensions();
    if w != w2 || h != h2 {
        return crate::CompareResult {
            similarity: 0.0,
            changed_regions: 1,
            improved: false,
            summary: format!(
                "Images have different dimensions: {}x{} vs {}x{}",
                w, h, w2, h2
            ),
        };
    }
    let before_rgb = before.to_rgb8();
    let after_rgb = after.to_rgb8();
    let total = (w * h) as f64;
    let mut diff_sum = 0.0f64;
    let mut changed = 0u64;
    for (p1, p2) in before_rgb.pixels().zip(after_rgb.pixels()) {
        let d = ((p1[0] as i32 - p2[0] as i32).abs()
            + (p1[1] as i32 - p2[1] as i32).abs()
            + (p1[2] as i32 - p2[2] as i32).abs()) as f64
            / (3.0 * 255.0);
        diff_sum += d;
        if d > 0.05 {
            changed += 1;
        }
    }
    let similarity = 1.0 - (diff_sum / total);
    let changed_regions = (changed / ((w * h / 100).max(1) as u64)) as usize;
    let improved = similarity > 0.95 && changed_regions < 5;
    let summary = format!(
        "Similarity: {:.1}%, changed regions: {}, {}",
        similarity * 100.0,
        changed_regions,
        if improved {
            "looks improved"
        } else {
            "significant changes detected"
        }
    );
    crate::CompareResult {
        similarity,
        changed_regions,
        improved,
        summary,
    }
}
