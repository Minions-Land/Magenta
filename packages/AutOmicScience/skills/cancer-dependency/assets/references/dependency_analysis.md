# Reference — Dependency Classification & normLRT

Distinguishing pan-essential genes (drug-undevelopable) from selective dependencies (targetable vulnerabilities), and testing selectivity with normLRT.

## Binary dependency call

DepMap standard threshold: gene-effect < −0.5 = "dependent":

```python
dependent = (gene_effect < -0.5).astype(int)   # genes × cell lines
```

Some analyses use the **probability of dependency** file (`CRISPR_gene_dependency.csv`, values 0–1) and threshold at 0.5:

```python
dep_prob = pd.read_csv("CRISPR_gene_dependency.csv", index_col=0)
dependent = (dep_prob > 0.5).astype(int)
```

## Pan-essential vs selective

**Pan-essential**: essential in nearly all cell lines (ribosomal proteins, RNA Pol, proteasome). These are NOT good drug targets — killing them kills normal cells too (no therapeutic window).

```python
dependency_frequency = dependent.mean(axis=1)  # fraction of lines dependent

pan_essential = dependency_frequency[dependency_frequency >= 0.9].index
selective = dependency_frequency[
    (dependency_frequency > 0.05) & (dependency_frequency < 0.9)
].index
never_essential = dependency_frequency[dependency_frequency <= 0.05].index
```

The **selective** genes are the therapeutic targets: essential in *some* cancers, dispensable in others.

## normLRT selective-dependency score

normLRT (normal Likelihood Ratio Test) quantifies how much a gene's dependency distribution deviates from a single normal — bimodal/skewed distributions indicate selective dependency (some lines very dependent, others not).

**Concept:** fit (a) a single normal to all gene-effect scores, and (b) a skew-normal or mixture. A large likelihood ratio = the gene's dependency is selective (a subset of lines is specifically dependent).

```python
from scipy.stats import norm, skewnorm
import numpy as np

def normLRT_score(gene_scores):
    gene_scores = gene_scores.dropna().values
    # Null: single normal
    mu, sigma = norm.fit(gene_scores)
    ll_normal = norm.logpdf(gene_scores, mu, sigma).sum()
    # Alt: skew-normal (captures selective tail)
    a, loc, scale = skewnorm.fit(gene_scores)
    ll_skew = skewnorm.logpdf(gene_scores, a, loc, scale).sum()
    lrt = 2 * (ll_skew - ll_normal)
    return lrt   # higher = more selective

normlrt = gene_effect.apply(lambda row: normLRT_score(row), axis=1)
selective_ranked = normlrt.sort_values(ascending=False)
```

High normLRT genes (e.g., top 500) are the classic selective dependencies — this is how DepMap's original paper prioritized targets.

## Group-comparison selective dependency

Alternatively, test whether a gene is more essential in cancer type A vs others:

```python
from scipy.stats import mannwhitneyu

def selective_in_group(gene, group_lines, other_lines):
    g = gene_effect.loc[gene, group_lines].dropna()
    o = gene_effect.loc[gene, other_lines].dropna()
    # One-sided: group MORE dependent (lower gene-effect)
    stat, p = mannwhitneyu(g, o, alternative="less")
    effect = g.mean() - o.mean()   # negative = more dependent in group
    return {"gene": gene, "delta": effect, "p": p}
```

## Therapeutic-window logic

A good target is:
1. **Selectively dependent** (essential in the cancer of interest)
2. **NOT pan-essential** (dispensable in normal/other tissues → therapeutic window)
3. **Druggable** (see `druggability.md`)

```python
candidates = [
    g for g in selective
    if g not in pan_essential
    and dependency_frequency_in_cancer[g] > 0.5   # dependent in ≥50% of cancer lines
]
```

## Pitfalls

- **Targeting pan-essential genes** — no therapeutic window; toxic to normal cells
- **Wrong threshold** — −0.5 is standard; document if you deviate
- **normLRT without enough lines** — needs a decent sample (>50 lines) for stable fit
- **Ignoring copy-number confound** — Chronos corrects this; CERES doesn't (amplified regions look falsely essential)
- **One-sided vs two-sided** — selective dependency is directional (more essential in group) → one-sided

## Grounding

`report`: dependency threshold, n pan-essential / selective / never-essential, normLRT top genes or group-comparison stats with effect + p.
