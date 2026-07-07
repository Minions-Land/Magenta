# Reference — Covariate-Adjusted Association (OLS)

Per-metabolite OLS with clinical covariates.

## OLS per feature
```python
import statsmodels.formula.api as smf
from statsmodels.stats.multitest import multipletests

results = []
for feat in log_mat.columns:
    df = pd.DataFrame({"y": phenotype, "feat": log_mat[feat],
                       "Age": age, "BMI": bmi})
    model = smf.ols("y ~ feat + Age + BMI", data=df).fit()
    results.append({"feature": feat, "coef": model.params["feat"],
                    "p": model.pvalues["feat"]})
res = pd.DataFrame(results)
res["padj"] = multipletests(res.p, method="fdr_bh")[1]
```

## Thresholds
- Positive association: `coef > 0` AND `padj < 0.05`
- Directionality matters: positive coef = metabolite↑ when phenotype↑

## Pitfalls
- Wrong direction interpreted
- No FDR correction
- Non-log-transformed intensities

## Grounding
`report`: model formula, n features tested, n significant, top hits with coef + p + padj.
