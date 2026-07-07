---
name: microbiome
description: Microbiome analysis — 16S rRNA amplicon (OTU/ASV tables) and shotgun metagenomic taxonomic/functional abundance profiles, CLR transformation, alpha/beta diversity, differential abundance (DESeq2/ANCOM/ALDEx2), taxonomy filtering, survival integration. Use when the user has microbial abundance tables (taxa × samples), asks for diversity analysis, taxon differential abundance, or microbiome-phenotype association.
requiredTools: [run_python, bash, read, write, observe_figure]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, microbiome, 16S, metagenomics, taxonomy, diversity, clr, differential-abundance, ancom, aldex2]
extends: omics-shared
---

# Microbiome Analysis — 16S & Metagenomics

Microbiome analysis: parse 16S OTU/ASV or metagenomic taxonomic abundance tables, apply CLR transformation, compute alpha/beta diversity, test differential abundance (DESeq2/ANCOM/ALDEx2), integrate with clinical phenotypes (Cox survival, correlation). Builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply).

This is **NOT** assembly/binning, **NOT** functional annotation (KEGG/MetaCyc pathways are out of scope for this lightweight skill).

---

## Prerequisites

1. **Data format**: taxa × samples abundance matrix (counts or relative abundance), taxonomy table (Kingdom→Species)
2. **Context**: sample metadata (condition, patient ID, clinical covariates) for differential/association tests
3. **Library**: `scikit-bio` (diversity), `pydeseq2` (DE), or R via rpy2 (`DESeq2`, `ALDEx2`, `ANCOM`)

---

## Capability Menu

| Capability | Maturity | Tool/Method | Reference Doc |
|------------|----------|-------------|---------------|
| Load abundance table, taxonomy filtering | **REFERENCE** | `run_python` | `assets/references/abundance_loading.md` |
| CLR transformation | **REFERENCE** | scipy / compositions | `assets/references/abundance_loading.md` |
| Alpha diversity (Shannon, Chao1, Faith PD) | **REFERENCE** | scikit-bio | `assets/references/diversity.md` |
| Beta diversity (Bray-Curtis, UniFrac) + PCoA | **REFERENCE** | scikit-bio | `assets/references/diversity.md` |
| Differential abundance (DESeq2 / ANCOM / ALDEx2) | **REFERENCE** | pydeseq2 / R via rpy2 | `assets/references/differential_abundance.md` |
| Taxon-phenotype association (Cox survival) | **REFERENCE** | lifelines CoxPHFitter | `../clinical-survival/assets/references/cox_ph.md` |

All capabilities are **REFERENCE** because microbiome analysis requires study-specific judgment: taxonomy filtering (prevalence thresholds, low-count taxa), rarefaction vs CLR, which diversity metric, which DA method (compositional vs count-based).

---

## Standard Workflow

### 1. Load abundance table

```python
import pandas as pd
# taxa (rows) × samples (cols) — counts or relative abundance
abundance = pd.read_csv("otu_table.csv", index_col=0)
# Taxonomy table: OTU_ID → Kingdom, Phylum, Class, Order, Family, Genus, Species
taxonomy = pd.read_csv("taxonomy.csv", index_col=0)
```

### 2. Filter low-prevalence taxa

```python
# Keep taxa present in ≥10% of samples
prevalence_threshold = 0.1
keep = (abundance > 0).sum(axis=1) >= len(abundance.columns) * prevalence_threshold
abundance_filt = abundance.loc[keep]
```

### 3. CLR transformation (compositional data)

```python
import numpy as np
from scipy.stats.mstats import gmean

def clr_transform(counts):
    # Add pseudocount, compute geometric mean, log-ratio
    counts_pseudo = counts + 1
    gm = gmean(counts_pseudo, axis=0)
    return np.log(counts_pseudo / gm)

clr_abundance = clr_transform(abundance_filt.values)
```

See `assets/references/abundance_loading.md`.

### 4. Alpha diversity

```python
from skbio.diversity import alpha_diversity
shannon = alpha_diversity('shannon', abundance_filt.T)  # samples in rows
# Compare between groups
from scipy.stats import mannwhitneyu
stat, p = mannwhitneyu(shannon[group1], shannon[group2])
```

### 5. Differential abundance

```python
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

metadata = pd.DataFrame({"condition": conditions}, index=abundance_filt.columns)
dds = DeseqDataSet(counts=abundance_filt.T, metadata=metadata, design_factors="condition")
dds.deseq2()
stat = DeseqStats(dds, contrast=["condition", "disease", "healthy"])
res = stat.summary()
# res: baseMean, log2FoldChange, pvalue, padj (per taxon)
```

See `assets/references/differential_abundance.md`.

---

## Microbiome Best Practice (on top of omics-shared)

### 1. Compositional data requires CLR

Microbiome counts are compositional (sum-to-1 constraint). Raw counts violate independence assumptions. **CLR transformation** (centered log-ratio) is the standard for parametric tests. Rarefaction (subsampling to even depth) is deprecated for DE.

### 2. Prevalence filtering

Low-prevalence taxa (present in <10% of samples) are noise. Filter before DE to reduce multiple-testing burden.

### 3. Taxonomy level matters

Analyze at the finest reliable level (usually Genus or Species for 16S; Species for shotgun). Aggregating to Phylum loses signal.

### 4. Zero-inflation

Many taxa are absent (true zeros) or undetected (sampling zeros). DESeq2 handles this via negative-binomial. ANCOM/ALDEx2 are compositionally-aware alternatives.

### 5. Batch effects (sequencing run, DNA extraction kit)

Microbiome data is highly batch-sensitive. Include `batch` as a covariate in the design, or use ComBat-seq for correction.

---

## Pitfalls

- **Not CLR-transforming for parametric tests** — raw counts violate assumptions
- **No prevalence filter** — testing thousands of rare taxa inflates FDR
- **Wrong taxonomy level** — Phylum-level DE loses Genus/Species signal
- **Rarefaction for DE** — deprecated; loses information
- **Ignoring batch effects** — sequencing run dominates biological signal
- **Treating absence as zero abundance** — absence may be biological or technical

---

## Evidence & Reporting

Every analysis emits:
- **Data**: n samples, n taxa (before/after filtering), taxonomy level, sequencing depth per sample
- **Transformation**: CLR / log+pseudocount / raw counts (state which)
- **Diversity**: alpha metric + group comparison (stat + p), beta metric + PERMANOVA
- **DA**: method (DESeq2/ANCOM/ALDEx2), n tested, n significant (padj<0.05), top taxa with log2FC + padj
- **Figures** → `observe_figure`

See reference docs for per-analysis reporting templates.
