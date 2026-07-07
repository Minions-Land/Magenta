# scRNA-seq Compositional Analysis

## Overview

This guide covers compositional analysis for scRNA-seq data: scCODA (Bayesian compositional analysis) and Milo (differential abundance testing). These methods test changes in cell type proportions or neighborhood abundances between conditions.

**For differential expression of genes within cell types**, see `markers_de.md`.

---

## Compositional Analysis (scCODA)

### 1. Prepare Count Data

```python
import pandas as pd
from sccoda.util import comp_ana as mod
from sccoda.util import cell_composition_data as dat

# Count cells per sample per cell type
cell_counts = adata.obs.groupby(['sample_id', 'cell_type']).size().unstack(fill_value=0)

# Sample metadata
sample_meta = adata.obs[['sample_id', 'condition']].drop_duplicates().set_index('sample_id')

# Create scCODA data object
coda_data = dat.from_pandas(
    cell_counts,
    covariate_df=sample_meta,
    covariate_columns=['condition']
)
```

### 2. Run scCODA

```python
# Set up model
model = mod.CompositionalAnalysis(coda_data, formula="condition", reference_cell_type="automatic")

# Run MCMC
model.sample_hmc()

# Get results
results = model.summary()
print(results)

# Credible effects (cell types with significant change)
credible = results[results['Final Parameter'] != 0]
print(f"\nCell types with credible compositional change:\n{credible}")
```

### 3. Visualization

```python
# Effect plot
model.plot_effects()

# Boxplot of cell type proportions
coda_data.plot_boxplot(feature='condition', figsize=(12, 6))

# Stacked barplot
coda_data.plot_stacked_barplot(feature='condition')
```

### 4. Alternative: Manual Compositional Test

```python
# Simple frequency-based test (not accounting for compositionality)
# Use only as comparison to scCODA

from scipy.stats import mannwhitneyu

# Compute proportions
props = adata.obs.groupby(['sample_id', 'cell_type']).size().unstack(fill_value=0)
props = props.div(props.sum(axis=1), axis=0)

# Merge with condition
props = props.merge(sample_meta, left_index=True, right_index=True)

# Test each cell type
results = []
for cell_type in props.columns[:-1]:  # Exclude 'condition' column
    treated = props[props['condition'] == 'treated'][cell_type]
    control = props[props['condition'] == 'control'][cell_type]
    
    stat, pval = mannwhitneyu(treated, control, alternative='two-sided')
    results.append({
        'cell_type': cell_type,
        'mean_treated': treated.mean(),
        'mean_control': control.mean(),
        'fold_change': treated.mean() / control.mean(),
        'p_value': pval
    })

results_df = pd.DataFrame(results)

# FDR correction
from statsmodels.stats.multitest import multipletests
results_df['padj'] = multipletests(results_df['p_value'], method='fdr_bh')[1]

print(results_df.sort_values('padj'))
```

## Integrated Workflow: All Three Methods

```python
import scanpy as sc
import pandas as pd
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats
import milopy
from sccoda.util import comp_ana as mod
from sccoda.util import cell_composition_data as dat

# 1. Load annotated data
adata = sc.read_h5ad('annotated.h5ad')

# Ensure metadata is present
assert 'sample_id' in adata.obs.columns
assert 'condition' in adata.obs.columns
assert 'cell_type' in adata.obs.columns

# 2. Pseudobulk DE (PyDESeq2)
print("Running pseudobulk DE...")
pb_data = pseudobulk(adata)
de_results = {}

for cell_type, counts in pb_data.items():
    dds = DeseqDataSet(counts=counts.T, metadata=sample_metadata, design_factors="condition")
    dds.deseq2()
    stat_res = DeseqStats(dds, contrast=["condition", "treated", "control"])
    stat_res.summary()
    de_results[cell_type] = stat_res.results_df

# 3. Differential abundance (Milo)
print("Running Milo DA...")
sc.pp.neighbors(adata, n_neighbors=30)
milopy.core.make_nhoods(adata, prop=0.1)
milopy.core.count_nhoods(adata, sample_col='sample_id')
milopy.core.DA_nhoods(adata, design='~ condition', model_contrasts='conditiontreated')
nhood_res = adata.uns['nhood_adata'].obs

# 4. Compositional analysis (scCODA)
print("Running scCODA...")
cell_counts = adata.obs.groupby(['sample_id', 'cell_type']).size().unstack(fill_value=0)
sample_meta = adata.obs[['sample_id', 'condition']].drop_duplicates().set_index('sample_id')
coda_data = dat.from_pandas(cell_counts, covariate_df=sample_meta, covariate_columns=['condition'])
model = mod.CompositionalAnalysis(coda_data, formula="condition", reference_cell_type="automatic")
model.sample_hmc()
comp_results = model.summary()

# 5. Compare results
print("\n=== Summary ===")
print(f"DE genes per cell type: {[(ct, (res['padj'] < 0.05).sum()) for ct, res in de_results.items()]}")
print(f"Significant Milo neighborhoods: {(nhood_res['SpatialFDR'] < 0.1).sum()}")
print(f"Cell types with compositional change: {(comp_results['Final Parameter'] != 0).sum()}")
```

## Best Practices

1. **Always use raw counts for DE**: Log-normalized data breaks distributional assumptions

2. **Require biological replicates**: Minimum 3 per condition for pseudobulk DE

3. **Filter lowly expressed genes**: Remove genes expressed in <10 cells before pseudobulk

4. **Check for batch effects**: Visualize PCA colored by batch before DE

5. **Use appropriate reference for scCODA**: "automatic" mode works well in most cases

6. **Validate with marker genes**: Check if known markers show expected direction

7. **Report multiple testing correction**: Always use adjusted p-values (FDR)

8. **Document design formula**: Record all covariates included in model

9. **Check model assumptions**: QQ plots, dispersion estimates, Cook's distance

10. **Combine methods**: Use DE for genes, Milo for neighborhoods, scCODA for cell type shifts

## Common Pitfalls

- Using normalized/log-transformed data for PyDESeq2 (need raw counts)
- Insufficient replicates (n=2 is not enough for DE)
- Ignoring batch effects or confounders
- Testing compositional data with standard frequency tests
- Not filtering low-quality cells before aggregation
- Aggregating across batches instead of samples
- Using clusters instead of annotated cell types
- Comparing absolute cell counts instead of proportions
- Over-interpreting small effect sizes
- Not validating with orthogonal methods (FACS, IF, etc.)

## Troubleshooting

### Issue: PyDESeq2 fails with singular matrix error
**Cause:** Perfect collinearity in design, or too few samples  
**Fix:** Check design matrix, ensure sufficient replicates, remove redundant covariates

### Issue: No significant genes found
**Cause:** Insufficient power, small effect sizes, or high variability  
**Fix:** Check power analysis, increase replicates, aggregate more cells per pseudobulk

### Issue: Milo finds too many/too few neighborhoods
**Cause:** prop parameter too high/low  
**Fix:** Tune prop (default 0.1), check neighborhood size distribution

### Issue: scCODA reference selection changes results dramatically
**Cause:** No truly stable cell type, or small sample size  
**Fix:** Test multiple references, report sensitivity, use "automatic" mode

### Issue: DE and compositional results disagree
**Cause:** Different questions (expression vs abundance)  
**Fix:** Interpret correctly—both can be true (cell type increases but genes downregulated)

## Available AOSE Tools

```bash
# Check DE/composition tools
aos bio list-tools | grep -E "deseq|de_test|composition"
```

- `bio_rank_genes_groups` - Basic Wilcoxon DE (scanpy)
- `bio_pydeseq2` - PyDESeq2 pseudobulk DE (if installed)
- `bio_milo` - Milo differential abundance (if milopy installed)
- `bio_sccoda` - scCODA compositional analysis (if sccoda installed)

## References

- PyDESeq2: Muzellec et al. bioRxiv 2022 (Python port of DESeq2)
- DESeq2: Love et al. Genome Biology 2014
- Milo: Dann et al. Nature Biotechnology 2021
- scCODA: Buttner et al. Nature Communications 2021
- Compositional data analysis: Aitchison 1986

## When to Seek Expert Help

- Complex experimental designs (time-series, multi-factor, nested)
- Small sample sizes (n<3 per group)
- Confounded designs (batch == condition)
- Interpreting compositional shifts in context
- Power analysis for future experiments
- Integration with proteomics or other modalities
