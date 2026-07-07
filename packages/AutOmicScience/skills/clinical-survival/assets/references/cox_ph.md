# Reference — Cox Proportional-Hazards Regression

Semi-parametric regression for hazard ratios and multivariable adjustment.

## Basic Cox model
```python
from lifelines import CoxPHFitter
cph = CoxPHFitter()
cph.fit(df, duration_col="time", event_col="event")
cph.print_summary()
```

Reading the summary:
- **coef**: log hazard ratio
- **exp(coef)**: hazard ratio (HR)
- **exp(coef) lower/upper 95%**: HR confidence interval
- **p**: significance

```python
hr = cph.hazard_ratios_["biomarker"]
ci = cph.confidence_intervals_.loc["biomarker"]  # log scale; exp() for HR CI
```

## Multivariable adjustment
Include covariates to adjust for confounders:
```python
cph.fit(df[["time","event","biomarker","age","stage"]],
        duration_col="time", event_col="event")
# HR for biomarker is now adjusted for age + stage
```

## Univariate per-feature screening
Test each feature separately (e.g., per-taxon, per-gene):
```python
from statsmodels.stats.multitest import multipletests
results = []
for feat in features:
    cph = CoxPHFitter()
    cph.fit(df[["time","event",feat]], duration_col="time", event_col="event")
    results.append({"feature": feat, "HR": cph.hazard_ratios_[feat],
                    "p": cph.summary.loc[feat, "p"]})
res = pd.DataFrame(results)
res["padj"] = multipletests(res.p, method="fdr_bh")[1]
# Decision rule e.g.: HR > 1 & p < 0.05
```

## PH assumption check (Schoenfeld)
```python
cph.check_assumptions(df, show_plots=False)
# Or explicitly:
from lifelines.statistics import proportional_hazard_test
ph = proportional_hazard_test(cph, df)
print(ph.summary)  # p < 0.05 → PH violated for that covariate
```

Remedies for PH violation:
- **Stratify** on the violating variable: `cph.fit(..., strata=["stage"])`
- **Time-varying coefficients** (CoxTimeVaryingFitter)
- **Restricted mean survival time** as an alternative summary

## Pitfalls
- **HR without CI** — HR=2.1 with CI [0.9, 4.8] is not significant
- **No PH check** — violated PH invalidates the HR
- **Low events-per-variable** (<10 events per covariate) → unstable, overfit HRs
- **Collinear covariates** → inflated standard errors
- **Ties handling** — Efron (lifelines default) is fine; Breslow less accurate

## Grounding
`report`: model covariates, HR + 95% CI + p per covariate, PH assumption test result + remedy if violated, events-per-variable, FDR if screening many features.
