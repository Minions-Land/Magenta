# Reference — Differential Occupancy / Accessibility

Testing whether peak signal (ChIP occupancy or ATAC accessibility) differs between conditions, using count-based models.

## The count matrix

Count reads in consensus peaks per sample (peaks × samples):

```bash
# bedtools multicov: count reads from each BAM in each peak
bedtools multicov -bams cond1_r1.bam cond1_r2.bam cond2_r1.bam cond2_r2.bam \
  -bed consensus_peaks.bed > peak_counts.txt
```

```python
import pandas as pd
counts = pd.read_csv("peak_counts.txt", sep="\t", header=None)
peak_ids = counts.iloc[:, :3].astype(str).agg("_".join, axis=1)  # chr_start_end
count_matrix = counts.iloc[:, 3:]  # samples in columns
count_matrix.index = peak_ids
count_matrix.columns = sample_names
```

## Method 1: DiffBind (R, gold standard)

DiffBind wraps DESeq2/edgeR for ChIP/ATAC differential binding:

```python
# Via rpy2, or run an R script
# dba → dba.count → dba.contrast → dba.analyze
# Returns differential peaks with Fold, p, FDR
```

DiffBind handles the ChIP-specific normalization (library size, effective genome size) and is the community standard.

## Method 2: pydeseq2 (pure Python)

Treat peaks like genes — negative-binomial DE on the count matrix:

```python
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

metadata = pd.DataFrame({"condition": conditions}, index=sample_names)
dds = DeseqDataSet(counts=count_matrix.T, metadata=metadata, design_factors="condition")
dds.deseq2()
stat = DeseqStats(dds, contrast=["condition", "treated", "control"])
res = stat.summary()
# res: baseMean, log2FoldChange, pvalue, padj (per peak)
```

## Method 3: CPM + descriptive log2FC (n=2, no proper model)

When replicates are too few for a statistical model (n=2), report descriptive fold-changes with an explicit caveat:

```python
import numpy as np
cpm = count_matrix / count_matrix.sum(axis=0) * 1e6
log2fc = np.log2(cpm[treated_cols].mean(axis=1) + 1) - np.log2(cpm[control_cols].mean(axis=1) + 1)
# CAVEAT: n=2 gives no valid p-value; this is descriptive ranking only
```

**Flag the n=2 limitation** — with 2 replicates, DESeq2's dispersion estimate is unstable; report fold-changes as exploratory.

## Thresholds

- **|log2FC| > 1** (2-fold) + **padj < 0.05** — standard significance
- **One-sided** when testing directional loss/gain (e.g., H3K27ac depletion after treatment)

```python
gained = res[(res.log2FoldChange > 1) & (res.padj < 0.05)]
lost = res[(res.log2FoldChange < -1) & (res.padj < 0.05)]
```

## Normalization considerations

- **Library size** — deeper-sequenced samples have more reads per peak; DESeq2 size factors handle this
- **Effective genome size** — differs by assay; DiffBind accounts for it
- **Spike-in normalization** — for global changes (e.g., global H3K27me3 loss), spike-in is more accurate than library-size normalization

## Pitfalls

- **n=2 treated as high-confidence** — flag the caveat; dispersion is unstable
- **Not merging replicate peaks first** — inflates the peak set
- **Wrong contrast direction** — verify treated vs control in the summary
- **CPM without size factors for statistical tests** — use DESeq2 normalization, not raw CPM, when computing p-values
- **No FDR** — thousands of peaks need BH correction

## Grounding

`report`: count method (multicov), n peaks tested, DE method (DiffBind/pydeseq2/CPM), replicate count + caveat if n≤2, n gained/lost with thresholds, top peaks with log2FC + padj.
