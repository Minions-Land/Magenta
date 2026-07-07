---
name: cancer-genomics
description: Tabular cancer genomics analysis — MAF/CNA somatic mutation and copy-number alteration parsing, variant classification (pathogenic/LoF vs benign), per-patient gene recurrence, tumor mutational burden (TMB), copy-number burden, pathway-alteration gene-set analysis, hotspot/protein-domain filtering, mutation×phenotype association (Fisher exact + FDR), oncoplots (maftools-style). Use when the user has MAF files, CNA segment files, or asks to analyze somatic mutations, identify recurrently altered genes, compute TMB, test mutation-phenotype associations, or generate oncoplots.
requiredTools: [run_python, bash, read, write, observe_figure, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, cancer, genomics, maf, cna, somatic-mutations, tmb, oncoplot, variant-classification, fisher-test]
extends: omics-shared
---

# Cancer Genomics — Tabular Somatic Mutation & CNA Analysis

Tabular cancer genomics: parse MAF (Mutation Annotation Format) and CNA (copy-number alteration) files, classify variants by pathogenicity, compute per-patient gene recurrence and TMB, identify hotspots and protein-domain enrichments, test mutation×phenotype associations with Fisher exact + FDR, and generate oncoplots. Builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply).

This is **NOT** germline GWAS, **NOT** WGS/WES alignment/calling (assumes MAF already generated), **NOT** ML training on mutation features.

---

## Prerequisites

1. **Data format**: MAF file (tab-delimited, standard TCGA/GDC columns) or CNA segment file
2. **Context**: `omics_compute summarize` on the MAF to thread sample counts + cancer types forward
3. **Clinical annotation**: patient metadata table (response, stage, survival) if testing associations

Standard MAF columns: `Hugo_Symbol`, `Chromosome`, `Start_Position`, `End_Position`, `Variant_Classification`, `Variant_Type`, `Tumor_Sample_Barcode`, `Protein_Change`, `HGVSp_Short`.

---

## Capability Menu

| Capability | Maturity | Tool/Method | Reference Doc |
|------------|----------|-------------|---------------|
| **Data loading & context** | | | |
| Load MAF → count variants, samples, genes | **READY** | `omics_compute load_dataset` | `assets/references/file_formats.md` |
| Summarize dataset (n_samples, n_variants, cancer distribution) | **READY** | `omics_compute summarize` | `../omics-shared/assets/references/data_context.md` |
| **Variant classification** | | | |
| Pathogenic variant filtering (CGC tiers 1/2, LoF, activating-mut) | **REFERENCE** | `run_python` | `assets/references/variant_classification.md` |
| Silent/benign exclusion | **REFERENCE** | `run_python` | `assets/references/variant_classification.md` |
| **Gene-level recurrence** | | | |
| Per-patient gene alteration (any pathogenic mut) | **REFERENCE** | `run_python` | `assets/references/recurrence.md` |
| Recurrence frequency ranking | **REFERENCE** | `run_python` | `assets/references/recurrence.md` |
| Minimum-support filtering (≥5 patients) | **REFERENCE** | `run_python` | `assets/references/recurrence.md` |
| **Mutation burden** | | | |
| TMB (tumor mutational burden: variants/Mb) | **REFERENCE** | `run_python` | `assets/references/tmb.md` |
| TMB distribution (median + IQR, not mean±SD) | **REFERENCE** | `run_python` | `assets/references/tmb.md` |
| **Copy-number analysis** | | | |
| CNA segment loading (chrom, start, end, log2ratio) | **REFERENCE** | `run_python` | `assets/references/cna.md` |
| Gene-level CN call (amp/gain/neutral/loss/del) | **REFERENCE** | `run_python` | `assets/references/cna.md` |
| CNA burden (fraction of genome altered) | **REFERENCE** | `run_python` | `assets/references/cna.md` |
| **Pathway & hotspot** | | | |
| Pathway-alteration frequency (gene-set any-hit) | **REFERENCE** | `run_python` | `assets/references/pathway_alteration.md` |
| Hotspot identification (recurrent protein position) | **REFERENCE** | `run_python` | `assets/references/hotspots.md` |
| Protein-domain filtering (e.g., ESR1 LBD 300–550) | **REFERENCE** | `run_python` | `assets/references/hotspots.md` |
| **Association testing** | | | |
| Mutation×phenotype Fisher exact + FDR | **REFERENCE** | `run_python` | `assets/references/association.md` |
| One-sided vs two-sided test selection | **REFERENCE** | `run_python` | `assets/references/association.md` |
| Minimum cell-count gate (expected ≥5) | **REFERENCE** | `run_python` | `assets/references/association.md` |
| **Visualization** | | | |
| Oncoplot (maftools-style heatmap) | **REFERENCE** | `run_python` (comut or custom matplotlib) | `assets/references/oncoplot.md` |
| TMB distribution histogram | **REFERENCE** | `run_python` | `../omics-shared/assets/references/visualization.md` |

**All capabilities are REFERENCE** (hand-rolled `run_python`) because mutation analysis requires study-specific judgment: which variants are pathogenic (CGC tiers, LoF rules), which genes belong to a pathway, which protein domains matter, Fisher test sidedness, FDR method. These are deliberate design decisions (like DE contrasts in bulk-RNA), not black-box automation.

---

## Standard Workflow

### 1. Load & summarize

```python
import pandas as pd
maf = pd.read_csv("data.maf", sep="\t", comment="#")
print(f"Loaded {len(maf)} variants from {maf.Tumor_Sample_Barcode.nunique()} samples")
# omics_compute summarize → thread context forward
```

### 2. Variant classification

Filter to pathogenic mutations. See `assets/references/variant_classification.md` for the CGC-based recipe and LoF rules.

```python
pathogenic = maf[maf.Variant_Classification.isin([
    "Missense_Mutation", "Nonsense_Mutation", "Frame_Shift_Del", 
    "Frame_Shift_Ins", "Splice_Site", "In_Frame_Del", "In_Frame_Ins"
])]
# Exclude Silent, Intron, 3'UTR, 5'UTR, IGR
```

### 3. Gene recurrence

Per-patient binary alteration matrix (gene × sample):

```python
recurrence = pathogenic.groupby(["Tumor_Sample_Barcode", "Hugo_Symbol"]).size().unstack(fill_value=0)
recurrence = (recurrence > 0).astype(int)  # binarize
gene_freq = recurrence.sum(axis=0) / len(recurrence)
top_genes = gene_freq.sort_values(ascending=False).head(20)
```

### 4. TMB computation

See `assets/references/tmb.md`:

```python
tmb = pathogenic.groupby("Tumor_Sample_Barcode").size() / 38  # 38 Mb = typical exome size
median_tmb = tmb.median()
iqr_tmb = tmb.quantile(0.75) - tmb.quantile(0.25)
print(f"TMB: median {median_tmb:.2f}, IQR {iqr_tmb:.2f} variants/Mb")
```

### 5. Association testing

Mutation×response Fisher exact:

```python
from scipy.stats import fisher_exact
gene_mut = recurrence["TP53"]  # binary
response = clinical["response"]  # "R" or "NR"
cont_table = pd.crosstab(gene_mut, response)
odds, p = fisher_exact(cont_table, alternative="two-sided")
print(f"TP53 vs response: OR={odds:.2f}, p={p:.3e}")
```

Apply FDR correction across all genes (Benjamini-Hochberg). See `assets/references/association.md`.

### 6. Oncoplot

```python
import matplotlib.pyplot as plt
from comut import CoMut  # or custom heatmap

# Top 20 genes × all samples, sorted by recurrence
top20 = recurrence[top_genes.index[:20]]
comat = CoMut()
comat.add_categorical_data(top20.T, name="Mutations", category_order=["TP53", "KRAS", ...])
comat.plot_comut(figsize=(12, 6))
plt.savefig("oncoplot.pdf", dpi=300, bbox_inches="tight")
```

`observe_figure` before citing it.

---

## Cancer Genomics Best Practice (on top of omics-shared)

### 1. Variant classification must be grounded

Don't invent pathogenicity rules — use CGC (Cancer Gene Census) tiers 1/2 for oncogenes/TSGs, or COSMIC hotspots, or ClinVar pathogenic. Document which classification you used.

### 2. TMB = median + IQR, not mean ± SD

TMB distribution is right-skewed (hypermutators). Report median and interquartile range.

### 3. Pathway alteration = any-hit gene-set

A pathway is "altered" if ≥1 gene in the set has a pathogenic mutation. Don't sum mutation counts — that double-counts patients with multiple hits.

### 4. Fisher test sidedness matters

- **Two-sided**: enrichment or depletion (most associations)
- **One-sided (`alternative="less"`)**: mutual exclusivity (e.g., KRAS/BRAF in melanoma)

Document which you used and why.

### 5. Minimum cell count for Fisher

Expected count ≥5 in all 2×2 cells, or use Fisher exact (not chi-squared). Filter out singleton-mutated genes before FDR correction.

### 6. Clinical variable normalization

- Collapse T1/T1a/T1b → T1; N0/Nx → N0. Use the coarsest available stage.
- Prefer pathologic (PATH_) over clinical (CLIN_) when both exist.
- Drop "Discrepancy" rows.

### 7. Every oncoplot → observe_figure

Never cite an oncoplot you didn't render and inspect.

---

## Pitfalls

- **Wrong variant-classification rule** — treating all Missense as pathogenic, or excluding Nonsense as "not interesting"
- **Silent mutations in TMB** — TMB should count only non-silent variants
- **Mean±SD for TMB** — distribution is skewed; use median+IQR
- **Summing pathway hits** — patient with TP53+MDM2 mutations counts once, not twice
- **Two-sided test for exclusivity** — mutual exclusivity needs `alternative="less"`
- **No minimum-support gate** — singleton genes inflate FDR family
- **Not collapsing stage substages** — T1a/T1b/T1c as separate categories loses power
- **Clinical variable leakage** — keeping "Discrepancy" rows or mixing PATH/CLIN
- **Ungrounded oncoplot** — citing a figure you didn't `observe_figure`

---

## When Things Go Wrong

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| **Recurrence looks wrong** | Silent variants not excluded | Filter to pathogenic only (see variant_classification.md) |
| **Fisher p-values all 1.0** | Wrong contingency table | Check crosstab orientation; ensure binary gene_mut |
| **TMB outliers dominate** | Using mean instead of median | Report median + IQR |
| **Pathway frequency > 100%** | Summing instead of any-hit | Use `.any()` not `.sum()` |
| **Oncoplot shows "?" for genes** | Gene name mismatch (HGNC vs alias) | Standardize to HGNC symbols before plotting |

---

## Evidence & Reporting

Every analysis emits:
- **Quantitative claims** → trailing JSON `report` with exact counts/p-values
- **Figures** → `observe_figure` before citing
- **MAF provenance**: source (TCGA/GDC/local), n_samples, n_variants, cancer types
- **Variant-classification rule**: which pathogenicity criteria (CGC/COSMIC/ClinVar)
- **Association test**: Fisher sidedness, FDR method, minimum-support gate

See reference docs for per-analysis reporting templates.
