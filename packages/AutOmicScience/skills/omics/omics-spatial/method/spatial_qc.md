# Spatial QC

**Maturity: REFERENCE** — hand-rolled in `run_python` with scanpy + squidpy (both installed); spatial-aware QC, distinct from scRNA cell QC.

## Goal / When to Use

Apply QC that is *spatial-aware*, distinct from scRNA cell QC. Use right after loading spatial data, before any feature matrices or clustering.

## Decision Criteria

**The judgment this guides:**

- **For spot data** (Visium, Slide-seq) — standard counts/genes thresholds plus **spatial sanity**: are low-count spots off-tissue (expected) or on-tissue (problem)? Visualize QC metrics **in space** to catch regional artifacts a histogram would hide.

- **For imaging/single-cell data** (Xenium, MERFISH, CosMx) — additionally **segmentation quality**:
  - Cell area — too small = over-segmentation (fragments), too large = under-segmentation (merged cells)
  - Transcripts per cell — too few = poor capture
  - Negative/blank-probe fraction — high fraction = technical noise
  - Whether segmentation boundaries match the image (if you have it)

- **Decide thresholds from the data distribution and the platform**, not fixed numbers. What's "low" for Visium (500 UMI/spot) is normal for MERFISH (10-50 transcripts/cell if it's a small panel).

## Method Menu

- **Compute per-obs QC** — reuse the scRNA QC recipe's machinery (`sc.pp.calculate_qc_metrics`), then add spatial-specific metrics:
  - For imaging: control-probe fraction, segmentation area
  - For spots: on-tissue vs. off-tissue (from the spaceranger tissue mask or manual inspection)

- **Visualize QC *in space*** — `sq.pl.spatial_scatter(adata, color='<qc_metric>')` for every QC metric, not just histograms. Regional artifacts (damaged tissue, edge effects, uneven capture) are invisible in a histogram.

## How-to

### Reuse scRNA QC + add spatial viz

```python
import scanpy as sc
import squidpy as sq

# Standard per-cell metrics
sc.pp.calculate_qc_metrics(adata, inplace=True)
# Populates: total_counts, n_genes_by_counts, pct_counts_mt (if mito genes present)

# For imaging: add control-probe fraction
if 'NegControl' in adata.var_names or 'BLANK' in adata.var_names:
    control_genes = [g for g in adata.var_names if g.startswith(('NegControl', 'BLANK', 'Blank', 'NegPrb', 'antisense'))]
    adata.obs['pct_counts_control'] = (
        adata[:, control_genes].X.sum(axis=1).A1 / adata.obs['total_counts']
    ) * 100

# Visualize QC in space
sq.pl.spatial_scatter(adata, color='total_counts', save='_qc_counts.png')
sq.pl.spatial_scatter(adata, color='n_genes_by_counts', save='_qc_genes.png')
if 'pct_counts_control' in adata.obs:
    sq.pl.spatial_scatter(adata, color='pct_counts_control', save='_qc_control.png')

# observe_figure on each: do low-quality regions make sense (edges, folds)?
```

### Filter (after inspecting the spatial QC plots)

```python
# Choose thresholds from the distribution + spatial view
min_counts = 200  # adapt per platform
min_genes = 100
max_control_pct = 10.0  # for imaging

pre_filter = adata.n_obs
adata = adata[
    (adata.obs['total_counts'] >= min_counts) &
    (adata.obs['n_genes_by_counts'] >= min_genes),
    :
].copy()

if 'pct_counts_control' in adata.obs:
    adata = adata[adata.obs['pct_counts_control'] <= max_control_pct, :].copy()

print(f"Filtered {pre_filter} → {adata.n_obs} obs")
```

## Pitfalls & Quality Checks

- **A uniform histogram can hide a damaged tissue region** — always `observe_figure` the QC-on-space plots. A histogram showing "reasonable" values can mask a large dead zone or a folded tissue edge that only the spatial view reveals.

- **Do not blanket-filter "low-count" spots that are genuinely low-cellularity tissue** — some tissue regions (e.g., extracellular matrix, lumen) have low RNA capture by biology, not by technical failure. Inspect the spatial plot: if low counts cluster off-tissue or at folds, filter them; if they're in a known low-signal region, keep them.

- **Over-segmentation (imaging)** — inflates cell count and dilutes signal (one real cell split into 2-3 fragments). Signals: many cells with tiny area, very low transcripts/cell. Flag and consider re-segmentation.

- **Under-segmentation (imaging)** — merges multiple cells into one. Signals: huge cell area, high transcripts/cell, marker co-expression that should be mutually exclusive (e.g., epithelial + immune markers in one "cell"). Flag and consider re-segmentation.

- **Off-tissue spots (Visium)** — should be filtered. If spaceranger provided a tissue mask (`adata.obs['in_tissue']`), use it; otherwise infer from the spatial count plot (a clear tissue outline vs. background).

- **`observe_figure`** — every QC metric on space. Red flags:
  - A streak/band of low counts (technical artifact, maybe a fold or bubble)
  - High control-probe fraction in one region (local technical failure)
  - Cell-area distribution with a long tail (segmentation issue)

## Grounding

**What to record as `EvidenceRecord`:**

```python
{
  "n_obs_pre_filter": 4500,
  "n_obs_post_filter": 3800,
  "thresholds": {
    "min_counts": 200,
    "min_genes": 100,
    "max_control_pct": 10.0
  },
  "median_counts": 1200,
  "median_genes": 850,
  "median_control_pct": 2.5,  # if applicable
  "off_tissue_removed": 700,  # if applicable
  "platform": "visium",
  "spatial_qc_figures": ["_qc_counts.png", "_qc_genes.png", "_qc_control.png"]
}
```

Ground: pre/post cell counts, thresholds applied, median QC values, fraction off-tissue removed.

## Honesty

- If QC removes a **large fraction** (>30-40%), say so and consider whether the threshold (not the data) is wrong. Inspect the spatial plots — is the filtered set biologically sensible?

- If one region is systematically low-quality, **flag it** — a damaged tissue region or a segmentation failure. Don't silently filter it and proceed as if the whole sample is uniform.

- **Abstain from strong conclusions on a heavily filtered sample** — if you removed half the cells, the spatial structure you're left with may not represent the original tissue.

- For imaging data, **segmentation quality is upstream of this QC** — if segmentation is broken (massive over/under-segmentation), no threshold here will fix it. Surface the segmentation issue and recommend re-running the segmentation pipeline, not just filtering the results.
