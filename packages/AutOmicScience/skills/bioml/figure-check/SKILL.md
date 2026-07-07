---
name: bioml-figure-check
disable-model-invocation: true
---

# BioML Figure Check — Publication-Grade Plotting & Audit

> Subskill of `bioml`. Enter here from the parent skill when you produce or audit figures for a publication, poster, or benchmark submission. Read `../SKILL.md` (parent) and `../../omics-shared/SKILL.md` first — their evidence/grounding rules apply here.

Two responsibilities: **apply matplotlib publication discipline** (rcParams, Type-42 font compliance), and **audit layout honesty** (no empty quadrants, readable labels, proper legend placement).

---

## When to Use

- Before every new figure goes into a shared workspace or submission
- When a figure is rejected for "poor quality" or "formatting issues"
- When auditing a figure's layout / readability before publication
- When choosing the right chart type for a data shape

---

## The Non-Skippable Preamble

**Every `gen_figure.py` starts with this block:**

```python
import matplotlib
matplotlib.use('Agg')  # non-interactive backend
import matplotlib.pyplot as plt

# Publication rcParams — ALWAYS include this
plt.rcParams.update({
    'pdf.fonttype': 42,        # Type-42 (TrueType) not Type-3 (bitmap)
    'ps.fonttype': 42,
    'font.size': 7,            # Nature/Cell standard body text
    'axes.labelsize': 7,
    'axes.titlesize': 8,
    'xtick.labelsize': 6,
    'ytick.labelsize': 6,
    'legend.fontsize': 6,
    'figure.titlesize': 8,
    'font.family': 'sans-serif',
    'font.sans-serif': ['Arial', 'Helvetica', 'DejaVu Sans'],
    'axes.linewidth': 0.5,
    'xtick.major.width': 0.5,
    'ytick.major.width': 0.5,
    'xtick.direction': 'out',  # ticks point outward
    'ytick.direction': 'out',
    'axes.spines.top': False,   # remove top/right spines (cleaner)
    'axes.spines.right': False,
})
```

**Why `pdf.fonttype=42` is non-negotiable:** The matplotlib PDF backend silently embeds Type-3 bitmap fonts unless told otherwise. A Type-3 PDF looks fine on-screen but scores 0 on `vector_fidelity` and prints poorly. **This setting cannot be skipped**, even for "simple" plots.

---

## Chart Type Selection

Pick the chart type that matches your data shape. Common archetypes:

| Data shape | Chart type | When to use |
|------------|------------|-------------|
| 2D continuous (x, y) | **Scatter** | Gene expression, embeddings, correlations |
| 2D + density | **Hexbin** or **2D histogram** | >10k points, avoid overplotting |
| Time series (1 variable) | **Line plot** | Training loss, temporal gene expression |
| Time series (multiple) | **Multi-line** with legend | Compare conditions/models |
| Categorical × continuous | **Box plot** or **violin plot** | Cell-type marker expression, batch effects |
| Part-of-whole | **Stacked bar** | Cell-type composition across samples |
| Heatmap (matrix) | **imshow / pcolormesh** | Gene × sample expression, confusion matrix |
| Network | **networkx layout + edges** | Cell-cell communication, regulatory network |

**Avoid:**
- **3D plots** — hard to read, print poorly
- **Pie charts** — use stacked bar instead
- **Dual y-axis** — confusing, use facets

---

## The Standard Workflow

### 1. Generate the plot

```python
fig, ax = plt.subplots(figsize=(3.5, 2.5), dpi=300)  # Nature single-column width ≈ 3.5"

# Your plot:
ax.scatter(x, y, s=2, alpha=0.6, c=colors, cmap='viridis')
ax.set_xlabel("UMAP 1")
ax.set_ylabel("UMAP 2")
ax.set_title("scRNA-seq UMAP", loc='left')  # left-aligned title (journal style)

# Legend (if needed):
handles, labels = ax.get_legend_handles_labels()
ax.legend(handles, labels, loc='upper right', frameon=False)

plt.tight_layout()
plt.savefig("output/umap.pdf", dpi=300, bbox_inches='tight')
plt.close()
```

### 2. Post-save Type-42 verification

**After every `plt.savefig`**, verify the PDF embeds TrueType fonts:

```bash
pdffonts output/umap.pdf | grep -v "Type 42\|Type 1C" && echo "FAIL: bitmap fonts detected" || echo "OK: vector fonts"
```

If it fails, the `pdf.fonttype=42` rcParam was not set. Fix it and regenerate.

### 3. Visual audit (pixel-level layout check)

Render the PDF to PNG at print resolution and visually inspect:

```bash
# Render at 300 DPI (print quality)
gs -sDEVICE=pngalpha -r300 -o output/umap_300dpi.png output/umap.pdf

# Or use ImageMagick:
convert -density 300 output/umap.pdf output/umap_300dpi.png
```

Open `umap_300dpi.png` and audit for:

| Issue | Check |
|-------|-------|
| **Empty quadrants** | No large blank regions (>20% of canvas). If present, crop or rebalance. |
| **Overlapping labels** | Axis labels don't collide with tick labels or title. |
| **Legend obscures data** | Legend placed in a blank region, not covering points. |
| **Readable labels** | All text ≥6 pt at print size. Zoom to 100% — can you read it? |
| **Axis spans data** | No clipping, no excessive whitespace. |
| **Colorbar labeled** | If using a colormap, include a labeled colorbar. |

If any issue is present, adjust and regenerate.

### 4. Evidence

`observe_figure` on the generated figure before it backs a claim in a result. The figure + its generation script are the audit trail.

---

## ML-Specific Plotting Idioms

### Training curves

```python
ax.plot(epochs, train_loss, label='Train', linewidth=1)
ax.plot(epochs, val_loss, label='Val', linewidth=1, linestyle='--')
ax.set_xlabel("Epoch")
ax.set_ylabel("Loss")
ax.set_yscale('log')  # often clearer for loss
ax.legend(frameon=False)
```

### Confusion matrix

```python
import seaborn as sns
sns.heatmap(cm, annot=True, fmt='d', cmap='Blues', ax=ax, cbar_kws={'label': 'Count'})
ax.set_xlabel("Predicted")
ax.set_ylabel("True")
```

### UMAP / t-SNE (embedding)

```python
for i, label in enumerate(unique_labels):
    mask = (labels == label)
    ax.scatter(embedding[mask, 0], embedding[mask, 1], s=1, alpha=0.6, label=label)
ax.set_xlabel("UMAP 1")
ax.set_ylabel("UMAP 2")
ax.legend(loc='upper right', frameon=False, markerscale=2)
```

### Benchmark comparison (bar chart)

```python
methods = ["Baseline", "scVI", "scANVI", "Our method"]
scores = [0.72, 0.81, 0.85, 0.87]
ax.bar(methods, scores, color='steelblue', edgecolor='black', linewidth=0.5)
ax.set_ylabel("ARI")
ax.set_ylim(0.6, 1.0)  # zoom to relevant range
ax.axhline(0.7, color='red', linestyle='--', linewidth=0.5, label='Pass threshold')
ax.legend(frameon=False)
```

---

## Caption Discipline

A good caption answers: *What is this plot? What do the axes mean? What is the main message?*

```markdown
**Figure 1. scRNA-seq integration with scVI.**
UMAP of 50,000 cells from 3 batches after scVI integration.
Color: cell type (annotated with scANVI).
The model successfully merges batches while preserving cell-type structure (ARI = 0.85).
```

---

## Pitfalls

- **Skipping `pdf.fonttype=42`** — the PDF looks fine but embeds bitmap fonts
- **Not verifying with `pdffonts`** — you assume it's vector but it's not
- **Ignoring empty quadrants** — wasted canvas space
- **Legend covering data** — place it in a blank region or use `loc='best'` as a starting point
- **Colormap without a colorbar** — readers can't interpret the colors
- **3D plots** — hard to read, avoid
- **Saving as PNG for publication** — use PDF or SVG for vector graphics

---

## When Things Go Wrong

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| **`pdffonts` shows Type 3** | `pdf.fonttype` not set | Add the rcParams block at the top |
| **Labels overlap** | `tight_layout()` not called, or axes too small | Call `plt.tight_layout()` before save; or enlarge figsize |
| **Legend obscures data** | Auto-placement failed | Manually set `loc='upper right'` or place outside with `bbox_to_anchor=(1.05, 1)` |
| **Empty bottom-left quadrant** | Data doesn't span axes | Set `ax.set_xlim` / `ax.set_ylim` to crop whitespace |
| **Text too small** | Default font size (10–12 pt) not adjusted | Use the rcParams block above (7 pt body, 6 pt ticks) |

---

## Evidence & Reporting

Every figure emits:
- The figure file (`.pdf` preferred)
- The generation script (`gen_figure.py`)
- The data source (which `.h5ad` / `.npy` / `.csv` was plotted)
- `pdffonts` output (confirms Type-42)
- The 300 DPI PNG render (for visual audit)

`observe_figure` on the figure before it backs a claim. The script + data source are the reproducibility trail.
