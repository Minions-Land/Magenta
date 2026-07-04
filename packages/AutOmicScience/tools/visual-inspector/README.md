# Visual Inspector

Visual inspection and quality analysis tools for scientific plots in AutOmicScience.

## Overview

The visual-inspector provides automated quality assessment for plots generated during omics analysis workflows. It helps ensure publication-ready visualization quality by detecting common issues and providing actionable feedback.

## Tools

### analyze_plot

Analyze a plot image for quality metrics.

**Checks**:
- Axes detection
- Label presence and readability
- Edge density (data visibility)
- Color diversity
- Plot-type-specific validation

**Returns**:
- `quality_score`: 0.0-1.0 overall quality
- `has_axes`: boolean
- `has_labels`: boolean
- `edge_density`: 0.0-1.0
- `color_diversity`: 0.0-1.0
- `issues`: list of detected problems
- `suggestions`: list of improvement recommendations

**Usage**:
```json
{
  "image_path": "/path/to/umap.png",
  "plot_type": "scatter"
}
```

### compare_images

Compare before/after versions of a plot to detect changes.

**Returns**:
- `similarity`: 0.0-1.0 similarity score
- `changed_regions`: count of significantly different regions
- `improved`: boolean indicating quality improvement
- `summary`: human-readable change description

**Usage**:
```json
{
  "before_path": "/path/to/plot_v1.png",
  "after_path": "/path/to/plot_v2.png"
}
```

### validate_render

Validate that a rendered plot meets minimum quality threshold.

**Returns**:
- `ok`: boolean pass/fail
- `quality_score`: actual score
- `min_required`: threshold used
- `analysis`: full analysis result

**Usage**:
```json
{
  "image_path": "/path/to/plot.png",
  "min_quality_score": 0.6
}
```

## Use Cases in Omics Workflows

### 1. Post-QC Visualization Validation
After running `omics_compute preprocess`, validate UMAP/PCA plots:
```
1. Generate UMAP plot
2. analyze_plot → check quality_score
3. If score < 0.5, adjust visualization parameters
4. Regenerate and validate again
```

### 2. Publication-Ready Figure QA
Before including plots in reports:
```
1. Generate final figure
2. validate_render with min_quality_score=0.7
3. If fail, review issues and suggestions
4. Apply fixes and revalidate
```

### 3. Parameter Tuning Feedback
When adjusting plot aesthetics:
```
1. Generate plot_v1.png
2. Adjust parameters
3. Generate plot_v2.png
4. compare_images → check if improved
5. Continue iteration
```

### 4. Batch Plot Quality Control
For multi-sample analyses:
```
For each sample:
  1. Generate cluster plot
  2. analyze_plot
  3. Flag low-quality samples for manual review
```

## Technical Details

**Implementation**: Pure Rust (no OpenCV dependency)
- `image` crate for I/O
- `imageproc` crate for edge detection and analysis
- Lightweight, fast, platform-independent

**Supported Formats**: PNG, JPEG, BMP, TIFF

**Performance**: 
- Typical analysis time: <500ms for 1920x1080 image
- Scales linearly with image size
- Recommended: use downsampled images for large plots

## Quality Metrics Explained

### Edge Density (0.0-1.0)
- Measures data presence vs blank space
- Low (<0.02): mostly empty, possible rendering failure
- Medium (0.02-0.10): typical plots
- High (>0.10): dense plots (heatmaps, scatter with many points)

### Color Diversity (0.0-1.0)
- Measures color palette richness
- Low (<0.1): monochrome or limited palette
- Medium (0.1-0.3): typical scientific plots
- High (>0.3): complex multi-series plots, heatmaps

### Quality Score Thresholds
- **0.8-1.0**: Excellent - publication-ready
- **0.6-0.8**: Good - minor improvements recommended
- **0.4-0.6**: Fair - significant issues present
- **<0.4**: Poor - major problems, likely render failure

## Integration with Skills

Add to RNA/scATAC/Spatial skill workflows:

```markdown
## Plot Quality Validation

After generating visualizations with `omics_compute` or matplotlib:

1. **Analyze quality**:
   ```
   analyze_plot(image_path="output/umap.png", plot_type="scatter")
   ```

2. **Check results**:
   - If quality_score >= 0.7: proceed
   - If quality_score < 0.7: review issues and suggestions

3. **Common fixes**:
   - Missing labels → Add title, axis labels
   - Low edge density → Check if data loaded correctly
   - Low color diversity → Use distinct colors per cluster
```

## Building

```bash
cd packages/AutOmicScience/tools/visual-inspector
cargo build --release
```

Binary output: `target/release/visual-inspector`

## Dependencies

- Rust 2021 edition
- image = "0.25"
- imageproc = "0.25"
- tokio (for async operations)
- serde, serde_json (for I/O)

## Source

Adapted from BioAgent/AutOmicScience `plugins/aose-visual-inspector` for Magenta3 integration.
