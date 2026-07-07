# Reference — Peak Loading & QC (BED / narrowPeak)

Parsing and quality-checking ChIP-seq / ATAC-seq peak files.

## BED / narrowPeak format

Peaks come as BED3, BED6, or narrowPeak (BED6+4):

| Column | BED6 | narrowPeak extras |
|--------|------|-------------------|
| 1 | chrom | |
| 2 | start (0-based) | |
| 3 | end | |
| 4 | name | |
| 5 | score | |
| 6 | strand | |
| 7 | | signalValue (fold enrichment) |
| 8 | | pValue (-log10) |
| 9 | | qValue (-log10) |
| 10 | | peak (summit offset) |

```python
import pyranges as pr
peaks = pr.read_bed("peaks.narrowPeak")
# Or pandas for narrowPeak columns:
import pandas as pd
cols = ["chrom","start","end","name","score","strand",
        "signalValue","pValue","qValue","peak"]
df = pd.read_csv("peaks.narrowPeak", sep="\t", header=None, names=cols)
```

**0-based half-open** — BED coordinates start at 0; end is exclusive. Don't mix with 1-based (GTF/VCF).

## QC metrics

- **Peak count** — typical ranges: TF ChIP 10k–50k, H3K4me3 20k–40k, H3K27me3 broad domains fewer/wider
- **FRiP** (Fraction of Reads in Peaks) — >1% acceptable, >5% good. Low FRiP = poor enrichment
- **Peak width distribution** — narrow (TF, ATAC ~200–500bp) vs broad (H3K27me3, H3K9me3 kb-scale)
- **Signal-to-noise** — signalValue distribution; drop peaks below a fold-enrichment threshold

```python
print(f"n peaks: {len(df)}")
print(f"width: median={df.eval('end-start').median():.0f}bp")
print(f"signalValue: median={df.signalValue.median():.2f}")
```

## Consensus peaks (merging replicates)

Overlapping peaks across replicates must be merged into a consensus set:

```python
# Combine replicate peak sets, merge overlapping intervals
combined = pr.concat([rep1, rep2, rep3])
consensus = combined.merge()   # union of overlapping intervals
# Or require peaks present in ≥2 replicates:
consensus = combined.merge(count=True)
consensus = consensus[consensus.Count >= 2]
```

## Blacklist filtering

ENCODE blacklist regions (repetitive/artifact-prone) should be removed:

```python
blacklist = pr.read_bed("hg38-blacklist.v2.bed")
peaks_clean = peaks.overlap(blacklist, invert=True)
```

## Narrow vs broad peaks

- **Narrow** (MACS2 default): TF ChIP, ATAC, H3K4me3, H3K27ac — sharp summits
- **Broad** (MACS2 --broad): H3K27me3, H3K9me3, H3K36me3 — diffuse domains

Use the right mode; calling broad marks with narrow settings fragments the domains.

## Pitfalls

- **0-based vs 1-based confusion** — BED is 0-based; off-by-one shifts annotation
- **Not filtering blacklist** — artifact regions inflate peak counts and false positives
- **Not merging replicates** — replicate-specific peaks bias differential analysis
- **Wrong peak mode** — broad marks called as narrow gives fragmented peaks
- **Ignoring FRiP** — low-enrichment samples pollute the analysis

## Grounding

`report`: n peaks per sample, peak caller + settings, FRiP if available, consensus peak count, blacklist filtering applied, genome build.
