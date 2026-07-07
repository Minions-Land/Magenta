---
name: single-cell-annotation
description: >
  Best practices for annotating cell types in single-cell RNA-seq data using
  marker-based, automated, and reference-based approaches. Distilled from
  "Single-cell best practices" by Luecken, M.D. et al. covering manual
  marker gene analysis, automated classifiers, and reference label transfer.
tags:
- single-cell
- scRNA-seq
- annotation
- cell-types
- scanpy
source: Biomni
license: CC-BY-4.0
metadata:
  display-name: Single-Cell Annotation
  authors: Distilled from Luecken, M.D., Theis, F.J. et al.
  affiliations: Helmholtz Munich, Wellcome Sanger Institute, Harvard Medical School
  version: "1.0"
  last-updated: "2025-01"
  commercial-use: allowed
  original-source: https://www.sc-best-practices.org/cellular_structure/annotation.html
---

# Single-Cell RNA-seq Cell Type Annotation

Best practices for annotating cell types in single-cell RNA-seq data using marker-based, automated, and reference-based approaches.

## Overview

Cell type annotation is the process of assigning cell type labels to clusters or individual cells in single-cell RNA-seq data. This guide covers three main approaches and their practical implementation.

## Three Annotation Approaches

### 1. Manual Marker-Based Annotation

Identify cell types by examining expression of known marker genes in each cluster.

**Tools**: Scanpy, Seurat  
**Best for**: Small datasets, novel cell types, high confidence needs

**Workflow**:
```python
import scanpy as sc

# Visualize marker genes
sc.pl.dotplot(adata, marker_genes, groupby='leiden')
sc.pl.stacked_violin(adata, marker_genes, groupby='leiden')

# Examine top genes per cluster
sc.tl.rank_genes_groups(adata, 'leiden', method='wilcoxon')
sc.pl.rank_genes_groups(adata, n_genes=20)

# Assign labels
cluster_annotations = {
    '0': 'T cells',
    '1': 'B cells',
    '2': 'Monocytes',
    # ...
}
adata.obs['cell_type'] = adata.obs['leiden'].map(cluster_annotations)
```

**Key Resources**:
- **PanglaoDB**: https://panglaodb.se/markers.html
- **CellMarker**: http://biocc.hrbmu.edu.cn/CellMarker/
- **Human Protein Atlas**: https://www.proteinatlas.org/

**Tips**:
- Use multiple markers per cell type
- Check negative markers (genes NOT expressed)
- Validate with known biology
- Consider tissue context

### 2. Automated Annotation

Use pre-trained classifiers to automatically assign cell type labels.

**Tools**: CellTypist, scAnnotate  
**Best for**: Standard tissues, quick preliminary annotation, large datasets

**CellTypist Workflow**:
```python
import celltypist
from celltypist import models

# Download model
models.download_models(force_update=True, model='Immune_All_Low.pkl')

# Load model
model = models.Model.load(model='Immune_All_Low.pkl')

# Predict
predictions = celltypist.annotate(
    adata, 
    model='Immune_All_Low.pkl',
    majority_voting=True
)

# Transfer labels
adata.obs['celltypist'] = predictions.predicted_labels
```

**Available Models**:
- **Immune_All**: Pan-immune cell atlas
- **Healthy_Adult**: Adult human tissues
- **COVID19**: COVID-19 immune response
- **Pan_Fetal**: Fetal development
- Custom: Train your own

**Pros**:
- Fast and reproducible
- No expert knowledge needed
- Handles large datasets

**Cons**:
- Limited to trained cell types
- May miss novel populations
- Model-dependent accuracy

### 3. Reference-Based Label Transfer

Transfer labels from annotated reference datasets to your query data.

**Tools**: scArches, scANVI, Azimuth, SingleR  
**Best for**: Well-characterized tissues, integration with public data

**scANVI Workflow**:
```python
import scvi

# Prepare reference (already annotated)
scvi.model.SCVI.setup_anndata(reference_adata, batch_key='batch')
reference_model = scvi.model.SCVI(reference_adata)
reference_model.train()

# Setup scANVI with labels
scvi.model.SCANVI.setup_anndata(
    reference_adata, 
    batch_key='batch',
    labels_key='cell_type'
)
scanvi_model = scvi.model.SCANVI.from_scvi_model(
    reference_model,
    unlabeled_category='Unknown'
)
scanvi_model.train()

# Transfer to query
scvi.model.SCANVI.prepare_query_anndata(query_adata, scanvi_model)
query_model = scvi.model.SCANVI.load_query_data(query_adata, scanvi_model)
query_model.train()

# Get predictions
query_adata.obs['predicted_cell_type'] = query_model.predict()
```

**SingleR Workflow** (simpler):
```python
import scanpy as sc
import anndata as ad

# Using SingleR via rpy2
import rpy2.robjects as ro
from rpy2.robjects.packages import importr

# Load reference
ref_adata = sc.read_h5ad('reference.h5ad')

# Run SingleR
singler = importr('SingleR')
predictions = singler.SingleR(
    test=query_adata.X,
    ref=ref_adata.X,
    labels=ref_adata.obs['cell_type']
)

query_adata.obs['singler_labels'] = predictions
```

**Public References**:
- **Azimuth references**: https://azimuth.hubmapconsortium.org/references/
- **CELLxGENE**: https://cellxgene.cziscience.com/
- **Human Cell Atlas**: https://www.humancellatlas.org/

## Choosing the Right Approach

| Criterion | Marker-Based | Automated | Reference-Based |
|-----------|--------------|-----------|-----------------|
| **Expertise needed** | High | Low | Medium |
| **Speed** | Slow | Fast | Medium |
| **Novel cell types** | ✓ | ✗ | ✗ |
| **Reproducibility** | Low | High | High |
| **Tissue specificity** | ✓ | Limited | ✓ |
| **Large datasets** | Difficult | ✓ | ✓ |

## Hybrid Approach (Recommended)

1. **Start with automated**: Get quick preliminary labels
2. **Refine with markers**: Validate and correct errors
3. **Use reference**: For well-studied tissues
4. **Manual curation**: Final check and novel types

```python
# 1. Automated first pass
predictions = celltypist.annotate(adata, model='Immune_All_Low.pkl')
adata.obs['auto_annotation'] = predictions.predicted_labels

# 2. Check with markers
marker_genes = {
    'T cells': ['CD3D', 'CD3E'],
    'B cells': ['CD19', 'MS4A1'],
    'Monocytes': ['CD14', 'FCGR3A']
}
sc.pl.dotplot(adata, marker_genes, groupby='auto_annotation')

# 3. Manual correction
corrections = {
    'cluster_5': 'NK cells'  # Automated missed this
}
adata.obs['final_annotation'] = adata.obs['auto_annotation'].copy()
for cluster, label in corrections.items():
    mask = adata.obs['leiden'] == cluster
    adata.obs.loc[mask, 'final_annotation'] = label
```

## Quality Control

### Check Annotation Quality

1. **Marker expression**: Do canonical markers match labels?
```python
sc.pl.dotplot(adata, marker_genes, groupby='cell_type')
```

2. **Cluster composition**: Are labels consistent within clusters?
```python
import pandas as pd
pd.crosstab(adata.obs['leiden'], adata.obs['cell_type'])
```

3. **Doublet detection**: Are mixed labels actually doublets?
```python
import scrublet
scrub = scrublet.Scrublet(adata.X)
doublet_scores, predicted_doublets = scrub.scrub_doublets()
adata.obs['doublet_score'] = doublet_scores
```

4. **Expression coherence**: Do cells of same type cluster together?
```python
sc.pl.umap(adata, color='cell_type')
```

### Common Issues

**Mixed clusters**:
- May need finer resolution clustering
- Check for batch effects
- Consider doublets

**Conflicting markers**:
- Cell state vs. cell type (activated, stressed, etc.)
- Transitional populations
- Technical artifacts

**Low confidence predictions**:
- Insufficient reference coverage
- Novel cell type not in training
- Poor data quality

## Best Practices

1. **Use multiple evidence sources**: Combine approaches
2. **Validate thoroughly**: Check markers, literature, biology
3. **Document decisions**: Keep annotation rationale
4. **Version control**: Track annotation changes
5. **Share annotations**: Contribute to community resources
6. **Be conservative**: "Unknown" is better than wrong label
7. **Consider hierarchy**: Broad → specific (Immune → T cell → CD8+ T cell)

## Advanced Topics

### Hierarchical Annotation

```python
# Broad categories first
adata.obs['cell_type_broad'] = adata.obs['leiden'].map({
    '0': 'Immune',
    '1': 'Immune',
    '2': 'Epithelial',
    '3': 'Stromal'
})

# Then subdivide
immune_mask = adata.obs['cell_type_broad'] == 'Immune'
immune_adata = adata[immune_mask].copy()
# Re-cluster and annotate immune subset
```

### Cell State Annotation

Beyond cell type, annotate cell states:
- Activation state
- Cell cycle phase
- Stress response
- Differentiation stage

```python
# Cell cycle scoring
sc.tl.score_genes_cell_cycle(adata, s_genes, g2m_genes)

# Custom state scores
stress_genes = ['HSP90AA1', 'HSPA1A', 'HSPA1B']
sc.tl.score_genes(adata, stress_genes, score_name='stress_score')
```

## Resources

### Marker Databases
- **PanglaoDB**: https://panglaodb.se/
- **CellMarker**: http://biocc.hrbmu.edu.cn/CellMarker/
- **Human Protein Atlas**: https://www.proteinatlas.org/

### Tools
- **CellTypist**: https://www.celltypist.org/
- **scANVI**: https://docs.scvi-tools.org/
- **Azimuth**: https://azimuth.hubmapconsortium.org/
- **SingleR**: https://bioconductor.org/packages/SingleR/

### References
- **CELLxGENE**: https://cellxgene.cziscience.com/
- **Human Cell Atlas**: https://www.humancellatlas.org/
- **Tabula Sapiens**: https://tabula-sapiens-portal.ds.czbiohub.org/

### Literature
- **Luecken et al. (2023)**: "Current best practices in single-cell RNA-seq analysis" Mol Syst Biol
- **Original guide**: https://www.sc-best-practices.org/cellular_structure/annotation.html

## Citation

If you use this guide:
```
Biomni single-cell annotation guide, adapted from:
Luecken, M.D., Theis, F.J. et al. (2023). Current best practices in 
single-cell RNA-seq analysis: a tutorial. Molecular Systems Biology.
```

## License

CC BY 4.0 - Commercial use allowed with attribution
