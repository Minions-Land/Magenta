# Normalization & filtering (bulk RNA-seq)

Pick normalization **by goal**. A common error is z-scoring raw counts, or using log-CPM as a differential-
expression model input.

| Goal | Use | Why |
|---|---|---|
| **DE model input** | raw counts → DESeq2 size factors / edgeR TMM (the model normalizes internally) | count models want raw counts; they estimate the offset |
| **Clustering / PCA / heatmaps** | **VST** or **rlog** (DESeq2), or TMM→logCPM (`edgeR::cpm(log=TRUE)`) | variance-stabilized, homoscedastic, comparable across samples |
| **Cross-sample viz of a few genes** | logCPM or VST | not raw counts |

## Low-expression filtering (do this first)

```r
# edgeR::filterByExpr — the idiomatic filter (keeps genes with enough counts in the smallest group)
library(edgeR); dge <- DGEList(cts, group=meta$condition)
keep <- filterByExpr(dge, group=meta$condition); dge <- dge[keep,, keep.lib.sizes=FALSE]
dge  <- calcNormFactors(dge, method="TMM")             # TMM normalization factors
logcpm <- cpm(dge, log=TRUE, prior.count=1)            # for viz/clustering
```
Python equivalent: drop genes below a stated minimum count (e.g. `< min-count in the smallest group`);
state the rule you used.

## VST for clustering / PCA (DESeq2)

```python
from pydeseq2.dds import DeseqDataSet
dds = DeseqDataSet(counts=counts, metadata=meta, design_factors=["condition"]); dds.deseq2()
dds.vst()                        # variance-stabilized matrix in dds.layers["vst_counts"]
# → use dds.layers["vst_counts"] for PCA / Ward clustering / heatmaps (not raw counts, not z-scored counts)
```

## Rules

- **Do not** feed TPM/FPKM or log-CPM to a count model (DESeq2/edgeR) as if they were counts.
- **Do not** z-score raw counts for clustering — variance scales with the mean; variance-stabilize (VST/rlog) first.
- For very sparse / low-count matrices, a variance-stabilizing transform before PCA (or a sparse-aware
  decomposition) is more appropriate than dense PCA on raw counts.
- State the exact normalization + filter thresholds you used, so the analysis is reproducible.

## Sources

- Anders & Huber 2010, *Genome Biology* 11:R106 — size-factor normalization (+ DESeq2 VST, Love et al. 2014).
- Robinson & Oshlack 2010, *Genome Biology* 11:R25 — TMM normalization (edgeR).
- Chen, Lun & Smyth 2016, *F1000Research* — `filterByExpr` / edgeR RNA-seq DE workflow.
