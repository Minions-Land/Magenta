# QC, Doublets, Normalization, Feature Selection, Dimensionality Reduction

**Maturity: READY** — the standard path runs via `omics_runtime(subcommand="preprocess", modality="scrna", ...)`. Deviate by hand (below) only when the data breaks the defaults' assumptions.

## Goal / When to Use

Apply quality control when first encountering a dataset, or when a downstream surprise (ubiquitous "marker" genes, a cluster driven entirely by high mitochondrial percentage) sends you back to verify data quality. QC separates real cells from empty droplets, debris, and doublets before any analysis.

## Decision Criteria

### Thresholds — Adaptive vs Fixed

**Prefer MAD-based outlier detection** (median ± `nmads`·MAD on log-transformed library size, gene count, and percentage counts in top genes; stricter threshold on mitochondrial percentage) because fixed cutoffs are fragile across tissue types and protocols. Fixed cutoffs (e.g., "drop cells with <200 genes") work only when you know the expected distribution for that specific tissue and protocol.

Apply MAD filtering on:
- `log1p(total_counts)` — typically `nmads=5`
- `log1p(n_genes_by_counts)` — typically `nmads=5`
- `pct_counts_in_top_20_genes` — typically `nmads=5`
- `pct_counts_mt` — stricter, typically `nmads=3` (mitochondrial contamination is a strong quality signal)

Fall back to fixed thresholds only when distributions are pathological (bimodal library size suggesting two distinct populations, FFPE samples with known low counts). When using fixed thresholds, document the biological rationale.

### Doublets

**Score before QC filtering** — doublet detectors need the full high-count population to learn the doublet signature. If dataset has multiple samples/batches, run doublet detection per sample (`batch_key`) because doublet rates and profiles vary by sample.

`sc.pp.scrublet` is the in-stack default (part of scanpy). Set `threshold` based on the score distribution, not a magic number. Inspect the doublet score histogram and choose the threshold where the distribution shows a clear separation.

For datasets where Scrublet appears unstable (very small datasets, unusual bimodality in doublet scores), consider `DoubletDetection` (`doubletdetection.BoostClassifier`) as a more robust alternative.

### Ambient RNA

If only a filtered matrix is available (no empty droplets), ambient RNA correction is typically skipped and documented as a limitation. If a raw matrix (with empty droplets) is available, ambient correction is worth considering.

**Do not fabricate a raw matrix** if one is absent. State explicitly when ambient correction was not performed and why.

### Normalization

**Shifted-log normalization** (`sc.pp.normalize_total` followed by `sc.pp.log1p`) is the default. Use `target_sum=None` (normalizes to median library size) rather than a fixed 1e4, unless you have a specific reason for the fixed target.

Analytic Pearson residuals (`sc.experimental.pp.normalize_pearson_residuals`) are a principled alternative that can improve rare cell type detection and HVG selection, but require more care in downstream steps.

### HVG Selection

`flavor="seurat_v3"` computed on the raw counts layer (`layer="counts"`) is preferred for modern datasets. This requires `scikit-misc` (the LOESS backend). The alternative `flavor="seurat"` works on log-normalized data and does not require scikit-misc.

When using `batch_key`, HVG selection respects batch structure and selects features that vary within batches, not just between them.

### Resolution, PCs, Neighbors

These parameters are best left at helper defaults unless the data argues otherwise:
- Over-clustering visible in marker structure → reduce resolution
- Under-clustering (biologically distinct populations merge) → increase resolution
- Excessive noise in UMAP → reduce n_neighbors or n_pcs
- Loss of rare populations → increase n_pcs

## Method Menu

- **QC strategy:** MAD-based outlier detection (adaptive, preferred) vs fixed thresholds (fragile, use only with documented rationale)
- **Doublet detection:** `sc.pp.scrublet` (in-stack, fast) vs `doubletdetection.BoostClassifier` (more robust for small/unusual datasets)
- **Normalization:** Shifted-log (default: `normalize_total` + `log1p`) vs Pearson residuals (experimental, for rare types)
- **HVG flavor:** `seurat_v3` on counts layer (requires scikit-misc) vs `seurat` on log-normalized data

## How-to (default path)

Run the standardized QC→normalize→HVG→PCA→neighbors→UMAP→Leiden pipeline through the grounded tool — it executes in the pinned `task1` env and records evidence automatically:

```
omics_runtime(
  subcommand="preprocess",
  modality="scrna",
  args={"input": "raw.h5ad", "output": "processed.h5ad"}
)
```

The returned `report` carries the QC evidence (n_obs before/after, thresholds, n_hvg, n_pcs, n_clusters, doublet_rate). `processed.h5ad` has raw counts in `layers["counts"]`, normalized `X`, `obsm["X_pca"]`, `obsm["X_umap"]`, `obs["leiden"]`.

**What this subcommand actually does (so you know when to deviate):** it applies **fixed** QC thresholds (`min_genes=200`, `max_pct_mt=20`), shifted-log normalization, and `seurat_v3` HVG (which requires `scikit-misc`/`skmisc` in the env — `omics_preflight` checks for it). The fixed thresholds are reasonable for typical whole-cell 10x data but are **not** the adaptive MAD strategy discussed below. When the data argues for adaptive thresholds, Pearson residuals, or per-batch doublet handling, use the hand-written path.

### Hand-written QC (when deviating from defaults)

When the defaults don't fit (custom MAD thresholds, Pearson residuals, alternative doublet handling), write the steps explicitly in a `run_python` cell and emit a trailing `report` dict, then pass it to `evidence_from_kernel_cell` so it stays grounded:

```python
import scanpy as sc

# Calculate QC metrics
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], inplace=True)

# MAD-based filtering (example — adapt nmads as needed)
from scipy.stats import median_abs_deviation
import numpy as np

def is_outlier(x, nmads=5):
    med = np.median(x)
    mad = median_abs_deviation(x)
    return np.abs(x - med) > nmads * mad

# Flag outliers (per batch if batch_key is set)
adata.obs["outlier_counts"] = is_outlier(np.log1p(adata.obs["total_counts"]), nmads=5)
adata.obs["outlier_genes"] = is_outlier(np.log1p(adata.obs["n_genes_by_counts"]), nmads=5)
adata.obs["outlier_mt"] = is_outlier(adata.obs["pct_counts_mt"], nmads=3)

# Combine flags
adata.obs["outlier"] = (
    adata.obs["outlier_counts"] |
    adata.obs["outlier_genes"] |
    adata.obs["outlier_mt"]
)

# Filter
n_before = adata.n_obs
adata = adata[~adata.obs["outlier"]].copy()
n_after = adata.n_obs

print(f"Filtered {n_before - n_after} outlier cells ({n_before} → {n_after})")
```

## Pitfalls & observe_figure

### Figures to Check

1. **QC violin plots** (`sc.pl.violin` for `total_counts`, `n_genes_by_counts`, `pct_counts_mt`):
   - Is a clear quality mode being cut by your threshold?
   - Does the distribution justify your filtering strategy?

2. **QC scatter** (`total_counts` vs `n_genes_by_counts`, colored by `pct_counts_mt`):
   - Are high-mito cells clustering separately (debris)?
   - Linear relationship = good quality

3. **HVG dispersion plot** (`sc.pl.highly_variable_genes`):
   - Are enough genes selected (typically 2000-4000)?
   - Is the selection capturing biological variance?

4. **PCA variance ratio** (elbow plot):
   - How many PCs capture variance?
   - Typical: 30-50 PCs

5. **Post-Leiden UMAP** colored by QC metrics:
   - Color by `total_counts`: smooth gradient = good
   - Color by `pct_counts_mt`: clusters driven by mito = debris (re-filter)
   - Color by `leiden`: clear separation = appropriate resolution

### Red Flags

- **Ubiquitous marker genes**: A gene expressed in >50% of all cells is likely ambient RNA contamination
- **Doublet rate >15%**: Either true doublets or over-aggressive scoring — inspect score distribution
- **Sample drops below ~500 cells after filtering**: Either too-aggressive thresholds or genuinely low-quality sample (state which)
- **Cluster driven purely by high mitochondrial percentage**: This is debris, not a biological cell type — return to QC

## Grounding

Record from the helper's `report` dict:
- `n_obs_in`, `n_obs_out` (cells before and after filtering)
- `n_var_in`, `n_var_out` (genes before and after filtering)
- QC thresholds used (`qc_mode`, threshold values if fixed mode, `nmads` values if MAD mode)
- `doublet_rate` (fraction flagged)
- `n_hvg` (highly variable genes selected)
- `n_pcs` (principal components used)
- `n_clusters` (Leiden clusters)
- `batch_key` (if multi-sample)

All of these come directly from the `omics_runtime preprocess` `report` (or your hand-written report dict) and are captured as evidence automatically.

## Honesty

### When to Abstain or Flag Issues

- **If ambient correction was skipped** (no raw matrix available), state this explicitly as a limitation. Never claim ambient correction was performed when it wasn't.

- **If QC removes >30% of cells**, state this and verify the thresholds are appropriate. High removal rate may indicate:
  - Genuinely low-quality sample (report this)
  - Too-aggressive thresholds (adjust and document rationale)
  - Wrong tissue-specific expectations (e.g., nuclei have lower counts than whole cells)

- **If doublet detection is unstable** (bimodal score distribution, unclear threshold), state uncertainty. Consider trying DoubletDetection as alternative, or proceed without doublet filtering and document that as a caveat.

- **If downstream analysis reveals QC issues** (ubiquitous markers, debris clusters), return to QC rather than working around the problem. State clearly when re-QC is needed.
