# Dimensionality Reduction & Clustering

**Maturity: REFERENCE** — no runtime subcommand; hand-rolled in `run_python` with snapATAC2. One opinionated default: **spectral embedding → kNN → Leiden → UMAP**.

## Goal / When to Use

Get a low-dimensional cell representation + clusters from the ATAC feature matrix (tiles or peaks), for visualization and downstream analysis. Run after QC + feature matrix.

## Decision Criteria — pick one default

- **Default: snapATAC2 spectral** (`snap.tl.spectral`, cosine-similarity Laplacian eigenmaps). Purpose-built for ATAC's sparse, near-binary data; the depth normalization is handled internally (no manual first-component drop). The right choice for almost all datasets.
- **PeakVI (PARTIAL — deep, GPU)** — `scvi.model.PEAKVI`. Use only when you need **batch correction** or a probabilistic model, and a GPU is available.
- **TF-IDF + LSI** (`muon.atac.pp.tfidf` + `muon.atac.tl.lsi`) — classic alternative; here you **must drop LSI component 1** (it tracks sequencing depth). Reach for it only to match a published LSI pipeline.

## How-to (default path)

```python
import snapatac2 as snap
snap.tl.spectral(adata, n_comps=30)              # -> obsm["X_spectral"]
snap.pp.knn(adata, use_rep="X_spectral")
snap.tl.leiden(adata, resolution=1.0)            # -> obs["leiden"]
snap.tl.umap(adata)                              # -> obsm["X_umap"]
```
Why `n_comps=30`: enough to capture ATAC structure without over-fitting noise; raise toward 50 for very heterogeneous tissue. Resolution is judgment — start at 1.0, then split/merge guided by marker peaks (`peak_calling.md`), not an arbitrary number.

**PeakVI (batch correction, GPU):**
```python
import scvi
scvi.model.PEAKVI.setup_anndata(adata, batch_key="batch")
model = scvi.model.PEAKVI(adata); model.train()
adata.obsm["X_scVI"] = model.get_latent_representation()
snap.pp.knn(adata, use_rep="X_scVI"); snap.tl.leiden(adata); snap.tl.umap(adata)
```

## Failure Modes

- **Depth-driven UMAP gradient** — *symptom:* UMAP colored by `total_counts` shows a smooth gradient. *Diagnosis:* using raw TF-IDF+LSI without dropping component 1. *Fix:* drop LSI comp-1, or use snapATAC2 spectral (handles it internally).
- **One giant blob** — *symptom:* no cluster structure. *Diagnosis:* too few features selected, or n_comps too low. *Fix:* widen feature selection (`snap.pp.select_features`), raise n_comps.
- **Shredded micro-clusters** — *symptom:* dozens of tiny clusters. *Diagnosis:* resolution too high. *Fix:* lower resolution; validate that splits have distinct marker peaks before keeping them.

## observe_figure checkpoints

1. **UMAP by cluster** — clean separation vs blob / shredding.
2. **UMAP by `total_counts` / TSSE** — a gradient that *tracks clusters* means technical variation drives the embedding (bad); uniform is good.

## Grounding

Record: embedding method + dims, n_clusters, resolution, n_cells, embedding key (`X_spectral` / `X_scVI` / `X_lsi`) → `EvidenceRecord`.

## Honesty

- If clusters track depth / TSSE rather than biology, say the embedding is technically confounded and fix features before interpreting.
- Resolution is a choice — report it and that the cluster count depends on it.
