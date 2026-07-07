# Reference — Multi-Omic Integration with Dependency Data

Combining DepMap dependency with phosphoproteomics, expression, or mutation data to prioritize targets with converging evidence.

## The integration principle

A target with **converging evidence** across data types is more credible than one supported by a single assay:

- **Dependency** (DepMap): knockout is lethal → functional requirement
- **Expression/phospho** (upregulated): the pathway is active → biological relevance
- **Mutation** (MAF): genotype context → patient stratification

Converging = dependent AND (over-expressed OR activated OR in a mutated pathway).

## Dependency + phosphoproteomics (da-5-3)

Genes that are both (a) phospho-activated and (b) a dependency → active-pathway driver candidates:

```python
# Phospho: activating-site upregulated (see proteomics/phosphoproteomics.md)
phospho_up = set(de_phospho[
    (de_phospho.padj < 0.05) & (de_phospho.log2FC > 1)
].gene)

# Dependency: essential in the relevant cancer type
dep_genes = set(
    gene_effect.loc[:, cancer_lines].mean(axis=1).pipe(lambda s: s[s < -0.5]).index
)

# Converging candidates
candidates = phospho_up & dep_genes
print(f"{len(candidates)} genes: phospho-activated AND dependency")
```

## Dependency + expression

Overexpressed genes that are also dependencies (oncogene addiction pattern):

```python
# Expression: overexpressed in cancer vs normal (log2FC > 1)
overexpr = set(de_rna[(de_rna.padj < 0.05) & (de_rna.log2FC > 1)].gene)

# Dependency
dep_genes = set(gene_effect.loc[:, cancer_lines].mean(axis=1).pipe(lambda s: s[s < -0.5]).index)

# Correlation within cell lines: does higher expression → stronger dependency?
import numpy as np
def expr_dep_corr(gene):
    expr = ccle_expression.loc[gene, cancer_lines]
    dep = gene_effect.loc[gene, cancer_lines]
    common = expr.dropna().index & dep.dropna().index
    from scipy.stats import spearmanr
    r, p = spearmanr(expr[common], dep[common])
    return {"gene": gene, "spearman_r": r, "p": p}
# Negative r = higher expression → lower (more negative) gene-effect → stronger dependency
```

## Dependency + MAF/CNA

Mutation status as a dependency modifier (the SL logic, see `synthetic_lethality.md`):

```python
# Cell lines with gene A mutated vs WT (from CCLE_mutations)
a_mutant = ccle_mut[ccle_mut.Hugo_Symbol == "GENE_A"].DepMap_ID.unique()
a_wt = [l for l in cancer_lines if l not in a_mutant]

# Is gene B a stronger dependency in A-mutant lines?
from scipy.stats import mannwhitneyu
b_mut = gene_effect.loc["GENE_B", a_mutant].dropna()
b_wt = gene_effect.loc["GENE_B", a_wt].dropna()
stat, p = mannwhitneyu(b_mut, b_wt, alternative="less")
```

## Multi-cancer breadth ranking

A target essential across many cancer types has broad therapeutic potential:

```python
# For each gene, count cancer types where it's a dependency in >50% of lines
breadth = {}
for gene in selective_genes:
    n_cancers = 0
    for cancer, lines in cancer_type_lines.items():
        dep_freq = (gene_effect.loc[gene, lines] < -0.5).mean()
        if dep_freq > 0.5:
            n_cancers += 1
    breadth[gene] = n_cancers

# Genes with dual evidence (dependency + druggable) across most cancers
breadth_ranked = pd.Series(breadth).sort_values(ascending=False)
```

## Combining rule semantics

| Rule | Meaning | Use when |
|------|---------|----------|
| **Intersection (AND)** | Supported by all data types | High-confidence, conservative |
| **Union (OR)** | Supported by any | Discovery, sensitive |
| **Weighted score** | Rank by combined evidence | Prioritization with tradeoffs |

State which rule you used and why.

## Pitfalls

- **Union when intersection intended** — "converging evidence" means AND, not OR
- **Comparing across scales without normalization** — dependency (−2..0.5), expression (TPM), phospho (log2 ratio) are different scales
- **Correlation sign confusion** — negative Spearman (expr vs gene-effect) = stronger dependency with higher expression
- **Cell-line vs patient mismatch** — DepMap is cell lines; don't directly equate to patient tumor frequencies
- **Ignoring lineage** — a pan-cancer dependency may be driven by one dominant lineage

## Grounding

`report`: data types integrated, combination rule (AND/OR/weighted), converging candidates with per-data-type evidence, breadth if computed.
