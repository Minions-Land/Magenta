---
name: proteomics
description: Proteomics analysis — plasma Olink targeted panels (NPX QC, paired within-subject differential expression), mass-spectrometry shotgun proteomics (MaxQuant/Perseus, log2-ratio tables), phosphoproteomics (activating-site filtering, occupancy), cross-cohort hypergeometric enrichment with correct universe, directional concordance, effect-size ranking. Use when the user has Olink NPX files, MaxQuant output, phosphoproteomics data, or asks to test differential protein expression, identify enriched pathways, or integrate proteomics with dependency/transcriptomics.
requiredTools: [run_python, bash, read, write, observe_figure]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, proteomics, olink, npx, mass-spec, maxquant, phosphoproteomics, differential-expression, hypergeometric, effect-size]
extends: omics-shared
---

# Proteomics — Olink & Mass-Spec Differential Expression

Proteomics analysis: parse Olink NPX (Normalized Protein eXpression) with QC flags, test paired within-subject differential expression, load MaxQuant/Perseus Excel outputs (multi-header parsing), run cross-cohort hypergeometric enrichment with explicitly-defined universes, assess directional concordance, and analyze phosphoproteomics (ActivatingSite filtering, occupancy). Builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply).

This is **NOT** single-cell CyTOF, **NOT** immunoassays (ELISA/Luminex raw OD), **NOT** ML training on protein features.

---

## Prerequisites

1. **Data format**: Olink NPX file (sample × protein, with QC columns), MaxQuant `proteinGroups.txt` or Perseus-exported Excel, or phosphoproteomics table
2. **Context**: sample metadata (timepoint, treatment, response) if testing paired or cross-cohort comparisons
3. **Universe definition**: for hypergeometric tests, the denominator (all proteins measured, or a biologically-defined background)

---

## Capability Menu

| Capability | Maturity | Tool/Method | Reference Doc |
|------------|----------|-------------|---------------|
| **Olink NPX** | | | |
| Load Olink NPX, parse QC flags (PASS/WARN/FAIL) | **REFERENCE** | `run_python` | `assets/references/olink_qc_de.md` |
| Handle LOD (limit of detection) values | **REFERENCE** | `run_python` | `assets/references/olink_qc_de.md` |
| Paired within-subject differential expression (t-test) | **REFERENCE** | `scipy.stats.ttest_rel` | `assets/references/olink_qc_de.md` |
| Effect-size ranking (by log2FC or t-statistic) | **REFERENCE** | `run_python` | `assets/references/effect_size.md` |
| **Mass-spec (MaxQuant/Perseus)** | | | |
| Load MaxQuant proteinGroups.txt | **REFERENCE** | `pandas` | `assets/references/mass_spec_de.md` |
| Parse Perseus multi-header Excel (skip metadata rows) | **REFERENCE** | `pandas.read_excel(header=[0,1])` | `assets/references/mass_spec_de.md` |
| Log2-ratio differential expression | **REFERENCE** | `run_python` | `assets/references/mass_spec_de.md` |
| **Phosphoproteomics** | | | |
| ActivatingSite filtering (kinase substrates) | **REFERENCE** | `run_python` | `assets/references/phosphoproteomics.md` |
| Phosphosite occupancy (phospho / total protein) | **REFERENCE** | `run_python` | `assets/references/phosphoproteomics.md` |
| **Cross-cohort enrichment** | | | |
| Hypergeometric enrichment with correct universe | **REFERENCE** | `scipy.stats.hypergeom` | `assets/references/cross_cohort.md` |
| Directional concordance (upregulated in both) | **REFERENCE** | `run_python` | `assets/references/cross_cohort.md` |
| **Visualization** | | | |
| Volcano plot (log2FC vs -log10 p) | **REFERENCE** | `matplotlib` | `../omics-shared/assets/references/visualization.md` |

**All capabilities are REFERENCE** because proteomics requires study-specific judgment: which QC flag to accept (PASS only vs PASS+WARN), how to handle LOD, which universe for enrichment, which effect-size threshold. These are deliberate design decisions, not black-box automation.

---

## Standard Workflow

### 1. Load & QC (Olink)

```python
import pandas as pd
olink = pd.read_csv("olink_npx.csv")
# Columns: SampleID, Assay (protein), NPX, QC_Warning, LOD

# Filter to PASS QC
olink_pass = olink[olink.QC_Warning == "PASS"]

# Pivot to matrix (samples × proteins)
npx_matrix = olink_pass.pivot(index="SampleID", columns="Assay", values="NPX")
```

### 2. Paired differential expression (Olink)

Timepoint 1 vs timepoint 2 (within-subject):

```python
from scipy.stats import ttest_rel
import numpy as np

# Split by timepoint
npx_t1 = npx_matrix.loc[samples_t1]
npx_t2 = npx_matrix.loc[samples_t2]

# Paired t-test per protein
results = []
for protein in npx_matrix.columns:
    stat, p = ttest_rel(npx_t1[protein], npx_t2[protein], nan_policy="omit")
    log2fc = (npx_t2[protein] - npx_t1[protein]).mean()  # NPX is already log2
    results.append({"protein": protein, "log2FC": log2fc, "t": stat, "p": p})
de = pd.DataFrame(results)
```

Apply FDR correction (BH):

```python
from statsmodels.stats.multitest import multipletests
de["padj"] = multipletests(de.p, method="fdr_bh")[1]
```

### 3. MaxQuant/Perseus loading

See `assets/references/mass_spec_de.md` for the multi-header Excel parsing recipe.

### 4. Cross-cohort hypergeometric

Two cohorts, both with DE results → test enrichment of upregulated proteins:

```python
from scipy.stats import hypergeom

# Cohort A: upregulated proteins (padj < 0.05, log2FC > 0.5)
up_A = set(de_A[(de_A.padj < 0.05) & (de_A.log2FC > 0.5)].protein)
# Cohort B: same
up_B = set(de_B[(de_B.padj < 0.05) & (de_B.log2FC > 0.5)].protein)

# Overlap
overlap = up_A & up_B

# Universe = all proteins measured in BOTH cohorts
universe = set(de_A.protein) & set(de_B.protein)
M = len(universe)    # total proteins
N = len(up_A)        # successes in cohort A
n = len(up_B)        # draws (cohort B up)
k = len(overlap)     # overlap

p = hypergeom.sf(k - 1, M, N, n)  # P(X ≥ k)
print(f"Overlap: {k} / {n} (p={p:.3e})")
```

See `assets/references/cross_cohort.md` for the full recipe + universe definition.

### 5. Effect-size ranking

Rank by **effect size** (log2FC or t-statistic), not p-value:

```python
de_ranked = de[de.padj < 0.05].sort_values("log2FC", key=abs, ascending=False)
top10 = de_ranked.head(10)
```

See `assets/references/effect_size.md`.

---

## Proteomics Best Practice (on top of omics-shared)

### 1. QC flags must be honored

Olink NPX with `QC_Warning != "PASS"` should be excluded or flagged. A WARN might be acceptable if the study tolerates it, but state the decision.

### 2. LOD (limit of detection) handling

Values below LOD are sometimes reported as `LOD - epsilon` or imputed. Document how you handle them (exclude, impute, or keep as-is with a note).

### 3. Paired tests for within-subject comparisons

Use `scipy.stats.ttest_rel` (paired t-test), not `ttest_ind` (independent). Within-subject comparisons (pre/post treatment, tumor/normal matched) have correlation.

### 4. Hypergeometric universe = proteins measured

The denominator is **all proteins measured in both cohorts**, not the full human proteome. A wrong universe inflates the enrichment p-value.

### 5. Directional concordance matters

Cross-cohort "overlap" means **directionally concordant** (both up or both down), not just significant in both. A protein up in cohort A and down in cohort B is a discordance, not a replicate.

### 6. Effect-size ranking before pathway interpretation

Rank by effect size (log2FC, t-statistic), not by p-value. A protein with log2FC=0.1 and p<1e-10 (from huge sample size) is less biologically interesting than log2FC=2.0 with p=0.01.

### 7. Phosphoproteomics = site-specific

Phosphoproteomics measures **phosphosites** (e.g., `TP53_S15`), not total protein. Activating sites (kinase substrates) are a small functional subset — filter before interpretation.

---

## Pitfalls

- **Not filtering by QC flag** — WARN/FAIL values degrade results
- **Unpaired test on paired data** — loses power, wrong test
- **Wrong hypergeometric universe** — using the full proteome instead of measured proteins
- **Ranking by p-value** — misses effect size; sample-size-driven significance
- **Not checking directional concordance** — conflating discordance with replication
- **MaxQuant multi-header not parsed** — reading the wrong row as header, scrambling column names
- **Phosphosite treated as gene** — `TP53_S15` ≠ TP53 total protein

---

## When Things Go Wrong

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| **Hypergeometric p=1.0** | Universe too large (full proteome used) | Restrict to measured proteins |
| **t-test gives weird results** | Used `ttest_ind` instead of `ttest_rel` | Use paired test for within-subject |
| **MaxQuant columns scrambled** | Multi-header Excel not parsed | Use `pd.read_excel(header=[0,1])` or skip rows |
| **Phosphosite enrichment weak** | No ActivatingSite filter | Filter to kinase substrates |
| **Low overlap in cross-cohort** | Different effect-size thresholds or FDR | Align cutoffs; check directional concordance |

---

## Evidence & Reporting

Every analysis emits:
- **Quantitative claims** → trailing JSON `report` with exact counts/p-values
- **Figures** → `observe_figure` before citing
- **Data provenance**: Olink panel name, MaxQuant version, n_samples, n_proteins measured
- **QC decision**: which flags accepted (PASS only vs PASS+WARN)
- **Test choice**: paired vs independent, one-sided vs two-sided
- **Universe definition**: for hypergeometric, the exact denominator

See reference docs for per-analysis reporting templates.
