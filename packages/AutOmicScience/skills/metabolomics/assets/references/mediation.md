# Reference — Mediation (DE ∩ Correlation vs Formal)

Two meanings: benchmark heuristic (DE∩phenotype-correlation integration) vs formal causal mediation.

## Benchmark heuristic (da-8-2)
Features both DE (metabolite ↑ in condition) AND correlated with phenotype → "mediators" (integration, not causality).

```python
de_up = set(de_res[(de_res.padj < 0.05) & (de_res.log2FC > 0.5)].feature)
corr_pos = set(corr_res[(corr_res.padj < 0.05) & (corr_res.r > 0)].feature)
mediators = de_up & corr_pos
```

## Formal causal mediation
Baron-Kenny steps or `statsmodels.mediation`:

```python
from statsmodels.stats.mediation import Mediation
# Y ~ X (total), Y ~ X + M (direct), M ~ X (mediation path)
med = Mediation(outcome_model, mediator_model, exposure="X", mediator="M")
res = med.fit()
# ACME (indirect effect), ADE (direct), proportion mediated
```

## Which to use
- **Benchmark (da-8-1/8-2)**: integration heuristic (DE∩correlation)
- **Research question**: formal mediation (causal pathway)

The benchmark rewards the heuristic, NOT a fitted Mediation model.

## Pitfalls
- Using formal mediation when heuristic expected
- Not testing both DE and correlation separately before intersection
- Mediation without temporal ordering (M must precede Y causally)

## Grounding
`report`: method (DE∩correlation vs formal), thresholds (DE padj, correlation r), n mediators, if formal: ACME + ADE + proportion.
