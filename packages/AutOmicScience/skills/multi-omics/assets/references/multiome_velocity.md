# Multiome Velocity (MultiVelo)

**Maturity: REFERENCE** — chromatin-informed RNA velocity via **MultiVelo**, hand-rolled in `run_python`. MultiVelo is **version-isolated** (pins `pandas<=1.4.4`, `scipy<1.14`, `matplotlib<3.8`; needs `scvelo`) — it **cannot share `task3`**; run it in a dedicated env. Use only with spliced/unspliced RNA + paired ATAC on a developmental/transition process — never on a static atlas.

## Decision Criteria

- **Requires spliced/unspliced counts** (velocyto / kb-python) in the RNA modality **and** paired ATAC peaks. No spliced/unspliced → **no velocity; stop, don't fake it.**
- **Developmental / transitional** biology only. Forcing velocity on stable types is a confident artifact.
- **MultiVelo takes two AnnData, not a MuData** — extract `mdata["rna"]` and `mdata["atac"]`, pass them separately; the model **returns** a result AnnData you must capture.

## How-to

Prep each modality, then run the chromatin-aware dynamical model:

```python
import scvelo as scv
import multivelo as mv

# RNA: scvelo moments (produces the Ms / Mu layers the model needs)
adata_rna = mdata["rna"].copy()
scv.pp.filter_and_normalize(adata_rna, min_shared_counts=10, n_top_genes=2000)
scv.pp.moments(adata_rna, n_pcs=30, n_neighbors=50)               # -> layers Ms, Mu

# ATAC: aggregate to gene-linked peaks, TF-IDF, smooth over a shared kNN
adata_atac = mv.aggregate_peaks_10x(mdata["atac"], "peak_annotation.tsv", "feature_linkage.bedpe")
mv.tfidf_norm(adata_atac)
mv.knn_smooth_chrom(adata_atac, nn_idx, nn_dist)                  # nn_idx/nn_dist from the shared (WNN) kNN

# chromatin-aware dynamical velocity — returns a NEW AnnData
mv.settings.VERBOSITY = 0
adata_result = mv.recover_dynamics_chrom(
    adata_rna, adata_atac, max_iter=5, init_mode="invert", parallel=True, n_anchors=500)
mv.velocity_graph(adata_result)
mv.latent_time(adata_result)
mv.velocity_embedding_stream(adata_result, basis="umap", color="cell_type", show=False, save="_mv_stream.png")
```

`recover_dynamics_chrom(adata_rna, adata_atac, ...)` is the core call — **two AnnData in, one result AnnData out**; `velocity_graph` / `latent_time` / `velocity_embedding_stream` all act on `adata_result`, not on the MuData.

## Failure Modes

- **No spliced/unspliced** — *symptom:* `KeyError` on `Ms`/`Mu`. *Diagnosis:* plain count pipeline. *Fix:* re-quantify with velocyto/kb-python, or stop and report velocity was not possible.
- **Passed a MuData** — *symptom:* `recover_dynamics_chrom(mdata)` errors. *Diagnosis:* MultiVelo is not MuData-based. *Fix:* pass `mdata["rna"]` and `mdata["atac"]` separately; capture the returned result.
- **Env collision** — *symptom:* import/solver errors with modern pandas/scipy. *Fix:* dedicated env with MultiVelo's pinned deps; never `task3`.

## observe_figure checkpoints

1. **Velocity stream on UMAP** — flow consistent with known differentiation direction, not random.
2. **Latent time** — increases outward from the progenitor population.

## Grounding

Record: method (MultiVelo), n_cells, n velocity genes, latent-time range, velocity-confidence distribution → `EvidenceRecord` via `evidence_from_kernel_cell`.

## Honesty

- No spliced/unspliced → **state velocity is impossible**, don't proceed.
- Velocity is a short-term extrapolation confounded by cell cycle/stress; if directions are implausible or confidence is low, present it as inconclusive rather than narrating arrows.
