# Reference — Oncoplot (Mutation Landscape Visualization)

An oncoplot (a.k.a. waterfall plot) displays the mutation landscape: genes (rows) × patients (columns), colored by alteration type, sorted by recurrence.

## What it shows

- **Rows**: genes, sorted by alteration frequency (most recurrent at top)
- **Columns**: patients, sorted to cluster co-altered samples (memo sort)
- **Cell color**: alteration type (missense, truncating, amplification, deletion, …)
- **Side bar**: per-gene frequency (%)
- **Top bar**: per-patient TMB or alteration count (optional)

## Option A: comut (recommended, pip-installable)

```python
from comut import comut
import pandas as pd

# Build long-format dataframe: sample, category (gene), value (alteration type)
data = pd.DataFrame({
    "sample": [...],
    "category": [...],   # gene name
    "value": [...],      # "Missense", "Truncating", "Amplification", ...
})

toy = comut.CoMut()
toy.add_categorical_data(data, name="Mutations", mapping={
    "Missense": "#2c7fb8",
    "Truncating": "#000000",
    "Amplification": "#e41a1c",
    "Deletion": "#377eb8",
})
toy.plot_comut(figsize=(10, 6))
toy.figure.savefig("oncoplot.pdf", bbox_inches="tight", dpi=300)
```

## Option B: hand-rolled matplotlib

When comut isn't available:

```python
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

# altered_type: genes × patients, values are alteration-type strings ("" = none)
genes = altered_type.index      # sorted by frequency
patients = altered_type.columns # sorted (memo sort)

color_map = {
    "Missense": "#2c7fb8", "Truncating": "#000000",
    "Amplification": "#e41a1c", "Deletion": "#377eb8", "": "#e0e0e0",
}

fig, ax = plt.subplots(figsize=(12, len(genes) * 0.4))
for i, gene in enumerate(genes):
    for j, pt in enumerate(patients):
        alt = altered_type.loc[gene, pt]
        ax.add_patch(plt.Rectangle((j, len(genes)-i-1), 1, 1,
                                    color=color_map.get(alt, "#e0e0e0")))
ax.set_xlim(0, len(patients)); ax.set_ylim(0, len(genes))
ax.set_yticks([len(genes)-i-0.5 for i in range(len(genes))])
ax.set_yticklabels(genes)
ax.set_xticks([])
# Legend
handles = [mpatches.Patch(color=c, label=l) for l, c in color_map.items() if l]
ax.legend(handles=handles, bbox_to_anchor=(1.01, 1), loc="upper left", frameon=False)
plt.tight_layout()
plt.savefig("oncoplot.pdf", dpi=300, bbox_inches="tight")
```

## Memo sort (patient ordering)

Patients are ordered so co-altered samples cluster — the classic "waterfall" cascade. The MemoSort algorithm sorts patients by the binary alteration pattern of the top genes:

```python
# Simplified memo sort: order patients by binary alteration string of top genes
top_genes = genes[:10]
sort_key = altered[top_genes].astype(int).apply(
    lambda row: "".join(row.astype(str)), axis=1
)
patient_order = sort_key.sort_values(ascending=False).index
```

## Alteration-type assignment

Combine mutation class + CNA into a single display value per (gene, patient):

```python
def alteration_type(gene, patient):
    # Priority: truncating > missense > amp > del (or per convention)
    if is_truncating(gene, patient): return "Truncating"
    if is_missense(gene, patient): return "Missense"
    if cna.loc[gene, patient] == 2: return "Amplification"
    if cna.loc[gene, patient] == -2: return "Deletion"
    return ""
```

Multi-hit (both mutation + CNA) can be shown with a split cell or a priority rule — document which.

## Verify with observe_figure

After saving, **`observe_figure` on the oncoplot** before it backs any claim. Check:
- Genes sorted by frequency (top = most altered)
- Patients clustered (waterfall cascade visible)
- Colors legible, legend present
- Frequency side-bar matches the recurrence numbers in your `report`

## Pitfalls

- **Per-mutation cells instead of per-patient** — collapse first (see `recurrence.md`)
- **No memo sort** — random patient order hides co-occurrence patterns
- **Amplification/mutation same color** — they're different alterations; distinct colors
- **Too many genes** — show top 20–30 recurrent; a 200-gene oncoplot is unreadable
- **Not verifying the figure** — omics-shared requires `observe_figure`

## Grounding

`report`: genes shown (with frequencies), alteration-type encoding, patient count, figure path. The frequencies in the plot must match the recurrence table.
