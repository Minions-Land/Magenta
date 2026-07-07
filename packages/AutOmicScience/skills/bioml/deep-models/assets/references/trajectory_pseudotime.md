# Reference — Trajectory / Pseudotime with dynverse Output

Trajectory inference orders cells along a developmental/state continuum and recovers branch topology. Key: producing the deliverable in dynverse format.

## The task & output contract

**Input:** preprocessed AnnData (cells with a start/root defined or inferable).
**Output (dynverse format):** three tables describing the trajectory:
- **milestone_network**: edges between milestones (from, to, length, directed)
- **progressions**: per-cell position (cell_id, from, to, percentage along edge)
- **milestone_percentages**: per-cell milestone membership (cell_id, milestone_id, percentage)

**Evaluation:** HIM (topology), Corr (pseudotime correlation), F1_branches, F1_milestones vs a reference trajectory.

## Method options (escape-hatch ladder)

| Method | Approach | Performance | Compute |
|--------|----------|-------------|---------|
| **PHLOWER** | Hodge-Laplacian spectral (classical) | ~0.74 real-data F1 (SOTA-ish) | CPU minutes |
| **PAGA** (scanpy) | Graph abstraction | ~0.68–0.76 (within 0.05 of SOTA) | CPU seconds |
| **scVelo** | RNA velocity (needs spliced/unspliced) | direction, not topology | GPU minutes |

**Escape-hatch guidance:** **Start with PAGA** — it's in scanpy, runs in seconds, and reaches within 0.05 of SOTA on real data. Escalate to PHLOWER only if branch F1 < 0.6.

## PAGA (scanpy, first try)

```python
import scanpy as sc

sc.pp.neighbors(adata, n_neighbors=15)
sc.tl.leiden(adata)
sc.tl.paga(adata, groups="leiden")
sc.pl.paga(adata)                      # topology graph
sc.tl.draw_graph(adata, init_pos="paga")

# Pseudotime from a root cell
adata.uns["iroot"] = np.where(adata.obs["cell_type"] == "stem")[0][0]
sc.tl.dpt(adata)                        # adata.obs["dpt_pseudotime"]
```

## Converting to dynverse triple-CSV

The evaluator wants dynverse tables. Build them from PAGA connectivity + DPT:

```python
import pandas as pd
import numpy as np

# 1. milestone_network from PAGA connectivities (thresholded)
conn = adata.uns["paga"]["connectivities"].toarray()
groups = adata.obs["leiden"].cat.categories
edges = []
for i in range(len(groups)):
    for j in range(i+1, len(groups)):
        if conn[i, j] > 0.1:   # threshold
            edges.append({"from": groups[i], "to": groups[j],
                          "length": 1 - conn[i, j], "directed": False})
milestone_network = pd.DataFrame(edges)

# 2. progressions: assign each cell to its nearest edge, percentage from DPT
progressions = pd.DataFrame({
    "cell_id": adata.obs_names,
    "from": adata.obs["leiden"].values,   # simplified: cluster as milestone
    "to": adata.obs["leiden"].values,
    "percentage": adata.obs["dpt_pseudotime"].values,
})

# 3. milestone_percentages: soft membership (here hard = 1.0)
milestone_percentages = pd.DataFrame({
    "cell_id": adata.obs_names,
    "milestone_id": adata.obs["leiden"].values,
    "percentage": 1.0,
})

milestone_network.to_csv("milestone_network.csv", index=False)
progressions.to_csv("progressions.csv", index=False)
milestone_percentages.to_csv("milestone_percentages.csv", index=False)
```

Consult the evaluator's exact column names — dynverse conventions are strict.

## PHLOWER (escalation)

PHLOWER uses Hodge decomposition on the cell graph for tree-like trajectories. Clone its repo, follow its README. Output is already close to dynverse format (milestone tree + cell progressions). Use when PAGA's branch topology is too coarse.

## scVelo (direction, not topology)

When you need **direction** (which way cells are moving), RNA velocity from spliced/unspliced counts:

```python
import scvelo as scv
scv.pp.filter_and_normalize(adata)
scv.pp.moments(adata)
scv.tl.velocity(adata, mode="stochastic")
scv.tl.velocity_graph(adata)
scv.pl.velocity_embedding_stream(adata, basis="umap")
# Pseudotime with direction:
scv.tl.velocity_pseudotime(adata)   # adata.obs["velocity_pseudotime"]
```

scVelo needs a spliced/unspliced-aware count matrix (from velocyto or kb-python), not a standard count matrix.

## Pitfalls

- **Wrong output schema** — dynverse column names are exact; verify against the evaluator
- **No root cell** — pseudotime needs a defined start; set `iroot` biologically
- **scVelo without spliced/unspliced** — it can't run on a plain count matrix
- **Jumping to PHLOWER first** — PAGA is often within 0.05; try it first
- **Confusing pseudotime with real time** — it's an ordering, not a clock

## Grounding

`report`: method used, root definition, n milestones + branch structure, evaluation metrics (HIM/Corr/F1) if reference available, output file paths + schema confirmation.
