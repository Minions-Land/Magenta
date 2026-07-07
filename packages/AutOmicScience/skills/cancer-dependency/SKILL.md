---
name: cancer-dependency
description: Cancer functional genomics & dependency analysis — DepMap/CCLE CRISPR gene-effect screens (dependency scoring, normLRT selective-dependency test), Pharos druggability annotations (Tclin/Tchem/Tbio/Tdark tiers), therapeutic-window prioritization, synthetic lethality discovery (mutual-exclusivity Fisher test, paralog/PPI priors, BRCA-PARP canonical pairs), multi-omic integration (dependency + phosphoproteomics/expression/MAF). Use when the user has DepMap data, asks to identify druggable dependencies, selective vulnerabilities, synthetic-lethal gene pairs, or integrate dependency screens with other omics.
requiredTools: [run_python, bash, read, write]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, cancer, dependency, depmap, ccle, crispr, druggability, pharos, synthetic-lethality, normLRT]
extends: omics-shared
---

# Cancer Dependency — DepMap & Druggability Analysis

Cancer dependency analysis: parse DepMap/CCLE CRISPR gene-effect screens, identify selective dependencies vs pan-essential genes, test selective-dependency with normLRT, annotate druggability (Pharos/TTD), apply therapeutic-window prioritization, discover synthetic-lethal pairs via mutual-exclusivity + paralog/PPI priors, and integrate with phosphoproteomics/expression/MAF. Builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply).

This is **NOT** GWAS, **NOT** germline genetics, **NOT** ML training on dependency features.

---

## Prerequisites

1. **Data format**: DepMap CRISPR gene-effect matrix (genes × cell lines, Chronos/CERES scores), or pre-computed dependency calls
2. **Context**: cell-line metadata (cancer type, lineage, mutation status) if testing selective dependencies
3. **Druggability sources**: Pharos (API or download), Therapeutic Target Database (TTD), or DrugBank

DepMap releases quarterly at depmap.org. Standard file: `CRISPR_gene_effect.csv` (genes × cell lines, values ≈ −1 to +0.5).

---

## Capability Menu

| Capability | Maturity | Tool/Method | Reference Doc |
|------------|----------|-------------|---------------|
| **Dependency scoring** | | | |
| Load DepMap gene-effect matrix | **REFERENCE** | `pandas` | `assets/references/depmap_loading.md` |
| Binary dependency call (< −0.5 threshold) | **REFERENCE** | `run_python` | `assets/references/dependency_analysis.md` |
| Pan-essentiality filtering (≥90% lines dependent) | **REFERENCE** | `run_python` | `assets/references/dependency_analysis.md` |
| **Selective dependency** | | | |
| normLRT selective-dependency test | **REFERENCE** | `scipy.stats` | `assets/references/dependency_analysis.md` |
| Per-cancer-type dependency frequency | **REFERENCE** | `run_python` | `assets/references/dependency_analysis.md` |
| **Druggability** | | | |
| Pharos target annotation (Tclin/Tchem/Tbio/Tdark) | **REFERENCE** | Pharos API / download | `assets/references/druggability.md` |
| Therapeutic-window prioritization (dependent + druggable) | **REFERENCE** | `run_python` | `assets/references/druggability.md` |
| **Synthetic lethality** | | | |
| Mutual-exclusivity Fisher test (one-sided) | **REFERENCE** | `scipy.stats.fisher_exact` | `assets/references/synthetic_lethality.md` |
| Paralog prior (Ensembl BioMart) | **REFERENCE** | BioMart API / download | `assets/references/synthetic_lethality.md` |
| PPI prior (STRING) | **REFERENCE** | STRING API / download | `assets/references/synthetic_lethality.md` |
| Canonical BRCA-PARP pairs | **REFERENCE** | literature / curated list | `assets/references/synthetic_lethality.md` |
| **Multi-omic integration** | | | |
| Dependency + phosphoproteomics (activating-site upregulated + dependent) | **REFERENCE** | `run_python` | `assets/references/integration.md` |
| Dependency + expression (overexpressed + dependent) | **REFERENCE** | `run_python` | `assets/references/integration.md` |
| Dependency + MAF (mutated + paralog-dependent) | **REFERENCE** | `run_python` | `assets/references/integration.md` |

**All capabilities are REFERENCE** because dependency analysis requires study-specific judgment: dependency threshold (−0.5 vs −0.6), which cancer types to test, which druggability tier is "actionable," which priors to apply for synthetic lethality. These are design decisions.

---

## Standard Workflow

### 1. Load DepMap gene-effect

```python
import pandas as pd
gene_effect = pd.read_csv("CRISPR_gene_effect.csv", index_col=0)
# genes × cell lines, lower = more dependent (negative = lethal)
```

### 2. Binary dependency calls

Threshold = −0.5 (DepMap standard for "likely essential"):

```python
dependent = (gene_effect < -0.5).astype(int)
# genes × cell lines boolean matrix
```

### 3. Pan-essentiality filter

Remove genes essential in ≥90% of lines (housekeeping, not targetable):

```python
pan_essential_freq = dependent.mean(axis=1)
selective_genes = pan_essential_freq[pan_essential_freq < 0.9].index
```

### 4. Selective-dependency test (normLRT)

Is gene X more essential in cancer type A than in others?

```python
from scipy.stats import norm
import numpy as np

def normLRT(gene, cancer_lines, other_lines):
    scores_cancer = gene_effect.loc[gene, cancer_lines].dropna()
    scores_other = gene_effect.loc[gene, other_lines].dropna()
    # Likelihood ratio: cancer-specific mean vs pooled mean
    mu_c = scores_cancer.mean()
    mu_o = scores_other.mean()
    mu_pooled = pd.concat([scores_cancer, scores_other]).mean()
    var_pooled = pd.concat([scores_cancer, scores_other]).var()
    # LRT statistic
    lrt = (
        -2 * (
            norm.logpdf(scores_cancer, mu_pooled, np.sqrt(var_pooled)).sum() +
            norm.logpdf(scores_other, mu_pooled, np.sqrt(var_pooled)).sum()
        ) +
        2 * (
            norm.logpdf(scores_cancer, mu_c, np.sqrt(var_pooled)).sum() +
            norm.logpdf(scores_other, mu_o, np.sqrt(var_pooled)).sum()
        )
    )
    p = 1 - chi2.cdf(lrt, df=1)
    return {"gene": gene, "mean_cancer": mu_c, "mean_other": mu_o, "lrt": lrt, "p": p}
```

Apply across genes, FDR-correct. See `assets/references/dependency_analysis.md`.

### 5. Druggability annotation

```python
import requests
# Pharos API
def pharos_tier(gene):
    url = f"https://pharos-api.ncats.io/targets/{gene}"
    r = requests.get(url)
    if r.status_code == 200:
        data = r.json()
        return data.get("tdl", "Tdark")  # Tclin/Tchem/Tbio/Tdark
    return "Tdark"

selective["pharos_tier"] = selective.gene.apply(pharos_tier)
```

### 6. Therapeutic-window prioritization

Dependent + druggable (Tclin/Tchem) + not pan-essential:

```python
actionable = selective[
    (selective.mean_cancer < -0.5) &
    (selective.pharos_tier.isin(["Tclin", "Tchem"])) &
    (selective.pan_essential_freq < 0.9)
].sort_values("mean_cancer")
```

### 7. Synthetic lethality (mutual-exclusivity)

```python
from scipy.stats import fisher_exact
# Gene A and gene B: are they mutually exclusive in dependency?
dep_A = (gene_effect.loc["BRCA1"] < -0.5)
dep_B = (gene_effect.loc["PARP1"] < -0.5)
both = (dep_A & dep_B).sum()
only_A = (dep_A & ~dep_B).sum()
only_B = (~dep_A & dep_B).sum()
neither = (~dep_A & ~dep_B).sum()
odds, p = fisher_exact([[both, only_A], [only_B, neither]], alternative="less")
# alternative="less" tests for depletion of "both" (mutual exclusivity)
```

See `assets/references/synthetic_lethality.md` for paralog/PPI priors.

---

## Cancer-Dependency Best Practice (on top of omics-shared)

### 1. Gene-effect sign convention

DepMap Chronos/CERES: **negative = lethal** (CRISPR knockout reduces fitness). A score of −1.0 ≈ complete lethality; 0 ≈ no effect. Don't flip signs.

### 2. Dependency threshold = −0.5

The DepMap standard. Lower (−0.6) is more conservative; higher (−0.3) inflates false positives. State the threshold.

### 3. Pan-essentiality gate

Genes essential in ≥90% of lines (ribosomal proteins, core metabolic enzymes) are not therapeutic targets — they'd kill normal cells too. Filter them before druggability prioritization.

### 4. normLRT tests *selective* dependency

A gene can be essential in many cancers but still be *more* essential in one (selective). normLRT compares cancer-specific vs background essentiality.

### 5. Therapeutic window = dependent in cancer, tolerated in normal

A perfect target: lethal in the tumor, spares healthy tissue. DepMap (cancer lines) doesn't directly measure normal-cell toxicity — infer it from pan-essentiality frequency (low = likely tolerated).

### 6. Synthetic lethality priors

Not all gene pairs are plausible SL candidates. Apply priors:
- **Paralog pairs** (duplicate genes, one compensates for the other)
- **PPI neighbors** (proteins in the same complex)
- **Canonical pairs** (BRCA1/2–PARP1, ATM–ATR, …)

Raw mutual-exclusivity without priors gives thousands of false positives.

### 7. Multi-omic integration amplifies candidates

Dependency alone: "this gene is essential in cancer X." Dependency + phospho upregulation: "this kinase is *both* essential *and* hyperactivated" → stronger therapeutic rationale.

---

## Pitfalls

- **Wrong sign** — treating negative as "no effect" (it's lethal)
- **No pan-essentiality filter** — prioritizing ribosomal proteins
- **Threshold inconsistency** — switching between −0.5 and −0.3 mid-analysis
- **Two-sided Fisher for SL** — mutual exclusivity needs one-sided (depletion of co-dependency)
- **No FDR** — testing thousands of gene pairs inflates false positives
- **No SL priors** — accepting any exclusivity pair as biologically plausible
- **Pharos Tdark treated as actionable** — Tdark = no known ligand/tool compound; not druggable

---

## When Things Go Wrong

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| **All genes "dependent"** | Threshold too high (e.g., −0.1) | Use −0.5 (DepMap standard) |
| **No selective dependencies** | normLRT not applied; just used mean | Run normLRT per cancer type |
| **SL pairs look random** | No priors, two-sided test | Filter to paralog/PPI candidates, use one-sided Fisher |
| **Pharos API 404** | Gene symbol mismatch | Standardize to HGNC; try UniProt ID |
| **Therapeutic-window list dominated by housekeeping** | No pan-essentiality gate | Filter to <90% frequency |

---

## Evidence & Reporting

Every analysis emits:
- **Quantitative claims** → trailing JSON `report` with exact scores/p-values
- **Dependency calls**: gene, mean gene-effect in target cancer, threshold used, n lines
- **Druggability**: Pharos tier, evidence (TTD phase, DrugBank count)
- **SL pairs**: mutual-exclusivity odds ratio, p-value, prior applied (paralog/PPI/canonical)

See reference docs for per-analysis reporting templates.
