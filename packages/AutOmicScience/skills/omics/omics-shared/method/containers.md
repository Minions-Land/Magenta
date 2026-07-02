# Data Containers — AnnData, MuData, SpatialData

This document covers the decision tree for choosing the right data container, key conventions from `conventions.py`, loading/saving with `omics_io`, common pitfalls, and grounding requirements.

## Container Decision Tree

### When to Use Each Container

**AnnData** — Single-modality datasets
- scRNA-seq (gene expression matrix)
- scATAC-seq (peak accessibility matrix)
- Spatial transcriptomics (spots/cells with spatial coordinates)
- **File format**: `.h5ad`
- **Load with**: `omics_io.load_h5ad(path=...)`

**MuData** — Multi-modal datasets with shared observations
- Multiome (paired RNA + ATAC from same cells)
- CITE-seq (RNA + surface protein)
- Spatial multiome (spatial RNA + protein/morphology)
- **File format**: `.h5mu`
- **Load with**: `omics_io.load_h5mu(path=...)`
- **Access modalities**: `mdata.mod["rna"]`, `mdata.mod["atac"]`

**SpatialData** — Complex spatial datasets with multiple coordinate systems
- High-resolution imaging with transcript spots
- Multi-scale spatial data (spots + subcellular resolution)
- Multiple tissues/sections with different coordinate frames
- **File format**: `.zarr` directory
- **Load with**: `spatialdata.read_zarr(path)`
- **Note**: Not currently implemented in `omics_io`; use native `spatialdata` library

### Quick Decision Guide

```
Is it multi-modal (RNA + ATAC, RNA + protein)?
├─ Yes → MuData (.h5mu)
└─ No → Is it spatial with complex imaging layers?
    ├─ Yes → Consider SpatialData (.zarr)
    └─ No → AnnData (.h5ad)
```

## Key Conventions (from `conventions.py`)

**Always import constants from `conventions.py`** — never hardcode string literals. This ensures consistency across all analysis steps.

### Standard Slot Layout

```python
from conventions import (
    LAYER_COUNTS,           # "counts"
    OBS_LEIDEN,             # "leiden"
    OBS_CELLTYPE,           # "cell_type"
    OBS_BATCH,              # "batch"
    OBS_CONDITION,          # "condition"
    OBSM_PCA,               # "X_pca"
    OBSM_UMAP,              # "X_umap"
    OBSM_SPATIAL,           # "spatial"
    VAR_HIGHLY_VARIABLE,    # "highly_variable"
)
```

### Where Data Lives

| Data Type | Location | Convention Key | Notes |
|-----------|----------|----------------|-------|
| **Raw counts** | `layers["counts"]` | `LAYER_COUNTS` | Integer counts, never normalized |
| **Normalized data** | `X` | — | Log-normalized, suitable for visualization/DE |
| **PCA embedding** | `obsm["X_pca"]` | `OBSM_PCA` | First 50 PCs by default |
| **UMAP embedding** | `obsm["X_umap"]` | `OBSM_UMAP` | 2D projection for visualization |
| **Spatial coordinates** | `obsm["spatial"]` | `OBSM_SPATIAL` | (x, y) pixel/micron coordinates |
| **Clusters** | `obs["leiden"]` | `OBS_LEIDEN` | Leiden clustering result |
| **Cell type labels** | `obs["cell_type"]` | `OBS_CELLTYPE` | Curated or predicted annotations |
| **Batch/condition** | `obs["batch"]`, `obs["condition"]` | `OBS_BATCH`, `OBS_CONDITION` | Experimental metadata |
| **Highly variable genes** | `var["highly_variable"]` | `VAR_HIGHLY_VARIABLE` | Boolean mask for feature selection |

### Embedding Namespace Convention

All embeddings use the `X_*` prefix in `obsm`:
- `obsm["X_pca"]` — PCA coordinates
- `obsm["X_scVI"]` — scVI latent space
- `obsm["X_umap"]` — UMAP projection
- `obsm["X_harmony"]` — Harmony-corrected PCA
- `obsm["X_lsi"]` — LSI for ATAC data
- `obsm["X_spectral"]` — Spectral embedding

Use `conventions.is_embedding_key(key)` to check if a key follows this convention.

## Loading and Saving with `omics_io`

### Loading AnnData

```python
import sys, os
sys.path.insert(0, os.path.join(os.environ.get("AOS_SKILLS_DIR", "skills"), "omics", "_shared", "scripts"))
import io as omics_io

# Basic load
adata, report = omics_io.load_h5ad(path="data.h5ad")
print(f"Loaded {report['n_obs']} cells × {report['n_vars']} genes")

# Load with validation (fails if layers["counts"] missing)
adata, report = omics_io.load_h5ad(path="data.h5ad", validate_counts=True)

# Load in backed mode (lazy loading for large files)
adata, report = omics_io.load_h5ad(path="data.h5ad", backed="r")
```

**Report dict contains:**
- `path`: absolute path to loaded file
- `n_obs`, `n_vars`: shape
- `layers`: list of layer keys
- `obsm_keys`: list of embedding keys
- `obs_columns`: list of metadata columns
- `backed`: whether file was opened in backed mode

### Saving AnnData

```python
# Save with compression (default: gzip)
report = omics_io.save_h5ad(adata=adata, path="processed.h5ad")
print(f"Saved to {report['path']} ({report['size_bytes']} bytes)")

# Custom compression
report = omics_io.save_h5ad(
    adata=adata,
    path="processed.h5ad",
    compression="gzip",
    compression_opts=9  # max compression
)
```

### Loading MuData

```python
# Load multi-modal data
mdata, report = omics_io.load_h5mu(path="multiome.h5mu")

# Access modalities
rna = mdata.mod["rna"]
atac = mdata.mod["atac"]

print(f"Modalities: {list(report['modalities'].keys())}")
for mod, info in report['modalities'].items():
    print(f"  {mod}: {info['n_obs']} × {info['n_vars']}")

# Validate counts in all modalities
mdata, report = omics_io.load_h5mu(path="multiome.h5mu", validate_counts=True)
```

### Saving MuData

```python
report = omics_io.save_h5mu(mdata=mdata, path="multiome.h5mu")
print(f"Saved {len(report['modalities'])} modalities to {report['path']}")
```

### Validation Helper

```python
# Check if processed data meets requirements
validation = omics_io.validate_processed_adata(
    adata,
    require_counts=True,       # Must have layers["counts"]
    require_embedding=True,    # Must have at least one X_* in obsm
    require_clusters=False,    # Optional: check for obs["leiden"]
)

if not validation["valid"]:
    for error in validation["errors"]:
        print(f"ERROR: {error}")

for warning in validation["warnings"]:
    print(f"WARNING: {warning}")

print(f"Found embeddings: {validation['embeddings']}")
```

## Common Pitfalls

### 1. Modifying X Without Preserving Counts

**Wrong:**
```python
adata.X = sc.pp.normalize_total(adata.X, inplace=False)  # Raw counts lost!
```

**Right:**
```python
adata.layers["counts"] = adata.X.copy()  # Preserve raw counts
sc.pp.normalize_total(adata, inplace=True)
# Now: layers["counts"] = raw, X = normalized
```

### 2. Hardcoding Key Names

**Wrong:**
```python
if "leiden" in adata.obs.columns:
    clusters = adata.obs["leiden"]
```

**Right:**
```python
from conventions import OBS_LEIDEN
if OBS_LEIDEN in adata.obs.columns:
    clusters = adata.obs[OBS_LEIDEN]
```

### 3. Confusing MuData vs. AnnData Access

**Wrong:**
```python
mdata, report = omics_io.load_h5mu(path="multiome.h5mu")
counts = mdata.X  # This is the concatenated joint matrix, usually not what you want
```

**Right:**
```python
mdata, report = omics_io.load_h5mu(path="multiome.h5mu")
rna_counts = mdata.mod["rna"].X
atac_counts = mdata.mod["atac"].X
```

### 4. Not Checking for Backed Mode Side Effects

**Pitfall:**
```python
adata, _ = omics_io.load_h5ad(path="data.h5ad", backed="r")
adata.X = adata.X / adata.X.sum(axis=1)  # Error: cannot modify backed AnnData
```

**Fix:**
```python
# Either load fully in memory
adata, _ = omics_io.load_h5ad(path="data.h5ad")

# Or convert to in-memory when needed
adata = adata.to_memory()
```

### 5. Assuming obs["cell_type"] is Ground Truth

**Anti-pattern:**
```python
# User asks: "Annotate cell types in this dataset"
# Dataset already has obs["cell_type"] from submitter
answer = adata.obs["cell_type"].value_counts()  # Just echoing prior annotation!
```

**Right:**
```python
from conventions import OBS_CELLTYPE

if OBS_CELLTYPE in adata.obs.columns:
    print(f"WARNING: Prior annotation exists in obs['{OBS_CELLTYPE}'].")
    print("Treating this as reference for post-hoc comparison only.")
    prior_labels = adata.obs[OBS_CELLTYPE].copy()
    adata.obs[OBS_CELLTYPE + "_prior"] = prior_labels
    del adata.obs[OBS_CELLTYPE]
    # Now run your own annotation
```

### 6. Missing Validation After Processing

**Pitfall:**
```python
# Run preprocessing pipeline...
# Save and report without checking if standard keys exist
omics_io.save_h5ad(adata=adata, path="processed.h5ad")
```

**Better:**
```python
validation = omics_io.validate_processed_adata(
    adata,
    require_counts=True,
    require_embedding=True,
)

if not validation["valid"]:
    raise ValueError(f"Validation failed: {validation['errors']}")

omics_io.save_h5ad(adata=adata, path="processed.h5ad")
```

### 7. Not Using Report Dicts for Provenance

**Pitfall:**
```python
adata, _ = omics_io.load_h5ad(path="data.h5ad")  # Report discarded
# Later: "Where did this data come from?"
```

**Right:**
```python
adata, load_report = omics_io.load_h5ad(path="data.h5ad")
# ... process ...
save_report = omics_io.save_h5ad(adata=adata, path="processed.h5ad")

# Include reports in final provenance
evidence = {
    "input": load_report,
    "output": save_report,
    "n_cells_filtered": load_report["n_obs"] - save_report["n_obs"],
}
```

### 8. Densifying Sparse Matrices Unnecessarily

**Pitfall:**
```python
# Convert sparse to dense for no good reason
adata.X = adata.X.toarray()  # Memory blowup on large datasets!
```

**Fix:**
```python
# Keep X sparse unless you genuinely need dense operations
# Most scanpy/scverse tools handle sparse matrices efficiently
import scipy.sparse as sp
assert sp.issparse(adata.X), "X should remain sparse"
```

### 9. Putting Spatial Coordinates in obs Instead of obsm

**Wrong:**
```python
adata.obs["x"] = x_coords
adata.obs["y"] = y_coords
```

**Right:**
```python
import numpy as np
from conventions import OBSM_SPATIAL

adata.obsm[OBSM_SPATIAL] = np.column_stack([x_coords, y_coords])
```

## Grounding Requirements

Every quantitative claim about the data must trace to a computation output. The `omics_io` report dicts are **primary evidence** for data provenance.

### What to Record

- **Load operations**: `load_report` from `load_h5ad` / `load_h5mu`
- **Save operations**: `save_report` from `save_h5ad` / `save_h5mu`
- **Validation**: `validation_report` from `validate_processed_adata`
- **Shape changes**: Before/after cell/gene counts for any filtering step

### Example: Grounded Filtering Report

```python
adata, load_report = omics_io.load_h5ad(path="raw.h5ad")
n_cells_before = adata.n_obs
n_genes_before = adata.n_vars

# Apply QC filters...
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)

n_cells_after = adata.n_obs
n_genes_after = adata.n_vars

save_report = omics_io.save_h5ad(adata=adata, path="filtered.h5ad")

# Grounded evidence record
evidence = {
    "input_path": load_report["path"],
    "output_path": save_report["path"],
    "cells_before": n_cells_before,
    "cells_after": n_cells_after,
    "cells_removed": n_cells_before - n_cells_after,
    "genes_before": n_genes_before,
    "genes_after": n_genes_after,
    "genes_removed": n_genes_before - n_genes_after,
}

# This evidence dict should be returned or logged for provenance
```

### What Not to Do

- **No bare assertions**: "The dataset has 5,000 cells" → must cite `load_report['n_obs']`
- **No fabricated paths**: "Saved to output.h5ad" → must cite `save_report['path']` (absolute path)
- **No skipped validation**: If you claim "all required slots are present", show the `validation_report`

## Quick Reference

### Import Pattern

```python
import sys, os
sys.path.insert(0, os.path.join(os.environ.get("AOS_SKILLS_DIR", "skills"), "omics", "_shared", "scripts"))

import conventions
import io as omics_io
from conventions import (
    LAYER_COUNTS, OBS_LEIDEN, OBS_CELLTYPE, OBSM_PCA, OBSM_UMAP
)
```

### Standard Load-Validate-Process-Save Pattern

```python
# Load
adata, load_report = omics_io.load_h5ad(path="input.h5ad", validate_counts=True)

# Validate
validation = omics_io.validate_processed_adata(
    adata, require_counts=True, require_embedding=False
)
if not validation["valid"]:
    raise ValueError(f"Input validation failed: {validation['errors']}")

# Process (example: add embedding)
sc.tl.pca(adata)
adata.obsm[conventions.OBSM_PCA] = adata.obsm["X_pca"]

# Save
save_report = omics_io.save_h5ad(adata=adata, path="output.h5ad")

# Report evidence
evidence = {
    "input": load_report,
    "output": save_report,
    "validation": validation,
}
```

### MuData Pattern

```python
# Load
mdata, load_report = omics_io.load_h5mu(path="multiome.h5mu", validate_counts=True)

# Access modalities
rna = mdata.mod["rna"]
atac = mdata.mod["atac"]

# Process each modality independently
sc.pp.normalize_total(rna)
sc.pp.log1p(rna)

# Process cross-modality integration
# ... (e.g., MultiVI, WNN)

# Save
save_report = omics_io.save_h5mu(mdata=mdata, path="integrated.h5mu")
```

## When to Deviate from These Conventions

The conventions and helpers are optimized for **standard workflows on well-formed data**. Deviate when:

1. **Legacy data**: Dataset uses non-standard keys (e.g., `raw.X` instead of `layers["counts"]`). Document the mapping explicitly.
2. **Vendor formats**: 10x CellRanger outputs, Parse Biosciences, etc. Use domain-specific loaders first, then map to conventions.
3. **Novel modalities**: New assay types (e.g., spatial proteomics) may not fit AnnData cleanly. Consider SpatialData or custom structures.
4. **Performance**: Backed mode required for datasets >100GB. Accept read-only constraints.

Always document deviations and provide a mapping back to standard conventions in your analysis notes.
