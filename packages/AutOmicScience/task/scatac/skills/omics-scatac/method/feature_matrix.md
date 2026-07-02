# Feature & Peak Matrix Generation

**Maturity: PARTIAL** — tiles via snapATAC2 in `run_python`; peaks via the `omics_runtime` peak_calling subcommand (READY).

## Goal / When to Use

Build cell × feature matrix for downstream embedding. Use after QC, before clustering.

## Decision Criteria

**Tile matrix** (fixed genomic bins, e.g. 500bp) - fast, unbiased default for **first clustering, QC, cross-sample comparison**. No peak set required.

**Peak matrix** (from called peaks) - preferred for **final analysis, motif enrichment, peak-gene linkage** as features are biologically meaningful regulatory elements.

Common flow: tiles → cluster → call peaks per cluster → peak matrix → refine

## Method Menu

- **Tile matrix**: `snap.pp.add_tile_matrix` → `snap.pp.select_features`
- **Peak calling**: `snap.tl.macs3` (per-group) → `snap.tl.merge_peaks`
- **Peak matrix**: `snap.pp.make_peak_matrix`

## How-to

```python
import snapatac2 as snap

# Tile matrix for the first pass (unbiased, no peak set needed)
snap.pp.add_tile_matrix(adata, bin_size=500)
snap.pp.select_features(adata, n_features=25000)

# After clustering, call peaks per cluster (grounded subcommand), then build the peak matrix
omics_runtime(subcommand="peak_calling", modality="scatac", args={
    "input": "qc.h5ad", "output": "peaks.bed", "fragment-file": "fragments.tsv.gz",
    "mode": "pseudobulk", "cluster-column": "leiden"})
# then snap.pp.make_peak_matrix(adata, ...) — see peak_calling.md
```

## Pitfalls & Quality Checks

- Bin size too large blurs signal; too small explodes memory
- Exclude chrM/chrY: `exclude_chroms=("chrM", "chrY")`
- Feature count after selection: ~10k-100k
- Small groups give noisy peaks - merge neighbors or raise `min_cells`

## Grounding

Record: matrix shape, bin size, n_selected_features, n_peaks, groupby → `EvidenceRecord`
