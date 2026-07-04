---
name: rna
description: Single-cell RNA-seq — QC & preprocessing, batch integration, clustering, marker genes, cell-type annotation (marker+LLM / reference), DE, functional, trajectory, cell-cell communication.
requiredTools: [run_python, create_notebook, add_cell, observe_figure, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, scrna, single-cell, scanpy, scverse, annotation, integration]
extends: omics-shared
---

# scRNA-seq Analysis

Builds on `omics-shared` (loaded automatically — its rules apply here). Run compute through the **`omics_compute`** tool with `modality="scrna"`; it dispatches into the pinned `task1` env and records evidence automatically.

## Prerequisites

1. `omics_preflight(modality="scrna")` passes (provisions/validates `task1`).
2. AnnData with raw counts in `layers["counts"]`.
3. A `summarize` report + free-text study description threaded into every biological decision.

## Capability menu (with maturity)

| Capability | Maturity | How | Method doc |
|------------|----------|-----|------------|
| QC → norm → HVG → PCA → neighbors → UMAP → Leiden | **READY** | `omics_compute preprocess` | `method/qc.md` |
| Dataset summary for context | **READY** | `omics_compute summarize` | `../omics-shared/method/data_context.md` |
| Batch integration (Harmony) | **READY** | `omics_compute integrate` | `method/integration.md` |
| Batch integration (scVI / scANVI) | **PARTIAL** | needs GPU; verify preflight | `method/integration.md` |
| Per-cluster marker genes | **READY** | `omics_compute marker_table` | `method/markers_de.md` |
| Cell-type annotation (marker + LLM) | **READY** | markers → LLM labeling (Route 1) | `method/annotation.md` |
| Cell-type annotation (reference pipeline) | **PARTIAL** | `run_annotation_pipeline` (Route 2) | `method/annotation.md` |
| Pathway / TF activity, enrichment, perturbation | **READY** | `omics_compute pathway_activity` / `enrichment` / `perturbation` | `method/functional.md` |
| Cross-condition DE (pseudobulk DESeq2) | **REFERENCE** | hand-rolled in `run_python` | `method/markers_de.md` |
| Compositional analysis (cell type abundance) | **REFERENCE** | hand-rolled (scCODA / Milo) | `method/composition.md` |
| Trajectory / RNA velocity / fate | **REFERENCE** | hand-rolled (scVelo / CellRank) | `method/trajectory.md` |
| Cell-cell communication | **REFERENCE** | hand-rolled (LIANA) | `method/ccc.md` |

Read the method doc before running a capability — each gives the opinionated default, exact parameters, failure modes, and grounding.

## Standard workflow

Run each step through `omics_compute`; read the per-step method doc for parameters and decisions.

1. **Preflight & load** — `omics_preflight(modality="scrna")`; load the h5ad; `omics_compute(subcommand="summarize", modality="scrna", args={"input":"data.h5ad"})`. Thread the summary + study description forward.
2. **QC & preprocess** — `omics_compute(subcommand="preprocess", modality="scrna", args={"input":"raw.h5ad","output":"processed.h5ad"})`. See `method/qc.md` for MAD-vs-fixed thresholds, doublets, normalization.
3. **Integration (if multi-batch)** — only if a batch effect is visible. `omics_compute(subcommand="integrate", modality="scrna", args={"input":"processed.h5ad","output":"integrated.h5ad","batch-key":"batch","method":"harmony"})`. Validate with ARI/NMI (`method/integration.md`).
4. **Marker genes** — `omics_compute(subcommand="marker_table", modality="scrna", args={"input":"processed.h5ad","output":"markers.csv","groupby":"leiden","min-logfc":"0.5","min-pct":"0.25"})`.
5. **Annotation** — Route 1 (default): thread the marker table + summary + study description into a labeling decision (`method/annotation.md`); abstain to "unknown" when ambiguous. Route 2: `run_annotation_pipeline` when a labeled reference exists.
6. **Visualize & ground** — plot UMAP colored by `cell_type`/`leiden`/QC; `observe_figure` each before it backs a claim; cite the `omics_compute` reports as evidence.

## Marker table schema (read before using markers)

`omics_compute marker_table` writes a CSV with columns: **`group`** (cluster id), **`names`** (gene), `scores`, `logfoldchanges`, `pvals`, `pvals_adj`, `pct_nz_group`, `pct_nz_reference`, `pts`, `pts_rest`, `specificity`. Group and rank with these column names (note: `group`/`names`, never `cluster`/`gene`):

```python
import pandas as pd
m = pd.read_csv("markers.csv")
top = m.sort_values(["group", "scores"], ascending=[True, False]).groupby("group").head(5)
summary = top.groupby("group")["names"].apply(lambda g: ", ".join(g)).to_dict()
```

Ribosomal / mito / MALAT1 / hemoglobin noise genes are already excluded by the subcommand.

## Two annotation routes

- **Route 1 — marker + LLM (default).** Cluster → marker table → label clusters from marker patterns + tissue/study context; abstain ("unknown") when markers are ambiguous. Interpretable, reference-free, abstention-capable.
- **Route 2 — reference pipeline.** Use `run_annotation_pipeline` when a suitable labeled reference can be built. Reproducible; needs a quality reference.

Default to Route 1 unless the user provides/requests a labeled reference. Either way, treat any pre-existing `cell_type` column as prior annotation (compare with ARI/NMI; never copy it).

## scRNA-specific rules (on top of omics-shared)

- **Counts in `layers["counts"]`** before preprocess; the subcommand normalizes from there.
- **Integration must earn its place** — compare ARI/NMI vs known labels before/after; if biology degrades, keep the unintegrated space and say so.
- **QC removing >30% of cells** → investigate thresholds vs genuine low quality; document which (`method/qc.md`).
- **Non-specific markers** → likely over-clustering; lower resolution and re-run before annotating.
- **Abstain over guess** — an ambiguous cluster is "unknown", not an invented label.

## When things go wrong

- **>50% cells dropped in QC** — thresholds too strict or low-quality data; re-run adaptive QC, document.
- **Markers non-specific** — over-clustering; reduce resolution / adjust `n_neighbors`, re-run markers.
- **Integration hurts biology** — ARI/NMI drops after integration; use unintegrated space downstream, document.
- **Ambiguous annotation** — label "unknown", record which markers were present and why ambiguous.
