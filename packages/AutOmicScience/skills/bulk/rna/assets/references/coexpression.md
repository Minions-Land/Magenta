# Co-expression networks (WGCNA) & module coherence

## WGCNA — weighted gene co-expression network analysis (R)

Standard pipeline on **variance-stabilized** expression (VST / TMM-logCPM), genes in columns, samples in rows.

```r
suppressMessages(library(WGCNA)); options(stringsAsFactors=FALSE)
datExpr <- t(vst_matrix)                                   # samples x genes (VST/logCPM, filtered)

# 1. Pick soft-threshold power by scale-free topology fit (aim R^2 >= ~0.8, then the smallest such power)
sft   <- pickSoftThreshold(datExpr, powerVector=1:20, networkType="signed", verbose=0)
power <- sft$powerEstimate

# 2. Blockwise module detection on a SIGNED network + TOM
net <- blockwiseModules(datExpr, power=power, networkType="signed", TOMType="signed",
                        minModuleSize=30, mergeCutHeight=0.25, numericLabels=TRUE, verbose=0)

# 3. Module eigengenes, then module–trait association
MEs   <- moduleEigengenes(datExpr, net$colors)$eigengenes
trait <- read.csv("trait.csv", row.names=1)                # numeric/ordinal sample traits
mtCor <- cor(MEs, trait, use="pairwise.complete.obs")
mtP   <- corPvalueStudent(mtCor, nrow(datExpr))            # p per (module, trait)
cat(sprintf('{"power":%s,"n_modules":%d}\n', power, length(unique(net$colors))))
```

Key conventions: **signed** network + **signed TOM** (preserves direction of co-expression); choose the
soft power from the scale-free-fit curve (do not hard-code); summarize each module by its **eigengene**
(1st PC) and relate modules to traits via eigengene–trait correlation with a p-value.

### Module → cell-type / gene-set enrichment
Test each module's gene membership against marker/annotation gene sets with **Fisher's exact + BH-FDR**
(same math as `enrichment.md` ORA), using the analysed genes as the background universe.

## Lightweight "co-expression coherence" (no full WGCNA)

When the question is how tightly a defined gene set co-varies:

```python
import pandas as pd, numpy as np
# 1. define the set (e.g. top-N genes by |correlation| with a score), 2. within-set pairwise Spearman
sub = expr[gene_set]                                       # samples x genes (log/VST)
r   = sub.corr(method="spearman").values
np.fill_diagonal(r, np.nan)
mean_within = np.nanmean(r)                                # module coherence
per_gene    = pd.Series(np.nanmean(r, axis=1), index=gene_set)   # per-gene mean r
low_coh     = per_gene[per_gene < 0.2].index.tolist()      # weakly-coherent members
```
Report the mean within-set correlation and, if asked, flag low-coherence members by a stated threshold.

## Sources

- Langfelder & Horvath 2008, *BMC Bioinformatics* 9:559 — WGCNA. · Zhang & Horvath 2005, *SAGMB* — weighted
  network / soft-thresholding. · The official WGCNA tutorials (Horvath lab) for the signed-network defaults.
- Module eigengene: Langfelder & Horvath 2007, *BMC Syst Biol* (eigengene networks).
