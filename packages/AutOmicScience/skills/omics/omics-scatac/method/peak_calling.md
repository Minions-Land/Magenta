# Peak Calling & Differential Accessibility

**Maturity: READY** — peak calling via `omics_runtime(subcommand="peak_calling", modality="scatac", ...)`; differential accessibility is hand-rolled snapATAC2 (REFERENCE).

## Goal / When to Use

Derive cell-type-specific peaks and find differentially accessible regions. Use after clustering, when you need cell-type-specific regulatory elements.

## Decision Criteria

**The judgment this guides:**

- **Call peaks per cluster/cell-type** (`groupby='leiden'`), not on all cells pooled — this recovers rare-population regulatory elements that bulk calling misses.

- **Provide `replicate`/`blacklist` when available** — pseudo-replicates (technical replicates of the same biological sample) improve peak reproducibility; blacklists (ENCODE blacklist regions) remove artifact-prone regions.

- **Merge overlapping peaks** into a non-redundant set (`snap.tl.merge_peaks`) before building the peak matrix — otherwise you have many partially-overlapping peaks representing the same regulatory element.

- **For differential accessibility (DA):**
  - **`snap.tl.marker_regions`** (fast, z-score, ignores per-cell variance) for a quick view of cluster-specific peaks
  - **`snap.tl.diff_test`** (regression-based, uses single-cell info; `min_log_fc`, `min_pct`) when you need rigor and per-cell variability matters

## Method Menu

- **`snap.tl.macs3`** (SnapATAC2's MACS3 wrapper) — per-group MACS3 calling
- **MACS3 CLI/API directly** on per-group fragment BEDs (`macs3 callpeak`, FRAG format) — when you need non-default parameters
- **`snap.tl.merge_peaks`** — merge overlapping peaks from per-group calls
- **`snap.tl.marker_regions`** (fast DA) vs **`snap.tl.diff_test`** (rigorous DA)

## How-to

### Per-group peak calling + merge + matrix

Grounded path — the `omics_runtime` peak_calling subcommand (records evidence):
```python
omics_runtime(subcommand="peak_calling", modality="scatac", args={
    "input": "qc.h5ad", "output": "peaks.bed", "fragment-file": "fragments.tsv.gz",
    "mode": "pseudobulk", "cluster-column": "leiden", "qvalue": "0.05",
})
```
Or directly with snapATAC2 in `run_python`: `snap.tl.macs3(adata, groupby="leiden")` → `snap.tl.merge_peaks(...)` → `snap.pp.make_peak_matrix(...)` (confirm exact kwargs against the installed snapATAC2 version).

### Differential accessibility (fast)

```python
# Marker regions per cluster (z-score)
snap.tl.marker_regions(
    adata_peaks,
    groupby='leiden',
    pvalue=0.01
)
# Results in adata_peaks.uns['marker_regions']
```

### Differential accessibility (rigorous)

```python
# Regression-based DA (accounts for per-cell variance)
snap.tl.diff_test(
    adata_peaks,
    groupby='leiden',
    group1='0',
    group2='rest',  # or a specific cluster
    min_log_fc=0.5,
    min_pct=0.1
)
# Results in adata_peaks.uns['diff_test']
```

## Pitfalls & Quality Checks

- **Too-small groups give noisy peaks** — if a cluster has <50-100 cells, consider merging it with neighbors or raising `min_cells` before calling. A handful of cells cannot define a robust peak set.

- **FDR threshold and `min_pct` control DA call counts** — record them. A loose threshold (e.g., p<0.1) inflates DA hits; a strict one (p<0.01) may miss real but modest changes.

- **`observe_figure`** — a DA heatmap (top DA regions × clusters) or a genome-browser track for a few top DA peaks. Do the DA peaks make biological sense (e.g., B-cell-specific peaks near B-cell TFs)?

- **Red flags:**
  - A cluster with zero peaks after calling (too few cells, or all reads in blacklist regions)
  - Peaks dominated by one huge region (artifact, maybe a repetitive element)
  - DA results with thousands of hits at a loose threshold (likely noise; tighten the threshold)

## Grounding

**What to record as `EvidenceRecord`:**

```python
{
  "method": "macs3_per_cluster",
  "groupby": "leiden",
  "n_groups": 12,
  "qvalue": 0.05,
  "replicate": None,
  "blacklist": "/path/to/blacklist.bed",
  "n_peaks_per_group": {
    "0": 15000,
    "1": 12000,
    ...
  },
  "n_merged_peaks": 45000,
  "merge_half_width": 250,
  "da_method": "diff_test",
  "da_n_regions": {
    "0_vs_rest": 350,
    "1_vs_rest": 280,
    ...
  },
  "da_thresholds": {"min_log_fc": 0.5, "min_pct": 0.1}
}
```

Ground: n peaks per group, n merged peaks, thresholds, n DA regions per comparison.

## Honesty

- If a cluster yields **no peaks**, report that (candidate for merging, or the cluster is low-quality) — do not force a result by loosening the q-value to extreme levels.

- **DA is relative** — "cluster 0 has more accessible peaks than the rest" does not mean "cluster 0 is more open overall" (it could be that cluster 0 has specific peaks while others have different specific peaks). Be precise about what the contrast is.

- **Peak calling on sparse data is noisy** — small clusters, low-depth samples, or regions with few reads will have unreliable peaks. Flag low-confidence peaks rather than treating all peaks equally.
