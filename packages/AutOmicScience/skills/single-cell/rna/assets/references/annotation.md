# scRNA-seq Cell Type Annotation

**Maturity: Route 1 (marker + LLM) = READY** — cluster with Leiden, then `omics_compute(subcommand="marker_table", modality="scrna", ...)`, then thread the marker table + dataset summary + study description into a labeling decision. **Route 2 (reference pipeline) = PARTIAL** — call the `run_annotation_pipeline` tool when a labeled reference is available.

## Goal / When to Use

Assign biological cell-type labels to clusters after QC and clustering. Annotation is a **hypothesis grounded in marker evidence**, never a lookup. Pick a route based on whether a trustworthy labeled reference exists.

## Two routes (pick one)

- **Route 1 — marker + LLM (default).** Cluster → marker table → label each cluster from its marker pattern + tissue/study context; abstain ("unknown") when markers are ambiguous. Interpretable, reference-free, abstention-capable. Use this unless the user supplies or requests a labeled reference.
- **Route 2 — reference pipeline (PARTIAL).** Call `run_annotation_pipeline` (a real Task tool on the omics leader) when a quality labeled reference can be built. Reproducible label transfer; depends on reference quality.

Do not bolt on other automated annotators ad hoc (CellTypist / scANVI / popV / scArches): Route 2 already provides the grounded reference path, and Route 1 keeps the call interpretable and auditable.

## Anti-circular rule (read first)

If the dataset already carries an `obs["cell_type"]` (or similar) column, treat it as **prior annotation, not ground truth**. Never copy it into your output, and never feed it into the marker test as the grouping. Cluster independently with Leiden, annotate from markers, then **compare** your labels against the prior with ARI/NMI (`omics_compute score` with `pred-key`/`ref-key`/`metric`, or `sklearn.metrics`). Report agreement and investigate disagreements. Copying the prior column is circular — the most common silent failure in annotation.

## Route 1 — marker + LLM (READY, default)

### Step 1 — Ensure clusters exist

Annotation needs a Leiden partition. `omics_compute preprocess` writes `obs["leiden"]`; if your h5ad lacks it, run preprocess first (`qc.md`). Over-clustering forces spurious labels — if markers come back non-specific (Step 3), lower resolution and re-cluster **before** labeling.

### Step 2 — Compute the marker table (grounded)

```
omics_compute(
  subcommand="marker_table",
  modality="scrna",
  args={"input": "processed.h5ad", "output": "markers.csv",
        "groupby": "leiden", "min-logfc": "0.5", "min-pct": "0.25"}
)
```

The returned `report` carries n_markers per cluster and the parameters used (evidence recorded automatically). `markers.csv` columns are exactly: **`group`** (cluster id), **`names`** (gene), `scores`, `logfoldchanges`, `pvals`, `pvals_adj`, `pts`, `pts_rest`, `specificity`. Ribosomal / mito / MALAT1 / hemoglobin noise genes are already excluded by the subcommand.

### Step 3 — Format top markers per cluster

Rank by `scores` within each `group`; prefer genes with high `specificity` (expressed in-group, not in the rest):

```python
import pandas as pd
m = pd.read_csv("markers.csv")
top = m.sort_values(["group", "scores"], ascending=[True, False]).groupby("group").head(8)
per_cluster = top.groupby("group")["names"].apply(lambda g: ", ".join(g)).to_dict()
for grp, genes in per_cluster.items():
    print(f"cluster {grp}: {genes}")
```

### Step 4 — Labeling decision (thread markers + context)

Make the call from three inputs **together** — never markers alone:

1. the top markers per cluster (Step 3),
2. the dataset summary (`omics_compute summarize` → n_cells, tissue, organism, n_clusters),
3. the free-text study description (tissue, disease, condition, expected populations).

For each cluster, name the most likely cell type from its specific markers, cross-checked against the tissue's expected populations. **Abstain to "unknown" when**: top markers are non-specific or housekeeping; two lineages' markers co-occur (possible doublet/transitional); or no canonical pattern matches the tissue. Record *which* markers drove each call.

Then write the final labels — the only step that sets `cell_type` — and emit a report so it stays grounded:

```python
import scanpy as sc
adata = sc.read_h5ad("processed.h5ad")

cluster_to_celltype = {        # from your judgment, NOT copied from any column
    "0": "CD4 T cell", "1": "CD14+ monocyte", "2": "B cell",
    "3": "CD8 T cell", "4": "NK cell", "5": "unknown",
}
adata.obs["cell_type"] = adata.obs["leiden"].map(cluster_to_celltype).astype("category")

report = {
    "operation": "annotation_marker_llm",
    "n_clusters": int(adata.obs["leiden"].nunique()),
    "labels": adata.obs["cell_type"].value_counts().to_dict(),
    "n_unknown": int((adata.obs["cell_type"] == "unknown").sum()),
    "markers_used": per_cluster,
}
adata.write_h5ad("annotated.h5ad")
report
```

Pass the trailing `report` to `evidence_from_kernel_cell` so the labels and their supporting markers are captured as evidence.

### Step 5 — Validate visually

Cross-check before any claim:

```python
canonical = {                  # human PBMC; swap for your tissue
    "T cell": ["CD3D", "CD3E"], "CD4 T": ["CD4", "IL7R"], "CD8 T": ["CD8A", "CD8B"],
    "B cell": ["CD79A", "MS4A1"], "Monocyte": ["CD14", "LYZ"], "NK": ["GNLY", "NKG7"],
    "DC": ["FCER1A", "CST3"], "Platelet": ["PPBP", "PF4"],
}
sc.pl.dotplot(adata, canonical, groupby="leiden", dendrogram=True)
sc.pl.umap(adata, color=["leiden", "cell_type"])
```

`observe_figure` each plot. A label whose canonical markers light up in its cluster is supported; a "T cell" cluster without CD3D is a flag — revisit it.

### Marker interpretation guidance

- Rank by `scores`; trust genes with high `specificity` over ubiquitous ones.
- Annotate **hierarchically**: lineage first (lymphoid / myeloid / …), then type (CD4 T / CD8 T / monocyte), then state (naive / memory / activated) only if markers support it.
- A gene expressed in >50% of *all* cells is ambient/housekeeping, not a marker — ignore it.

Compact human-PBMC reference (validation only — adapt to your tissue):

| Lineage | Type | Markers |
|---------|------|---------|
| Lymphoid | T cell | CD3D, CD3E, CD3G |
| Lymphoid | CD4 T | CD4, IL7R, CCR7 |
| Lymphoid | CD8 T | CD8A, CD8B, GZMK |
| Lymphoid | Treg | FOXP3, IL2RA, CTLA4 |
| Lymphoid | NK | GNLY, NKG7, KLRD1 |
| Lymphoid | B cell | CD79A, MS4A1, CD19 |
| Lymphoid | Plasma | MZB1, IGHG1, SDC1 |
| Myeloid | CD14+ monocyte | CD14, LYZ, S100A8 |
| Myeloid | CD16+ monocyte | FCGR3A, MS4A7 |
| Myeloid | DC | FCER1A, CST3, CLEC10A |
| Myeloid | pDC | LILRA4, IL3RA, CLEC4C |
| Other | Platelet | PPBP, PF4, GP9 |

## Route 2 — reference pipeline (PARTIAL)

When a quality labeled reference is available, call the `run_annotation_pipeline` tool (a real Task tool registered on the omics leader). It runs a 3-stage sequential team — **selector → adapter → adjudicator** — performing no-training, label-free reference transfer:

- **selector** picks source + model execution pairs from gene-name/metadata evidence (no peeking at query labels);
- **adapter** emits an executable AdapterSpec (load query + reference, align shared genes, invoke embedding label transfer, postprocess);
- **adjudicator** chooses a consensus coarse label per group from votes/confidence, abstaining to the unknown label when evidence is contradictory.

It is **PARTIAL** because it needs a curated reference bundle and heavier transfer deps, and is a separate orchestration tool rather than an `omics_compute` subcommand. Validate its output with the same marker dotplots as Route 1, and compare to any prior labels with ARI/NMI — never accept transferred labels unchecked. (Notably it does *not* wrap CellTypist/scANVI; it is a label-free consensus transfer with explicit abstention.)

## Failure Modes

1. **Prior labels copied into output (circular annotation).** *Symptom:* `cell_type` matches an existing column with ARI ≈ 1.0 and no independent marker support. *Diagnosis:* the existing column was reused as the grouping or copied through. *Fix:* cluster fresh with Leiden, annotate from markers, and report ARI/NMI vs the prior as a comparison — do not adopt it.

2. **Non-specific markers → forced labels.** *Symptom:* top markers per cluster are ribosomal/housekeeping or shared across many clusters; labels feel arbitrary. *Diagnosis:* over-clustering (resolution too high) splitting one population, or unremoved ambient RNA. *Fix:* lower Leiden resolution and re-run markers; if a gene is ubiquitous, return to QC (`qc.md`); abstain where still ambiguous.

3. **Co-expressed lineage markers in one cluster.** *Symptom:* a cluster shows both, e.g., CD3D (T) and CD79A (B), or epithelial + immune markers. *Diagnosis:* doublets that survived QC, or a true transitional / ambient-mixed state. *Fix:* check the cluster's doublet score and `pct_counts_mt`; if doublet-driven, re-QC; otherwise label "unknown"/"doublet" rather than pick one lineage.

4. **Tissue mismatch in the marker reference.** *Symptom:* PBMC canonical markers don't light up because the data is brain/tumor/etc. *Diagnosis:* the validation dict doesn't match the tissue. *Fix:* swap in tissue-appropriate canonical markers from the study description before validating; abstain rather than force PBMC labels.

## observe_figure checkpoints

- **Dotplot of canonical markers by `leiden`** — does each labeled cluster express its type's markers, and only those?
- **UMAP colored by `cell_type` and `leiden`** — are labeled regions contiguous, or scattered (a scattered label is suspect)?
- **UMAP colored by `pct_counts_mt` / doublet score** — does an "unknown"/ambiguous cluster coincide with debris or doublets?

Observe each figure before it backs a claim.

## Grounding

Record from the `marker_table` report + your annotation report dict:

- `n_clusters`, per-cluster top markers (`markers_used`), and the `min-logfc`/`min-pct` used;
- the cluster→label mapping and `labels` counts;
- `n_unknown` (abstentions);
- ARI/NMI vs any prior `cell_type` column (comparison, not adoption).

The `omics_compute marker_table` report is captured automatically; pass your hand-written annotation report through `evidence_from_kernel_cell`.

## Honesty / Abstention

- **Abstain over guess.** An ambiguous cluster is "unknown", not an invented label. Report how many cells/clusters are unknown.
- **State the evidence per label.** A claim "cluster 3 = CD8 T" must name the markers (CD3D, CD8A, …) that support it.
- **Annotation is a hypothesis**, not a measurement; functional validation (flow / IF / assays) is the gold standard. Say so when labels back a strong biological claim.
- **Never present transferred or prior labels as your own finding** without marker corroboration and an ARI/NMI comparison.
