---
name: bulk-epigenomics
disable-model-invocation: true
---

# Bulk Epigenomics — ChIP-seq & ATAC-seq Peak Analysis

> Subskill of `bulk`. Enter here from the parent skill when the data is bulk ChIP-seq or ATAC-seq peak files (BED format). Read `../SKILL.md` (parent) and `../../omics-shared/SKILL.md` first — their evidence/grounding rules apply here.

This subskill covers **bulk epigenomic assays**: ChIP-seq (histone marks, TF binding), bulk ATAC-seq (chromatin accessibility), differential peak occupancy/accessibility, TSS annotation, enhancer calling, and TF footprinting. **NOT single-cell chromatin (scATAC-seq)** — that's in `single-cell/atac`.

---

## Prerequisites

1. **Data format**: peak BED files (chr, start, end, name, score) from MACS2/HOMER/Genrich, or count matrices (peaks × samples)
2. **Genome annotation**: GTF/GFF for TSS extraction, gene annotation
3. **Context**: sample metadata (condition, replicate) for differential occupancy

---

## Capability Menu

| Capability | Maturity | Tool/Method | Reference Doc |
|------------|----------|-------------|---------------|
| BED peak loading & QC | **REFERENCE** | pybedtools / pyranges | `assets/references/peak_loading.md` |
| Differential occupancy (peak DE) | **REFERENCE** | DiffBind / pydeseq2 on peak counts | `assets/references/differential_occupancy.md` |
| TSS annotation & distance | **REFERENCE** | ChIPseeker / pyranges + GTF | `assets/references/tss_annotation.md` |
| Histone mark interpretation | **REFERENCE** | domain knowledge | `assets/references/histone_marks.md` |
| ATAC TF footprinting | **REFERENCE** | TOBIAS / HINT-ATAC | `assets/references/atac_footprinting.md` |

All capabilities are **REFERENCE** (hand-rolled `run_python` or R via rpy2) because peak analysis requires study-specific judgment: which peaks to merge, how to define promoters vs enhancers, which distance bands matter, TSS precedence rules.

---

## Standard Workflow

### 1. Load peaks (BED)

```python
import pyranges as pr
peaks = pr.read_bed("peaks.bed")  # chr, start, end, name, score
print(f"{len(peaks)} peaks loaded")
```

### 2. Differential occupancy

Count reads in peaks per sample, then DESeq2:

```bash
bedtools multicov -bams sample1.bam sample2.bam ... -bed peaks.bed > counts.txt
```

```python
import pandas as pd
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

counts = pd.read_csv("counts.txt", sep="\t", header=None, 
                     names=["chr","start","end","name","score"] + sample_names)
counts = counts.set_index("name")[sample_names]  # peaks × samples

dds = DeseqDataSet(counts=counts, metadata=metadata, design_factors="condition")
dds.deseq2()
stat = DeseqStats(dds, contrast=["condition", "treated", "control"])
res = stat.summary()
# res: log2FoldChange, padj
```

See `assets/references/differential_occupancy.md`.

### 3. TSS annotation

Annotate each peak to its nearest gene TSS:

```python
import gtfparse
gtf = gtfparse.read_gtf("genes.gtf")
tss = gtf[gtf.feature == "transcript"].copy()
tss["tss"] = tss.apply(lambda r: r.start if r.strand=="+" else r.end, axis=1)
tss_gr = pr.PyRanges(chromosomes=tss.seqname, starts=tss.tss, ends=tss.tss+1, 
                     gene_name=tss.gene_name)

# Nearest TSS per peak
peaks_with_tss = peaks.nearest(tss_gr, suffix="_tss")
# distance = peaks.Start - tss.Start (signed)
```

See `assets/references/tss_annotation.md`.

---

## Epigenomics Best Practice (on top of omics-shared)

### 1. Histone mark interpretation

- **H3K4me3**: active promoters (mark TSS ±1kb)
- **H3K27ac**: active enhancers (distal >3kb from TSS)
- **H3K27me3**: repressed/poised (Polycomb, often developmental genes)
- **H3K36me3**: gene-body mark (elongation)

Differential H3K4me3 = differential promoter activity. See `assets/references/histone_marks.md`.

### 2. Promoter vs enhancer distance bands

- **Promoter**: TSS ±3kb
- **Proximal**: 3–10 kb
- **Distal/enhancer**: >10 kb

Report the distribution, not just "nearest gene."

### 3. Peak merging across replicates

Merge overlapping peaks (bedtools merge) before differential analysis to avoid replicate-driven false positives.

### 4. ATAC footprinting for TF activity

ATAC signal has a **TF footprint** (depletion at the motif center, flanked by high signal). TOBIAS / HINT-ATAC detect these. Differential footprinting = differential TF activity.

---

## Pitfalls

- **Not merging replicate peaks** — overlapping peaks counted multiple times
- **Wrong distance metric** — unsigned distance loses promoter vs downstream distinction
- **Promoter = gene start** — TSS varies by strand; always use strand-aware TSS
- **No FDR** — testing thousands of peaks needs BH correction
- **Histone mark misinterpretation** — H3K27me3 ≠ active; it's repressive

---

## Evidence & Reporting

Every analysis emits:
- **Peak provenance**: caller (MACS2 q<0.05?), n peaks, genome build
- **Differential occupancy**: n tested, n significant (padj<0.05), top hits with log2FC
- **TSS annotation**: per-peak distance, promoter/enhancer classification distribution
- **Figures** → `observe_figure`

See reference docs for per-analysis reporting templates.
