# Per-Modality Preprocessing

**Maturity: REFERENCE** — prepare each modality for joint analysis by **reusing the scRNA and scATAC recipes** on `mdata["rna"]` / `mdata["atac"]`. No new steps invented here.

## Goal / When to Use

Before joint embedding, each modality needs its own embedding (RNA: PCA; ATAC: spectral/LSI) with **raw counts preserved** (`layers["counts"]`). What you compute is governed by the joint method you'll use.

## Decision Criteria

- **RNA** (`mdata["rna"]`) — scRNA recipe: QC → normalize → HVG → PCA. For **MultiVI** keep `layers["counts"]` intact (it needs raw counts); for **WNN** you need `X_pca`.
- **ATAC** (`mdata["atac"]`) — scATAC recipe: QC → feature matrix → spectral embedding. For **MultiVI** keep `layers["counts"]`; for **WNN** you need `X_spectral` (or `X_lsi`).
- **Which joint method governs requirements:** WNN → per-modality embeddings; MultiVI → raw counts in both.

## How-to

Run each modality through its modality's path, then re-intersect if filtering dropped cells.

```python
# RNA — scRNA preprocess subcommand (write the modality out, run, read back)
omics_compute(subcommand="preprocess", modality="scrna",
              args={"input": "rna.h5ad", "output": "rna_pp.h5ad"})   # QC→norm→HVG→PCA→neighbors→UMAP→Leiden

# ATAC — snapATAC2 in run_python (see omics-scatac: atac_qc.md / feature_matrix.md / dimred_cluster.md)
import snapatac2 as snap, muon as mu
snap.metrics.tsse(mdata["atac"], snap.genome.hg38)
snap.pp.add_tile_matrix(mdata["atac"]); snap.pp.select_features(mdata["atac"])
snap.tl.spectral(mdata["atac"])                                      # -> obsm["X_spectral"]

# Re-intersect if either modality dropped cells during QC
mu.pp.intersect_obs(mdata)
```

Point at the modality recipes — **don't duplicate them here**: `omics-scrna` (`method/qc.md`, `method/integration.md`) and `omics-scatac` (`method/atac_qc.md`, `method/feature_matrix.md`, `method/dimred_cluster.md`).

## Failure Modes

- **Normalized the layer MultiVI reads from** — *symptom:* garbage MultiVI latent. *Diagnosis:* MultiVI needs raw counts. *Fix:* keep `layers["counts"]`; point MultiVI at it.
- **Forgot to re-intersect after per-modality filtering** — *symptom:* modality cell counts diverge, joint step errors. *Fix:* `mu.pp.intersect_obs(mdata)` after QC.
- **Poor ATAC TSSE** — *symptom:* one modality low-quality. *Diagnosis:* it poisons the joint embedding (WNN weights reveal it). *Fix:* flag it; consider single-modality for that population.

## observe_figure checkpoints

- RNA QC (n_genes / mt%) and ATAC TSSE distributions — reuse the per-modality checks; both modalities must pass before joining.

## Grounding

Per modality: cells/features after filtering, HVG count, PCA/spectral variance, counts preserved → `EvidenceRecord`.

## Honesty

If one modality is low-quality (e.g., poor TSSE), flag it — a weak modality drags the joint embedding, and the WNN weights will show it.
