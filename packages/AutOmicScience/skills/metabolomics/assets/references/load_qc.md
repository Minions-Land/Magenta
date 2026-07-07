# Reference — Metabolite Loading & QC

Load metabolite/lipid intensity matrices, apply QC filters, log-transform.

## Format
Samples × features (metabolites/lipids) intensity matrix. Feature IDs: HMDB, KEGG, or lipid shorthand.

```python
import pandas as pd
import numpy as np
mat = pd.read_csv("metabolites.csv", index_col=0)  # features in columns
```

## QC filters
- **Missing-value rate**: drop features missing in >20% of samples
- **Low-variance filter**: drop constant/near-constant features (CV < 0.1)
- **Zero imputation**: optional; replace 0 with LOD/2 or drop

```python
keep = (mat > 0).sum(axis=0) > len(mat) * 0.8
mat_clean = mat.loc[:, keep]
```

## Log-transform
Metabolite intensities are right-skewed → log2 before parametric tests:

```python
log_mat = np.log2(mat_clean + 1)
```

## Normalization
- **Probabilistic quotient normalization** (PQN): common in metabolomics
- **Total-sum normalization**: sum-to-constant per sample
- **Quantile normalization**: equalizes distributions

For clinical studies with paired samples, PQN or sum-normalization preferred.

## Pitfalls
- Not log-transforming before t-tests
- High missing-value features retained
- Wrong axis (samples vs features)

## Grounding
`report`: n samples, n features, missing-value filter threshold, log-transform applied, normalization method.
