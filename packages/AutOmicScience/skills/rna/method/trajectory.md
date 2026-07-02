# scRNA-seq Trajectory, RNA Velocity & Fate

**Maturity: REFERENCE** — no compute subcommand; one opinionated recipe below, run in `run_python`; emit a `report` dict and pass it to `evidence_from_kernel_cell` to stay grounded.

> Partial alternative: the omics analyst toolset also exposes `velocity_analysis` (scVelo), `trajectory_pseudotime` (DPT/Palantir/latent-time), and `fate_mapping` (CellRank) as wrapped tools. They are convenient but coarser; the hand-written recipe here is the documented default because it lets you justify the root, gate velocity on data quality, and ground each step.

## Goal / When to Use

Use trajectory analysis when cells form a **continuum** (differentiation, activation, a developmental axis) and you want to order them or infer direction. Do **not** reach for it when the biology is a set of discrete, stable cell types — forcing a trajectory onto islands produces a confident-looking artifact.

Two questions gate everything:
1. **Is a trajectory even supported?** Check PAGA connectivity and the UMAP. Disconnected clusters → there is no trajectory; abstain.
2. **What is the root?** Pseudotime is meaningless without a biologically justified start (the stem/progenitor population). Never let the tool pick an arbitrary root.

## Decision Criteria

- **Pseudotime first, velocity only if you can.** Diffusion pseudotime (DPT) + PAGA runs on any processed AnnData and answers "what is the ordering and topology". RNA velocity adds *direction* but **requires `spliced`/`unspliced` layers** (from velocyto or kb-python) — a standard Cell Ranger `filtered_feature_bc_matrix` does **not** have them. If those layers are absent, run DPT/PAGA and say velocity was not possible.
- **Dynamical velocity model.** When velocity is available, use `mode="dynamical"` (full kinetics) over `stochastic`; it is slower but the steady-state assumption fails on transient populations.
- **CellRank for fate probabilities.** Only after velocity is computed and its confidence is acceptable. CellRank turns the velocity field into terminal states and per-cell fate probabilities; it is an extension, not the default.
- **Velocity is a short-term extrapolation, not a fate guarantee.** It is confounded by cell cycle and stress. Treat low `velocity_confidence` regions as unreliable.

## How-to (default path)

Assumes a processed AnnData (normalized `X`, HVGs, `obsm["X_pca"]`, neighbors, `obs["leiden"]`/`obs["cell_type"]`, `obsm["X_umap"]`) and a `cell_type`/marker-based idea of the root population.

### 1. Topology + pseudotime (always)

```python
import scanpy as sc
import numpy as np

# PAGA: cluster-level connectivity — is there a continuum, or disconnected islands?
sc.tl.paga(adata, groups="leiden")
sc.pl.paga(adata, color="leiden", threshold=0.05, show=False, save="_paga.png")

# Diffusion map, then a BIOLOGICALLY CHOSEN root before diffusion pseudotime.
sc.tl.diffmap(adata, n_comps=15)
root_cluster = "HSC"  # set from progenitor markers / study design — not arbitrary
adata.uns["iroot"] = np.flatnonzero(adata.obs["cell_type"] == root_cluster)[0]
sc.tl.diffusion_pseudotime(adata)  # writes adata.obs["dpt_pseudotime"]

sc.pl.umap(adata, color=["leiden", "dpt_pseudotime"], show=False, save="_dpt.png")
```

### 2. RNA velocity — ONLY if spliced/unspliced layers exist

```python
import scvelo as scv

# Gate on the data: skip this whole block if the layers are absent.
assert {"spliced", "unspliced"} <= set(adata.layers), \
    "no spliced/unspliced layers — skip velocity, report DPT/PAGA only"

scv.pp.filter_and_normalize(adata, min_shared_counts=30, n_top_genes=2000)
scv.pp.moments(adata, n_pcs=30, n_neighbors=30)
scv.tl.recover_dynamics(adata, n_jobs=8)   # dynamical model fit
scv.tl.velocity(adata, mode="dynamical")
scv.tl.velocity_graph(adata)
scv.tl.velocity_confidence(adata)          # adata.obs["velocity_confidence"]

scv.pl.velocity_embedding_stream(adata, basis="umap", color="cell_type",
                                 show=False, save="_velocity_stream.png")
# Sanity-check direction on known markers (phase portraits):
scv.pl.velocity(adata, var_names=["CD34", "MPO", "HBB"], show=False, save="_phase.png")
```

### 3. Fate probabilities (CellRank) — extension, after velocity

```python
import cellrank as cr

vk = cr.kernels.VelocityKernel(adata)
vk.compute_transition_matrix()
ck = cr.kernels.ConnectivityKernel(adata)
ck.compute_transition_matrix()
combined = 0.8 * vk + 0.2 * ck             # velocity-led, connectivity-smoothed

g = cr.estimators.GPCCA(combined)
g.fit(cluster_key="cell_type")             # coarse-grains into macrostates
g.predict_terminal_states()
g.compute_fate_probabilities()
cr.pl.fate_probabilities(adata, show=False, save="_fate.png")
```

### 4. Emit the report and ground it

```python
report = {
    "method": "paga+dpt",                  # +scvelo+cellrank if velocity was run
    "root_cluster": root_cluster,
    "n_cells": int(adata.n_obs),
    "dpt_pseudotime_range": [float(adata.obs["dpt_pseudotime"].min()),
                             float(adata.obs["dpt_pseudotime"].max())],
    # include only if velocity ran:
    "velocity_mode": "dynamical",
    "mean_velocity_confidence": float(adata.obs["velocity_confidence"].mean()),
    "terminal_states": sorted(map(str, g.terminal_states.cat.categories)),
}
report
```

Pass `report` to `evidence_from_kernel_cell`. Drop the `velocity_*`/`terminal_states` keys when velocity was not run.

**Alternative pseudotime methods** (1 line): Palantir (`palantir`, multi-fate probabilities) and Slingshot (R, smooth lineage curves via `anndata2ri`) are reasonable when DPT under-resolves branches; reach for them only if DPT visibly fails.

## Failure Modes

- **No spliced/unspliced layers** — *symptom:* `KeyError` / assert fails in step 2. *Diagnosis:* matrix came from Cell Ranger `filtered_feature_bc_matrix`, which has no nascent counts. *Fix:* re-quantify with velocyto or kb-python, or skip velocity and report DPT/PAGA only, stating the limitation.
- **Velocity arrows point backward or scatter randomly** — *symptom:* stream plot disagrees with known biology; `velocity_confidence` low. *Diagnosis:* steady-state assumption wrong, low depth, or cell cycle dominating. *Fix:* use `mode="dynamical"`, inspect `scv.pl.velocity` phase portraits for key markers, score/regress cell cycle; if confidence stays low, drop velocity and report pseudotime only.
- **Pseudotime contradicts known biology** — *symptom:* mature cells get low pseudotime. *Diagnosis:* wrong root, or no real continuum (discrete types forced onto a line). *Fix:* re-pick the root from progenitor markers; if PAGA shows disconnected clusters, abstain — there is no trajectory.
- **CellRank reports too many terminal states** — *symptom:* more terminal macrostates than plausible endpoints. *Diagnosis:* over-clustering or noisy velocity. *Fix:* coarsen `cluster_key`, validate each terminal state with markers, discard the spurious ones.

## observe_figure checkpoints

Call `observe_figure` on each before it backs a claim:
1. **PAGA graph** — connected continuum vs disconnected islands (islands ⇒ no trajectory).
2. **DPT UMAP** — smooth gradient emanating from the root; abrupt jumps ⇒ wrong root or branching not resolved.
3. **Velocity stream** — flow consistent with known differentiation direction.
4. **Phase portraits** (`scv.pl.velocity`) — clean up/down-regulation arcs for marker genes; flat clouds ⇒ unreliable velocity.
5. **Fate probabilities** — each terminal state is a real, marker-supported endpoint.

## Honesty / when to abstain

- **No continuum → no trajectory.** If PAGA connectivity is weak and UMAP shows discrete islands, say so and stop; do not impose pseudotime on stable cell types.
- **State the root and that it is a choice.** Pseudotime is relative to the root you picked; report which population and why.
- **If layers are missing, say velocity was not run** — never imply directional dynamics from pseudotime alone (DPT has no inherent direction).
- **Low velocity confidence is a result, not a nuisance.** Report mean confidence; if it is low across the manifold, present velocity as inconclusive rather than narrating arrows.
- **Cycling/stressed cells confound velocity.** Flag this when the population includes proliferating cells.
