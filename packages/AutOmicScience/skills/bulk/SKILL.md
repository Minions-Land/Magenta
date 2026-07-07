---
name: bulk
description: Bulk omics analysis (bulk RNA-seq, pseudobulk) — count-based differential expression (DESeq2 / edgeR / limma-voom), normalization (TMM / VST / logCPM), pathway enrichment (GSEA / ORA), co-expression networks (WGCNA). Use when the user has a bulk or pseudobulk gene-count matrix with sample metadata (not single-cell data) and asks for differential expression, enrichment, normalization, or co-expression analysis.
requiredTools: [run_python, bash, read, write, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, bulk, bulk-rna, rna-seq, differential-expression, deseq2, gsea, wgcna]
extends: omics-shared
---

# Bulk Omics Analysis

Bulk omics analysis routes through **modality-specific subskills**. This parent skill provides shared foundations and routing. All bulk work builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply).

---

## Routing: Which Subskill?

Identify the data type and read the appropriate subskill:

| Your data | Subskill | When to use |
|-----------|----------|-------------|
| **Bulk RNA-seq** (gene-count matrix) | `rna/SKILL.md` | Bulk or pseudobulk gene-count matrices with sample metadata. Count-based DE, normalization, GSEA/ORA, WGCNA. |
| **ChIP-seq / bulk ATAC-seq** (peak files) | `epigenomics/SKILL.md` | Peak BED files. Differential occupancy/accessibility, TSS annotation, histone-mark interpretation, TF footprinting. |

**Bulk vs single-cell:** if the data is a gene × sample count matrix (dozens of samples, not thousands of cells), it's bulk. If it's cells × genes with per-cell resolution, use the `single-cell` skill instead. Single-cell data summed to donor/group level (**pseudobulk**) is analyzed here with bulk methods.

After identifying the data type, **read the corresponding subskill** for detailed guidance. The subskills are chapters of this skill and cannot be invoked independently.

---

## Shared Bulk Foundations

These conventions apply across bulk analyses:

### 1. Counts-First Tabular Analysis

Bulk omics is **tabular** (a gene × sample matrix + a sample metadata table), not AnnData/scanpy. The core inputs:

1. A **raw integer count** matrix (genes × samples) — never start DE from TPM/FPKM/normalized values
2. A **sample metadata** table aligning each column to condition + covariates (batch, sex, age, RIN, …)

You can `omics_compute load_dataset` a count matrix into AnnData to reuse the grounded `enrichment` / `pathway_activity` subcommands, but the count-model steps (DE, normalization, WGCNA) are hand-written in `run_python` / `Rscript`.

### 2. Use Count-Based Statistical Models

- **DE model input** = raw counts → DESeq2/edgeR/limma-voom (negative-binomial / voom variance modeling)
- A Welch t-test or OLS on log-CPM is statistically weaker (ignores the count mean–variance relationship)
- **Normalization by goal**: VST/rlog for clustering/PCA; TMM+logCPM or size-factors for the DE model input; never z-score raw counts

### 3. Effect Size + Significance Are Separate Axes

- **Shrink fold changes** (apeglm/ashr) before ranking or GSEA — unshrunk LFC over-weights low-count genes
- When asked "which genes change most", rank by **shrunken |log2FC|** with an FDR gate, not by adjusted p
- Report both effect size and significance

### 4. Model Covariates in the Design

Batch/sex/age/RIN/library-prep/site when present — an unmodeled confound is the most common silent error. State the design formula.

### 5. State Your Conventions

Normalization, shrinkage estimator, ranking metric, FDR method, background universe — a result is only interpretable and reproducible alongside its method.

### 6. Evidence & Grounding (from omics-shared)

- Every quantitative claim → emit a trailing JSON `report` and cite exact numbers (log2FC, padj, NES, module sizes)
- Every plot (volcano/MA/heatmap) → `observe_figure` before it backs a claim

---

## Next Steps

Read the subskill matching your data type (currently: `rna/` for bulk RNA-seq, `epigenomics/` for ChIP-seq / bulk ATAC-seq). Follow its capability menu and method docs for the opinionated defaults, exact parameters, and failure modes.
