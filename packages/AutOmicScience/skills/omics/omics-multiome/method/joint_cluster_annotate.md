# Joint Clustering & Annotation

**Maturity: REFERENCE** — cluster on the joint representation, then annotate via two routes (same as scRNA). Hand-rolled `muon` + the scRNA marker path.

## Goal / When to Use

After joint embedding, cluster cells on the joint space and assign biological labels.

## Decision Criteria

- **Cluster on the joint graph/representation:**
  - **WNN** produces a joint **graph** (not an `X_wnn` embedding) — cluster directly on it: `mu.tl.leiden(mdata)` after `mu.pp.neighbors(mdata)`.
  - **MultiVI** produces `obsm["X_multivi"]` — cluster via `mu.pp.neighbors(mdata, use_rep="X_multivi")` → `mu.tl.leiden`.
  - Resolution by marker support, not an arbitrary number.
- **Annotate via two routes (same as scRNA):** Route 1 = marker + LLM (default); Route 2 = reference pipeline (`run_annotation_pipeline`).

## How-to

```python
import muon as mu
# cluster on the joint representation
mu.pp.neighbors(mdata)                      # WNN graph (or use_rep="X_multivi" for MultiVI)
mu.tl.leiden(mdata, resolution=1.0, key_added="leiden")
mu.tl.umap(mdata)
```

**Annotation — Route 1 (marker + LLM, default):** markers come from the **RNA** modality via the scRNA marker subcommand; write the RNA modality out and run:
```python
omics_runtime(subcommand="marker_table", modality="scrna",
              args={"input": "rna.h5ad", "output": "markers.csv", "groupby": "leiden"})
# thread markers.csv + dataset summary + study description into a labeling decision (omics-scrna: annotation.md)
```
Validate each call against **both** modalities — RNA expression *and* ATAC accessibility at the marker genes.

**Route 2 (reference pipeline):** call `run_annotation_pipeline` when a labeled reference exists.

## Failure Modes

- **Clustering on `X_wnn`** — *symptom:* `use_rep="X_wnn"` KeyError. *Diagnosis:* WNN is a graph, not an embedding. *Fix:* cluster on the WNN graph (`mu.tl.leiden(mdata)` after `mu.pp.neighbors`); only MultiVI has `X_multivi`.
- **Joint adds nothing** — *symptom:* joint ARI/NMI ≈ single-modality. *Fix:* report it; don't force a joint interpretation.

## observe_figure checkpoints

1. Joint UMAP by cluster + by RNA/ATAC QC + by modality weight.
2. Marker validation: do top RNA markers also show ATAC accessibility at those genes?

## Grounding

Record: n_clusters, resolution, annotation route, per-cluster markers, confidence → `EvidenceRecord`.

## Honesty

If the joint embedding doesn't beat single-modality (ARI/NMI), say so. Treat any pre-existing `cell_type` column as prior, not ground truth (compare post-hoc, never copy).
