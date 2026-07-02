# Spatial Cell-Cell Communication

**Maturity: REFERENCE** — ligand-receptor analysis. The default (**squidpy `gr.ligrec`**, CellPhoneDB-style) runs on the installed stack; the directional / optimal-transport alternative (**COMMOT**) needs an isolated env.

## Goal / When to Use

Generate **ligand-receptor interaction hypotheses** between annotated cell types/domains in spatial context. Use after a trustworthy annotation (garbage labels → garbage CCC). Spatial CCC adds proximity over expression-only CCC.

## Decision Criteria — pick one default

- **Default: squidpy `gr.ligrec`** — a permutation test (CellPhoneDB method) for enriched ligand-receptor pairs between cluster pairs. Installed, fast, the right first pass.
- **Directional, distance-aware → COMMOT (needs isolated env)** — collective optimal transport that infers **signaling direction and per-spot sent/received signal**, constrained by spatial distance. Use when you specifically need directionality / spatial range. Pins old `anndata 0.7.6` / `pandas 1.4` + POT — never `task2`.

## How-to (default — squidpy ligrec)

```python
import squidpy as sq

sq.gr.ligrec(
    adata, cluster_key="cell_type",
    n_perms=1000, threshold=0.01,          # ligand/receptor must be expressed in ≥1% of a cluster
    use_raw=False,                          # use normalized .X
)
res = adata.uns["cell_type_ligrec"]         # {"means", "pvalues", "metadata"}
sq.pl.ligrec(res, alpha=0.001, save="_ligrec.png")   # significant LR pairs between type pairs
```
- `threshold=0.01` drops lowly-expressed pairs; `n_perms=1000` is the permutation null for the p-values; `use_raw=False` runs on normalized expression.

**Directional CCC (COMMOT — isolated env):**
```python
import commot as ct   # isolated env: anndata 0.7.6 / pandas 1.4 / POT
df = ct.pp.ligand_receptor_database(database="CellChat", species="human", signaling_type="Secreted Signaling")
df = ct.pp.filter_lr_database(df, adata, min_cell_pct=0.05)
ct.tl.spatial_communication(adata, database_name="cellchat", df_ligrec=df, dis_thr=200, heteromeric=True)
adata.obsm["commot-cellchat-sum-sender"]; adata.obsm["commot-cellchat-sum-receiver"]   # per-spot sent/received signal
```
- `dis_thr=200` — max signaling distance (µm); couplings beyond it are forbidden (the spatial constraint). `heteromeric=True` treats `_`-joined names as receptor complexes.

## Failure Modes

- **Everything is "significant"** — *symptom:* thousands of LR pairs. *Diagnosis:* loose threshold / noisy labels. *Fix:* raise `threshold`, validate annotation, rank by interaction strength.
- **Implausible interactions** (types that can't touch) — *symptom:* spatially distant types "communicating". *Diagnosis:* expression-only ligrec ignores location. *Fix:* restrict to spatially adjacent pairs (`nhood_enrichment`), or use COMMOT's `dis_thr`.
- **COMMOT env collision** — *symptom:* import errors with modern anndata/pandas. *Fix:* dedicated env with its pinned deps; never `task2`.

## observe_figure checkpoints

1. **Ligrec dotplot** (`sq.pl.ligrec`) — are the top source→target pairs biologically plausible (e.g. immune→epithelial)?
2. **COMMOT sender/receiver maps** — does sent/received signal localize to the expected interface regions?

## Grounding

Record: method, `cluster_key`, `n_perms`/`threshold` (ligrec) or `database`/`dis_thr` (COMMOT), top significant LR pairs (source, target, pair), and the resource → `EvidenceRecord`.

## Honesty

- **LR co-expression ≠ proven signaling** — these are hypotheses; spatial proximity strengthens but doesn't prove them.
- Restrict claims to **spatially adjacent** type pairs — expression-only ligrec will pair types that never touch.
- COMMOT directionality is an OT inference, not measured flow — present it as such.
