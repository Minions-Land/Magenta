# Reference — Tumor Mutational Burden (TMB)

TMB = the count of somatic mutations, a biomarker for immunotherapy response.

## Definition

**TMB = number of non-synonymous (or all somatic) mutations**, optionally normalized per megabase (Mb) of sequenced territory.

Two common forms:
- **Raw count**: total non-synonymous mutations per sample
- **Per-Mb**: count / panel_size_Mb (e.g., MSK-IMPACT ≈ 1.2 Mb, whole-exome ≈ 30–50 Mb)

```python
# Non-synonymous = coding, protein-altering
nonsyn_classes = [
    "Missense_Mutation", "Nonsense_Mutation", "Frame_Shift_Del",
    "Frame_Shift_Ins", "Splice_Site", "In_Frame_Del", "In_Frame_Ins",
    "Nonstop_Mutation", "Translation_Start_Site"
]
nonsyn = maf[maf.Variant_Classification.isin(nonsyn_classes)]
tmb = nonsyn.groupby("Tumor_Sample_Barcode").size()   # raw count per sample

# Per-Mb (if panel size known):
panel_mb = 1.2   # MSK-IMPACT
tmb_per_mb = tmb / panel_mb
```

Some definitions include synonymous mutations (total mutational burden); the immunotherapy-relevant TMB is usually **non-synonymous only** (neoantigen-generating). State which you use.

## Distribution: median + IQR, not mean±SD

TMB is **right-skewed** (hypermutators create a long tail). Always report **median + interquartile range**, never mean±SD:

```python
import numpy as np
median = tmb.median()
q1, q3 = tmb.quantile([0.25, 0.75])
print(f"TMB median={median:.1f}, IQR=[{q1:.1f}, {q3:.1f}]")
```

## Group comparison

**Two groups** (e.g., responder vs non-responder) → Mann-Whitney U (non-parametric, since skewed):

```python
from scipy.stats import mannwhitneyu
tmb_resp = tmb[responder_samples]
tmb_nonresp = tmb[nonresponder_samples]
stat, p = mannwhitneyu(tmb_resp, tmb_nonresp, alternative="two-sided")
```

**≥3 groups** (e.g., breast cancer subtypes) → Kruskal-Wallis:

```python
from scipy.stats import kruskal
stat, p = kruskal(tmb_subtypeA, tmb_subtypeB, tmb_subtypeC, tmb_subtypeD)
```

## TMB ↔ immunotherapy framing (da-3-4)

High TMB → more neoantigens → better response to immune checkpoint inhibitors (anti-PD-1/PD-L1, anti-CTLA-4). When interpreting a TMB↔response association:
- Higher TMB in responders supports the neoantigen hypothesis
- FDA-approved threshold: TMB ≥ 10 mut/Mb = "TMB-high" (pembrolizumab tumor-agnostic indication)
- Report the effect direction + biological framing, not just the p-value

## Pitfalls

- **Mean±SD on skewed data** — always median+IQR for TMB
- **Parametric t-test** — use Mann-Whitney/Kruskal (non-parametric)
- **Counting silent mutations** — non-synonymous TMB is the standard for immunotherapy
- **Not normalizing per-Mb when comparing panels** — WES and targeted panels give different raw counts
- **Hypermutators not flagged** — MSI-high / POLE-mutant tumors are biologically distinct; consider reporting separately

## Grounding

`report` with: TMB definition used (non-syn count vs per-Mb), median+IQR per group, test statistic + p-value, effect direction.
