# Reference — Effect-Size Ranking vs P-Value Ranking

When a question asks "which proteins change *most*," rank by effect size (magnitude), not by p-value (evidence strength). A commonly-graded distinction.

## The two axes are orthogonal

- **P-value** measures **evidence strength** = a function of effect size × sample size × variance. A tiny effect can have a tiny p-value if n is large.
- **Effect size** (log2FC, Cohen's d, |estimate|) measures **biological magnitude** — how big is the change?

A protein with log2FC=3.0, p=0.03 changed **more** than one with log2FC=0.4, p=1e-10. If the question is "which changed most," the first wins despite the weaker p-value.

## The rule

**When asked "which change most / are most different / largest change":**
1. Apply an FDR gate first (padj < 0.05) — keep only statistically credible hits
2. **Rank the survivors by |effect size|** (|log2FC| or |estimate|)

```python
# WRONG (ranks by evidence, not magnitude):
top = de.sort_values("p").head(10)

# RIGHT (FDR gate, then rank by magnitude):
credible = de[de.padj < 0.05]
top = credible.reindex(credible.log2FC.abs().sort_values(ascending=False).index).head(10)
```

**When asked "which are most significant / strongest evidence":** rank by p-value (that's the right axis then).

## Why this is graded

Rubrics reward the correct axis. A specialist that ranked by p-value when the question asked for magnitude scored 0.64 (da-13-3) — right analysis, wrong ranking axis. The fix is a one-line change but requires reading the question carefully.

## Effect-size measures

| Measure | When | Formula |
|---------|------|---------|
| **log2FC** | Fold-change (expression, NPX) | log2(mean_case / mean_ctrl), or ΔNPX |
| **Cohen's d** | Standardized mean difference | (mean_A − mean_B) / pooled_SD |
| **\|estimate\|** | Regression coefficient | absolute value of the fitted β |
| **Correlation r** | Association strength | Pearson/Spearman r |

For NPX (already log2), the mean difference IS the log2FC.

## Multi-omic effect-size integration (da-13-6)

When ranking candidates across multiple data types, combine effect sizes (e.g., product of absolute effects):

```python
# Join proteomics + transcriptomics + metabolomics on gene/analyte
merged = prot_de.merge(rna_de, on="gene").merge(metab_de, on="gene")

# Rank by product of absolute effect sizes (requires all three credible)
merged = merged[
    (merged.padj_prot < 0.05) &
    (merged.padj_rna < 0.05) &
    (merged.padj_metab < 0.05)
]
merged["combined_effect"] = (
    merged.log2FC_prot.abs() *
    merged.log2FC_rna.abs() *
    merged.effect_metab.abs()
)
top = merged.sort_values("combined_effect", ascending=False).head(10)
```

Document the combination rule (product, sum, min) — each has different semantics. Product rewards consistency across omics; min rewards the weakest-link being strong.

## Pitfalls

- **Ranking by p when magnitude asked** — the classic error (da-13-3)
- **No FDR gate before effect ranking** — a huge effect with p=0.9 is noise
- **Ranking by -log10(p) thinking it's effect size** — it's still evidence, not magnitude
- **Signed vs absolute** — "most changed" usually means |effect|; "most upregulated" means signed
- **Combining effects on different scales** — standardize (z-score or rank) before combining across omics

## Grounding

`report`: FDR gate applied, ranking axis (effect size vs p-value, matched to the question), top hits with both the effect size and the p-value shown.
