# Reference — scRNA → Protein Translation (CITE-seq Prediction)

Predicting surface-protein abundance from RNA-only single-cell data. The task: given scRNA-seq, output a protein-abundance matrix matching a CITE-seq panel.

## The task & output contract

**Input:** scRNA-seq AnnData (RNA counts only).
**Output:** protein-abundance matrix, shape `(n_cells, n_proteins)` — exact shape matters (e.g., `(1618, 224)`).
**Evaluation:** per-protein correlation (Pearson/Spearman) or per-cell cosine similarity vs held-out measured protein.

## Model options (escape-hatch ladder)

| Model | Approach | Typical performance | Compute |
|-------|----------|---------------------|---------|
| **scTranslator** | Transformer, mega-pretrained | ~0.94 cosine (SOTA) | 1 month × 32 GPU pretrain (infeasible to reproduce) |
| **sciPENN** | RNN + transfer learning | ~0.89 cosine | GPU minutes |
| **totalVI** | VAE (joint RNA+protein) | ~0.85–0.88 correlation | GPU minutes–hours |

**Escape-hatch guidance:** scTranslator's SOTA requires pretraining you cannot reproduce. **Start with sciPENN or totalVI** — they reach 0.85–0.89, close enough to clear most bars. Only invest in a transformer if the target metric is >0.90 AND simpler models fall short.

## totalVI (scvi-tools)

totalVI jointly models RNA + protein. For prediction, train on cells with both modalities, then impute protein for RNA-only cells:

```python
import scvi
import scanpy as sc

# adata has RNA in .X (counts) and protein in .obsm["protein_expression"]
scvi.model.TOTALVI.setup_anndata(
    adata,
    protein_expression_obsm_key="protein_expression",
    layer="counts",
    batch_key="batch",
)
model = scvi.model.TOTALVI(adata)
model.train(max_epochs=400)

# Impute protein for query cells (RNA-only)
_, protein_pred = model.get_normalized_expression(
    adata_query, n_samples=25, return_mean=True
)
# protein_pred: (n_cells, n_proteins)
```

## sciPENN

sciPENN is purpose-built for RNA→protein transfer across datasets:

```bash
pip install sciPENN
```

```python
from sciPENN.sciPENN_API import sciPENN_API

# train_rna/train_protein = reference (both modalities); test_rna = query (RNA-only)
scipenn = sciPENN_API(
    gene_trainsets=[train_rna],
    protein_trainsets=[train_protein],
    gene_test=test_rna,
)
scipenn.train(n_epochs=10000, ES_max=12, decay_max=6, decay_step=0.1, lr=1e-3)
predicted = scipenn.predict()   # (n_cells, n_proteins) AnnData
```

## Evaluation

Match the evaluator's metric exactly:

```python
import numpy as np
from scipy.stats import pearsonr

# Per-protein Pearson
per_protein_r = [
    pearsonr(pred[:, i], truth[:, i])[0]
    for i in range(pred.shape[1])
]
mean_r = np.mean(per_protein_r)

# Per-cell cosine (if that's the metric)
from numpy.linalg import norm
per_cell_cos = [
    np.dot(pred[c], truth[c]) / (norm(pred[c]) * norm(truth[c]))
    for c in range(pred.shape[0])
]
```

Report **both** per-protein and per-cell if unsure which the evaluator uses.

## Gene/protein alignment

The query RNA must share genes with the training set; the output proteins must match the target panel order:

```python
# Align genes (intersection), reorder proteins to match evaluator's expected order
common_genes = train_rna.var_names.intersection(test_rna.var_names)
# Ensure output columns == evaluator's protein list, same order
predicted = predicted[:, evaluator_protein_order]
```

## Pitfalls

- **Wrong output shape** — evaluator expects exact `(n_cells, n_proteins)`; verify with `.shape`
- **Protein column order mismatch** — reorder to the evaluator's panel
- **Normalizing RNA before the model** — totalVI/sciPENN want raw counts
- **Chasing scTranslator SOTA** — the pretrain is infeasible; sciPENN/totalVI are the tractable path
- **Wrong metric** — per-cell cosine ≠ per-protein Pearson; check the evaluator

## Grounding

`report`: model used, output shape, per-protein mean correlation + per-cell cosine, gene/protein alignment applied, comparison to SOTA (and why the tractable model was chosen).
