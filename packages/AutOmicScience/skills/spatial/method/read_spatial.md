# Read Spatial Data

**Maturity: READY** — `omics_compute(subcommand="read_spatial", modality="spatial", ...)` dispatches the format-aware loader and records evidence; the `spatialdata_io` readers below cover the imaging platforms.

## Goal / When to Use

Load any spatial format into the canonical containers (AnnData / SpatialData) and verify coordinates before any analysis. Use when starting with a spatial sample.

## Decision Criteria

**The judgment this guides:**

- **Container choice** — Use plain **`AnnData`** (coords in `obsm["spatial"]`) when the question is expression/cluster/stat-centric and you don't need the registered image/transcript/segmentation layers. Use **`SpatialData`** when you need image overlays at native resolution, transcript points, segmentation polygons, multiple coordinate systems, Visium HD bins, or you will aggregate transcripts/channels into a table. You can always derive an AnnData view from a SpatialData table and write results back.

- **Platform detection** — Visium (spaceranger dir), Visium HD (bins at multiple resolutions), Xenium, MERFISH/MERSCOPE, CosMx, Stereo-seq, or generic `.h5ad` with coords. Choose the loader by what the data *is*, not by what you wish it were.

## Method Menu

**By platform:**
- **Visium** — `squidpy.read.visium(path)` for a spaceranger output directory, or `spatialdata_io.visium(path)` for a SpatialData container
- **Visium HD** — `spatialdata_io.visium_hd(path)` (bins at 2/8/16 µm)
- **Xenium** — `spatialdata_io.xenium(path)`
- **MERFISH/MERSCOPE** — `spatialdata_io.merscope(path)`
- **CosMx** — `spatialdata_io.cosmx(path)`
- **Stereo-seq** — `spatialdata_io.stereoseq(path)`
- **Generic `.h5ad` with coords** — `anndata.read_h5ad(path)`, then validate `obsm["spatial"]` is present

**Helper-backed:** The frozen helper `read_spatial.read_spatial(path=..., platform=...)` wraps the format dispatch, returns `(adata, report)`, sets `layers['counts']`, runs `var_names_make_unique`, and asserts `obsm['spatial']` is 2D or 3D.

## How-to

### Via the frozen helper (preferred for AnnData output)

```python
import sys, os
from pathlib import Path

# Resolve skills dir
skills_dir = os.environ.get("AOS_SKILLS_DIR") or "skills"
sys.path.insert(0, str(Path(skills_dir) / "omics" / "spatial" / "scripts"))

from read_spatial import read_spatial

# Load
adata, report = read_spatial(
    path="/path/to/spaceranger_output",
    platform="visium",
    filter_control_probes=True,  # for imaging platforms
    var_names_make_unique=True
)

# Inspect
print(f"Loaded {report['n_obs']} obs x {report['n_vars']} vars")
print(f"Spatial dims: {report['spatial_dim']}")
print(f"Coord bounds: {report['spatial_bounds']}")
```

### For image/segmentation work (SpatialData)

```python
import spatialdata_io as sdio

# Read into SpatialData
sdata = sdio.xenium("/path/to/xenium_output")

# Inspect elements
print(sdata)  # shows images, labels, points, shapes, tables

# Extract the AnnData table
adata = sdata.tables['table']  # Xenium typically names it 'table'

# Or validate an existing SpatialData
from read_spatial import validate_spatial
report = validate_spatial(adata, require_counts=True)
```

### Coordinate validation

```python
# After load, verify spatial coords are sane
import matplotlib.pyplot as plt
import squidpy as sq

sq.pl.spatial_scatter(
    adata,
    color='total_counts',
    figsize=(6, 6),
    save='_spatial_qc_counts.png'
)
# observe_figure: is a tissue outline visible? or just noise/empty?
```

## Pitfalls & Quality Checks

- **Coordinate units differ per platform** — Visium is in array coordinates (row, col), Xenium/MERFISH/CosMx are in microns, Stereo-seq is in bin IDs. Never assume — check `obsm['spatial'].min()`, `.max()` and plot it.

- **Visium HD at 2 µm bins is NOT single-cell** — bin to 8/16 µm or treat as spots (multi-cell aggregates). Don't run single-cell annotation on 2 µm bins as if they were cells.

- **Imaging panels are targeted** (hundreds of genes, not whole transcriptome) — HVG/marker logic that assumes 20K genes will mislead. Methods like gene activity or imputation that expect broad coverage will fail or give garbage.

- **Control/blank probes in imaging data must be filtered before QC** — Xenium/MERFISH/CosMx include negative-control probes (named `NegControl*`, `BLANK*`, etc.) for QC purposes; these are not real genes and will poison downstream analysis if not removed. The helper's `filter_control_probes=True` handles this.

- **`observe_figure`** — a spatial scatter of `total_counts`: is a tissue outline visible, or is it uniform noise? An empty/garbled spatial plot signals wrong platform, missing coords, or a load failure.

## Grounding

**What to record as `EvidenceRecord`** (from the helper `report`):

```python
{
  "platform": "visium",
  "n_obs": 3500,
  "n_vars": 18000,
  "spatial_dim": 2,  # or 3 for Stereo-seq/volumetric
  "spatial_bounds": {"min": [0, 0], "max": [127, 127]},
  "has_image": True,
  "counts_layer_set": True,
  "n_control_probes_removed": 0,
  "var_names_unique": True
}
```

Ground: n obs/vars, coordinate dimensionality and bounds, detected platform, presence of an image, counts-layer set.

## Honesty

- If a format/version is **unsupported by the available readers**, surface the blocker (preflight should catch this) — do not hand-roll a brittle parser that silently mis-loads.

- If the input path is missing or malformed, **fail loud** — the helper raises `FileNotFoundError` with the expected layout for that platform.

- If `obsm['spatial']` is absent or its dimensionality is wrong (not 2D or 3D), **raise** — do not fabricate coordinates.

- **Pairing (multiome / multi-modal)** — if the data is described as "spatial transcriptomics + protein" or similar, note that the load step here only brings in the RNA/peak matrix; the protein/ADT modality is a separate load.
