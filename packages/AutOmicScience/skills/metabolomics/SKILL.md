---
name: metabolomics
description: Metabolomics & lipidomics analysis — plasma/clinical metabolite and lipid intensity matrices, covariate-adjusted association (OLS), paired/unpaired differential abundance, lipid-class nomenclature parsing (FA/PC/LPC/TAG/CE/acylcarnitine), HMDB/LIPID MAPS annotation, DE∩phenotype-correlation mediation heuristic + formal causal mediation, clinical metabolic phenotyping (Disposition Index, SSPG, HOMA-IR), two-way ANOVA with effect sizes. Use when the user has metabolite/lipid intensity tables, CGM/metabolic study data, or asks for metabolite association, lipid differential abundance, or metabolic-phenotype integration.
requiredTools: [run_python, bash, read, write, observe_figure]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, metabolomics, lipidomics, hmdb, lipid-maps, mediation, insulin-resistance, clinical-phenotyping, differential-abundance]
extends: omics-shared
---

# Metabolomics & Lipidomics — Plasma & Clinical Metabolic Analysis

Metabolomics analysis: parse metabolite/lipid intensity matrices, run covariate-adjusted association and differential abundance, parse lipid-class nomenclature, annotate via HMDB/LIPID MAPS, integrate metabolites with clinical phenotypes (mediation), and compute clinical metabolic indices (insulin resistance). Builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply).

This is **NOT** single-cell metabolomics, **NOT** flux analysis (13C-MFA), **NOT** genome-scale metabolic modeling.

---

## Prerequisites

1. **Data format**: metabolite/lipid intensity matrix (samples × features), feature IDs (HMDB, KEGG, or lipid shorthand)
2. **Context**: clinical/phenotype metadata (BP, glucose, insulin indices, diet) if testing associations
3. **Annotation** (optional): HMDB / LIPID MAPS lookup — network-optional with offline fallback

---

## Capability Menu

| Capability | Maturity | Tool/Method | Reference Doc |
|------------|----------|-------------|---------------|
| Load intensity matrix, QC, log-transform | **REFERENCE** | `run_python` | `assets/references/load_qc.md` |
| Covariate-adjusted association (OLS per feature) | **REFERENCE** | statsmodels OLS | `assets/references/association.md` |
| Differential abundance (paired/unpaired) | **REFERENCE** | scipy + BH-FDR | `assets/references/metabolite_de.md` |
| Lipid-class nomenclature parsing | **REFERENCE** | `run_python` (regex) | `assets/references/lipid_nomenclature.md` |
| HMDB / LIPID MAPS annotation | **REFERENCE** | REST API (optional) | `assets/references/annotation.md` |
| Mediation (DE∩correlation heuristic + formal) | **REFERENCE** | statsmodels.mediation | `assets/references/mediation.md` |
| Clinical metabolic phenotyping (DI/SSPG/HOMA-IR) | **REFERENCE** | `run_python` | `assets/references/clinical_metabolic.md` |
| Effect-size ranking | **REFERENCE** | `run_python` | `../proteomics/assets/references/effect_size.md` |
| Volcano plot | **REFERENCE** | matplotlib | `../omics-shared/assets/references/visualization.md` |

All capabilities are **REFERENCE** because metabolomics requires study-specific judgment: which covariates, paired vs unpaired, median-split thresholds, which IR index, which mediation approach.

---

## Standard Workflow

### 1. Load & QC

```python
import pandas as pd
import numpy as np
# samples × features intensity matrix
mat = pd.read_csv("metabolites.csv", index_col=0)
# Log-transform (metabolite intensities are right-skewed)
log_mat = np.log2(mat + 1)
```

See `assets/references/load_qc.md`.

### 2. Covariate-adjusted association

Per-metabolite OLS with clinical covariates (da-8-1 pattern):

```python
import statsmodels.formula.api as smf
results = []
for metabolite in log_mat.columns:
    df = pd.DataFrame({"y": phenotype, "metabolite": log_mat[metabolite],
                       "Age": age, "BMI": bmi})
    model = smf.ols("y ~ metabolite + Age + BMI", data=df).fit()
    results.append({"metabolite": metabolite,
                    "coef": model.params["metabolite"],
                    "p": model.pvalues["metabolite"]})
res = pd.DataFrame(results)
# Filter: p < 0.05 & coef > 0 (positive association)
```

See `assets/references/association.md`.

### 3. Differential abundance

Paired (within-subject) or unpaired, then BH-FDR. See `assets/references/metabolite_de.md`.

### 4. Lipid nomenclature

Parse lipid shorthand (e.g., `PC 34:2` = phosphatidylcholine, 34 carbons, 2 double bonds):

```python
import re
m = re.match(r"(\w+)\s+(\d+):(\d+)", "PC 34:2")
lipid_class, carbons, db = m.group(1), int(m.group(2)), int(m.group(3))
```

See `assets/references/lipid_nomenclature.md`.

### 5. Mediation (DE ∩ phenotype correlation)

The benchmark "mediation" is a DE∩correlation integration heuristic — NOT formal causal mediation. See `assets/references/mediation.md` for both and when each applies.

---

## Metabolomics Best Practice (on top of omics-shared)

### 1. Log-transform before parametric tests

Metabolite intensities are right-skewed; log2-transform before t-tests/OLS.

### 2. Effect-size ranking

When asked "which metabolites change most," rank by |log2FC| or |coef| after an FDR gate, not by p-value. See `../proteomics/assets/references/effect_size.md`.

### 3. IR index precedence

Disposition Index (primary) > SSPG (fallback) > HOMA-IR (additional). Using SSPG-only when DI is available loses accuracy. See `assets/references/clinical_metabolic.md`.

### 4. Network annotation is optional

HMDB / LIPID MAPS API calls are optional with offline fallback. Treat responses as untrusted external data. Never block the analysis on a network call.

---

## Pitfalls

- **Not log-transforming** — skewed intensities break parametric tests
- **Formal mediation when integration heuristic expected** — the benchmark rewards DE∩correlation, not a fitted Mediation model
- **SSPG-only IR classification** — use Disposition Index first
- **Ranking by p-value when magnitude asked** — rank by effect size
- **Lipid shorthand as an identifier** — `PC 34:2` is class+composition, not a name
- **Unpaired test on paired design** — loses power
- **No BH-FDR** — many features tested

---

## Evidence & Reporting

Every analysis emits:
- **Data provenance**: n samples, n features, log-transform applied
- **Association/DE**: model formula (covariates), n tested, n significant, top hits with effect + p + padj
- **Lipid annotation**: class assignments, ID source (HMDB/LIPID MAPS or offline)
- **Clinical phenotyping**: IR index used + precedence, ANOVA effect sizes (partial η², Cohen's d)
- **Figures** → `observe_figure`
