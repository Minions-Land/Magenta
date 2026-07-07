# Reference — Clinical Metabolic Phenotyping

Insulin-resistance indices and metabolic classification.

## Disposition Index (primary)
DI = insulin sensitivity × β-cell function.

```python
DI = (insulin_secretion_rate / glucose_AUC) * matsuda_index
```

Used in da-8-1 as the primary IR metric.

## SSPG (Steady-State Plasma Glucose, fallback)
From insulin-suppression test. SSPG > 150 mg/dL = insulin-resistant.

```python
ir_class = "IR" if sspg > 150 else "IS"
```

## HOMA-IR (additional)
Fasting glucose × fasting insulin / 22.5. Crude but common.

```python
homa_ir = (fasting_glucose_mmol * fasting_insulin_uU_mL) / 22.5
```

## Precedence
Disposition Index (gold) > SSPG (validated alternative) > HOMA-IR (baseline). Use DI if available.

## Two-way ANOVA (da-8-3)
Condition × IR interaction with effect sizes:

```python
from statsmodels.formula.api import ols
from statsmodels.stats.anova import anova_lm
model = ols("metabolite ~ C(condition) * C(IR) + Age + BMI", data=df).fit()
aov = anova_lm(model, typ=2)
# Report: F, p, partial η² (effect size)
```

## Pitfalls
- Using SSPG-only when DI available
- No effect-size reporting (F and p without η²)
- Wrong ANOVA type (Type I vs Type II)

## Grounding
`report`: IR index used + precedence, classification thresholds, ANOVA formula, F + p + partial η², effect direction interpretation.
