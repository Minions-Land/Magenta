# scRNA-seq Batch Integration

**Maturity: READY** — Harmony runs via `omics_compute(subcommand="integrate", modality="scrna", ...)`. scVI / scANVI are **PARTIAL** (separate tool, needs scvi-tools + GPU; see below). Default to Harmony.

## Goal / When to Use

Integrate only when a batch effect is actually visible — cells clustering by sample/donor/lane instead of by cell type on the UMAP. Integration is not a default step; it trades batch mixing against biological signal, and over-correction silently erases real biology (e.g. forcing disease and healthy to overlap). **Integration must earn its place:** validate that it improves batch mixing without degrading biology (below), and if it doesn't, keep the unintegrated space and say so.

Prerequisite: PCA already computed (`obsm["X_pca"]`, from `omics_compute preprocess`) and a batch column in `obs`.

## Decision Criteria — pick one default

- **Harmony (default).** Fast linear correction on PCA space; scales to millions of cells; preserves global geometry; deterministic. The right choice for the overwhelming majority of datasets — technical replicates, same platform, donor effects.
- **scVI (PARTIAL — deep, GPU).** Use only for genuinely deep, non-linear batch effects (cross-platform 10x + Smart-seq2, cross-lab) *and* when a GPU is available. Models raw counts with a generative network. Slower, stochastic, heavier deps — not the default.

Do not reach for scVI just because it is fancier — on standard same-platform data Harmony matches it at a fraction of the cost. Escalate to scVI only when Harmony provably fails to mix batches (check the metrics below).

## How-to (default path — READY)

Runs in the pinned `task1` env and records evidence automatically:

```
omics_compute(
  subcommand="integrate",
  modality="scrna",
  args={
    "input": "processed.h5ad",
    "output": "integrated.h5ad",
    "batch-key": "batch",
    "method": "harmony"
  }
)
```

Parameter rationale:
- `batch-key="batch"` — the `obs` column holding the technical batch (sample/donor/lane). Set it to whatever encodes the *technical* split, not a biological condition.
- `method="harmony"` — the default and recommended integration method.

The subcommand calls Harmony with `n_pcs=50, theta=2.0, sigma=0.1, max_iter_harmony=10` and writes the corrected embedding to **`obsm["X_pca_harmony"]`**. Downstream neighbors/UMAP/Leiden must use it:

```python
sc.pp.neighbors(adata, use_rep="X_pca_harmony")
sc.tl.umap(adata); sc.tl.leiden(adata)
```

### scVI / scANVI (PARTIAL — not via the subcommand)

No subcommand path. Needs `scvi-tools` + a GPU; confirm with `omics_preflight(modality="scrna")` first. Minimal recipe (raw counts, not log-normalized):

```python
import scvi
scvi.settings.seed = 0                                  # scVI is stochastic — pin the seed
scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="batch")
model = scvi.model.SCVI(adata, n_latent=30)
model.train(max_epochs=400, early_stopping=True)
adata.obsm["X_scVI"] = model.get_latent_representation()
# then: sc.pp.neighbors(adata, use_rep="X_scVI")
```

scANVI extends this with partial labels (`scvi.model.SCANVI.from_scvi_model(model, unlabeled_category="Unknown", labels_key="cell_type")`) to co-learn batch correction and label transfer. Emit a `report` dict and pass the cell to `evidence_from_kernel_cell` so the run is grounded.

## Validate integration (always — before trusting it)

Compare biology conservation **before vs after** integration. Re-cluster on each embedding and score the clustering against known cell-type labels (or a prior `cell_type` column treated as reference) with ARI/NMI:

```python
from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

def bio_score(adata, rep, ref="cell_type"):
    sc.pp.neighbors(adata, use_rep=rep)
    sc.tl.leiden(adata, key_added="leiden_tmp")
    return (adjusted_rand_score(adata.obs[ref], adata.obs["leiden_tmp"]),
            normalized_mutual_info_score(adata.obs[ref], adata.obs["leiden_tmp"]))

ari_before, nmi_before = bio_score(adata, "X_pca")
ari_after,  nmi_after  = bio_score(adata, "X_pca_harmony")
```

Interpretation: integration should keep ARI/NMI vs cell type roughly stable or higher while visibly mixing batches. **If ARI/NMI drops after integration, biology was degraded — discard the integrated embedding and proceed on `X_pca`, documenting the decision.** For a full batch-vs-bio panel, `scib-metrics` (`from scib_metrics.benchmark import Benchmarker`) scores several embeddings at once; the sklearn computation above is the minimal version and needs no extra deps.

## Failure Modes

1. **Batches still separate after integration.** → *Diagnosis:* wrong `batch-key`, or batches share almost no cell types (you can't mix populations that aren't both present). → *Fix:* confirm the `obs` column actually encodes the technical split; if cell-type composition barely overlaps across batches, subset to shared types or accept partial integration and document it.

2. **Biology disappears — known cell types merge / disease == healthy.** → *Diagnosis:* over-correction; the batch variable is confounded with the biological variable (each condition is its own batch), so mixing batches also mixes biology. ARI/NMI vs `cell_type` drops (validation above). → *Fix:* do not integrate that axis — keep `X_pca`, and model batch as a covariate in downstream DE instead (see `markers_de.md`).

3. **scVI gives a different embedding every run.** → *Diagnosis:* training is stochastic without a fixed seed, and/or it silently ran on CPU and under-trained. → *Fix:* set `scvi.settings.seed`, confirm the GPU was used, and train to convergence (`early_stopping=True`); with no GPU, use Harmony rather than a half-trained scVI.

4. **`KeyError: 'X_pca'` from the subcommand.** → *Diagnosis:* PCA wasn't computed — integration runs on the PCA embedding. → *Fix:* run `omics_compute preprocess` first so `obsm["X_pca"]` exists.

## observe_figure checkpoints

- **UMAP colored by `batch`, before vs after** (`sc.pl.umap(adata, color="batch")`): before = batches in separate islands; after = batches interleaved within each cell-type region. No change → integration didn't take (Failure Mode 1).
- **Same UMAP colored by `cell_type` / `leiden`**: cell-type structure must survive integration. If distinct types collapse into one blob, that's over-correction (Failure Mode 2) — observe this before reporting integrated clusters.
- **Side-by-side `batch` and `cell_type` panels** (`ncols=2`): the goal is batch-mixed *and* biology-preserved simultaneously; eyeball both before trusting the integrated space.

## Grounding

- `omics_compute integrate` returns a `report` with `method`, `n_batches`, `batch_sizes`, the Harmony parameters, and `output_embedding` (`X_pca_harmony`) — captured as evidence automatically; cite it plus the validation ARI/NMI numbers.
- scVI path: emit a `report` dict (method, `n_latent`, `max_epochs`, final ARI/NMI) and pass the cell to `evidence_from_kernel_cell`.
- Always record the before/after ARI/NMI; an integration claim without the biology-conservation check is ungrounded.

## Honesty / when to abstain

- **Integration didn't help:** if batches already mix (ARI/NMI and UMAP unchanged), say integration was unnecessary and proceed unintegrated — don't claim a correction that did nothing.
- **Confounded design (batch == condition):** integrating removes the very effect under study. State the confound and refuse to integrate that axis rather than producing a misleading mixed embedding.
- **No GPU for scVI:** don't silently fall back to a slow CPU run that under-trains. Use Harmony and say scVI was not run, or provision a GPU.
- **Report which space you used downstream** (`X_pca` vs `X_pca_harmony` vs `X_scVI`) so every downstream cluster/marker claim is traceable to an integration decision.
