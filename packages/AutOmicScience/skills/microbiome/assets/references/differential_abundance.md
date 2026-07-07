# Reference — Differential Abundance (DESeq2 / ANCOM / ALDEx2)

Testing which taxa differ in abundance between conditions.

## Method 1: DESeq2 (count-based, negative-binomial)
```python
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

# abundance: taxa × samples (counts)
metadata = pd.DataFrame({"condition": conditions, "batch": batches}, index=abundance.columns)
dds = DeseqDataSet(counts=abundance.T, metadata=metadata, design_factors="condition + batch")
dds.deseq2()
stat = DeseqStats(dds, contrast=["condition", "disease", "healthy"])
res = stat.summary()
# res: log2FoldChange, pvalue, padj per taxon
```

DESeq2 handles zero-inflation and compositional effects via size factors. Standard for RNA-seq, adopted for microbiome.

## Method 2: ANCOM (compositionally-aware, permutation)
ANCOM (Analysis of Composition of Microbiomes) tests for compositional differences:
```python
# Via R ANCOM package or Python implementations (e.g., scikit-bio)
# Returns W statistic (number of pairwise log-ratio tests significant)
```

ANCOM is conservative but robust to compositionality.

## Method 3: ALDEx2 (CLR + Monte Carlo)
ALDEx2 uses CLR-transformed data + MC to account for sampling variability:
```R
# Via R ALDEx2 package
library(ALDEx2)
aldex_out <- aldex(counts, conditions, mc.samples=128, test="t")
# Returns effect size (diff.btw / diff.win) + p-value
```

ALDEx2 is strict; low false-positive rate but lower power.

## Which method?
- **DESeq2** — standard, fast, handles covariates (batch), good power
- **ANCOM** — compositionally-aware, conservative, no covariates
- **ALDEx2** — compositionally-strict, lowest FPR, lowest power

Start with DESeq2; use ANCOM/ALDEx2 for validation if compositionality is a concern.

## Thresholds
`|log2FC| > 1` (2-fold) AND `padj < 0.05`

## Univariate per-taxon (for survival integration)
```python
from lifelines import CoxPHFitter
from statsmodels.stats.multitest import multipletests

results = []
for taxon in clr_abundance.index:
    df = pd.DataFrame({"time": time, "event": event, "taxon": clr_abundance.loc[taxon]})
    cph = CoxPHFitter()
    cph.fit(df, duration_col="time", event_col="event")
    results.append({"taxon": taxon, "HR": cph.hazard_ratios_["taxon"],
                    "p": cph.summary.loc["taxon", "p"]})
res = pd.DataFrame(results)
res["padj"] = multipletests(res.p, method="fdr_bh")[1]
```

This is the da-12-4 pattern (univariate Cox per taxon).

## Pitfalls
- DESeq2 on CLR-transformed data (DESeq2 wants raw counts)
- ANCOM without prevalence filtering (slow, unstable)
- No FDR correction (thousands of taxa tested)
- Ignoring batch effects (sequencing run, extraction kit)

## Grounding
`report`: method (DESeq2/ANCOM/ALDEx2), covariates in design, n taxa tested, n significant (padj<0.05), top taxa with log2FC + padj + taxonomy.
