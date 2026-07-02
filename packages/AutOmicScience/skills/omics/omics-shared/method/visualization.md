# Visualization & Figure Inspection

## Goal / When to Use

Before using any figure in a conclusion, save it to disk and inspect it with `observe_figure`. This guidance covers matplotlib/scanpy plotting patterns and the observe_figure feedback loop.

## Decision Criteria

**When you MUST save and observe:**
- Any figure that backs a claim (UMAP shows separation, QC histogram shows bimodality, marker expression localizes)
- Before reporting "12 distinct clusters" (observe UMAP/clustering)
- Before claiming "batch effect corrected" (observe before/after)
- Before interpreting marker expression (observe heatmap/dotplot)

**Observation verdict meanings:**
- **PASS**: Structure present as expected, proceed
- **WARN**: Minor artifacts or unclear structure, investigate before using
- **FAIL**: Wrong scale, empty axes, all-one-color, saturated → do not use, re-plot

## Method Menu

### 1. Save figures to disk (required)

Kernel captures only stdout/stderr, NOT inline plots. You MUST write figures to `runs/omics/<id>/figures/`:

```python
import matplotlib.pyplot as plt

# Create plot
sc.pl.umap(adata, color='leiden', show=False)

# Save to disk
fig_path = f"runs/omics/{run_id}/figures/umap_leiden.png"
plt.savefig(fig_path, dpi=150, bbox_inches='tight')
plt.close()
```

### 2. Call observe_figure

After saving, call the `observe_figure` tool:

```python
# Pseudo-code (actual call via tool system)
verdict = observe_figure(
    file_path=fig_path,
    question="Does this UMAP show distinct clusters?",
    expectation="Separated point clouds, not overlapping blob"
)
```

Returns verdict dict:
```python
{
    "success": true,
    "file_path": "runs/omics/run_001/figures/umap_leiden.png",
    "question": "Does this UMAP show distinct clusters?",
    "verdict": "PASS: Shows 12 well-separated clusters...",
    "agent": "gpt-4o"
}
```

### 3. Re-route on WARN/FAIL

```python
if "FAIL" in verdict["verdict"] or "WARN" in verdict["verdict"]:
    # Investigate: wrong parameters? need different visualization?
    # Do NOT proceed to conclusion with a failed figure
    return {"status": "blocked", "reason": verdict["verdict"]}
```

## How-To

### Complete figure workflow

```python
import os
os.makedirs(f"runs/omics/{run_id}/figures", exist_ok=True)

# 1. Generate figure
sc.pl.umap(adata, color='leiden', legend_loc='on data', show=False)

# 2. Save
fig_path = f"runs/omics/{run_id}/figures/umap_leiden.png"
plt.savefig(fig_path, dpi=150, bbox_inches='tight')
plt.close()

# 3. Observe (via tool call - pseudo-code here)
verdict = observe_figure(
    file_path=fig_path,
    question="Are clusters well-separated?",
    expectation="Distinct point clouds with minimal overlap"
)

# 4. Ground
evidence = {
    "operation": "figure_observation",
    "figure_path": fig_path,
    "question": verdict["question"],
    "verdict": verdict["verdict"],
    "timestamp": datetime.utcnow().isoformat()
}
print(json.dumps(evidence))

# 5. Use verdict in analysis decision
if "PASS" in verdict["verdict"]:
    # Proceed with clustering interpretation
    pass
elif "WARN" in verdict["verdict"]:
    # Investigate but may proceed with caveats
    pass
else:  # FAIL
    # Do not use this figure, re-plot or choose different viz
    pass
```

### Common scanpy plots

**Embedding plots:**
```python
sc.pl.umap(adata, color=['leiden', 'n_genes', 'pct_mito'], show=False)
plt.savefig(f"runs/omics/{run_id}/figures/umap_overview.png", dpi=150, bbox_inches='tight')
plt.close()
```

**QC violin plots:**
```python
sc.pl.violin(adata, ['n_genes', 'n_counts', 'pct_mito'], groupby='leiden', show=False)
plt.savefig(f"runs/omics/{run_id}/figures/qc_violin.png", dpi=150, bbox_inches='tight')
plt.close()
```

**Marker heatmaps:**
```python
sc.pl.heatmap(adata, marker_genes, groupby='leiden', swap_axes=True, show=False)
plt.savefig(f"runs/omics/{run_id}/figures/marker_heatmap.png", dpi=150, bbox_inches='tight')
plt.close()
```

**Spatial plots (if spatial data):**
```python
import squidpy as sq
sq.pl.spatial_scatter(adata, color='cell_type', size=1.5, show=False)
plt.savefig(f"runs/omics/{run_id}/figures/spatial_celltypes.png", dpi=150, bbox_inches='tight')
plt.close()
```

### DPI and format choices

- **DPI**: 150 (good balance of quality and file size)
- **Format**: PNG (universal, lossless for plots)
- **bbox_inches='tight'**: Removes excess whitespace

For publication-quality:
```python
plt.savefig(fig_path, dpi=300, bbox_inches='tight', format='pdf')
```

### Batch plotting multiple figures

```python
figures = {
    "umap_leiden": lambda: sc.pl.umap(adata, color='leiden', show=False),
    "umap_batches": lambda: sc.pl.umap(adata, color='batch', show=False),
    "qc_violin": lambda: sc.pl.violin(adata, ['n_genes', 'pct_mito'], show=False),
}

for name, plot_fn in figures.items():
    plot_fn()
    fig_path = f"runs/omics/{run_id}/figures/{name}.png"
    plt.savefig(fig_path, dpi=150, bbox_inches='tight')
    plt.close()

    # Observe each
    verdict = observe_figure(file_path=fig_path, question=f"Does {name} show expected structure?")
    # ... process verdict
```

## Pitfalls & Quality Checks

❌ **Using `show=True` or relying on inline display**
- Inline plots are invisible to the kernel output → cannot be observed
- Solution: Always `show=False` + `plt.savefig()` + `plt.close()`

❌ **Not calling observe_figure before citing a figure**
- Claiming "UMAP shows clear separation" without actually looking at it
- Solution: Every figure-backed claim needs an observe_figure verdict

❌ **Ignoring WARN/FAIL verdicts**
- Proceeding with conclusion despite "structure unclear" verdict
- Solution: Re-plot, investigate parameters, or drop the claim

❌ **Saving to wrong directory**
- Saving to cwd instead of `runs/omics/<id>/figures/`
- Solution: Always organize under the run directory for reproducibility

❌ **Forgetting `plt.close()`**
- Accumulating figures in memory → memory leak in batch plotting
- Solution: Always close after saving

❌ **Overwriting figures**
- Using same filename for different plots
- Solution: Use descriptive unique names (`umap_leiden.png`, `umap_batch.png`)

## Grounding

For every figure used in a conclusion:

```python
evidence = {
    "operation": "figure_based_claim",
    "claim": "12 distinct clusters visible in UMAP",
    "figure_path": fig_path,
    "observe_verdict": verdict["verdict"],
    "timestamp": datetime.utcnow().isoformat()
}
print(json.dumps(evidence))
```

The figure path + verdict together form the evidence for the visual claim.

## Honesty

- **If observe_figure returns FAIL**, do not use that figure. Re-generate with different parameters or choose a different visualization.
- **If structure is "unclear" or "ambiguous"**, say so in your conclusion—do not overstate what the figure shows.
- **If you generate a figure but forget to observe it**, the claim is ungrounded—either observe it retroactively or drop the claim.

Figures are evidence, but only if you actually look at them. The observe_figure tool is the mechanism that makes "looking" explicit and auditable.
