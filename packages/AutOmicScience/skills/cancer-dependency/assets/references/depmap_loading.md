# Reference — DepMap Data Loading & Context

DepMap (Dependency Map) is a large-scale CRISPR knockout screen across ~1,000 cancer cell lines. Understanding the data structure and lineage metadata.

## DepMap file structure

DepMap releases (quarterly at depmap.org) include:

| File | Content |
|------|---------|
| `CRISPR_gene_effect.csv` | Gene-effect scores (genes × cell lines), Chronos/CERES algorithm |
| `sample_info.csv` | Cell-line metadata (lineage, cancer type, sex, primary/metastatic) |
| `CCLE_mutations.csv` | MAF-like somatic mutations |
| `CCLE_expression.csv` | RNA-seq TPM (genes × cell lines) |
| `Achilles_gene_dependency.csv` | Legacy (pre-Chronos), same structure |

## Gene-effect matrix

```python
import pandas as pd
gene_effect = pd.read_csv("CRISPR_gene_effect.csv", index_col=0)
# Shape: ~18,000 genes × ~1,000 cell lines
# Values: gene-effect scores, typically −2 to +0.5
```

**Sign convention:**
- **Negative = lethal** (CRISPR knockout reduces fitness)
- **0 = no effect** (knockout is neutral)
- **Positive = beneficial** (rare; knockout enhances growth)

A score of −1.0 ≈ complete lethality (like a known essential gene). A score of −0.5 is the standard "dependency" threshold.

## Cell-line metadata

```python
meta = pd.read_csv("sample_info.csv")
# Key columns: DepMap_ID, stripped_cell_line_name, lineage, primary_disease, sex
```

**Lineage** is the tissue/organ of origin: lung, breast, pancreas, hematopoietic_and_lymphoid_tissue, …

**DepMap_ID** (e.g., `ACH-000001`) is the join key to gene-effect columns.

## Mapping cell lines to cancer types

```python
# Subset to a cancer type
breast_lines = meta[meta.lineage == "breast"].DepMap_ID
breast_gene_effect = gene_effect[breast_lines]
```

Or by `primary_disease` for finer granularity (e.g., "Lung Adenocarcinoma" vs "Lung Squamous Cell Carcinoma").

## Context threading

Use `omics_compute summarize` on the gene-effect matrix to emit counts:

```python
# report: n_genes, n_lines, n_lineages, top lineages by line count
```

Thread forward: "DepMap 24Q2, 18,333 genes × 1,086 cell lines, 38 lineages."

## Gene naming

DepMap uses **HGNC gene symbols**. Some rows have `(id)` suffixes for paralogs (e.g., `HLA-A (id)` vs `HLA-A`). Strip or disambiguate:

```python
gene_effect.index = gene_effect.index.str.replace(r" \(.*\)", "", regex=True)
```

## Chronos vs CERES

- **Chronos** (current, 21Q2+): improved algorithm, corrects copy-number confounds
- **CERES** (legacy): older algorithm, still in `Achilles_gene_dependency.csv`

Prefer Chronos (`CRISPR_gene_effect.csv`) for new analyses.

## Pitfalls

- **Sign confusion** — positive = beneficial (rare), negative = lethal
- **Not joining on DepMap_ID** — cell-line names have aliases; use the canonical ID
- **Lineage too coarse** — "blood" includes ALL leukemias/lymphomas; use `primary_disease` if finer resolution needed
- **Not filtering unmapped genes** — some rows are retired symbols; validate against HGNC

## Grounding

`report`: DepMap version (e.g., 24Q2), n_genes, n_lines, lineage distribution, any subsetting applied.
