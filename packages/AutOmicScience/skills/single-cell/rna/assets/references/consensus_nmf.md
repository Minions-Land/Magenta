# Reference — Consensus NMF (Gene Program Discovery)

Consensus non-negative matrix factorization (cNMF) discovers recurrent gene programs (meta-programs) across cells via repeated NMF with stability scoring.

## Goal

Identify interpretable gene modules (programs) that capture biological variation (cell states, pathways, spatial niches) beyond discrete cell types. A "program" = a ranked gene set co-expressed across a subset of cells.

## The NMF problem

Given a gene × cell matrix X, factor it as X ≈ W × H, where:
- **W** (genes × k): gene-loading matrix (programs as gene sets)
- **H** (k × cells): cell-usage matrix (how much each cell uses each program)
- k = rank (number of programs)

Challenge: **rank selection** — how many programs (k)?

## Consensus NMF algorithm

1. Run NMF multiple times (50–100 replicates) for each candidate k
2. For each k, cluster the resulting W matrices (program stability)
3. Compute **cophenetic coefficient** — measures clustering stability (0–1 scale)
4. Pick k where cophenetic peaks or plateaus (elbow)

```python
from sklearn.decomposition import NMF
import numpy as np
from scipy.cluster.hierarchy import linkage, cophenet
from scipy.spatial.distance import pdist

def consensus_nmf(X, k, n_replicates=50):
    """Run consensus NMF for rank k"""
    W_list = []
    for _ in range(n_replicates):
        model = NMF(n_components=k, init='nndsvda', max_iter=500, random_state=None)
        W = model.fit_transform(X)
        W_list.append(W)
    # Stack and cluster
    W_stack = np.concatenate(W_list, axis=1)  # genes × (k*n_replicates)
    # Pairwise correlation between program replicates
    corr = np.corrcoef(W_stack.T)
    # Hierarchical clustering
    Z = linkage(pdist(corr), method='average')
    c, _ = cophenet(Z, pdist(corr))
    return c, W_list  # cophenetic coef, replicate W matrices

# Scan k
k_range = range(3, 16)
cophenetic = {}
for k in k_range:
    c, _ = consensus_nmf(X, k, n_replicates=50)
    cophenetic[k] = c
# Plot cophenetic vs k; pick k at the elbow/peak
```

## cnmf package (alternative)

The `cnmf` Python package automates this:

```bash
pip install cnmf
```

```python
from cnmf import cNMF
import scanpy as sc

# Prepare: highly-variable genes only
sc.pp.highly_variable_genes(adata, n_top_genes=2000)
counts = adata[:, adata.var.highly_variable].X.toarray()

# Run cnmf
cnmf_obj = cNMF(output_dir="./cnmf_output", name="programs")
cnmf_obj.factorize(counts, k_range=(5, 15), n_iter=100)
cnmf_obj.combine()
cnmf_obj.consensus(k=10, density_threshold=0.1)
# Load results
usage = cnmf_obj.load_usage(k=10)          # cells × programs
programs = cnmf_obj.load_gene_spectra(k=10)  # programs × genes
```

## Interpreting programs

Top genes per program (rank by loading):

```python
top_genes_per_program = {}
for i in range(k):
    genes_ranked = W[:, i].argsort()[::-1][:50]  # top 50 genes
    top_genes_per_program[f"Program_{i+1}"] = gene_names[genes_ranked]
```

Annotate via pathway enrichment (MSigDB Hallmark, Reactome):

```python
import gseapy as gp
enr = gp.enrichr(gene_list=top_genes_per_program["Program_1"], gene_sets='MSigDB_Hallmark_2020')
```

## Metaprograms (cross-dataset consensus)

Run cNMF on multiple datasets separately, then cluster the resulting programs across datasets to find conserved **metaprograms** (e.g., interferon-response, cell-cycle, hypoxia recurring across cohorts).

## Pitfalls

- **Not filtering to HVGs** — all genes inflates dimensionality, dilutes signal
- **k too low** — underfits, lumps distinct programs
- **k too high** — overfits, splits one program into redundant subprograms
- **Ignoring cophenetic plateau** — picking k at a local wobble instead of the stable region
- **No pathway annotation** — raw gene lists are hard to interpret; always enrich

## Grounding

`report`: k selected (cophenetic score), per-program top 20 genes, pathway enrichments, cell-usage UMAP (colored by program scores).
