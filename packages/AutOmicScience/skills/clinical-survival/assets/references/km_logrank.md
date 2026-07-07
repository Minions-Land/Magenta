# Reference — Kaplan-Meier & Log-Rank Test

Non-parametric survival estimation and group comparison.

## Kaplan-Meier estimator
```python
from lifelines import KaplanMeierFitter
kmf = KaplanMeierFitter()
kmf.fit(durations=df.time, event_observed=df.event, label="All")
kmf.plot_survival_function()
print("Median survival:", kmf.median_survival_time_)
```

## Multi-group KM plot
```python
import matplotlib.pyplot as plt
ax = plt.subplot()
for g in df.group.unique():
    mask = df.group == g
    kmf.fit(df.time[mask], df.event[mask], label=f"Group {g}")
    kmf.plot_survival_function(ax=ax)
plt.ylabel("Survival probability"); plt.xlabel("Time (months)")
plt.savefig("km.pdf", dpi=300, bbox_inches="tight")
```
`observe_figure` before citing.

## Median survival with CI
```python
from lifelines.utils import median_survival_times
median = kmf.median_survival_time_
ci = median_survival_times(kmf.confidence_interval_)
```

## Log-rank test (two groups)
```python
from lifelines.statistics import logrank_test
res = logrank_test(df[df.group==0].time, df[df.group==1].time,
                   df[df.group==0].event, df[df.group==1].event)
print(f"p={res.p_value:.3e}, stat={res.test_statistic:.2f}")
```

## Pairwise log-rank (>2 groups)
```python
from lifelines.statistics import pairwise_logrank_test
res = pairwise_logrank_test(df.time, df.group, df.event)
print(res.summary)  # apply BH correction across pairs
```

## Multivariate log-rank (overall difference)
```python
from lifelines.statistics import multivariate_logrank_test
res = multivariate_logrank_test(df.time, df.group, df.event)
```

## PH assumption note
Log-rank is most powerful under proportional hazards. **Crossing KM curves** signal PH violation → log-rank underpowered. Inspect the curves; if they cross, consider restricted-mean-survival-time comparison.

## Pitfalls
- Crossing curves → log-rank underpowered
- >2 groups without pairwise correction (multiplicity)
- Tiny groups after split → unstable curves
- Not reporting median survival (p-value alone insufficient)

## Grounding
`report`: n per group, median survival + 95% CI per group, log-rank statistic + p (pairwise + corrected if >2 groups), survival at landmark times, figure path.
