# RNA Integration & Label Transfer

**Maturity: REFERENCE** — gene-activity bridge + the scRNA integration/label-transfer recipes, hand-rolled in `run_python`.

## Goal / When to Use

Assign cell-type labels to ATAC clusters using a labeled scRNA reference (the common way to name ATAC populations). Use after clustering exists and you have a suitable reference.

## Decision Criteria

**The judgment this guides:**

- **The bridge is gene activity** (from `gene_activity.md`) — convert ATAC to gene space, then integrate with the scRNA reference in that shared space and transfer labels.

- **Method for the shared space** — **scVI/scANVI-style or ingest/kNN label transfer** reusing the **scRNA integration recipe** (`task/scrna/skills/omics-scrna/method/integration.md`). Choose by reference size and batch:
  - Small reference, no batch → simple kNN in PCA/UMAP space
  - Large reference, batch → scVI-style integration (e.g., scANVI for semi-supervised transfer)

- **Gene activity is noisy**, so **treat transferred labels as hypotheses** confirmed by marker peaks / motifs in the target ATAC data. Do not blindly trust the transfer.

- **This is Route-1 interpretation support** — the reference annotation pipeline (`run_annotation_pipeline`) remains a separate callable instrument for reference-based consensus when desired.

## Method Menu

- **Gene-activity bridge** (`gene_activity.md`) + **scRNA integration/label-transfer** (`omics-scrna`: `integration.md` + `annotation.md`)
- **Reference annotation pipeline** (`run_annotation_pipeline`) — for reference-based consensus

## How-to

### Build gene-activity matrix (inline)

```python
import snapatac2 as snap
import scanpy as sc

# Gene activity from ATAC (reuse gene_activity.md recipe)
ga = snap.pp.make_gene_matrix(
    adata,
    gene_anno=genome,
    include_gene_body=True,
    upstream=2000,
    downstream=0
)

# Sanity check: not all-zero
assert ga.X.sum() > 0, "Gene-activity matrix is all-zero — wrong genome/annotation"

# Normalize
ga.layers['counts'] = ga.X.copy()
sc.pp.normalize_total(ga, target_sum=1e4)
sc.pp.log1p(ga)
# ga.X now holds log-normalized gene activity
```

### Integrate with scRNA reference (reuse the scRNA recipes)

The agent **reads `task/scrna/skills/omics-scrna/method/integration.md`** and **`annotation.md`** — they are already written and cover:
- HVG selection on the shared space
- Integration (Harmony / BBKNN / Scanorama / scVI)
- Label transfer (kNN / scANVI ingest / consensus)

**Example (simple kNN transfer):**

```python
# Assume you have a reference with labels
# adata_ref.obs['cell_type'] = ['T cell', 'B cell', ...]

# Find shared genes
shared_genes = ga.var_names.intersection(adata_ref.var_names)
print(f"Shared genes: {len(shared_genes)}")

if len(shared_genes) < 100:
    print("Warning: very few shared genes — transfer will be unreliable")

# Subset to shared genes
ga_sub = ga[:, shared_genes].copy()
ref_sub = adata_ref[:, shared_genes].copy()

# Concatenate for joint PCA
import anndata
adata_concat = anndata.concat([ref_sub, ga_sub], label='modality', keys=['ref', 'query'])

# Joint PCA + neighbors
sc.pp.pca(adata_concat)
sc.pp.neighbors(adata_concat)

# Transfer labels via kNN majority vote
from collections import Counter
ref_labels = ref_sub.obs['cell_type'].values
query_indices = adata_concat.obs['modality'] == 'query'
ref_indices = adata_concat.obs['modality'] == 'ref'

# For each query cell, find k nearest ref neighbors
from scipy.sparse import csr_matrix
import numpy as np

knn_graph = adata_concat.obsp['connectivities']  # neighbors graph
transferred_labels = []

for i in np.where(query_indices)[0]:
    neighbors = knn_graph[i, ref_indices].toarray().flatten()
    top_k_idx = np.argsort(-neighbors)[:10]  # top 10 neighbors
    neighbor_labels = ref_labels[top_k_idx]
    majority = Counter(neighbor_labels).most_common(1)[0][0]
    transferred_labels.append(majority)

ga.obs['transferred_cell_type'] = transferred_labels
```

### Compare against ATAC marker peaks

```python
# Compute marker peaks for the transferred labels.
# Build a cell × peak matrix first via the peak_calling subcommand (see peak_calling.md):
# omics_runtime(subcommand="peak_calling", modality="scatac", args={...})  -> adata_peaks

# Transfer the labels to the peak matrix
adata_peaks.obs['transferred_cell_type'] = ga.obs['transferred_cell_type']

# Marker peaks per transferred type
snap.tl.marker_regions(adata_peaks, groupby='transferred_cell_type')
# Compare: do the marker peaks make sense for the transferred labels?
```

## Pitfalls & Quality Checks

- **Feature/gene-name mismatch** between activity matrix and reference — if gene symbols differ (e.g., uppercase vs mixed-case), mapping will fail. Harmonize gene names before integration.

- **Batch between modalities** — ATAC vs RNA is itself a batch effect. Integration methods like Harmony/scVI can handle it, but simple PCA concatenation may give modality-driven splits rather than biological clusters.

- **Do not over-trust activity-derived labels** — gene activity is a rough proxy for expression. Validate transferred labels with ATAC-specific evidence (marker peaks, motif enrichment). If a transferred label contradicts the ATAC markers, the transfer is wrong.

- **Compare against any pre-existing `obs` labels only post-hoc** (avoid circular reasoning) — never copy an existing label column as the answer.

- **`observe_figure`** — a UMAP of the gene-activity space colored by transferred labels. Do clusters segregate by label, or is it noisy? A second UMAP of the peak space with the same labels — do ATAC clusters match the transferred types?

## Grounding

**What to record as `EvidenceRecord`:**

```python
{
  "method": "gene_activity_knn_transfer",
  "reference_source": "PBMC_scRNA_atlas",
  "n_reference_cells": 50000,
  "n_shared_genes": 8000,
  "n_query_cells": 5000,
  "transferred_labels": {
    "T cell": 1200,
    "B cell": 800,
    "Myeloid": 600,
    ...
  },
  "per_cluster_confidence": {
    "0": "high (marker peaks consistent)",
    "1": "medium (weak marker overlap)",
    "2": "low (contradicts ATAC markers)"
  },
  "marker_peak_validation": {
    "T cell": ["chr14:peak_12345 near TCF7", "chr10:peak_67890 near LEF1"],
    ...
  }
}
```

Ground: n transferred labels, per-cluster confidence, overlap with marker evidence.

## Honesty

- **Abstain on low-confidence clusters** — if a cluster's transferred label contradicts its marker peaks (e.g., labeled "T cell" but marker peaks near epithelial TFs), flag it as "uncertain / contradictory" rather than accepting the transfer.

- **Gene activity is a proxy, not expression** — state that clearly. "Transferred label suggests T cell (via gene activity); marker peaks near TCF7/LEF1 support this" is honest. "Transferred label proves T cell" over-claims.

- **Small shared-gene set → unreliable transfer** — if fewer than ~100 genes overlap, or if the overlap is all housekeeping genes, the transfer has little biological signal. Report that and lower confidence accordingly.

- **Cross-modality transfer is hypothesis-generating** — it's a starting point for annotation, not ground truth. Always validate with ATAC-specific evidence (peaks, motifs) before building claims on the transferred labels.
