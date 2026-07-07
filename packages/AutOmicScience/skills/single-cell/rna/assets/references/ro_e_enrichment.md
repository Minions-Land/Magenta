# Reference — Ro/e Tissue Enrichment (TME Composition)

Ro/e (ratio of observed to expected) quantifies which cell types are enriched or depleted in a given tissue/compartment — the standard method for tumor-microenvironment (TME) composition analysis.

## Goal

Identify cell types over- or under-represented in a specific tissue (e.g., tumor vs adjacent-normal vs blood), beyond what random distribution would predict. Ro/e > 1 = enriched; Ro/e < 1 = depleted.

## Method 1: chi-square residuals (standard)

Build a contingency table (cell type × tissue), compute expected counts from marginals, and Ro/e = observed / expected:

```python
import pandas as pd
import numpy as np
from scipy.stats import chi2_contingency

# Contingency: rows = cell types, cols = tissues
obs = pd.crosstab(adata.obs["cell_type"], adata.obs["tissue"])

# Chi-square gives expected counts under independence
chi2, p, dof, expected = chi2_contingency(obs)
expected = pd.DataFrame(expected, index=obs.index, columns=obs.columns)

# Ro/e ratio
roe = obs / expected
# roe > 1 → enriched in that tissue; < 1 → depleted

# Standardized (Pearson) residuals — signed enrichment strength
residuals = (obs - expected) / np.sqrt(expected)
```

Interpretation:
- **Ro/e > 1** (positive residual) → the cell type is enriched in that tissue
- **Ro/e < 1** (negative residual) → depleted
- Large |residual| → strong deviation from random

## Method 2: sampling-normalized proportion fold-change

When cell numbers per tissue differ dramatically, normalize by sampling depth:

```python
# Proportion of each cell type within each tissue
prop = obs / obs.sum(axis=0)   # column-normalized (within tissue)
# Overall proportion (pooled)
overall = obs.sum(axis=1) / obs.sum().sum()
# Fold-change vs pooled expectation
roe_fc = prop.div(overall, axis=0)
```

## Tumor-specific triple filter (da-1-3 pattern)

To find cell types specific to the tumor compartment:

```python
# Enriched in tumor AND depleted in normal AND depleted in blood
tumor_specific = roe.index[
    (roe["Tumor"] > 1) &
    (roe["Normal"] < 1) &
    (roe["Blood"] < 1)
]
```

## TME cell-type biology (expected hits)

Tumor-enriched populations commonly recovered:
- **Mph_SPP1** — SPP1+ tumor-associated macrophages (pro-tumor, angiogenic)
- **Fibro_FAP** — FAP+ cancer-associated fibroblasts (CAFs, stromal remodeling)
- **Endo_COL4A1** — tumor endothelium (angiogenesis)
- **CD8_Tex_LAYN** — LAYN+ exhausted CD8 T cells (dysfunctional, checkpoint targets)

These annotations combine a lineage marker + a state marker (`Lineage_StateGene`), the naming convention used in TME atlases.

## Granularity

Run Ro/e at the **finest cell-type granularity** available (SubCellType, not broad lineage) — the enrichment signal is in the states (e.g., SPP1+ vs FOLR2+ macrophages), not the lineage.

## Low-count handling

Chi-square is unreliable when expected counts < 5. For rare cell types:
```python
# Flag cells where expected < 5 — interpret Ro/e cautiously or use Fisher exact
low_count = expected < 5
```

## Pitfalls

- **Broad granularity** — running on lineage hides state-level enrichment; use SubCellType
- **Low cell counts** — chi-square invalid when expected < 5; flag or use Fisher
- **Batch confounded with tissue** — if each tissue is one patient, batch effect ≡ tissue effect; note the confound
- **Not signing the residual** — Ro/e alone loses direction near 1; report the residual sign
- **Comparing raw counts across tissues** — always normalize (Ro/e or proportion), never raw counts

## Grounding

`report`: contingency table dims, chi-square statistic + p, per-cell-type Ro/e and standardized residual for the tissue(s) of interest, list of tumor-specific types passing the filter.
