# Functional Analysis — Pathway/TF Activity, Gene-set Enrichment, Perturbation

**Maturity: READY** — all three run through tested `omics_compute` subcommands (`pathway_activity`, `enrichment`, `perturbation`) in the pinned `task1` env; call the tool. (CNV inference has no subcommand — out of scope here; if needed it is a REFERENCE hand-rolled `infercnvpy` recipe in `run_python`.)

## Goal / When to Use

Move from genes to **function**: regulatory/pathway activity per cell, gene-set enrichment of a gene list, or differential response to a perturbation/condition. Use when you want mechanistic interpretation beyond individual marker genes.

## Decision Criteria (which subcommand)

- **Per-cell pathway / TF activity** to overlay on UMAP or compare across clusters → `pathway_activity`.
- **Is gene-set X over-represented in a fixed gene list** (e.g. a cluster's specific markers)? → `enrichment` (ORA).
- **What changes between a treated/condition group and its control?** → `perturbation`.

Background rule for enrichment: ORA tests your query set against the resource's gene universe, so pass a *focused, biologically meaningful* list (a cluster's specific markers) — never a random HVG dump, which inflates apparent significance.

## 1. Pathway / TF activity (READY) — `pathway_activity`

```
omics_compute(
  subcommand="pathway_activity",
  modality="scrna",
  args={"adata": "processed.h5ad", "output": "pathway.h5ad",
        "method": "mlm", "resource": "progeny", "organism": "human"}
)
```

**Why these defaults:** `resource="progeny"` is a compact, well-curated set of ~14 signaling pathways with signed gene weights — ideal for per-cell activity and easy to read on a UMAP. `method="mlm"` (multivariate linear model) fits all pathways jointly, accounting for shared genes — the decoupler-recommended default for weighted networks. For **TF** activity switch `resource="collectri"` (CollecTRI regulons); for broad programs use `resource="msigdb"` (Hallmark). On very large datasets `method="ulm"` (univariate) is lighter. Optional flags: `layer`, `use-raw` (bare store-true), `min-size` (default 5).

**Output:** per-cell scores in `adata.obsm["pathway_<method>"]` and metadata in `uns["pathway_analysis"]` within `pathway.h5ad`; the returned `report` lists `n_pathways`, `n_cells`, and per-pathway mean/std (evidence recorded automatically). Read scores back for plotting:

```python
import scanpy as sc, pandas as pd
a = sc.read_h5ad("pathway.h5ad")
acts = pd.DataFrame(a.obsm["pathway_mlm"], index=a.obs_names,
                    columns=a.uns["pathway_analysis"]["pathway_names"])
acts["leiden"] = a.obs["leiden"].values
print(acts.groupby("leiden").mean())     # per-cluster mean activity
```

## 2. Gene-set enrichment (READY) — `enrichment`

```
omics_compute(
  subcommand="enrichment",
  modality="scrna",
  args={"gene-list": "CD3D,CD3E,IL7R,CCR7,GZMK,CD8A",
        "output": "enrichment.json",
        "method": "ora", "resource": "msigdb", "organism": "human"}
)
```

**Why these defaults:** `method="ora"` (over-representation / Fisher test) is the correct test for an *unranked* gene list — e.g. the top specific markers of one cluster. `resource="msigdb"` (Hallmark sets) gives broad, well-annotated biological programs; switch to `progeny`/`collectri` for pathway/TF sets. Build the gene list from the marker CSV's `names` column: sort by `scores`, filter on `specificity` and `logfoldchanges > 0.5`, take ~20–100 genes. Optional flags: `padj-threshold` (default 0.05), `top-n` (default 50).

> `method="gsea"` is **not** available here — GSEA needs a *ranked* gene list with scores, which this subcommand does not accept (it errors). For ranked enrichment, build a pseudobulk DE ranking and run GSEA in `run_python` (REFERENCE), or use `pathway_activity` with `method="gsea"` on expression.

**Output:** a JSON file with `top_pathways` (sorted by adjusted p-value), `n_significant_pathways`, and the full result table; the returned `report` summarizes the top hits (evidence recorded automatically).

## 3. Perturbation / condition response (READY) — `perturbation`

```
omics_compute(
  subcommand="perturbation",
  modality="scrna",
  args={"adata": "processed.h5ad", "output": "perturbation.h5ad",
        "perturbation-column": "condition", "control-value": "control"}
)
```

**Why these defaults:** runs DE of **each** non-control value vs the named control. `perturbation-column` is the `obs` column holding the labels and `control-value` its baseline level — **both required**. `method` defaults to `"wilcoxon"` (robust, non-parametric, scanpy's default for single cell). Add `"test-values": "stim,drugA"` to restrict comparisons, `"n-top-genes": "50"` to cap reported genes, or tune `"logfc-threshold"` / `"padj-threshold"` for stringency.

> **Cell-level Wilcoxon over-counts.** Each cell is treated as a replicate, so p-values are anticonservative. For a publication-grade condition contrast with biological replicates, prefer **pseudobulk DESeq2/edgeR** (REFERENCE, `method/markers_de.md`) and treat this subcommand's output as an exploratory screen.

**Output:** `uns["perturbation_analysis"]` (per-perturbation significant-gene counts, thresholds) in `perturbation.h5ad`; the returned `report` gives `n_significant_genes` per perturbation plus the top genes (evidence recorded automatically).

## Failure Modes

1. **ORA on a noisy/huge gene list.** *Symptom:* hundreds of "significant" pathways, none specific. *Diagnosis:* the gene list was HVGs or a whole cluster's unfiltered genes, so everything overlaps something. *Fix:* pass only the top specific markers (high `specificity`, `logfoldchanges > 0.5`) — typically 20–100 genes — from `marker_table`.

2. **Wrong organism / symbol mismatch.** *Symptom:* near-zero pathways pass `min-size`, or activity scores are all ≈0. *Diagnosis:* `organism` doesn't match the gene symbols (mouse `Cd3d` vs human `CD3D`), so few genes map into the network. *Fix:* set `organism="mouse"` for mouse symbols; confirm `var_names` are gene symbols, not Ensembl IDs.

3. **Perturbation column/control typo.** *Symptom:* the subcommand errors `Control value '...' not found` or `column not found`. *Diagnosis:* `perturbation-column` or `control-value` doesn't match `obs` exactly (case/whitespace). *Fix:* print `adata.obs[col].value_counts()` and pass the exact level string.

4. **Underpowered condition contrast.** *Symptom:* thousands of "DE" genes between two conditions with one sample each. *Diagnosis:* no biological replication; the cell-level test inflates significance. *Fix:* aggregate to pseudobulk with ≥3 replicates/condition and use DESeq2/edgeR (REFERENCE); report cell-level results as exploratory.

## observe_figure checkpoints

- **Pathway/TF activity UMAP or per-cluster heatmap** — do high-activity pathways match known biology (e.g. JAK-STAT high in activated immune cells)?
- **Enrichment bar plot (top sets by adjusted p)** — are the top sets plausible for the input gene list, or generic ("metabolism" everywhere = non-specific input)?
- **Perturbation volcano / top-gene dotplot** — are the top responders biologically coherent for the perturbation?

Observe each before it backs a claim.

## Grounding

Record from each subcommand's `report`:

- **pathway_activity:** `method`, `resource`, `organism`, `n_pathways`, `n_cells`, per-pathway mean activity (top few).
- **enrichment:** `method`, `resource`, `n_input_genes`, `n_significant_pathways`, top pathway names + adjusted p-values.
- **perturbation:** `method`, `control_value`, `test_values`, `n_significant_genes` per perturbation, top genes.

Reports + evidence are captured automatically; cite them, and always record the **resource and its version** (PROGENy / CollecTRI / MSigDB evolve — "STAT3 is active" depends on the network version).

## Honesty

- **Report the resource + version.** TF/pathway claims implicitly depend on the PROGENy/CollecTRI/MSigDB version.
- **Pathway activity is an aggregate proxy** for coordinated gene expression, not a flux measurement — don't over-read small shifts.
- **Single-cell perturbation DE is exploratory** unless backed by pseudobulk with biological replicates; flag it.
- **Enrichment reflects your input set.** A generic gene list yields generic hits; state how the list was built (which cluster, which filters).
