# Standard Preprocessing

## Goal / When to Use

Decide when to use the frozen `standard_preprocess` helper versus adapting preprocessing by hand. Use this guidance before running QC and dimensionality reduction.

## Decision Criteria

**Use `standard_preprocess` when:**
- Data is a standard scRNA-seq count matrix
- QC is routine (standard thresholds work)
- No batch effects need integration BEFORE neighbors
- Want speed + reproducibility
- Default parameters (n_hvg=2000, resolution=1.0) are reasonable

**Adapt by hand when:**
- QC is unusual (nuclei data, very low depth, tissue-specific thresholds)
- Strong batch effects → need integration (Harmony, scVI) before neighbors
- Modality needs different features (scATAC tiles, spatial neighborhoods)
- Want non-standard HVG flavor or custom filtering
- Exploring parameter space (resolution sweep, n_neighbors tuning)

The helper is a **power-tool**, not mandatory. Choose based on what the data needs.

## Method Menu

### Option 1: Use standard_preprocess

```python
from preprocess import standard_preprocess

adata, report = standard_preprocess(
    adata,
    n_hvg=2000,
    resolution=1.0,
    n_pcs=50,
    n_neighbors=15,
    seed=0,
    qc_mode="fixed",  # or "adaptive"
    min_genes=200,
    min_cells=3,
    max_mito_percent=20,
    return_report=True
)
```

**What it does:**
1. QC filtering (cells/genes)
2. Normalize (target_sum=1e4) + log1p
3. HVG selection (seurat_v3, n_top_genes)
4. PCA (n_comps)
5. Neighbors graph (n_neighbors, n_pcs)
6. UMAP embedding
7. Leiden clustering (resolution)

**Returns:**
- `adata`: processed dataset with embeddings, clusters
- `report`: dict with all params, shapes, n_clusters, duration

### Option 2: Adapt by hand

Write custom scanpy code when the data demands it:

```python
# Example: batch integration before neighbors
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
sc.pp.normalize_total(adata)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000)

# Batch correction (not in standard_preprocess)
sc.external.pp.harmony_integrate(adata, key='batch')

# Then neighbors on corrected embedding
sc.pp.neighbors(adata, use_rep='X_pca_harmony')
sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=1.0)
```

## How-To

### Using standard_preprocess

```python
# Ensure raw counts in layers["counts"]
adata.layers[LAYER_COUNTS] = adata.X.copy()

# Run preprocessing
adata_processed, report = standard_preprocess(
    adata,
    n_hvg=2000,
    resolution=1.0,
    qc_mode="fixed",
    return_report=True
)

# Emit report as evidence
import json
print(json.dumps(report))
```

**Report structure:**
```python
{
    "operation": "standard_preprocess",
    "initial_shape": [10000, 25000],
    "post_qc_shape": [8500, 23000],
    "final_shape": [8500, 23000],
    "cells_filtered": 1500,
    "genes_filtered": 2000,
    "parameters": {
        "n_hvg": 2000,
        "resolution": 1.0,
        "n_pcs": 50,
        "n_neighbors": 15,
        "seed": 0,
        "qc_mode": "fixed",
        "min_genes": 200,
        "min_cells": 3,
        "max_mito_percent": 20
    },
    "n_clusters": 12,
    "start_time": "2026-01-15T10:30:00",
    "end_time": "2026-01-15T10:32:15",
    "duration_seconds": 135
}
```

### QC mode choices

**"fixed" mode (default):**
- Hard thresholds: min_genes, min_cells, max_mito_percent
- Use for standard datasets where you know reasonable cutoffs

**"adaptive" mode:**
- Median absolute deviation (MAD) filtering
- Removes outliers (3 MADs from median) for n_genes, total_counts, pct_mito
- Use for heterogeneous datasets or when you don't know good thresholds

```python
# Adaptive QC
adata, report = standard_preprocess(
    adata,
    qc_mode="adaptive",
    return_report=True
)
```

### Overriding module constants

The helper reads constants from its module top:
- `DEFAULT_N_HVG = 2000`
- `DEFAULT_RESOLUTION = 1.0`
- etc.

These are the **single source of truth**. Override per-call via kwargs:

```python
# Use different resolution
adata, report = standard_preprocess(
    adata,
    resolution=0.5,  # Lower resolution → fewer clusters
    return_report=True
)
```

### Extracting specific results

```python
# After preprocessing, access results directly
n_clusters = len(adata.obs[OBS_LEIDEN].unique())
embedding_shape = adata.obsm[OBSM_UMAP].shape

# Or from the report
n_clusters = report["n_clusters"]
final_shape = report["final_shape"]
```

## Pitfalls & Quality Checks

❌ **Not storing raw counts first**
- `standard_preprocess` assumes `layers["counts"]` exists
- Solution: `adata.layers[LAYER_COUNTS] = adata.X.copy()` before preprocessing

❌ **Using on already-normalized data**
- Preprocessing normalizes, so feeding in log-normalized X → wrong
- Solution: Start from raw counts

❌ **Forgetting `return_report=True`**
- Without it, only `adata` is returned, no evidence
- Solution: Always `return_report=True` for grounding

❌ **Ignoring batch effects**
- `standard_preprocess` does NOT correct batch → use manual integration
- Solution: If batch is strong, adapt by hand with Harmony/scVI

❌ **Not checking QC results**
- Blindly accepting filtered cells without inspecting what was removed
- Solution: Check `report["cells_filtered"]` and `report["genes_filtered"]`

## Grounding

Emit the report dict as evidence (already shown above). The report contains everything needed for reproducibility:
- Initial/post-QC/final shapes
- All parameters used
- Number of clusters found
- Timestamps and duration

## Honesty

- **If QC removes >50% of cells**, investigate why before proceeding. The data may be low-quality or thresholds may be wrong.
- **If clustering produces 1 cluster or >50 clusters**, inspect the data and consider adjusting resolution.
- **If the helper fails** (e.g., HVG selection raises an error), report the error and either fix the input or adapt by hand.

The helper is deterministic and tested, but it is not magic. It makes sensible default choices—check that those defaults fit your data before trusting the results.
