# Reference — Differential Abundance (Paired/Unpaired)

Paired or unpaired t-tests on metabolites.

## Paired
```python
from scipy.stats import ttest_rel
from statsmodels.stats.multitest import multipletests

results = []
for feat in log_mat.columns:
    t, p = ttest_rel(log_mat[feat].loc[pre_samples], log_mat[feat].loc[post_samples])
    log2fc = log_mat[feat].loc[post_samples].mean() - log_mat[feat].loc[pre_samples].mean()
    results.append({"feature": feat, "log2FC": log2fc, "p": p})
res = pd.DataFrame(results)
res["padj"] = multipletests(res.p, method="fdr_bh")[1]
```

## Unpaired
Use `ttest_ind` instead of `ttest_rel`.

## Thresholds
`|log2FC| > 0.5` AND `padj < 0.05`

## Pitfalls
- Paired design analyzed as unpaired → loses power
- No FDR
- Ranking by p instead of effect size

## Grounding
`report`: test (paired/unpaired), n features tested, n up/down (thresholds), top hits with log2FC + padj.
