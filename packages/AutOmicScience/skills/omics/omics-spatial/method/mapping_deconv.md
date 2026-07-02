# Mapping & Deconvolution

**Maturity: PARTIAL** — assign cell types to spatial locations from an scRNA reference. Both tools (**cell2location** for spot deconvolution, **Tangram** for cell/label mapping) need install (not in `task2`); cell2location wants a GPU.

## Goal / When to Use

Two related tasks, pick by platform resolution:
- **Spot deconvolution** (Visium, Slide-seq — multi-cell spots) → estimate **cell-type proportions per spot**. Default: **cell2location**.
- **Cell mapping / label transfer** (project a reference onto space; any platform) → **Tangram**.

Both need a well-annotated, **same-species same-gene-naming** scRNA reference covering the tissue's cell types, trained on **raw counts**.

## Decision Criteria

- **Visium/spot proportions → cell2location** — Bayesian, models the multi-cell mixture per spot, returns calibrated abundances. GPU-recommended (30k training epochs).
- **"Where would each reference cell/type go" → Tangram** — optimal-transport mapping; also transfers labels and (separately) imputes genes (`imputation.md`).
- **No suitable reference** → stop; report that deconvolution/mapping needs a matched reference.

## How-to — spot deconvolution (cell2location, default)

Two stages: learn per-cell-type signatures from the reference, then map onto the spatial data.

```python
import cell2location
from cell2location.models import RegressionModel, Cell2location

# Stage A — reference signatures (raw-count scRNA, cell_type in .obs)
RegressionModel.setup_anndata(adata_ref, batch_key=None, labels_key="cell_type")
ref = RegressionModel(adata_ref); ref.train(max_epochs=250)
adata_ref = ref.export_posterior(adata_ref)
inf_aver = adata_ref.varm["means_per_cluster_mu_fg"][
    [f"means_per_cluster_mu_fg_{c}" for c in adata_ref.uns["mod"]["factor_names"]]]
inf_aver.columns = adata_ref.uns["mod"]["factor_names"]

# Stage B — spatial mapping (raw-count Visium; intersect genes to inf_aver first)
adata_vis = adata_vis[:, inf_aver.index].copy()
Cell2location.setup_anndata(adata_vis, batch_key="sample")
mod = Cell2location(adata_vis, cell_state_df=inf_aver,
                    N_cells_per_location=30, detection_alpha=20)
mod.train(max_epochs=30000)
adata_vis = mod.export_posterior(adata_vis)
adata_vis.obs[inf_aver.columns] = adata_vis.obsm["q05_cell_abundance_w_sf"].values   # per-spot abundances (q05 point estimate)
```

Parameter rationale:
- `N_cells_per_location=30` — prior on cells per spot; **set from paired histology** (≈30 in many tissues). It regularises total abundance to a tissue-plausible count.
- `detection_alpha=20` — regularises within-slide detection variability; **20** for high variability (typical human data), **200** for low. These are the two hyperparameters the authors flag.
- Both stages need **raw counts**; the spatial `var_names` must be intersected to the signature genes (cell2location hard-guards on it).

## How-to — cell/label mapping (Tangram)

```python
import tangram as tg

tg.pp_adatas(adata_sc, adata_sp, genes=markers)            # intersect/clean genes; writes training_genes
adata_map = tg.map_cells_to_space(adata_sc, adata_sp, mode="clusters",
                                  cluster_label="cell_type", density_prior="rna_count_based",
                                  num_epochs=1000, device="cpu")   # device="cuda:0" for GPU
tg.project_cell_annotations(adata_map, adata_sp, annotation="cell_type")
adata_sp.obsm["tangram_ct_pred"]                            # spots × cell types (spatial prediction)
```
- `mode="clusters"` (with `cluster_label`) maps cell-type clusters — robust, the common choice; `mode="cells"` maps individual cells (heavier). `density_prior="rna_count_based"` weights spots by RNA content.

## Failure Modes

- **Deconvolution returns one dominant type everywhere** — *symptom:* flat proportions. *Diagnosis:* reference missing tissue cell types, or signatures degenerate. *Fix:* check `labels_key` covers all types; complete the reference and retrain Stage A.
- **Genes don't intersect** — *symptom:* cell2location guard error. *Diagnosis:* spatial `var_names` ≠ signature index (species/naming). *Fix:* harmonize gene names; intersect before Stage B.
- **Tangram map is diffuse** — *symptom:* every type smeared across all spots. *Diagnosis:* too few shared marker genes, or `mode="cells"` on sparse data. *Fix:* pass informative `genes=markers`; use `mode="clusters"`.

## observe_figure checkpoints

1. **Abundance / proportion maps** (`sq.pl.spatial_scatter(adata_vis, color=<cell_type>)`) — does each type localize to its expected region (T cells in lymphoid areas, etc.)?
2. **Dominant-type map** — does the spatial pattern match the histology / known architecture?

## Grounding

Record: method, reference source + n cell types, `N_cells_per_location`/`detection_alpha` (cell2location) or `mode`/`density_prior` (Tangram), where abundances/predictions landed, and a per-type localization sanity-check → `EvidenceRecord`.

## Honesty

- **Proportions are estimates, not counts** — report inferred abundances; validate localization against markers/histology.
- **Garbage reference → garbage mapping** — if the reference doesn't match the tissue/species, the result reflects the reference, not the spatial biology; say so.
- Both tools need install + (cell2location) a GPU — if unavailable, state that deconvolution was not run rather than substituting a weaker method.
