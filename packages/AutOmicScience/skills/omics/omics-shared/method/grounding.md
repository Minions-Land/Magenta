# Evidence Grounding — Phase 0 Python

## Goal

Ground every quantitative claim in your analysis with traceable evidence. Before a number enters your conclusion, emit a structured record that captures what was computed, how it was derived, and where it came from.

Evidence grounding is **not optional** when `evidencePolicy: required` — it is a contract. The Rust runtime consumes your helper `report` dicts and Python tool outputs to build `EvidenceRecord` and `TraceStep` entries that make the final report auditable.

## When to Ground

Use evidence grounding whenever you:

1. **Produce a quantitative claim** — cluster count, gene expression value, QC threshold, p-value, ARI score
2. **Apply a transformation** — filtering cells, normalizing counts, selecting HVGs, sampling a subset
3. **Make a comparison** — reference vs. query, batch A vs. batch B, before vs. after integration
4. **Invoke a standard method** — Leiden clustering, differential expression, trajectory inference
5. **Cite external data** — loaded dataset accession, reference annotation source, prior study

## Decision Criteria

**When to return a helper `report` dict:**

- You run a standard preprocessing pipeline → `standard_preprocess(..., return_report=True)` gives you the dict
- You perform a custom analysis step → build your own dict with the same structure
- You apply a filter or transformation → record input shape, output shape, parameters
- You compute a metric → include the metric name, value, and source data summary

**When to emit evidence explicitly:**

- You call a bio tool (e.g., `bio_gene_lookup`, `bio_literature_search`) → the Rust side auto-creates `EvidenceRecord`
- You load a dataset → note the accession, source, and summary in your next cell
- You reference prior work → cite the study and state what you extracted from it

## Method Menu

### 1. Standard Preprocessing Report

Use the built-in `standard_preprocess` helper with `return_report=True`:

```python
adata, report = preprocess.standard_preprocess(
    adata,
    n_hvg=2000,
    resolution=1.0,
    return_report=True  # <-- always True for phase 0
)

# The report dict is your evidence
print(f"Filtered {report['cells_filtered']} cells, identified {report['n_clusters']} clusters")
```

**What's in the report:**
- `initial_shape`, `post_qc_shape`, `final_shape` — cell/gene counts at each stage
- `cells_filtered`, `genes_filtered` — how many were removed
- `parameters` — exact values for all tunable knobs (n_hvg, resolution, n_pcs, etc.)
- `n_clusters` — number of Leiden clusters found
- `start_time`, `end_time`, `duration_seconds` — execution trace

### 2. Custom Analysis Report

When adapting by hand, build your own report dict:

```python
report = {
    "operation": "custom_integration",
    "method": "scvi",
    "input_shape": (adata.n_obs, adata.n_vars),
    "parameters": {
        "n_latent": 30,
        "n_layers": 2,
        "dropout_rate": 0.1,
    },
    "n_batches": len(adata.obs["batch"].unique()),
    "latent_dim": adata.obsm["X_scVI"].shape[1],
    "duration_seconds": 42.3,
}
```

**Required fields:**
- `operation` — what you did
- `parameters` — all tunable values
- `input_shape` or `input_summary` — what went in
- `output_shape` or `output_summary` — what came out

### 3. Dataset Summary Evidence

Use `summarize.summarize_adata()` to create a plain-text context, then **pair it with the study description**:

```python
summary = summarize.summarize_adata(adata)
print(summary)

# In your next prompt, state:
# "Dataset: GSE12345 — 5,000 cells × 20,000 genes, layers: counts, obs: batch(3), cell_type(8), condition(healthy, disease)"
```

This summary becomes implicit evidence that grounds statements like "the dataset contains 8 cell types" or "we have 3 batches."

### 4. Transformation Steps

When you filter, sample, or transform data, record the change:

```python
# Before
initial_cells = adata.n_obs

# Filter
adata = adata[adata.obs["pct_counts_mt"] < 20].copy()

# After
final_cells = adata.n_obs

report = {
    "operation": "qc_filter",
    "criterion": "pct_counts_mt < 20",
    "initial_cells": initial_cells,
    "final_cells": final_cells,
    "cells_removed": initial_cells - final_cells,
}
```

### 5. Metric Computation

When you compute a score (ARI, silhouette, variance explained), capture it:

```python
from sklearn.metrics import adjusted_rand_score

ari = adjusted_rand_score(adata.obs["cell_type"], adata.obs["leiden"])

report = {
    "operation": "cluster_evaluation",
    "metric": "adjusted_rand_index",
    "value": float(ari),
    "reference": "cell_type (prior annotation)",
    "predicted": "leiden (computed clusters)",
    "n_cells": adata.n_obs,
}
```

## How Evidence Gets Recorded

### Python → Rust Flow

1. **You emit a report dict** in your notebook cell (e.g., `standard_preprocess(..., return_report=True)`)
2. **The Python tool captures it** as part of the cell's output (stdout, return value, or side effect)
3. **The Rust agent parses it** and creates an `EvidenceRecord` with:
   - `source: Computation`
   - `source_type: "scanpy"` (or your tool name)
   - `identifier: "standard_preprocess_run_001"`
   - `content: <JSON serialization of the report dict>`
   - `timestamp: <ISO 8601>`
4. **The runtime stores it** in `ToolResult.metadata` (though note: as of 2026-06-13, `Message` does not yet have a metadata field, so provenance is built but not fully wired — see memory note on "provenance gap")

### What the Rust Side Does

From `aose-schemas/src/grounding.rs`:

```rust
pub struct EvidenceRecord {
    pub source: EvidenceSource,       // Tool | Database | Literature | Computation | Manual
    pub source_type: String,          // "scanpy", "GEO", "PubMed", etc.
    pub identifier: String,           // file path, accession, DOI
    pub url: Option<String>,          // retrieval URL
    pub timestamp: String,            // ISO 8601
    pub content: String,              // summary or full data
    pub metadata: HashMap<String, Value>,  // structured extras
}
```

For your helper report dicts, the Rust side will call:

```rust
EvidenceRecord::from_computation(
    "scanpy",                        // source_type
    "preprocess_run_001",            // identifier
    serde_json::to_string(&report),  // content
    chrono::Utc::now().to_rfc3339()  // timestamp
)
```

### Bio Tool Auto-Evidence

When you call a bio tool like `bio_gene_lookup`, the Rust side auto-creates evidence:

```rust
EvidenceRecord::from_database(
    "Ensembl",                       // source_type
    "ENSG00000157764",               // identifier (gene ID)
    "BRAF: serine/threonine kinase", // content (summary)
    timestamp,
    Some("https://ensembl.org/...")  // url
)
```

You don't need to do anything — the tool wiring handles it.

## Pitfalls

### 1. Silent Numbers

**Wrong:**
```python
# Cell output: "Found 12 clusters"
```

**Right:**
```python
n_clusters = len(adata.obs["leiden"].unique())
print(f"Found {n_clusters} clusters")

report = {
    "operation": "leiden_clustering",
    "resolution": 1.0,
    "n_clusters": n_clusters,
}
```

The number "12" must trace to a computation with parameters.

### 2. Forgetting Parameters

**Wrong:**
```python
report = {
    "operation": "hvg_selection",
    "n_hvg": 2000,
}
```

**Right:**
```python
report = {
    "operation": "hvg_selection",
    "n_hvg": 2000,
    "flavor": "seurat_v3",
    "initial_genes": adata.n_vars,
    "selected_genes": 2000,
}
```

Include the method variant and input/output shapes.

### 3. Copying Instead of Computing

**Wrong:**
```python
# You see adata.obs["cell_type"] exists, so you just repeat it
print("Cell types: T cells, B cells, NK cells")
```

**Right:**
```python
# If cell_type is prior annotation, state that
print("Cell types (prior annotation from study authors):")
print(adata.obs["cell_type"].value_counts())

# If you computed it yourself, show the code + report
```

**Anti-circular rule:** Never treat existing annotations as your answer. Use them only for post-hoc comparison (ARI/NMI).

### 4. Ignoring Transformations

**Wrong:**
```python
# Filter to 1000 genes for speed
adata_sub = adata[:, :1000].copy()
# ... analysis on adata_sub ...
# "We found X% of cells express marker Y"
```

The percentage is over a subset, not the full dataset. Flag it:

```python
report = {
    "operation": "gene_subset",
    "input_genes": adata.n_vars,
    "output_genes": 1000,
    "is_partial": True,  # <-- critical flag
}
```

### 5. Missing Dataset Context

**Wrong:**
```python
# First cell: load dataset, immediately start analysis
```

**Right:**
```python
# First cell: load dataset, summarize it, state the study context
summary = summarize.summarize_adata(adata)
print(summary)
print("\nStudy context: GSE12345, healthy vs. disease PBMC, 10x 3' v3 chemistry")
```

Thread this context into every downstream prompt.

## Grounding Checklist

Before moving past phase 0, confirm:

- [ ] Every number in your conclusion has a matching `report` dict or explicit evidence
- [ ] All preprocessing parameters are recorded (n_hvg, resolution, n_pcs, seed)
- [ ] Dataset shape and context are stated upfront (accession, n_cells, n_genes, obs columns)
- [ ] Transformations are logged (QC filter removed X cells, subset to Y genes)
- [ ] Metrics are paired with their inputs (ARI over N cells, reference = cell_type, predicted = leiden)
- [ ] Prior annotations are labeled as such, not claimed as your output
- [ ] If you sampled or filtered, `is_partial: True` is set

## Honesty Boundaries

### When Data Doesn't Match Claims

If the study description says "healthy + disease" but `adata.obs` has no condition column:

**Wrong:**
```python
# Assume batch 1 = healthy, batch 2 = disease
```

**Right:**
```python
print("Study claims healthy vs. disease, but no condition column found in obs.")
print("Available columns:", list(adata.obs.columns))
print("Cannot proceed without explicit condition labels. Request clarification or check metadata.")
```

### When You Can't Explain a Result

If a cluster has no differentially expressed markers:

**Wrong:**
```python
# Guess: "likely doublets or low-quality cells"
```

**Right:**
```python
report = {
    "operation": "marker_identification",
    "cluster_id": "5",
    "n_de_genes": 0,
    "conclusion": "unknown — no significant markers at FDR < 0.05",
}
print("Cluster 5: no DE genes found. Label: unknown (requires manual inspection or alternative method).")
```

### When Evidence Is Weak

If you have 2 cells expressing a marker:

**Wrong:**
```python
# "This cluster is enriched for CD4"
```

**Right:**
```python
report = {
    "operation": "marker_check",
    "marker": "CD4",
    "n_cells_positive": 2,
    "n_cells_total": 150,
    "fraction": 0.013,
}
print("CD4: 2/150 cells (1.3%) — insufficient for cell type assignment")
```

## Summary

Evidence grounding is the contract between your Python analysis and the Rust runtime's report generator. Every quantitative claim must trace to:

1. **A computation** — with input, output, and parameters
2. **A dataset** — with accession, shape, and summary
3. **A method** — with algorithm, variant, and hyperparameters
4. **A transformation** — with before/after state and flags (is_partial)

Helper `report` dicts become `EvidenceRecord` entries. Bio tool calls auto-create evidence. Dataset summaries provide implicit grounding for shape/structure claims.

**Abstain over fabricate.** Missing data → blocker with fix command. Unresolvable cluster → "unknown". Weak signal → state the fraction and defer. Uncertainty is honest; invention is not.
