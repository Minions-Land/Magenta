# Cell-Cell Communication

**Maturity: REFERENCE** — no runtime subcommand; one opinionated recipe below, run in `run_python`; emit a `report` dict and pass it to `evidence_from_kernel_cell` to stay grounded.

## Goal / When to Use

Generate ligand-receptor interaction hypotheses between annotated cell types. Use after you have a **trustworthy annotation** (garbage labels → garbage CCC) and want to explore which types may be signaling to each other.

## Decision Criteria

**The judgment this guides:**

- **Method-consensus vs. single method** — **liana `rank_aggregate`** gives a robust-rank-aggregation (RRA) consensus across multiple methods (CellPhoneDB, NATMI, Connectome, etc.), preferable to any single method for a first pass. Use a single method only when you specifically want its particular score/assumption.

- **Expression-fraction filter** — filter by `expr_prop` (default 0.1) and `min_cells` per group so lowly-expressed pairs don't dominate the ranking. A ligand/receptor expressed in <10% of cells in a type is a weak signal.

- **Organism/resource** — choose the ligand-receptor database by organism (`consensus` resource is multi-organism and usually the default).

## Method Menu

- **liana `rank_aggregate`** (consensus across CellPhoneDB, NATMI, Connectome, SingleCellSignalR, etc.) — robust default
- **Single methods** — CellPhoneDB, NATMI, Connectome, etc. (via liana) when you want a specific score/assumption
- **Result table** — lands in `adata.uns['liana_res']` as a DataFrame

## How-to

```python
import liana as li

# Robust-rank-aggregation consensus
li.mt.rank_aggregate(
    adata,
    groupby='cell_type',
    expr_prop=0.1,       # min fraction of cells expressing L/R in each type
    min_cells=10,        # min cells per type
    use_raw=False,       # use normalized .X, not raw counts
    resource='consensus' # multi-organism L-R database
)

# Inspect results
liana_res = adata.uns['liana_res']
print(liana_res.head(20))

# Visualize top interactions (returns a plotnine ggplot — save with .save())
p = li.pl.dotplot(
    adata,
    colour='magnitude_rank',   # consensus magnitude (lower = stronger)
    size='specificity_rank',   # consensus specificity (lower = more specific)
    inverse_size=True,         # so stronger/more-specific pairs render as larger dots
    top_n=20,
    orderby='magnitude_rank',
    orderby_ascending=True,
    figure_size=(8, 6),
)
p.save('liana_top20.png')
# Optionally pass source_labels=[...] / target_labels=[...] (lists of cell types) to subset senders/receivers.
```

**What lands in `adata.uns['liana_res']`:**
- `source`, `target` — sender, receiver cell types
- `ligand_complex`, `receptor_complex` — the L-R pair
- `magnitude_rank`, `specificity_rank` — RRA consensus ranks (lower = stronger)
- `lr_means` — mean expression of the pair
- Method-specific scores (if you ran a single method)

**Confirm exact liana symbols/kwargs against the installed version** — the API has evolved (e.g., `li.method.rank_aggregate` in older versions, `li.mt.rank_aggregate` in recent ones).

## Failure Modes

- **Garbage labels in, garbage CCC out** — *symptom:* implausible sender→receiver pairs (two distant, non-interacting types dominate). *Diagnosis:* CCC is grouped by `cell_type`; wrong/over-clustered annotation corrupts every interaction. *Fix:* fix annotation first (`annotation.md`); never run CCC on `leiden` ids you have not labeled.
- **Top hits are ambient/housekeeping genes** — *symptom:* ribosomal or ubiquitously expressed genes appear as top ligands. *Diagnosis:* ambient contamination or non-specific expression mislabeled as signaling. *Fix:* confirm QC/ambient handling; discard housekeeping pairs; cross-check the ligand is genuinely cell-type-specific.
- **A single pair overwhelms the ranking** — *symptom:* one L-R pair sits far above all others. *Diagnosis:* technical artifact or one contaminant gene. *Fix:* inspect that gene's per-type expression; if it is broadly/ambiently expressed, drop it and re-rank.
- **`expr_prop` mis-set** — *symptom:* hundreds of weak hits, or rare-but-real signals missing. *Diagnosis:* too low (e.g. 0.01) admits noise; too high (e.g. 0.5) censors rare types. *Fix:* keep the 0.1 default unless you have a reason; document any change.

## observe_figure checkpoints

- **liana dotplot** of top source→target L-R pairs — are the implicated types biologically plausible (e.g. immune → epithelial), or two types that cannot interact? Call `observe_figure` before any interaction is asserted.

## Grounding

Build the `report` dict **from `liana_res`** (do not hardcode numbers), then pass it to `evidence_from_kernel_cell`:

```python
top = liana_res.sort_values("magnitude_rank").head(20)
report = {
    "method": "liana_rank_aggregate",
    "groupby": "cell_type",
    "n_types": int(adata.obs["cell_type"].nunique()),
    "n_interactions": int(len(liana_res)),  # total L-R pairs tested
    "expr_prop": 0.1,
    "min_cells": 10,
    "resource": "consensus",
    "top_interactions": top[
        ["source", "target", "ligand_complex", "receptor_complex", "magnitude_rank"]
    ].to_dict("records"),
}
report
```

Ground only the top-ranked interactions (source, target, L-R pair, ranks), the `expr_prop`/`min_cells` used, and the resource — these come straight from `liana_res`.

## Honesty

- Present CCC as **hypothesis-generating** — expression co-occurrence is **not proof of signaling**. A ligand and receptor being expressed in neighboring types is consistent with communication, but it does not prove it (other mechanisms, autocrine loops, non-functional expression are all possible).

- **Do not over-interpret without orthogonal support** — e.g., if you claim "T cells activate B cells via CD40L-CD40," cite the CCC evidence as supporting, then validate with:
  - Known biology (is this interaction documented?)
  - Spatial co-localization (do these types actually neighbor each other?)
  - Functional perturbation (if you have perturbation data, does blocking the ligand change the target's state?)

- **CCC methods differ** — CellPhoneDB uses a permutation test on mean expression; NATMI uses a weighted score; Connectome uses network topology. The consensus ranking aggregates across these, so it's robust to any one method's assumptions, but it also smooths over real disagreements. If a pair ranks high in the consensus but you want to understand *why*, look at the per-method scores.

- **Spatial CCC (liana bivariate, squidpy ligrec) is stronger** — if you have spatial data, use spatial-aware CCC instead of or in addition to expression-only CCC, because proximity matters (the expression-only consensus here cannot prove physical co-location).
