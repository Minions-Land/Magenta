# Cross-Modal Interpretation

**Maturity: REFERENCE** — interpret the *joint* result. The genuinely multiome-specific question here is **modality weighting** (which modality drives which population); peak→gene linkage, TF→target, and eGRN now live in `regulation.md` (SCENIC+).

## Goal / When to Use

After joint embedding + clustering, interpret how the two modalities contribute — per-cell **modality weights** from WNN reveal which populations are RNA-driven vs ATAC-driven. Use to sanity-check the joint embedding and to build the biological story.

## Modality weights (WNN)

`muon`'s WNN (`mu.pp.neighbors(mdata)`) writes **per-cell modality weights** into `mdata.obs`. Find the columns it added (naming follows muon's convention, a per-modality `*:weight`-style column) and plot them on the joint UMAP — don't hardcode a column name, inspect:

```python
import muon as mu
# after mu.pp.neighbors(mdata) built the joint (WNN) graph:
weight_cols = [c for c in mdata.obs.columns if "weight" in c.lower()]
mu.pl.embedding(mdata, basis="X_umap", color=weight_cols)
```

Interpretation: a population with high **ATAC** weight is separated mainly by chromatin (e.g. poised/primed states); high **RNA** weight means expression carries the signal. A modality weight that is uniform everywhere means the joint step added little over single-modality.

## Peak→gene linkage, TF→target, eGRN — not here

These require the eGRN pipeline, **not** this step:
- **multiome** (paired RNA+ATAC) → **`regulation.md`** (SCENIC+): `region_to_gene_adj.tsv` is the reusable region→gene linkage, and `eRegulon_*.tsv` carries TF→region→gene.
- **pure scATAC** (no RNA) → `scatac-seq` `method/peak_gene_linkage.md` (co-accessibility / gene-activity correlation).

## Failure Modes

- **Reading modality weights as importance ranks** — *symptom:* "ATAC matters more globally". *Diagnosis:* weights are *local* graph weights, not a global statement. *Fix:* report per-population, as a hypothesis.
- **Interpreting before looking** — *symptom:* claims about modality drivers with no figure. *Fix:* `observe_figure` the UMAP colored by each weight column first.

## Grounding

Record: modality-weight distributions per cluster, the weight column names found, and the joint embedding used → `EvidenceRecord`.

## Honesty

- Modality weights describe the *graph*, not biology directly — state which populations are modality-driven as a hypothesis.
- If you need regulatory links / GRN, say they come from the SCENIC+ pipeline (`regulation.md`), not from this interpretation step.
