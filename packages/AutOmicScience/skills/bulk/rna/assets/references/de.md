# Differential expression (count-based)

**Default:** a negative-binomial / voom count model — `pyDESeq2` (Python) or `DESeq2`/`edgeR`/`limma-voom`
(R). A Welch t-test or OLS on log-CPM ignores the count mean–variance relationship and is statistically
weaker; prefer a count model. Input = **raw integer counts** + a sample metadata table with the condition
and every relevant covariate.

## Recipe A — pyDESeq2 (Python, no R needed)

```python
import pandas as pd, numpy as np, json
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

counts = pd.read_csv("counts.csv", index_col=0)          # genes x samples (raw ints)
meta   = pd.read_csv("meta.csv",   index_col=0)          # samples x covariates; index == counts.columns
counts = counts.T.loc[meta.index]                        # DeseqDataSet wants samples x genes
counts = counts.loc[:, counts.sum(0) >= 10]              # low-expression filter (see normalization.md)

dds = DeseqDataSet(counts=counts, metadata=meta,
                   design_factors=["batch", "condition"])  # covariates FIRST, tested factor LAST
dds.deseq2()
st = DeseqStats(dds, contrast=["condition", "treated", "control"])  # (factor, numerator, reference)
st.summary()
st.lfc_shrink(coeff="condition_treated_vs_control")       # apeglm-style shrinkage — do this before ranking
res = st.results_df.dropna(subset=["padj"])

sig = res[res.padj < 0.05]
sig = sig.reindex(sig.log2FoldChange.abs().sort_values(ascending=False).index)   # rank by |shrunken LFC|
report = {"n_tested": int(len(res)), "n_sig_fdr05": int((res.padj < 0.05).sum()),
          "n_up": int(((res.padj<0.05)&(res.log2FoldChange>0)).sum()),
          "n_down": int(((res.padj<0.05)&(res.log2FoldChange<0)).sum()),
          "top_up": sig[sig.log2FoldChange>0].head(10).index.tolist(),
          "top_down": sig[sig.log2FoldChange<0].head(10).index.tolist()}
res.to_csv("de_results.csv"); print(json.dumps(report))    # emit report for grounding
```

## Recipe B — DESeq2 (R, via Rscript) with covariate design + apeglm shrinkage

```r
# Rscript -e '...'  (requires DESeq2 + apeglm in the R env)
suppressMessages(library(DESeq2))
cts  <- as.matrix(read.csv("counts.csv", row.names=1))            # genes x samples, raw ints
cd   <- read.csv("meta.csv", row.names=1)                         # aligned to colnames(cts)
dds  <- DESeqDataSetFromMatrix(cts, cd, design = ~ batch + condition)   # covariates + tested factor last
dds  <- dds[rowSums(counts(dds)) >= 10, ]                         # filter
dds  <- DESeq(dds)
res  <- lfcShrink(dds, coef=resultsNames(dds)[length(resultsNames(dds))], type="apeglm")
res  <- as.data.frame(res); res <- res[order(-abs(res$log2FoldChange)), ]
write.csv(res, "de_results.csv")
cat(sprintf('{"n_sig_fdr05":%d}\n', sum(res$padj < 0.05, na.rm=TRUE)))
```

Choose **edgeR** (`glmQLFit`/`glmQLFTest`) or **limma-voom** (`voom`→`lmFit`→`eBayes`) instead when you
prefer them; all three are count-appropriate. For designs with many covariates or continuous traits,
**limma-voom** (optionally with `duplicateCorrelation`) is a common idiomatic choice.

## Pseudobulk (single-cell → bulk DE)

Sum **raw** counts per (sample/donor × group), then run Recipe A/B on the pseudobulk matrix. Do NOT run a
per-cell test.

```python
# adata: cells x genes with adata.obs[["donor","group"]] and raw counts in adata.layers["counts"]
import pandas as pd
X = pd.DataFrame(adata.layers["counts"], index=adata.obs_names, columns=adata.var_names)
key = adata.obs["donor"].astype(str) + "|" + adata.obs["group"].astype(str)
pb  = X.groupby(key.values).sum()                        # pseudobulk: donor|group x genes (raw sums)
# → build meta from the "donor|group" index, run pyDESeq2 with design ~ donor + group
```

## Ranking & thresholds

- "Most changed genes" → sort by **shrunken |log2FoldChange|** with an FDR gate (`padj < 0.05`), NOT by p.
- Report counts at the exact thresholds the prompt states (e.g. `|log2FC| > 0.5 & FDR < 0.05`).
- Effect-size + significance are separate axes — give both.

## Parsing a pre-computed DE table (DESeq2 / edgeR / Cuffdiff)

- **Verify contrast orientation** before interpreting sign: DESeq2 `contrast=(factor, test, ref)` → positive
  = up in `test`; Cuffdiff `gene_exp.diff` `log2(fold_change)` is `value_2` (sample_2) vs `value_1`.
- Apply the stated status/quality filter (Cuffdiff `status == "OK"`), FC + q-value thresholds.
- **Handle infinite FC** (`value_1==0` or `value_2==0`): keep and name the gene (e.g. report as `+Inf`)
  rather than silently dropping it.

## Sources

- Love, Huber & Anders 2014, *Genome Biology* 15:550 — DESeq2 (+ the Bioconductor DESeq2 vignette).
- Robinson, McCarthy & Smyth 2010, *Bioinformatics* 26:139 — edgeR (+ edgeR user guide).
- Law et al. 2014, *Genome Biology* 15:R29 — voom/limma (+ limma user guide).
- Zhu, Ibrahim & Love 2019, *Bioinformatics* 35:2084 — apeglm LFC shrinkage.
- Muzellec et al. 2023, *Bioinformatics* — PyDESeq2.
- Pseudobulk: Crowell et al. 2020, *Nat Commun* 11:6077 (muscat); Squair et al. 2021, *Nat Commun* 12:5692.
