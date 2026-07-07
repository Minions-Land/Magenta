# Observing Figures

## Goal / When to Use

After generating any PNG figure, before using it in a conclusion, call the `observe_figure` tool to get a text QC verdict. This is the feedback loop that enables adaptive re-routing.

## Decision Criteria

**What to check:**
- Structure presence: Are the expected patterns visible? (separated clusters, gradients, distributions)
- Artifacts: Rendering errors, blank regions, overlapping labels
- Scale: Axes appropriate? Color scale saturated? Points too small/large?
- Completeness: All expected elements present? Legend readable?

**When to re-route:**
- Verdict contains "FAIL": wrong scale, empty, all-one-color, saturated
- Verdict contains "WARN": minor issues, unclear structure
- Verdict says "structure unclear" or "cannot assess"

**When to proceed:**
- Verdict contains "PASS": structure present as expected
- Even with PASS, cite the verdict as evidence

## Method Menu

### The observe_figure tool

**Parameters:**
- `file_path` (required): Path to PNG file
- `question` (required): What to check ("Does this UMAP show distinct clusters?")
- `expectation` (optional): What you expect to see ("Separated point clouds")

**Returns:**
```json
{
  "success": true,
  "file_path": "runs/omics/run_001/figures/umap_leiden.png",
  "question": "Does this UMAP show distinct clusters?",
  "verdict": "PASS: Shows 12 well-separated clusters with minimal overlap. Cluster 3 and 7 are adjacent but distinguishable. Color scale is clear.",
  "agent": "gpt-4o"
}
```

**Verdict format:**
- Starts with `PASS`, `WARN`, or `FAIL`
- Followed by reasoning
- Mentions specific issues if present

## How-To

### Basic observe_figure call

```python
# After saving figure
fig_path = f"runs/omics/{run_id}/figures/umap_leiden.png"

# Call observe_figure (via tool - shown as function here for clarity)
verdict = observe_figure(
    file_path=fig_path,
    question="Does this UMAP show distinct clusters?",
    expectation="Separated point clouds, not overlapping blob"
)

print(verdict["verdict"])
# "PASS: Shows 12 well-separated clusters..."
```

### Crafting effective questions

**Good questions (specific, assessable):**
- "Does this UMAP show distinct clusters?"
- "Is the QC histogram bimodal with a clear cutoff?"
- "Does marker expression localize to expected clusters?"
- "Are batch effects visible in the UMAP?"

**Bad questions (vague, subjective):**
- "Is this plot good?" (too vague)
- "Does this look right?" (no clear criteria)
- "Is this publication-quality?" (subjective aesthetic judgment)

### Using expectations

Expectation helps the vision model assess against your intent:

```python
verdict = observe_figure(
    file_path=fig_path,
    question="Does this heatmap show differential marker expression?",
    expectation="Rows (genes) should show distinct on/off patterns across columns (clusters)"
)
```

Without expectation, the model can still assess, but may not catch subtle mismatches with your intent.

### Processing verdicts

```python
if "FAIL" in verdict["verdict"]:
    # Do not proceed with this figure
    print(f"Figure failed inspection: {verdict['verdict']}")
    # Re-plot with different parameters or choose different viz

elif "WARN" in verdict["verdict"]:
    # Investigate before proceeding
    print(f"Figure has issues: {verdict['verdict']}")
    # May proceed with caveats, or re-plot

elif "PASS" in verdict["verdict"]:
    # Safe to use in conclusions
    print(f"Figure passed: {verdict['verdict']}")
    # Include verdict text as evidence
```

### Re-plotting loop

```python
# Initial plot
sc.pl.umap(adata, color='leiden', size=10, show=False)
plt.savefig(fig_path, dpi=150)
plt.close()

verdict = observe_figure(fig_path, "Are clusters visible?")

if "FAIL" in verdict["verdict"] and "points too small" in verdict["verdict"]:
    # Re-plot with larger points
    sc.pl.umap(adata, color='leiden', size=50, show=False)
    plt.savefig(fig_path, dpi=150)
    plt.close()

    verdict = observe_figure(fig_path, "Are clusters visible now?")
```

### Observing multiple figures

```python
figures_to_check = [
    ("umap_leiden.png", "Does this show distinct clusters?"),
    ("umap_batch.png", "Are batches mixed or separated?"),
    ("qc_violin.png", "Do QC metrics vary across clusters?"),
]

observations = {}
for fig_name, question in figures_to_check:
    fig_path = f"runs/omics/{run_id}/figures/{fig_name}"
    verdict = observe_figure(fig_path, question)
    observations[fig_name] = verdict

# Check if any failed
failed = [name for name, v in observations.items() if "FAIL" in v["verdict"]]
if failed:
    print(f"Failed figures: {failed}")
    # Re-route analysis
```

## Pitfalls & Quality Checks

❌ **Skipping observe_figure to save time**
- Claiming "UMAP shows separation" without actually looking
- Solution: Observation is required for every figure-backed claim

❌ **Ignoring FAIL verdicts**
- Proceeding with a failed figure because it "looks fine to me"
- Solution: Trust the vision model—it catches artifacts you might miss

❌ **Vague questions**
- "Is this good?" → verdict is also vague
- Solution: Ask specific, assessable questions

❌ **Not re-plotting after FAIL**
- Accepting a broken figure instead of fixing parameters
- Solution: Re-plot with adjusted params (size, scale, layout)

❌ **Forgetting to save verdict as evidence**
- Observing but not recording the verdict
- Solution: Always emit the verdict in evidence dict

## Grounding

Include the observe_figure verdict in your evidence:

```python
evidence = {
    "operation": "figure_observation",
    "figure_path": fig_path,
    "question": verdict["question"],
    "verdict": verdict["verdict"],
    "used_in_conclusion": True,
    "timestamp": datetime.utcnow().isoformat()
}
print(json.dumps(evidence))
```

When you cite a figure in your final report, reference both the figure path and the observe_figure verdict—this is the complete evidence chain.

## Honesty

- **If a figure fails inspection, do not use it.** Re-plot or choose a different visualization.
- **If the verdict is "structure unclear", do not overstate what you can conclude.** Either improve the plot or hedge your claim.
- **If you forget to observe a figure that backs a claim**, that claim is ungrounded. Go back and observe it, or drop the claim.

The observe_figure tool is not optional for figure-backed claims—it is the mechanism that makes visual evidence auditable and the feedback loop that enables adaptive re-routing when plots fail.
