---
name: single-cell
description: Single-cell omics analysis (RNA-seq, ATAC-seq, multiome) — QC, preprocessing, integration, clustering, annotation, trajectory, cell-cell communication, chromatin accessibility, joint embeddings. Use when the user asks to analyze single-cell RNA-seq data (scRNA-seq, 10x), single-cell ATAC-seq (scATAC-seq, chromatin accessibility), or paired multiome (RNA+ATAC) datasets.
requiredTools: [run_python, create_notebook, add_cell, observe_figure, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, single-cell, scrna, scatac, multiome, scanpy, scverse, muon, snapatac2]
extends: omics-shared
---

# Single-Cell Omics Analysis

Single-cell analysis routes through **modality-specific subskills** based on the data type. This parent skill provides shared foundations and routing. All single-cell work builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply).

---

## Routing: Which Subskill?

Identify the data modality and read the appropriate subskill:

| Your data | Subskill | When to use |
|-----------|----------|-------------|
| **scRNA-seq** (single-cell RNA) | `rna/SKILL.md` | Gene expression from 10x, Drop-seq, SMART-seq, etc. Count matrices, h5ad/h5. |
| **scATAC-seq** (single-cell ATAC) | `atac/SKILL.md` | Chromatin accessibility. Fragment files, peak/tile matrices. |
| **Multiome** (paired RNA+ATAC) | `multiome/SKILL.md` | Simultaneously measured RNA+ATAC from the same nuclei. MuData with both modalities. |

**Don't guess the modality.** If the user says "single-cell" without specifying, ask or infer from file extensions (`.h5ad` with gene counts = scRNA; `fragments.tsv.gz` = scATAC; `.h5mu` or mention of "multiome/paired" = multiome).

After identifying the modality, **read the corresponding subskill** for detailed guidance. The subskills are chapters of this skill and cannot be invoked independently.

---

## Shared Single-Cell Foundations

These conventions apply across all three modalities (scRNA, scATAC, multiome):

### 1. Standard Workflow Pattern

Every single-cell analysis follows this sequence:

1. **Preflight** — `omics_preflight(modality="scrna"|"scatac"|"multiome")` validates the environment
2. **Load & summarize** — Load data → `omics_compute summarize` → thread context forward
3. **QC & preprocessing** — Filter low-quality cells/features, normalize (modality-specific)
4. **Dimensionality reduction** — PCA (scRNA), LSI (scATAC), or joint embedding (multiome)
5. **Clustering** — Neighbors graph → Leiden/Louvain
6. **Annotation** — Cell-type labels via markers (scRNA/multiome) or gene-activity proxy (scATAC)
7. **Downstream** — DE, trajectory, cell-cell communication, etc.
8. **Visualize & ground** — UMAP plots → `observe_figure` → cite evidence

### 2. The `omics_compute` Tool

Run compute through **`omics_compute(modality=..., subcommand=..., args=...)`** for standardized steps:
- Dispatches into pinned pixi environments (`task1`/scRNA, `task3`/multiome, `task4`/scATAC)
- Records evidence automatically via `EvidenceRecord`
- Deterministic, tested implementations

Available subcommands depend on modality — see the subskill for details.

### 3. AnnData Container Conventions

All modalities use **AnnData** (scRNA/scATAC) or **MuData** (multiome):

```python
adata.layers["counts"]     # raw counts (preserve!)
adata.X                    # normalized/transformed for embedding
adata.obs["leiden"]        # cluster assignments
adata.obs["cell_type"]     # final annotations
adata.obsm["X_pca"]        # PCA embedding (scRNA)
adata.obsm["X_umap"]       # UMAP for visualization
adata.var_names            # feature names (genes for scRNA, peaks/tiles for scATAC)
```

Never overwrite `layers["counts"]` — downstream methods need raw counts.

### 4. Integration & Batch Effects

- **Only integrate if batch effects are visible** — compare UMAP before/after
- **Validate integration** — compute ARI/NMI against known labels; if biology degrades, keep unintegrated
- **scRNA integration** — Harmony (default), scVI/scANVI (GPU-dependent)
- **scATAC integration** — SnapATAC2 Harmony on spectral embedding
- **Multiome** — joint embedding via WNN or MultiVI handles batch implicitly

Document the integration method and validation metrics.

### 5. Annotation Principles

- **Abstain over guess** — label ambiguous clusters "unknown", never fabricate cell types
- **Ground in markers** — scRNA uses gene expression markers; scATAC uses gene-activity proxy
- **Two routes (scRNA/multiome)**:
  - Route 1 (default): marker table → LLM labeling with study context
  - Route 2: reference-based pipeline when labeled atlas exists
- **Transfer labels (scATAC)** — use gene-activity bridge to transfer from scRNA reference

### 6. Evidence & Grounding Rules (from omics-shared)

- Every quantitative claim → `EvidenceRecord` or tool output
- Every plot → `observe_figure` before conclusions
- Report: cells/features retained, QC thresholds, embedding dimensions, cluster count
- Preserve provenance: raw counts, processing steps, parameter choices

### 7. When Things Go Wrong

Common failure modes across modalities:

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| **>50% cells dropped in QC** | Thresholds too strict or low-quality data | Use adaptive MAD thresholds; document quality; consider keeping if biologically real |
| **Clusters track technical variables** | QC metrics (n_counts, pct_mito) dominate biology | Revisit QC filtering; regress technical covariates |
| **Non-specific markers** | Over-clustering | Lower resolution, increase n_neighbors, re-cluster |
| **Integration hurts biology** | Batch correction too aggressive | Compare ARI/NMI; use unintegrated if integration degrades known structure |
| **Ambiguous annotation** | Markers overlapping or missing | Label "unknown"; document marker patterns; request reference or better markers |

---

## Next Steps

You've identified the modality. Now **read the corresponding subskill**:

- **scRNA-seq** → `rna/SKILL.md`
- **scATAC-seq** → `atac/SKILL.md`
- **Multiome (RNA+ATAC)** → `multiome/SKILL.md`

Each subskill provides modality-specific:
- Prerequisites & data formats
- Capability menu with maturity labels
- Detailed workflow with exact `omics_compute` calls
- Method documentation references
- Modality-specific rules & troubleshooting

The subskills assume you've read this parent skill first.
