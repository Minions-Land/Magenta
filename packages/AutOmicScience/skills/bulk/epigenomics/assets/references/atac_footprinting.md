# Reference — ATAC-seq TF Footprinting

Detecting transcription-factor binding from ATAC-seq via footprint analysis — TF-bound sites show local signal depletion (protein occludes Tn5 cutting) flanked by high accessibility.

## The footprint signal

At a TF-bound motif:
- **Center** (motif): signal depletion (TF protein blocks Tn5 transposase)
- **Flanks** (±50bp): signal peaks (open chromatin around the binding site)

Footprint depth = center_depletion / flank_signal. Differential footprinting = differential TF activity.

## TOBIAS (standard tool)

TOBIAS: Transcription factor Occupancy prediction By Investigation of ATAC-seq Signal.

```bash
# 1. Bias correction (Tn5 cutting bias correction)
TOBIAS ATACorrect --bam condition1.bam --peaks consensus_peaks.bed \
  --genome hg38.fa --outdir corrected/

# 2. Footprint scoring
TOBIAS FootprintScores --signal corrected/condition1_corrected.bw \
  --regions consensus_peaks.bed --output footprints.bw

# 3. Differential footprinting (compare conditions)
TOBIAS BINDetect --motifs jaspar_motifs.txt \
  --signals corrected/cond1_corrected.bw corrected/cond2_corrected.bw \
  --peaks consensus_peaks.bed --outdir bindetect_out/ \
  --cond_names cond1 cond2

# Output: per-TF differential binding scores + p-values
```

TOBIAS BINDetect outputs a table: `TF_name`, `motif_score`, `footprint_depth_cond1`, `footprint_depth_cond2`, `log2FC`, `pvalue`.

## HINT-ATAC (alternative)

```bash
rgt-hint footprinting --atac-seq --paired-end --organism=hg38 \
  --output-location=. condition1.bam peaks.bed

rgt-motifanalysis matching --organism=hg38 \
  --input-files condition1_footprints.bed
```

HINT is faster but less granular than TOBIAS for differential analysis.

## Interpreting differential footprints

- **↑ footprint depth in condition A** → TF more active/bound in A
- **Motif present but no footprint** → motif not occupied (pioneer site, or TF not expressed)
- **Footprint without motif match** → composite/indirect binding, or low PWM score

Footprinting is **condition-specific** — a TF's expression must be high for binding to occur. Cross-check TF mRNA expression (bulk RNA-seq) to validate.

## Motif databases

- **JASPAR** (2024 release): curated vertebrate TFs
- **HOCOMOCO** (v11): human/mouse TF motifs
- **CIS-BP**: comprehensive, many species

Match the organism and version to the ATAC-seq genome build.

## Pitfalls

- **No bias correction** — Tn5 has sequence bias; raw signal gives false footprints
- **Comparing raw ATAC signal instead of footprints** — open region ≠ TF-bound; need the footprint shape
- **Motif match without expression check** — a motif is just sequence; the TF must be expressed
- **Using the wrong motif database version** — organism mismatch or outdated PWMs
- **Not validating differential footprinting with TF expression** — ↑ footprint + ↑ TF mRNA is stronger evidence than footprint alone

## Grounding

`report`: tool (TOBIAS / HINT), motif database + version, bias-correction applied, per-TF footprint scores + log2FC + p, TF expression validation (RNA-seq) if available, top differential TFs with motif examples.
