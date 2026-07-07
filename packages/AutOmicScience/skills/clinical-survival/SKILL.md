---
name: clinical-survival
description: Survival analysis — Kaplan-Meier curves, log-rank test, Cox proportional-hazards regression for time-to-event clinical outcomes (overall survival, progression-free survival, any censored endpoint). Use when the user has survival data (time, event) and asks to test survival differences, stratify by a biomarker, compute hazard ratios, or generate KM plots.
requiredTools: [run_python, bash, read, write, observe_figure]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [clinical, survival, kaplan-meier, log-rank, cox-ph, hazard-ratio, censoring, time-to-event]
extends: omics-shared
---

# Clinical Survival Analysis — KM, Log-Rank, Cox PH

Survival analysis: Kaplan-Meier estimator for survival curves, log-rank test for group comparison, Cox proportional-hazards regression for hazard ratios and multivariable adjustment. Builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply).

This is **NOT** competing-risks analysis, **NOT** recurrent-event models, **NOT** cure models.

---

## Prerequisites

1. **Data format**: time-to-event table with `time` (numeric, follow-up duration) and `event` (binary: 1=event, 0=censored)
2. **Context**: grouping variable (treatment, biomarker high/low) or continuous covariates (age, expression) for stratification/adjustment
3. **Library**: `lifelines` (standard Python survival package)

```bash
pip install lifelines
```

---

## Capability Menu

| Capability | Maturity | Tool/Method | Reference Doc |
|------------|----------|-------------|---------------|
| Kaplan-Meier survival curves | **REFERENCE** | lifelines.KaplanMeierFitter | `assets/references/km_logrank.md` |
| Log-rank test (two-group comparison) | **REFERENCE** | lifelines.statistics.logrank_test | `assets/references/km_logrank.md` |
| Cox proportional-hazards regression | **REFERENCE** | lifelines.CoxPHFitter | `assets/references/cox_ph.md` |
| PH assumption check (Schoenfeld residuals) | **REFERENCE** | CoxPHFitter.check_assumptions | `assets/references/cox_ph.md` |
| Hazard ratio + 95% CI | **REFERENCE** | Cox model summary | `assets/references/cox_ph.md` |

All capabilities are **REFERENCE** because survival analysis requires study-specific judgment: censoring interpretation, PH violation handling, covariate selection, stratification cutoffs.

---

## Standard Workflow

### 1. Kaplan-Meier curves

```python
from lifelines import KaplanMeierFitter
import matplotlib.pyplot as plt

kmf = KaplanMeierFitter()
# Group 1
kmf.fit(durations=df[df.group==1].time, event_observed=df[df.group==1].event, label="Group 1")
kmf.plot_survival_function()
# Group 2
kmf.fit(durations=df[df.group==2].time, event_observed=df[df.group==2].event, label="Group 2")
kmf.plot_survival_function()
plt.ylabel("Survival probability")
plt.xlabel("Time (months)")
plt.savefig("km_curve.pdf", dpi=300, bbox_inches="tight")
```

`observe_figure` before citing.

### 2. Log-rank test

```python
from lifelines.statistics import logrank_test
results = logrank_test(
    durations_A=df[df.group==1].time, durations_B=df[df.group==2].time,
    event_observed_A=df[df.group==1].event, event_observed_B=df[df.group==2].event
)
print(f"Log-rank p={results.p_value:.3e}")
```

### 3. Cox proportional-hazards

```python
from lifelines import CoxPHFitter
cph = CoxPHFitter()
cph.fit(df, duration_col="time", event_col="event")
cph.print_summary()
# Hazard ratio for a covariate:
hr = cph.hazard_ratios_["biomarker"]
ci = cph.confidence_intervals_.loc["biomarker"]
```

See `assets/references/cox_ph.md`.

---

## Survival Best Practice (on top of omics-shared)

### 1. Right-censoring convention

`event=1` → event occurred (death, progression). `event=0` → censored (lost to follow-up, study end). Always check the coding — some datasets use opposite convention.

### 2. Time units

State the time unit (days, months, years) explicitly. Median survival = 12 (months? years?) is ambiguous.

### 3. Median survival with CI

Report median survival (time at which survival = 50%) with 95% CI:

```python
kmf.median_survival_time_
kmf.confidence_interval_survival_function_.loc[kmf.median_survival_time_]
```

### 4. Hazard ratio interpretation

HR > 1 → increased hazard (worse outcome). HR < 1 → protective. Always report the 95% CI — a wide CI (e.g., [0.8, 3.2]) spans 1.0 and is not significant.

### 5. PH assumption check

Cox PH requires proportional hazards (group hazard ratio constant over time). Check with Schoenfeld residuals. If violated, use stratification or time-varying coefficients.

---

## Pitfalls

- **Event coding reversed** — treating censored as events
- **No PH check** — Cox model invalid if PH violated
- **HR without CI** — HR=2.1 with CI=[0.9, 4.8] crosses 1.0 (not significant)
- **Median survival not reported** — log-rank p-value alone doesn't quantify the effect
- **Time units not stated** — "median=12" is ambiguous
- **Left-truncation ignored** — delayed entry (e.g., all patients recruited after year 1) biases KM

---

## Evidence & Reporting

Every analysis emits:
- **Data**: n patients, n events, median follow-up
- **KM**: median survival per group with 95% CI, survival at landmark times (1yr, 5yr)
- **Log-rank**: test statistic + p-value
- **Cox**: HR + 95% CI + p per covariate, PH assumption check result
- **Figures** → `observe_figure`

See reference docs for per-analysis reporting templates.
