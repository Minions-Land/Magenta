# Joint Embedding

**Maturity: REFERENCE** — no runtime subcommand; a few lines of `muon` in `run_python` (ground via `evidence_from_kernel_cell`). Produce **one cell representation** fusing RNA + ATAC for joint clustering and visualization. Works on the **MuData** directly.

## Decision Criteria — pick one default

- **Default: WNN (Weighted Nearest Neighbors).** Fast, interpretable, **per-cell modality-weighted** joint graph from pre-computed per-modality embeddings. No training. The right baseline for almost all paired data.
- **MultiVI (PARTIAL — deep, GPU).** Probabilistic joint latent via a VAE on **raw counts**; handles batch and optional missing-modality cells. Use only when you need batch correction / a generative model and have a GPU.

Both need paired cells (a MuData with `mod["rna"]` + `mod["atac"]`).

## How-to (default — WNN)

Prerequisite: per-modality embeddings already computed (RNA: `X_pca`; ATAC: `X_spectral`/`X_lsi` — see `per_modality_preprocess.md`). Real muon WNN operates on the **MuData**:

```python
import muon as mu
import scanpy as sc

# 1. per-modality neighbor graphs first (on each modality's embedding)
sc.pp.neighbors(mdata["rna"],  use_rep="X_pca")
sc.pp.neighbors(mdata["atac"], use_rep="X_spectral")

# 2. WNN: learns per-cell modality weights and builds the joint graph
mu.pp.neighbors(mdata)                      # weighted joint graph + per-cell modality weights in mdata.obs
mu.tl.umap(mdata)                           # joint UMAP -> mdata.obsm["X_umap"]
mu.tl.leiden(mdata, resolution=1.0, key_added="leiden")
```

This is real WNN (Hao 2021): `mu.pp.neighbors` learns the weights. **Do not hand-average the two graphs** (`0.5*rna + 0.5*atac` is *not* WNN — it ignores per-cell modality reliability). Inspect the modality-weight columns it writes to `mdata.obs` (see `cross_modality.md`).

## MultiVI (PARTIAL — GPU)

Raw counts in both modalities; `modalities=` maps which mod is which (required):

```python
import scvi
scvi.model.MULTIVI.setup_mudata(
    mdata, modalities={"rna_layer": "rna", "atac_layer": "atac"}, batch_key="batch")
model = scvi.model.MULTIVI(mdata)
model.train()
mdata.obsm["X_multivi"] = model.get_latent_representation()
mu.pp.neighbors(mdata, use_rep="X_multivi"); mu.tl.umap(mdata); mu.tl.leiden(mdata)
```

Emit a `report` dict and pass the cell to `evidence_from_kernel_cell` to stay grounded.

## Failure Modes

- **Hand-averaged graphs called "WNN"** — *symptom:* `0.5*rna + 0.5*atac`. *Diagnosis:* not WNN — ignores per-cell modality reliability. *Fix:* use `mu.pp.neighbors(mdata)`.
- **MultiVI on normalized data** — *symptom:* garbage latent. *Diagnosis:* MultiVI needs **raw counts**. *Fix:* keep `layers["counts"]` intact upstream and point MultiVI at them.
- **`setup_mudata` without `modalities=`** — *symptom:* error / wrong modality mapping. *Diagnosis:* MultiVI can't tell which mod is RNA vs ATAC. *Fix:* pass `modalities={"rna_layer": "rna", "atac_layer": "atac"}`.
- **Joint adds nothing** — *symptom:* joint ARI/NMI ≈ single-modality. *Diagnosis:* one modality dominates or the modalities agree. *Fix:* report it; use the single-modality embedding and say so.

## observe_figure checkpoints

1. **Joint UMAP by modality weight** (WNN) — which populations are RNA- vs ATAC-driven?
2. **Joint UMAP by cluster + by batch** — structure preserved, batch mixed (MultiVI).

## Grounding

Record: method (WNN/MultiVI), per-modality reps used, latent dims (MultiVI), modality-weight distribution (WNN), and ARI/NMI vs single-modality baselines → `EvidenceRecord` via `evidence_from_kernel_cell`.

## Honesty

- **Earn the joint embedding** — compare ARI/NMI vs each single modality; only claim improvement if measured.
- WNN weights are per-cell graph weights, not a global "which modality matters" verdict — report per-population.
