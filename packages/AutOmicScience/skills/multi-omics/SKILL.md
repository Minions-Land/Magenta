---
name: multi-omics
description: Single-cell multiome (paired RNA + ATAC) — MuData assembly, per-modality preprocess, joint embedding (WNN / MultiVI), joint clustering & annotation, chromatin-aware velocity (MultiVelo), eGRN (SCENIC+), cross-modal interpretation.
requiredTools: [run_python, create_notebook, add_cell, observe_figure, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [multiome, multimodal, rna, atac, scverse, mudata, muon, single-cell]
extends: omics-shared
---

# Single-Cell Multiome (RNA + ATAC) Analysis

Paired RNA + ATAC from the same nuclei. Reuses the scRNA and scATAC per-modality recipes, adds joint modeling. Run compute through the **`omics_compute`** tool with `modality="multiome"` (dispatches into the pinned `task3` env, records evidence).

## Prerequisites

1. **Preflight**: `omics_preflight(modality="multiome")` must pass
2. **Shared foundation**: Load `omics-shared` first
3. **Data format**: MuData with paired cells, or separate RNA/ATAC AnnData to assemble
4. **Per-modality knowledge**: Familiar with the scRNA and scATAC recipes

## Capability Menu

| Capability | When to Use | Documentation |
|------------|-------------|---------------|
| **Load & Assemble** | Build validated paired MuData from various sources | `method/load_multiome.md` |
| **Per-Modality Preprocess** | Reuse P1/P3 recipes on each modality before joining | `method/per_modality_preprocess.md` |
| **Joint Embedding** | Combine modalities into one cell representation (WNN/MultiVI) | `method/joint_embedding.md` |
| **Joint Cluster & Annotate** | Cluster on joint rep; label via two routes (marker+LLM / reference) | `method/joint_cluster_annotate.md` |
| **Multiome Velocity** | Chromatin-informed RNA velocity (MultiVelo, external env) | `method/multiome_velocity.md` |
| **eGRN & Regulation** | TF→region→gene eGRN + region-gene linkage (SCENIC+, external pipeline) | `method/regulation.md` |
| **Cross-Modal Interpretation** | Modality weights (which modality drives a population); peak-gene & eGRN → `regulation.md` | `method/cross_modality.md` |

## Global Rules

1. **Preflight first**: `omics_preflight(modality="multiome")` before compute
2. **Reuse scRNA/scATAC**: Don't re-derive uni-modal steps - point to those recipes
3. **Ground every claim**: All quantitative results → `EvidenceRecord`
4. **Observe figures**: `observe_figure` on every plot before conclusions
5. **Earn joint embedding**: Compare against single-modality baselines (ARI/NMI) - only claim improvement if measured
6. **Abstain over fabricate**: Missing data/deps → structured blocker, not guess
7. **Heavy methods expensive**: MultiVI/MultiVelo/SCENIC+ - start small, sanity-check, scale
8. **Write to workdir**: `runs/omics/<id>/` for reproducibility

## Container Structure

MuData with modalities under `.mod`:
```python
mdata.mod['rna']   # RNA AnnData
mdata.mod['atac']  # ATAC AnnData
mdata.obs          # Shared cell metadata
```

Per conventions (§6): counts in `layers["counts"]`, embeddings in `obsm["X_*"]`, clusters in `obs["leiden"]`, labels in `obs["cell_type"]`

## Standard Workflow

1. **Load/Assemble** → validated MuData with shared barcodes
2. **Per-Modality Preprocess** → RNA (QC/norm/HVG/PCA), ATAC (QC/features/embedding)
3. **Joint Embedding** → WNN or MultiVI latent space
4. **Joint Cluster** → Leiden on joint representation
5. **Annotate** → marker+LLM or FM pipeline
6. **Cross-Modal Analysis** → peak-gene links, TF activity, regulatory interpretation

## Compute Dispatch

Run compute through the **`omics_compute`** tool with `modality="multiome"`:
```python
# Available subcommands:
#   - load_multiome: Assemble/validate paired MuData
```

Joint embedding (WNN / MultiVI) is hand-rolled `muon` in `run_python`; velocity (MultiVelo) and eGRN (SCENIC+) run as external pipelines in isolated envs — see the method docs.
