# Reference — Copy Number Alteration (CNA)

Copy-number analysis: GISTIC discrete calls, segment-to-gene mapping, amplification/deletion thresholds, and the critical mutation-vs-CNA distinction.

## GISTIC discrete scale

The standard cBioPortal CNA matrix (gene × sample) uses GISTIC 2.0 discrete values:

| Value | Meaning |
|-------|---------|
| **+2** | Amplification (high-level) |
| **+1** | Gain (low-level) |
| **0** | Neutral (diploid) |
| **−1** | Shallow loss (heterozygous) |
| **−2** | Deep deletion (homozygous) |

**Thresholds for "altered":**
```python
cna = pd.read_csv("data_cna.txt", sep="\t", index_col=0)  # genes × samples

amplified = (cna == 2)      # high-level amplification only
deleted = (cna == -2)       # deep (homozygous) deletion only
# Low-level gain/loss (±1) usually NOT counted as "altered" unless specified
```

For oncogenes, amplification (+2) is the driver event. For tumor suppressors, deep deletion (−2) is the driver.

## The mutation-vs-amplification distinction (critical)

**ERBB2 mutation ≠ ERBB2 amplification.** These are separate alteration axes:
- **Mutation** comes from the MAF (point mutations, indels)
- **Amplification** comes from the CNA matrix (GISTIC +2)

A rubric will explicitly grade whether you separated them (da-18-1). ERBB2 (HER2) is amplified in ~15-20% of breast cancers — a targetable event distinct from the rarer ERBB2 point mutations.

```python
# WRONG: treating any ERBB2 event as one thing
erbb2_altered = mut_altered["ERBB2"] | cna_altered["ERBB2"]

# RIGHT: separate axes, per-gene rule
erbb2_mutation = mut_pathogenic["ERBB2"]        # from MAF
erbb2_amplification = (cna.loc["ERBB2"] == 2)   # from CNA matrix
# HER2+ clinical status is driven by AMPLIFICATION, not mutation
```

## Segment file → gene-level calls

If given a segment file (chrom, start, end, log2ratio) instead of a gene matrix:

```python
seg = pd.read_csv("segments.seg", sep="\t")
# columns: ID, chrom, loc.start, loc.end, seg.mean (log2 ratio)

# log2 ratio thresholds (approximate, ploidy-dependent):
#   > 0.3  → gain
#   > 0.9  → amplification (roughly 4+ copies)
#   < -0.3 → loss
#   < -1.3 → deep deletion

# Map a gene to segments overlapping its coordinates:
def gene_cn(gene_chrom, gene_start, gene_end, seg):
    overlapping = seg[
        (seg.chrom == gene_chrom) &
        (seg["loc.start"] <= gene_end) &
        (seg["loc.end"] >= gene_start)
    ]
    return overlapping["seg.mean"].mean()  # or length-weighted mean
```

Gene coordinates come from a reference (e.g., UCSC refGene, GENCODE).

## CNA burden (fraction of genome altered)

A sample-level summary metric:

```python
# From segments: fraction of genome with |log2ratio| > threshold
seg["length"] = seg["loc.end"] - seg["loc.start"]
altered_length = seg[seg["seg.mean"].abs() > 0.3]["length"].sum()
total_length = seg["length"].sum()
fga = altered_length / total_length   # Fraction of Genome Altered
```

FGA correlates with chromosomal instability (CIN) and can be a prognostic marker.

## Pitfalls

- **Conflating mutation and amplification** — the most-graded CNA error (da-18-1)
- **Counting ±1 as altered** — low-level gain/loss is usually noise; use ±2 for high-confidence calls
- **Wrong matrix orientation** — cBioPortal CNA is genes × samples; verify with `.shape` and index
- **Segment overlap not length-weighted** — a gene spanning two segments needs weighted averaging
- **Applying log2 thresholds without ploidy correction** — aneuploid tumors shift the baseline

## Grounding

`report` with: CNA source (GISTIC matrix vs segments), thresholds used, per-gene alteration calls with counts, FGA if computed.
