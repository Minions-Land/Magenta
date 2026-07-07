# Load & Assemble Multiome

**Maturity: READY** — `omics_compute(subcommand="load_multiome", modality="multiome", ...)` assembles a paired MuData with joint QC + barcode intersection, and records evidence automatically.

## Goal / When to Use

Build a clean, analysis-ready paired MuData (shared barcodes, per-modality QC, joint filter). First step, always.

## Decision Criteria

- **Source type:**
  - Two separate AnnData (RNA `.h5ad`, ATAC `.h5ad`) → the `load_multiome` subcommand assembles + intersects + filters.
  - One 10x combined `filtered_feature_bc_matrix.h5` → `muon.read_10x_h5(path)` auto-splits by feature_types into a MuData.
  - Existing `.h5mu` → `mudata.read_h5mu(path)`; validate only.
- **Pairing check:** if barcodes barely overlap, it is **not** paired multiome — handle the modalities separately, don't force a join.
- **ATAC features:** record whether peaks or tiles (affects downstream handling).

## How-to (default — the subcommand)

```python
omics_compute(subcommand="load_multiome", modality="multiome", args={
    "rna":    "rna.h5ad",
    "atac":   "atac.h5ad",
    "output": "multiome.h5mu",
})
```
It computes per-modality QC (RNA mt% / n_genes, ATAC n_peaks), **assembles the MuData first**, intersects to shared barcodes (`mu.pp.intersect_obs`), then applies a joint filter (`mu.pp.filter_obs`). The report carries `n_cells_{rna,atac,joint,filtered}`, `n_genes`, `n_peaks`.

For the 10x-combined or existing-h5mu cases, read in `run_python`:
```python
import muon as mu
mdata = mu.read_10x_h5("filtered_feature_bc_matrix.h5")   # combined RNA + Peaks
mu.pp.intersect_obs(mdata)
# preserve raw counts before any normalization:
mdata["rna"].layers["counts"]  = mdata["rna"].X.copy()
mdata["atac"].layers["counts"] = mdata["atac"].X.copy()
```

## Failure Modes

- **Barcode suffix mismatch (`-1`)** — *symptom:* empty intersection. *Diagnosis:* suffixes differ between modalities. *Fix:* harmonize/strip suffixes before assembly.
- **Treating unpaired as paired** — *symptom:* tiny `n_cells_joint`. *Diagnosis:* the two files aren't the same cells. *Fix:* if pairing is uncertain, say so and analyze separately.
- **Non-unique var_names** — *symptom:* errors downstream. *Fix:* `var_names_make_unique()` per modality.

## observe_figure checkpoints

- Per-modality QC distributions (RNA n_genes / mt%, ATAC n_peaks) before/after the joint filter — is the retained fraction reasonable, or did the join drop most cells (a pairing problem)?

## Grounding

Record: n_obs per modality before/after intersection, retained fraction, n_vars (genes/peaks), ATAC feature type → `EvidenceRecord` (auto-captured by the subcommand).

## Honesty

If the intersection retains too few cells, **stop and report** — don't proceed on a degenerate object. Preserve raw counts in `layers["counts"]` (MultiVI / velocity need them).
