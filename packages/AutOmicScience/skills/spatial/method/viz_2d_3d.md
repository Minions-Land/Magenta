# 2D/3D Visualization & Figure Inspection

**Maturity: REFERENCE** — hand-rolled plotting with squidpy / spatialdata-plot; every figure is observed before it backs a claim.

## Goal / When to Use

Produce spatial figures that the agent then **observes** to re-route — overlays on tissue, multi-section comparisons, 3D point clouds. Use throughout spatial analysis; every figure is observed before it backs a claim.

## Decision Criteria

**The judgment this guides:**

- **2D scatter on `obsm['spatial']`** (`sq.pl.spatial_scatter`) for spots/cells colored by gene/cluster/QC — the lightweight default for most spatial plots

- **SpatialData + spatialdata-plot** (`render_images`/`render_shapes`/`render_points`/`render_labels` → `.show()`) when you need the registered image, segmentation polygons, or transcripts at native resolution

- **3D point cloud** (matplotlib 3D / plotly) only when coordinates are genuinely 3D (z-stack, serial sections with registered z, Stereo-seq volumes) — not for 2D data artificially embedded in 3D

- **Choose by what must be verified**, not by aesthetics. A pretty figure that doesn't answer the QC/biological question is useless.

## Method Menu

- `squidpy.pl.spatial_scatter` / `spatial_segment` — 2D overlays on coords, with optional image
- `spatialdata_plot` declarative `render_*().show()` — images/shapes/points/labels at native resolution
- `scanpy.pl.spatial` (legacy AnnData-with-image) — **deprecated in recent scanpy in favor of `squidpy.pl.spatial_scatter`** — prefer the squidpy plot and confirm availability against the pinned scanpy version
- 3D scatter (matplotlib `ax.scatter(xs, ys, zs)` or plotly) for serial sections / Stereo-seq volumes

## How-to

### 2D spatial scatter (most common)

```python
import squidpy as sq

# Gene expression overlay
sq.pl.spatial_scatter(
    adata,
    color='CD3D',  # or a cluster column like 'leiden'
    figsize=(6, 6),
    spot_size=1.5,  # tune to match coord scale
    save='_CD3D_spatial.png'
)
# observe_figure: is the expected localization visible? (e.g., immune marker in immune-rich regions)

# Multi-gene panel
sq.pl.spatial_scatter(
    adata,
    color=['CD3D', 'MS4A1', 'LYZ'],
    ncols=3,
    figsize=(15, 5),
    save='_marker_panel.png'
)
```

### SpatialData with image/segmentation

```python
from spatialdata_plot import render_images, render_shapes, render_labels

# Build the plot (declarative)
(
    render_images(sdata, 'image').pl
    | render_shapes(sdata, 'segmentation', fill_alpha=0.3).pl
    | render_labels(sdata, 'cell_labels', color='leiden').pl
).show(figsize=(10, 10), save='_spatialdata_overlay.png')
```

### 3D point cloud (serial sections or volumetric)

```python
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

fig = plt.figure(figsize=(10, 8))
ax = fig.add_subplot(111, projection='3d')

coords = adata.obsm['spatial']  # shape (n_obs, 3)
colors = adata.obs['leiden'].astype('category').cat.codes

# Downsample for responsiveness if n_obs is large
if coords.shape[0] > 10000:
    import numpy as np
    np.random.seed(0)
    idx = np.random.choice(coords.shape[0], 10000, replace=False)
    coords = coords[idx, :]
    colors = colors[idx]

ax.scatter(coords[:, 0], coords[:, 1], coords[:, 2], c=colors, s=1, alpha=0.5)
ax.set_xlabel('X'); ax.set_ylabel('Y'); ax.set_zlabel('Z')
plt.savefig('runs/omics/<id>/figures/_3d_leiden.png', dpi=150)
plt.close()
```

## Pitfalls & Quality Checks

- **Spot size mismatched to coordinate scale** — yields a blank (spots too small, invisible) or a solid blob (spots too large, overlap). Tune `spot_size` or `size` until individual spots/cells are visible but not overlapping.

- **Coordinate flips** between image and array space are common (Visium row/col vs. image x/y) — verify a known landmark (e.g., an anatomical feature) aligns. If the tissue outline looks mirrored or rotated, coords may be flipped.

- **Color scale saturation** hides structure — if all values are squashed to one color, clip to a high percentile (e.g., `vmax=np.percentile(adata.obs['total_counts'], 99)`).

- **The whole point is the `observe_figure` verdict** — an empty/garbled figure is a red flag to re-route (wrong coords, missing data, scale issue). The vision sub-agent's verdict is itself evidence that the figure is usable.

- **3D responsiveness** — downsample to ~10K points if the dataset is large; fix a camera/orientation so successive frames are comparable (rotating the view makes before/after comparisons impossible).

## Grounding

**What to record as `EvidenceRecord`:**

```python
{
  "figure_path": "runs/omics/<id>/figures/_CD3D_spatial.png",
  "plot_type": "spatial_scatter",
  "color_by": "CD3D",
  "coord_dim": 2,
  "spot_size": 1.5,
  "n_obs_plotted": 3500,
  "observe_figure_verdict": "tissue outline clear, CD3D high in lymphoid region"
}
```

Ground: figure path, what is plotted, color/scale settings. The `observe_figure` verdict is itself evidence the figure is usable.

## Honesty

- **A pretty figure is not a result** — only the grounded numbers behind it are. Do not let a visualization stand in for a quantitative claim (e.g., "CD3D is high in region X" needs a per-region mean, not just a colored plot).

- If a figure is unclear/ambiguous after `observe_figure`, **say so** — treat downstream claims as unconfirmed and either re-plot or gather orthogonal evidence.

- **Never present an unobserved figure** — save it to disk, call `observe_figure`, read the verdict, then decide whether to use it. An inline-only plot (e.g., `plt.show()` in a notebook without `plt.savefig()`) is invisible to the agent and cannot back a claim.
