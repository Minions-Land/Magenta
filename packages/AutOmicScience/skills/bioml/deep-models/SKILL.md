---
name: bioml-deep-models
disable-model-invocation: true
---

# BioML Deep Models — Single-Cell Foundation & Deep Integration Models

> Subskill of `bioml`. Enter here from the parent skill when you need to train or apply a single-cell deep learning model. Read `../SKILL.md` (parent) and `../../omics-shared/SKILL.md` first — their ML-engineering foundations and evidence rules apply here.

This subskill covers **single-cell deep learning models** for integration, label transfer, reference mapping, and representation learning — the scvi-tools / scArches / scGPT / SATURN ecosystem. These models often **match or beat bespoke methods** at a fraction of the complexity, making them the first escape-hatch to try before reproducing a heavy paper pipeline.

---

## Escape Hatch Priority

**Before reaching for a foundation model or reproducing a heavy paper pipeline, run the mature baseline first.** Across benchmarks, simpler methods repeatedly match or beat the advertised SOTA on well-posed tasks (scVI-KMeans ≥ meK-means, scANVI ≥ scPoli, DeepSTARR CNN ≥ Nucleotide Transformer). Foundation models justify their compute cost only for few-shot learning, cross-species without orthologs, or when the baseline provably falls short. See `assets/references/foundation_models_escape.md` for the decision tree and the baseline-first recipe.

---

## When to Use Deep Models

Use this path when:
- The task is **label transfer** (annotate query cells against a labeled reference)
- The task is **atlas integration** (harmonize multiple datasets into a shared embedding)
- The task is **multimodal integration** (joint RNA+ATAC, RNA+protein, spatial+scRNA)
- The baseline uses a transformer/GNN/VAE and you want to check whether a mature simpler model already clears the bar

**Skip this path** for standard scanpy analysis (QC/clustering/DE) — use `../../single-cell/` instead.

---

## The Model Menu

| Model | Use case | Package | Compute |
|-------|----------|---------|---------|
| **scVI** | Batch integration, denoising, dimensionality reduction | scvi-tools | GPU (minutes) |
| **scANVI** | Semi-supervised annotation, label transfer | scvi-tools | GPU (minutes) |
| **scArches** | Reference mapping (train on ref, project query) | scArches | GPU (minutes) |
| **contrastiveVI** | Conditional generation, perturbation modeling | scvi-tools | GPU (minutes–hours) |
| **scPoli** | Atlas-scale reference mapping, label transfer | scArches | GPU (minutes–hours) |
| **MultiVI** | Joint RNA+ATAC/protein (multiome) | scvi-tools | GPU (minutes) |
| **SATURN** | Cross-species / cross-modality matching | SATURN (separate repo) | GPU (hours) |
| **scGPT** | Foundation model, few-shot learning | scGPT (separate repo) | GPU (hours), large memory |
| **totalVI** | RNA→protein prediction (CITE-seq) | scvi-tools | GPU (minutes–hours) |
| **sciPENN** | RNA→protein translation | sciPENN (pip) | GPU (minutes) |
| **PAGA** | Trajectory topology (coarse-grained, first try) | scanpy | CPU (seconds) |
| **PHLOWER** | Trajectory inference (tree topology, escalation) | PHLOWER (repo) | CPU (minutes) |
| **scVelo** | RNA velocity (pseudotime direction) | scvelo | GPU (minutes) |
| **Geneformer** | Foundation model (few-shot alternative to scGPT) | Geneformer (HF) | GPU (hours), 24 GB+ |

**First try: scANVI or scArches** for label transfer tasks; **scVI + KMeans** for integration. These are well-tested, fast, and often sufficient.

### Task-specific reference docs

| Task | Reference doc |
|------|---------------|
| RNA→protein translation (CITE-seq prediction) | `assets/references/rna_to_protein.md` |
| Trajectory / pseudotime → dynverse output | `assets/references/trajectory_pseudotime.md` |
| Cross-species / cross-modality (SATURN) | `assets/references/saturn_cross_species.md` |
| Foundation-model decision + escape hatches | `assets/references/foundation_models_escape.md` |
| Perturbation outcome prediction (Perturb-seq) | `assets/references/perturbation_prediction.md` |

---

## General Deep Model Recipe

### 1. Confirm prerequisites

- GPU available (`nvidia-smi`, `torch.cuda.is_available()`)
- Enough GPU memory (scVI/scANVI: ~8 GB for 50k cells; scGPT: 24–40 GB)
- Data is preprocessed AnnData: `adata.layers["counts"]` exists (raw counts), basic QC done

### 2. Install the package in an isolated env

```bash
# scvi-tools (scVI, scANVI, MultiVI, contrastiveVI)
pip install scvi-tools

# scArches (scArches, scPoli)
pip install scarches

# SATURN / scGPT: clone their repos, follow their install instructions
```

Pin the version. scvi-tools updates often; behavior can drift.

### 3. Prepare the data

Models expect:
- **Raw counts** in `adata.layers["counts"]` (don't normalize before passing to the model)
- **Batch/condition** in `adata.obs["batch"]` or similar
- **Cell-type labels** (if using scANVI or scPoli) in `adata.obs["cell_type"]`

Example:
```python
import scanpy as sc
adata = sc.read_h5ad("data.h5ad")
# Ensure counts are present:
if "counts" not in adata.layers:
    adata.layers["counts"] = adata.X.copy()
# Normalize and log for visualization only (the model uses raw counts):
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
```

### 4. Train the model

**scVI example:**
```python
import scvi
scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="batch")
model = scvi.model.SCVI(adata, n_latent=30, gene_likelihood="nb")
model.train(max_epochs=400)
adata.obsm["X_scvi"] = model.get_latent_representation()
```

**scANVI example (semi-supervised annotation):**
```python
scvi.model.SCANVI.setup_anndata(adata, layer="counts", batch_key="batch", labels_key="cell_type", unlabeled_category="Unknown")
model = scvi.model.SCANVI(adata, "Unknown", n_latent=30)
model.train(max_epochs=400)
adata.obs["scanvi_prediction"] = model.predict()
```

**scArches reference mapping:**
```python
# 1. Train on reference
import scarches as sca
sca.models.SCVI.setup_anndata(ref_adata, layer="counts", batch_key="batch")
ref_model = sca.models.SCVI(ref_adata, n_latent=30)
ref_model.train()
ref_model.save("ref_model/")

# 2. Project query
query_model = sca.models.SCVI.load_query_data(query_adata, "ref_model/")
query_model.train(max_epochs=200)
query_adata.obsm["X_scvi"] = query_model.get_latent_representation()
# Transfer labels from reference
ref_labels = ref_adata.obs["cell_type"]
query_adata.obs["predicted_cell_type"] = transfer_labels(query_adata.obsm["X_scvi"], ref_adata.obsm["X_scvi"], ref_labels)
```

### 5. Validate the embedding

```python
sc.pp.neighbors(adata, use_rep="X_scvi")
sc.tl.umap(adata)
sc.pl.umap(adata, color=["batch", "cell_type"], save="scvi_umap.pdf")
```

`observe_figure` on the UMAP before making conclusions. Check:
- Are batches mixed (if integration goal)?
- Are known cell types separated (if they should be)?
- No clear technical artifacts (clustering by n_counts/pct_mito)?

### 6. Evaluate quantitatively

```python
from scib.metrics import ari, nmi, silhouette_label
ari_score = ari(adata, "cell_type", "leiden")
sil_score = silhouette_label(adata, "cell_type", embed="X_scvi")
print(f"ARI: {ari_score:.3f}, Silhouette: {sil_score:.3f}")
```

Compare against:
- **Unintegrated baseline** (same metrics on PCA) — integration must not degrade biology
- **Task-specific SOTA** (if reproducing a benchmark) — the model should meet or beat it

Emit these metrics as `EvidenceRecord`.

---

## Model-Specific Notes

### scVI
- **Fast, robust, works out of the box** for most integration tasks.
- Default `n_latent=30` is good for up to 100k cells; increase to 50 for larger.
- Use `gene_likelihood="nb"` (negative binomial) for UMI counts; `"zinb"` if high dropout.

### scANVI
- Semi-supervised: you label a subset, it propagates labels to unlabeled cells.
- `unlabeled_category` must be in `adata.obs[labels_key]` for the cells you want predicted.
- Train epochs: ~400 for scVI phase, ~200 for scANVI phase.

### scArches / scPoli
- **Reference mapping** — train on a large reference once, project new queries without retraining the full atlas.
- scPoli extends scArches with label transfer and uncertainty quantification.
- Best for atlas-scale tasks (millions of reference cells).

### MultiVI
- Joint RNA+ATAC or RNA+protein in a single MuData.
- Expects `mdata.mod["rna"]` and `mdata.mod["atac"]` (or `protein`).
- Setup: `scvi.model.MULTIVI.setup_mudata(mdata, modalities={"rna": "rna_layer", "atac": "atac_layer"})`

### SATURN / scGPT
- **Foundation models** — pre-trained on large corpora, fine-tune on your task.
- Require their own repos (not in scvi-tools). Follow their READMEs closely.
- GPU memory: 24–40 GB. Wall-clock: hours for fine-tuning.
- Best for **few-shot** tasks (small labeled set) or **cross-species** transfer.

---

## Pitfalls

- **Passing normalized counts** — models expect raw UMI counts in `adata.layers["counts"]`, not log-normalized.
- **Not validating the embedding** — a trained model can produce garbage if hyperparams are wrong; always UMAP + metric check.
- **Comparing to SOTA on the wrong metric** — benchmark papers often cherry-pick the favorable metric; check what the evaluator actually uses.
- **Skipping the baseline** — scVI + KMeans might already clear the bar; don't jump to a transformer before checking.
- **Ignoring batch structure** — if batch effects are weak, integration can degrade biology; always compare ARI before/after.

---

## When Things Go Wrong

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| **Loss doesn't decrease** | Learning rate too high, or data has issues (all zeros, wrong format) | Check `adata.layers["counts"]` is raw integers; try lower LR |
| **OOM** | Batch size too large for GPU | Halve `train_size` in `.train(train_size=0.5)` |
| **Embedding looks like noise** | Too few epochs, or `n_latent` too low | Train longer (800 epochs), or increase `n_latent` to 50 |
| **Worse than baseline** | Integration too aggressive, biological signal lost | Check ARI/NMI vs unintegrated; if worse, don't integrate |

---

## Evidence & Reporting

Every deep-model run emits:
- Model name + version (e.g., `scvi-tools==1.0.3`)
- Hyperparams: `n_latent`, `gene_likelihood`, `max_epochs`, `train_size`
- Embedding shape and where it's stored (`adata.obsm["X_scvi"]`)
- Quantitative metrics: ARI, NMI, silhouette, ASW (batch), etc. — cite exact numbers as `EvidenceRecord`
- UMAP figure → `observe_figure`
- Comparison to baseline (unintegrated, or task SOTA)

This is your audit trail. If the model beats the baseline, document **why** (better batch correction? better latent structure?). If it doesn't, document **why not** (biology degraded? wrong hyperparams? task mismatch?).
