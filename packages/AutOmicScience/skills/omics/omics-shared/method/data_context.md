# Dataset Summary & Study Context

## Purpose

Every omics dataset has two layers of context that must be paired and threaded into every downstream analysis:

1. **Structural context** — what obs columns, layers, and embeddings exist (from `summarize_adata`)
2. **Scientific context** — biological question, experimental design, what existing annotations mean

Without both, the agent operates blind and produces unreliable or circular results.

## When to Use

**Always** — immediately after loading any dataset, before any analysis (annotation, DE, composition, QC decisions).

## Decision Criteria

**When dataset context is critical:**
- **Annotation:** Which cell types are biologically plausible given tissue/condition?
- **DE analysis:** Which comparisons make sense given the experimental design?
- **Composition analysis:** Is a condition-enriched population expected or surprising?
- **QC decisions:** Are these QC metrics typical for this data type?

**What structural context reveals:**
- Data shape (n_obs cells × n_vars genes)
- Available metadata columns (batch, condition, donor, existing annotations)
- Data structure (which layers, embeddings, graphs are present)
- Value distributions (numeric ranges, categorical frequencies)

**What study description provides:**
- Biological question / hypothesis
- Experimental design (conditions, perturbations, timepoints)
- Sample source (tissue, organism, technology)
- What existing obs columns represent

## Core Pattern

### 1. Generate Structural Summary

```python
from summarize import summarize_adata

summary_text = summarize_adata(adata, top_k=20)
```

**What it captures:**
- Shape: `n_obs cells × n_vars genes`
- Layers: comma-separated list (e.g., `counts`)
- Each `obs` column with:
  - Numeric: `name (numeric): range [min, max], mean=value`
  - Categorical: `name (categorical, N unique): val(count), val(count), ... +N more`
- `obsm` keys: available embeddings (e.g., `X_pca`, `X_umap`, `spatial`)

**Example output:**
```
Shape: 5000 cells × 2000 genes

Layers: counts

Cell metadata (obs):
  n_genes (numeric): range [500, 3500], mean=1850
  leiden (categorical, 8 unique): 0(850), 1(720), 2(650), 3(580), 4(490), 5(410), 6(380), 7(920)
  cell_type (categorical, 5 unique): T cell(1200), B cell(980), Monocyte(1100), NK cell(850), Dendritic cell(870)
  condition (categorical, 2 unique): control(2500), treated(2500)

Embeddings/matrices (obsm):
  X_pca, X_umap
```

### 2. Pair with Study Free-Text Description

```python
study_desc = """
PBMC samples from healthy donors (control) vs. patients with autoimmune disease (treated).
The 'condition' column distinguishes control/treated.
The 'cell_type' column was annotated by original authors using canonical markers.
"""

context = f"""
Dataset structure:
{summary_text}

Study description:
{study_desc}
"""
```

**What study description must include:**
- Biological question / experimental design
- What conditions/perturbations were tested
- What existing obs columns represent (especially existing annotations)
- Sample source (tissue, organism, technology)

### 3. Thread into Every Downstream Prompt

**Cell type annotation:**
```python
prompt = f"""
{context}

Task: Annotate leiden clusters using marker genes from the literature.
CRITICAL: The 'cell_type' column is prior annotation — use only for post-hoc comparison (ARI/NMI), never copy it as your answer.
"""
```

**Differential expression:**
```python
prompt = f"""
{context}

Task: Identify genes differentially expressed between control and treated conditions in T cells.
"""
```

**Composition analysis:**
```python
prompt = f"""
{context}

Task: Compare cell type proportions between control and treated. Report shifts that might explain disease phenotype.
"""
```

## How-To

### Complete context workflow

```python
import os, sys
skills_dir = os.environ.get("AOS_SKILLS_DIR") or "skills"
sys.path.insert(0, os.path.join(skills_dir, "omics", "_shared", "scripts"))
import summarize

# Load data
adata = sc.read_h5ad("data.h5ad")

# Generate summary (do this ONCE, right after load)
summary = summarize.summarize_adata(adata, top_k=20)

# User-provided study description
study_desc = "Healthy and COVID-19 PBMC, 10x Chromium 3' v3"

# Assemble full context
context = f"""
Dataset structure:
{summary}

Study description:
{study_desc}
"""

# Now thread into every downstream prompt
annotation_prompt = f"""
{context}

Task: Based on marker genes and this context, annotate cell types...
"""
```

### Anti-circular rule for existing annotations

If `summarize_adata` reveals an obs column like `cell_type` or `celltype_annotation`:

**Correct usage:**
- Post-hoc comparison: "My annotation agrees with prior labels (ARI=0.85)"
- Validation: "Prior annotation shows 12 T cell subtypes; I found 10"

**Circular usage (forbidden):**
- Copying: "cell_type column says 'CD4 T cell', so I label it CD4 T cell"
- This is circular—you are not performing annotation, just echoing prior work

**Recipe guidance:** Treat any existing cell-type-like column as **prior annotation**. Use only for post-hoc comparison (ARI/NMI), never as your answer.

### User claim vs data mismatch checking

Study description: "healthy + COVID-19 PBMC"
summarize_adata output: Shows `obs` columns but none distinguish condition

**Decision:**
```python
if "condition" not in adata.obs.columns and "disease" not in adata.obs.columns:
    # Flag mismatch
    return {
        "status": "blocked",
        "reason": "Study claims healthy + COVID-19 split, but no obs column distinguishes condition",
        "action": "Ask user: which obs column indicates condition, or is the data actually single-condition?"
    }
```

Do not silently pick a side or invent a split. Surface every study-vs-data mismatch.

**Common mismatches:**
- User: "Compare tumor vs. normal" → Data: no `tumor_type` or `tissue` column
- User: "Time-series at 0h, 6h, 24h" → Data: `timepoint` has values `["early", "late"]`
- User: "PBMC dataset" → Data: `tissue` column shows `["liver", "spleen"]`

**When to flag:**
- Missing expected columns
- Column values don't match user's claim
- Ambiguous column names (e.g., `group1`, `group2` without description)

### Per-cluster composition guidance

For annotating or interpreting clusters, cross-tabulate a categorical obs column against clusters:

```python
import pandas as pd

# If adata.obs has "donor" or "batch" or "condition"
if "condition" in adata.obs.columns:
    comp = pd.crosstab(adata.obs["leiden"], adata.obs["condition"], normalize='columns')
    print("Per-cluster composition:")
    print(comp)
```

**Interpretation guidance:**
- Cluster enriched in one condition → candidate for condition-specific state
- Cluster with 100% cells from one batch → likely technical artifact
- Disease state call requires marker support (anti-fabrication rule)

**Include in context:**
```python
cluster_sizes = adata.obs['leiden'].value_counts().sort_index()

context += f"""

Cluster sizes:
{cluster_sizes.to_string()}

Per-cluster composition by condition:
{comp.to_string()}

Flag: If a cluster is 100% from one condition, it might be condition-specific or a batch artifact.
"""
```

## Pitfalls & Quality Checks

### Common Mistakes

**Mistake 1: Calling summarize_adata multiple times**
```python
# BAD - wasteful and unnecessary
summary1 = summarize_adata(adata)
summary2 = summarize_adata(adata)  # Identical to summary1
```
**Fix:** Call once after load, store the text, reuse everywhere.

**Mistake 2: Summary without study description**
```python
# BAD - agent knows structure but not what columns mean
summary = summarize_adata(adata)
# No study description provided
```
**Fix:** Always pair structural summary with study description.

**Mistake 3: Not threading context into downstream prompts**
```python
# BAD - context generated but never used
context = get_context(adata)

# Later, in annotation step:
prompt = "Annotate these clusters"  # No context!
```
**Fix:** Every analysis prompt must include the full context (structural + study description).

**Mistake 4: Using existing labels without verification**
```python
# BAD - just copying existing labels
if 'cell_type' in adata.obs:
    return adata.obs['cell_type']
```
**Fix:** Perform fresh annotation, then compare against existing labels for validation.

**Mistake 5: Ignoring user-claim vs. data mismatches**
```python
# BAD - user says "tumor vs. normal" but data has no such column
# Agent proceeds anyway, picking a random column or guessing
```
**Fix:** Explicitly check and flag the mismatch. Ask for clarification.

**Mistake 6: Trusting study description blindly**
```python
# BAD - user says "10 donors" but summary shows only 2
# Agent doesn't verify
```
**Fix:** Check that study claims match what summary reveals. Flag discrepancies.

**Mistake 7: Fabricating column meanings**
```python
# BAD - data has obs["group1"], obs["group2"]
# Agent assumes "group1 = tumor, group2 = normal" without verification
```
**Fix:** If column meanings are unclear, flag and request clarification. Don't guess.

**Mistake 8: Over-calling disease states from composition alone**
```python
# BAD - cluster enriched in COVID-19 → calling it "COVID-associated macrophage" without marker evidence
```
**Fix:** Composition constrains candidates, but disease-state calls require marker support.

### Quality Checklist

Before moving to annotation, DE, or composition analysis:

- [ ] Generated structural summary with `summarize_adata(adata)`
- [ ] Collected study description (biological question, experimental design, column meanings)
- [ ] Checked for user-claim vs. data mismatches (expected columns present? Values match description?)
- [ ] Flagged any existing cell-type labels as prior annotation (anti-circular rule)
- [ ] Computed per-cluster composition if condition/batch columns exist
- [ ] Threaded full context (structural + study description) into downstream prompts
- [ ] If any column meanings are unclear, flagged for clarification instead of guessing

## Grounding

Record the `summarize_adata` output and study description as evidence:

```python
import json
from datetime import datetime

evidence = {
    "operation": "dataset_context",
    "summary": summary,
    "study_description": study_desc,
    "timestamp": datetime.utcnow().isoformat()
}
print(json.dumps(evidence))
```

If you perform per-cluster composition, emit that too:

```python
evidence = {
    "operation": "cluster_composition",
    "cluster_by": "leiden",
    "condition_by": "disease_status",
    "table": comp.to_dict(),
    "timestamp": datetime.utcnow().isoformat()
}
print(json.dumps(evidence))
```

This creates traceable evidence records that link every downstream biological claim back to the dataset structure that supported it.

## Integration with Other Methods

### With `preprocess.py`
```python
from preprocess import standard_preprocess

# 1. Load
adata = sc.read_h5ad(path)

# 2. Summarize BEFORE preprocessing (captures raw structure)
raw_summary = summarize_adata(adata)

# 3. Preprocess
adata = standard_preprocess(adata)

# 4. Summarize AFTER preprocessing (captures post-QC structure)
processed_summary = summarize_adata(adata)

context = f"""
Raw data:
{raw_summary}

After preprocessing:
{processed_summary}

Study description:
{study_desc}
"""
```

### With `grounding.py`
Context provides the obs columns available for evidence grounding. E.g., if context shows "leiden (8 clusters)", grounding should reference leiden cluster IDs.

### With `visualization.py`
When generating plots, use context to choose appropriate grouping variables. E.g., if context shows "condition (2 unique): control, treated", color by condition.

## Example: Full Context Assembly

```python
from summarize import summarize_adata
import scanpy as sc
import pandas as pd

# Load
adata = sc.read_h5ad("pbmc_dataset.h5ad")

# Structural summary
structural = summarize_adata(adata)

# Study description (from metadata or user)
study_desc = """
PBMC samples from 5 healthy donors and 5 patients with lupus (SLE).
Condition column: 'disease_state' (healthy, SLE).
Original authors annotated cell types in 'cell_type_orig' column using marker genes.
Goal: Validate original annotations and identify disease-associated cell states.
"""

# Check for mismatches
if 'disease_state' not in adata.obs:
    print("WARNING: Study claims 'disease_state' column but not found.")
    print("Available:", list(adata.obs.columns))

# Per-cluster composition (if clusters exist)
if 'leiden' in adata.obs and 'disease_state' in adata.obs:
    composition = pd.crosstab(
        adata.obs['leiden'],
        adata.obs['disease_state'],
        normalize='columns'
    )
    composition_str = composition.to_string()
else:
    composition_str = "(not yet clustered)"

# Assemble full context
context = f"""
Dataset structure:
{structural}

Study description:
{study_desc}

Per-cluster composition by disease_state:
{composition_str}

IMPORTANT:
- 'cell_type_orig' is prior annotation. Perform fresh annotation and compare using ARI/NMI.
- Flag any cluster that is 100% from one disease_state as potentially disease-specific or artifact.
"""

# Now thread this context into every downstream prompt
print(context)
```

<!-- SECTION_MARKER: summary -->
