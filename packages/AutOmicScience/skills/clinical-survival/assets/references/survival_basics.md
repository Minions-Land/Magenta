# Reference — Survival Analysis Basics

Core concepts for time-to-event analysis.

## Data structure
Two columns define survival:
- **time**: follow-up duration (from baseline to event or censoring)
- **event**: binary — 1 = event observed (death/progression), 0 = censored

```python
df = pd.DataFrame({"time": [...], "event": [...], "group": [...]})
```

## Right-censoring
A subject is censored when the event hasn't occurred by their last observation (lost to follow-up, study ends). Censored subjects contribute information up to their censoring time. **event=0** marks them.

**Verify the coding** — the single most common silent error is reversed event coding (censored labeled as events). Cross-check the event count against the study text.

## Dichotomizing continuous biomarkers
Continuous variables (expression, marker %) are often split for KM:
- **Median split**: high vs low at the median
- **Tertiles/quartiles**: for finer stratification (then pairwise log-rank)
- **Optimal cutpoint**: maximally-selected rank statistics (beware multiplicity inflation)

```python
df["group"] = (df["biomarker"] > df["biomarker"].median()).astype(int)
```

## Bias awareness

### Immortal-time (guarantee-time) bias
If the grouping variable is defined by a POST-baseline event (e.g., "responders" defined by on-treatment expansion), those patients are guaranteed to survive until that event → biased KM. Flag this caveat when grouping on post-baseline features.

### Left-truncation / delayed entry
Subjects entering the risk set after t=0 (registry data, prevalent cohorts). Needs `entry` handling in lifelines; ignoring it biases the KM estimate.

### Competing risks
With non-terminal events (death from other causes), standard KM overestimates cumulative incidence. Use cumulative-incidence functions (Fine-Gray, lifelines `AalenJohansenFitter`) when competing risks exist.

## Time units
Always state days/months/years. A median survival of "18" is meaningless without units.

## Pitfalls
- Reversed event coding
- Grouping on post-baseline features (immortal-time bias)
- Tiny groups after splitting (unstable curves)
- Ignoring competing risks

## Grounding
`report`: n patients, n events, censoring convention verified, median follow-up, time units, any bias caveats (immortal-time, left-truncation).
