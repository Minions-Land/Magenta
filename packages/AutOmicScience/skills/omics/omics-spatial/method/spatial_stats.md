# Spatial Statistics & Spatially-Variable Genes

**Maturity: REFERENCE** — hand-rolled in `run_python` with **squidpy** (installed, runs today). The model-based SVG alternative (SpatialDE) needs a separate install.

## Goal / When to Use

Quantify spatial structure: which genes are **spatially variable** (SVGs), whether cell types are **spatially co-located or segregated** (neighborhood enrichment, co-occurrence), and the **scale** of spatial patterns (Ripley). Run after QC + clustering/annotation, on a graph built from `obsm["spatial"]`.

## Decision Criteria — pick one default

- **Default: squidpy.** Covers the whole spatial-stats menu on the installed stack: spatial autocorrelation (**Moran's I** / Geary's C) for SVGs, **neighborhood enrichment** + **co-occurrence** for cell-type spatial relationships, **Ripley's K/L** for point-pattern scale. One graph, one library, fast.
- **Model-based SVG → SpatialDE (needs install).** A Gaussian-process test that also fits each SVG's **length-scale**. Reach for it only when you need the GP length-scale / pattern classes; Moran's I answers "is it spatial?" for most purposes far more cheaply.

## How-to (default — squidpy)

Build the spatial graph once, then run the statistics on it.

```python
import squidpy as sq

# 1. Spatial neighbor graph from obsm["spatial"]
sq.gr.spatial_neighbors(adata, coord_type="grid", n_neighs=6)   # Visium hex; coord_type="generic" (delaunay/kNN) for imaging

# 2. Spatially variable genes — Moran's I
sq.gr.spatial_autocorr(adata, mode="moran", n_perms=100, n_jobs=4)
svgs = adata.uns["moranI"].query("pval_norm < 0.05").sort_values("I", ascending=False)   # top SVGs by Moran's I

# 3. Cell-type spatial relationships (needs a cluster/cell_type label)
sq.gr.nhood_enrichment(adata, cluster_key="cell_type")          # which types neighbor which (z-scores in uns)
sq.gr.co_occurrence(adata, cluster_key="cell_type")             # co-occurrence vs distance

# 4. Point-pattern scale
sq.gr.ripley(adata, cluster_key="cell_type", mode="L")
```

Parameter rationale:
- `coord_type="grid", n_neighs=6` — Visium spots are a hexagonal lattice (6 neighbors). For **imaging/single-cell** (Xenium/MERFISH) use `coord_type="generic"` with `delaunay=True` or `n_neighs=6`.
- `mode="moran"` — Moran's I is the standard, interpretable autocorrelation index (−1…+1; >0 = clustered). Threshold `pval_norm < 0.05`.
- `n_perms=100` — permutation null for the empirical p-value; raise for a stricter null on small panels.

**Model-based SVG (SpatialDE — needs `pip install SpatialDE NaiveDE`, the separate `NaiveDE` package; not in `task2`):**
```python
import NaiveDE, SpatialDE
norm  = NaiveDE.stabilize(counts.T).T                                    # counts: spots × genes
resid = NaiveDE.regress_out(sample_info, norm.T, "np.log(total_counts)").T   # sample_info has x, y, total_counts
results = SpatialDE.run(sample_info[["x", "y"]], resid)                  # DataFrame; threshold qval < 0.05
```

## Failure Modes

- **Moran's I ≈ 0 for everything** — *symptom:* no SVGs. *Diagnosis:* the spatial graph is wrong (wrong `coord_type`, coords in wrong units). *Fix:* check `obsm["spatial"]` scale + plot the graph; use `coord_type="generic"` for imaging.
- **nhood_enrichment all near zero** — *symptom:* no cell-type structure. *Diagnosis:* labels are noisy (over-clustering) or the tissue genuinely has no segregation. *Fix:* validate `cell_type` first — this stat is only as good as the annotation.
- **SpatialDE slow / OOM** — *symptom:* hangs on >10k spots. *Diagnosis:* GP scales poorly. *Fix:* subset to HVGs, or use Moran's I; SpatialDE only for a curated gene set.

## observe_figure checkpoints

1. **Top SVGs in space** (`sq.pl.spatial_scatter(adata, color=top_svgs)`) — does the high-Moran's-I gene show a real pattern, or salt-and-pepper noise?
2. **Neighborhood-enrichment heatmap** (`sq.pl.nhood_enrichment`) — do enriched/depleted pairs match known tissue architecture?
3. **Co-occurrence / Ripley curves** — do they plateau at a sensible distance, or look flat (no structure)?

## Grounding

Record: graph params (`coord_type`, `n_neighs`), n SVGs at `pval_norm<0.05` + top genes with I, nhood-enrichment z-scores for key pairs, Ripley mode → `EvidenceRecord` via `evidence_from_kernel_cell`.

## Honesty

- **Spatial autocorrelation ≠ biological importance** — a high-Moran's-I gene is spatially structured, not necessarily functionally relevant; interpret with markers.
- **Every stat depends on the graph** — state `coord_type`/`n_neighs`; a different graph gives different numbers.
- nhood / co-occurrence / Ripley are **only as good as the cell-type labels** — if annotation is shaky, say so and treat the relationships as tentative.
