# Reference — Alpha & Beta Diversity

Measuring within-sample (alpha) and between-sample (beta) microbial diversity.

## Alpha diversity (within-sample richness/evenness)
Common metrics:
- **Shannon index** — accounts for richness + evenness
- **Chao1** — richness estimator (rare species)
- **Faith's PD** — phylogenetic diversity (needs tree)

```python
from skbio.diversity import alpha_diversity
import pandas as pd

# abundance: taxa × samples (samples in columns → transpose for skbio)
shannon = alpha_diversity('shannon', abundance.T.values, ids=abundance.columns)
chao1 = alpha_diversity('chao1', abundance.T.values, ids=abundance.columns)

# Compare groups
from scipy.stats import mannwhitneyu
stat, p = mannwhitneyu(shannon[group1_samples], shannon[group2_samples])
```

## Beta diversity (between-sample dissimilarity)
Common metrics:
- **Bray-Curtis** — abundance-based, most common
- **Unweighted UniFrac** — phylogenetic (presence/absence, needs tree)
- **Weighted UniFrac** — phylogenetic + abundance

```python
from skbio.diversity import beta_diversity
from skbio.stats.distance import permanova

# Bray-Curtis distance matrix
bc_dm = beta_diversity('braycurtis', abundance.T.values, ids=abundance.columns)

# PCoA (principal coordinates analysis) for visualization
from skbio.stats.ordination import pcoa
pcoa_results = pcoa(bc_dm)
# Plot PC1 vs PC2, color by group
```

## PERMANOVA (testing group differences in beta diversity)
```python
permanova_results = permanova(bc_dm, grouping=metadata["condition"], permutations=999)
print(f"PERMANOVA p={permanova_results['p-value']:.3e}")
```

## Interpreting diversity
- **Low alpha diversity** (Shannon) → dysbiosis, often seen in disease
- **High beta diversity within group** → heterogeneous microbiome
- **Significant PERMANOVA** → group centroids differ (community composition differs)

## Pitfalls
- UniFrac without a phylogenetic tree (needs 16S alignment + tree-building)
- PERMANOVA with unbalanced groups (low power)
- Not rarefying before alpha diversity (but see: CLR is better for most analyses)

## Grounding
`report`: alpha metric + per-group median+IQR + group-comparison stat+p, beta metric + PERMANOVA pseudo-F + p + R², PCoA figure.
