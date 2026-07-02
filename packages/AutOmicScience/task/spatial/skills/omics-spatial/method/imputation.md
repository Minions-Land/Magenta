# Gene Imputation for Targeted Panels

**Maturity: PARTIAL** — gene imputation via **Tangram** (`project_genes`), hand-rolled in `run_python`. Tangram is not in `task2` — install it (or run in a side env). Imaging panels only.

## Goal / When to Use

Predict expression of genes **not in a targeted imaging panel** at spatial locations, from a whole-transcriptome scRNA reference. Use **only for imaging platforms** (Xenium, MERFISH, CosMx) where the panel is limited. Do not use for whole-transcriptome spatial (Visium, Slide-seq, Stereo-seq).

## Decision Criteria

**The judgment this guides:**

- **Imputation engine** — the **optimal-transport mapper Tangram** (`project_genes`) projects all reference genes onto spatial locations via the cell→space transport plan.

- **Reuse the Tangram map from label transfer** (`mapping_deconv.md`) so the transport plan is reused — don't re-map just for imputation.

- **Decide by:** whether you already built a map, shared-gene adequacy (need sufficient overlap between panel and reference for the map to be meaningful), and compute budget.

## Method Menu

- **Tangram `project_genes`** (after `map_cells_to_space`) — projects all reference genes via the OT map

## How-to

### Tangram (reuse the mapping from label transfer)

```python
import tangram as tg

# Assume you already ran map_cells_to_space for label transfer
# tg_map = tg.map_cells_to_space(adata_sc, adata_sp, ...)

# Project all reference genes to spatial locations
adata_imputed = tg.project_genes(
    adata_map=tg_map,
    adata_sc=adata_sc,  # reference with full transcriptome
    cluster_label=None  # project genes, not clusters
)

# Validate: hold out measured panel genes, compare predicted vs measured
panel_genes = adata_sp.var_names.tolist()
predicted = adata_imputed[:, panel_genes].X
measured = adata_sp[:, panel_genes].X

import numpy as np
from scipy.stats import pearsonr
correlations = {}
for i, gene in enumerate(panel_genes):
    if measured[:, i].sum() > 0:  # skip all-zero genes
        r, p = pearsonr(measured[:, i].toarray().flatten(), predicted[:, i].toarray().flatten())
        correlations[gene] = r

print(f"Median correlation (predicted vs measured): {np.median(list(correlations.values()))}")
# Only trust imputed genes if validation correlations are reasonable (>0.3-0.5)
```

## Pitfalls & Quality Checks

- **Imputed genes are predictions, not measurements** — the dominant pitfall is treating them as data. Always validate on the measured panel first; report per-gene predicted-vs-measured correlation.

- **Validate before trusting** — hold out measured panel genes and compare predicted vs. measured. If correlations are poor (<0.3), imputation is unreliable — do not use the imputed genes for downstream claims.

- **A small shared/training-gene set makes imputation unreliable** — if the panel and reference share <100 genes, or the shared genes are all housekeeping/ubiquitous, the map has little biological signal to learn from.

- **`observe_figure`** — overlay an imputed gene's spatial map against a measured marker of the same region (e.g., imputed T-cell marker vs. measured CD3D). If they don't co-localize, the imputation is wrong.

- **Never present imputed genes as measured** — clearly label them as imputed in every figure legend, table, and claim.

## Grounding

**What to record as `EvidenceRecord`:**

```python
{
  "method": "tangram_project_genes",
  "reference_source": "PBMC_atlas_scRNA",
  "n_reference_cells": 50000,
  "n_shared_genes": 250,  # panel ∩ reference
  "n_imputed_genes": 18000,
  "validation_correlations": {
    "CD3D": 0.72,
    "MS4A1": 0.68,
    "LYZ": 0.45,
    ...
  },
  "median_validation_correlation": 0.58,
  "imputed_genes_used": ["FOXP3", "IL2RA", "CTLA4"],  # genes actually cited in claims
}
```

Ground: the mapper, training-gene count, validation correlations (held-out panel genes), and which imputed genes were used in claims.

## Honesty

- **Clearly label imputed genes as imputed** everywhere they are used — in figure legends, tables, text. Never say "FOXP3 is expressed in region X" if FOXP3 is imputed; say "imputed FOXP3 (validation r=0.6) suggests expression in region X."

- **Abstain from biological claims that rest solely on a poorly-validated imputed gene** — if validation correlations are <0.3, or if the imputed gene contradicts known biology, flag it and do not build a claim on it.

- **Imputation is extrapolation** — it cannot infer genes the reference doesn't express, or spatial patterns the shared genes don't capture. If the reference is from a different tissue/condition, the imputed genes may reflect reference biology, not spatial biology.

- **Report when imputation is skipped** — if the shared-gene set is too small, or if validation fails, say so explicitly and proceed without imputed genes rather than using unreliable predictions.
