# scRNA-seq Marker Genes & Cross-Condition DE

**Maturity: READY** — per-cluster marker genes run via `omics_compute(subcommand="marker_table", modality="scrna", ...)`. Cross-condition pseudobulk DE is **REFERENCE** (hand-rolled PyDESeq2, Part B).

## Goal / When to Use

Two distinct questions, two different tools — do not conflate them:

- **Part A — Per-cluster markers (READY).** "What genes define each cluster?" One-vs-rest test per Leiden cluster, used to *annotate* clusters into cell types. Run right after clustering.
- **Part B — Cross-condition DE (REFERENCE).** "Within a cell type, which genes change between conditions (treated vs control, disease vs healthy)?" Needs pseudobulk aggregation + a replicate-aware negative-binomial model (PyDESeq2), not a per-cell test.

---

## Part A — Per-cluster marker genes (READY)

### Default path

Run the grounded subcommand; it executes in the pinned `task1` env and records evidence automatically:

```
omics_compute(
  subcommand="marker_table",
  modality="scrna",
  args={
    "input": "processed.h5ad",
    "output": "markers.csv",
    "groupby": "leiden",
    "min-logfc": "0.5",
    "min-pct": "0.25"
  }
)
```

Parameter rationale:
- `groupby="leiden"` — markers per Leiden cluster (the standard annotation unit). Point it at any categorical `obs` column if you group differently.
- `min-logfc="0.5"` — keep genes ≥0.5 log2FC up in the cluster vs rest; drops weakly-enriched genes that make annotation ambiguous.
- `min-pct="0.25"` — gene must be detected in ≥25% of the cluster's cells; removes genes driven by a handful of outlier cells.

Under the hood: `sc.tl.rank_genes_groups` with the **Wilcoxon** test (`pts=True`, one-vs-rest), then a quality filter (`logfoldchanges ≥ min-logfc`, in-group fraction ≥ `min-pct`, out-group fraction ≤ 0.5). Ribosomal / mito / MALAT1 / hemoglobin noise genes are excluded before filtering, so they never occupy a top slot.

### The marker table schema (read before parsing)

The CSV columns are EXACTLY (never `cluster`, never `gene`):

`group`, `names`, `scores`, `logfoldchanges`, `pvals`, `pvals_adj`, `pts`, `pts_rest`, `specificity`

- `group` — cluster id · `names` — gene · `scores` — Wilcoxon statistic (rank by this) · `logfoldchanges` — log2FC vs rest · `pvals` / `pvals_adj` — raw / BH-adjusted p · `pts` / `pts_rest` — detection fraction in-group / rest · `specificity` = `pts / (pts + pts_rest)` (1.0 = exclusive to the cluster).

Top markers per cluster for annotation:

```python
import pandas as pd
m = pd.read_csv("markers.csv")
top = m.sort_values(["group", "scores"], ascending=[True, False]).groupby("group").head(5)
summary = top.groupby("group")["names"].apply(lambda g: ", ".join(g)).to_dict()
```

Prefer high `specificity` + high `scores` markers when assigning a cell type. A gene with high `logfoldchanges` but `specificity ≈ 0.5` is shared with other clusters and weakly diagnostic.

### Alternatives (rarely needed)

Wilcoxon is the robust default. `t-test` is faster but distribution-sensitive; `logreg` (multinomial) finds combinatorial markers but is slow and less interpretable. Only switch with a stated reason.

---

## Part B — Cross-condition pseudobulk DE (REFERENCE)

No subcommand. **Aggregate to pseudobulk, then PyDESeq2.** Do NOT run a per-cell DE test across conditions — cells from one donor are not independent replicates, so per-cell p-values are anti-conservative by orders of magnitude. Pseudobulk + a replicate-level model is the correct, publication-grade path.

Requirements: raw counts (not log-normalized), a cell-type column, a sample/donor column, a condition column, and **≥3 biological replicates per condition**. Below that, report the comparison as underpowered and abstain from FDR claims.

```python
import scanpy as sc
import numpy as np
import pandas as pd
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

adata = sc.read_h5ad("annotated.h5ad")          # raw counts in layers["counts"]
CELL_TYPE, SAMPLE, COND = "cell_type", "sample_id", "condition"
cell_type = "CD8 T"                              # run one cell type at a time

# 1. Pseudobulk: sum raw counts per sample, within this cell type
sub = adata[adata.obs[CELL_TYPE] == cell_type]
samples = sub.obs[SAMPLE].unique().tolist()
pb = pd.DataFrame(0, index=samples, columns=sub.var_names, dtype=int)
for s in samples:
    rows = (sub.obs[SAMPLE] == s).values
    pb.loc[s] = np.asarray(sub.layers["counts"][rows].sum(axis=0)).ravel()

# 2. Sample-level metadata aligned to the pseudobulk rows
meta = adata.obs[[SAMPLE, COND]].drop_duplicates().set_index(SAMPLE).loc[samples]

# 3. Drop genes present in <3 pseudobulk samples (DESeq2 dislikes all-zero rows)
pb = pb.loc[:, (pb > 0).sum(axis=0) >= 3]

# 4. Negative-binomial GLM with dispersion shrinkage
dds = DeseqDataSet(counts=pb, metadata=meta, design_factors=COND)
#    NOTE: PyDESeq2 >=0.4 replaces design_factors=COND with design="~condition".
dds.deseq2()
res = DeseqStats(dds, contrast=[COND, "treated", "control"])   # treated vs control
res.summary()
de = res.results_df            # baseMean, log2FoldChange, lfcSE, stat, pvalue, padj

sig = de[(de["padj"] < 0.05) & (de["log2FoldChange"].abs() > 1)]
report = {
    "operation": "pseudobulk_de", "cell_type": cell_type,
    "n_samples": int(pb.shape[0]), "contrast": ["treated", "control"],
    "n_genes_tested": int(de.shape[0]), "n_sig": int(sig.shape[0]),
    "top_up": sig.sort_values("log2FoldChange", ascending=False).head(10).index.tolist(),
    "top_down": sig.sort_values("log2FoldChange").head(10).index.tolist(),
}
report      # trailing expression → pass this cell to evidence_from_kernel_cell
```

Emit the trailing `report` dict and pass the cell to `evidence_from_kernel_cell` so the DE result is grounded — the same contract READY subcommands satisfy via their report.

Contrast direction: `[COND, "treated", "control"]` reports treated relative to control, so positive `log2FoldChange` = up in treated. State the direction in every claim.

### Alternatives

For a quick exploratory within-cluster contrast (no replicates), `sc.tl.rank_genes_groups(adata, groupby="condition")` works, but its per-cell p-values are not valid biological-replicate statistics — never report them as condition DE. For paired/covariate designs, add terms to the DESeq2 design (e.g. `design="~donor + condition"`).

---

## Failure Modes

1. **Every cluster shares the same "markers" (ribosomal, MALAT1, etc.).** → *Diagnosis:* over-clustering split one population, or residual ambient/QC contamination. The subcommand already strips known noise genes, so persistent ubiquitous markers mean the clusters aren't biologically distinct. → *Fix:* lower Leiden resolution and re-run preprocess→marker_table; if it persists, return to QC (`qc.md`).

2. **A cluster has zero markers after filtering.** → *Diagnosis:* `min-logfc`/`min-pct` too strict for a subtle state, or the cluster is a doublet/low-count artifact with no specific signal. → *Fix:* inspect the unfiltered ranking by lowering `min-logfc` to 0.25; if still empty and the cluster sits between two others on UMAP, it is likely a doublet bridge — do not annotate it.

3. **Pseudobulk DE returns thousands of "significant" genes.** → *Diagnosis:* almost always batch confounded with condition (each condition run on a different day/lane), or fewer than 3 true replicates so dispersion is underestimated. → *Fix:* check `meta` for batch≠condition; add the batch term to the design (`design="~batch + condition"`); if batch is perfectly confounded with condition, the effect is not separable — report it and abstain.

4. **PyDESeq2 raises a singular-matrix / linear-dependence error.** → *Diagnosis:* a design factor is collinear (e.g. every treated sample is also the only female), or a pseudobulk group has <2 samples. → *Fix:* drop the redundant covariate, confirm ≥2 samples per condition, and re-fit.

5. **High-`logfoldchanges` marker is not specific.** → *Diagnosis:* `specificity ≈ 0.5` means the gene is expressed roughly equally outside the cluster; logFC alone is misleading when the rest-fraction is high. → *Fix:* rank/annotate by `specificity` and `scores`, not `logfoldchanges` alone.

## observe_figure checkpoints

- **Dotplot of top markers per cluster** (`sc.pl.dotplot`, top 3-5 by `scores`): a clean block-diagonal (each cluster's markers dark only in that cluster) confirms separable clusters. Smeared columns → over-clustering; re-run at lower resolution before annotating.
- **UMAP colored by a candidate marker** (`sc.pl.umap`, `color=<gene>`): expression should localize to the cluster you're annotating, not diffuse across the embedding.
- **Volcano plot of pseudobulk DE** (`log2FoldChange` vs `-log10(padj)`): a roughly symmetric cloud with a handful of points past the thresholds is healthy; thousands of significant genes or a one-sided cloud signals batch confounding (Failure Mode 3) — observe it before reporting any DE count.

## Grounding

- Part A: `omics_compute marker_table` returns a `report` with `n_groups`, `markers_per_group`, the filter parameters, and timings — captured as evidence automatically. Cite the marker CSV path and that report.
- Part B: emit the hand-written `report` dict (`n_samples`, `contrast`, `n_genes_tested`, `n_sig`, top genes) and pass the cell to `evidence_from_kernel_cell`. Never report DE numbers that aren't backed by that cell.

## Honesty / when to abstain

- **<3 replicates per condition:** state the comparison is underpowered; do not present pseudobulk `padj` as conclusive. A single-replicate "DE" is descriptive only — say so.
- **Batch confounded with condition:** if you cannot separate them in the design, the DE is not interpretable; report the confound and abstain from a biological claim.
- **Ambiguous markers:** a cluster whose top markers don't point to a known cell type is "unknown", not a guessed label — record which markers were present and why they're ambiguous (see `annotation.md`).
- **Direction:** always state the contrast direction (what is "up" relative to what). An unsigned "differentially expressed" claim is not actionable.
