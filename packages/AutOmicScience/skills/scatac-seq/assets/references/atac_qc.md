# ATAC-Specific QC

**Maturity: READY** — `omics_compute(subcommand="atac_qc", modality="scatac", ...)` computes the metrics + filter and records evidence; the snapATAC2 calls below are what it runs.

## Goal / When to Use

Apply scATAC-specific quality control metrics before feature matrix generation. Use immediately after loading fragment data, before any analysis.

## Decision Criteria

QC thresholds are **dataset-dependent** and set from observed distributions:

- **TSS Enrichment (TSSE)** ≥ 5 (stringent: ≥ 8, permissive: ≥ 2) - measures signal at transcription start sites
- **Unique Fragments** ≥ 1,000 (≥ 500 floor for nuclei)
- **Fragment Size Distribution** - nucleosome banding pattern indicates quality
- **Mitochondrial Fraction** ≤ 0.10
- **Doublet Probability** ≤ 0.5

Frozen/snATAC often shows lower TSSE - adjust thresholds based on technology and tissue.

## Method Menu

- **TSS Enrichment**: `snap.metrics.tsse(adata, genome)`
- **Fragment Size**: `snap.metrics.frag_size_distr(adata)` + PEAKQC periodicity score
- **FRiP**: `snap.metrics.frip(adata, regions)` (requires peak/region set)
- **Doublets**: `snap.pp.scrublet` + `snap.pp.filter_doublets`

Grounded path: `omics_compute(subcommand="atac_qc", modality="scatac", ...)` runs these metrics + filter with evidence capture.

## How-to

```python
# Grounded path — the omics_compute atac_qc subcommand (records evidence):
omics_compute(subcommand="atac_qc", modality="scatac", args={
    "input": "atac.h5ad", "output": "qc.h5ad", "fragment-file": "fragments.tsv.gz",
    "compute-tsse": "true", "compute-frip": "true",
    "min-tsse": "5.0", "min-fragments": "1000", "filter": "true",
})

# Or compute directly with snapATAC2 in run_python:
import snapatac2 as snap
snap.metrics.tsse(adata, snap.genome.hg38)              # -> obs["tsse"]
snap.metrics.frag_size_distr(adata)
snap.pp.scrublet(adata); snap.pp.filter_doublets(adata)
adata = adata[(adata.obs["tsse"] >= 5.0) & (adata.obs["n_fragment"] >= 1000)].copy()
```

## Pitfalls & Quality Checks

- **No nucleosome banding** → tagmentation failure (stop, don't proceed)
- **Observe fragment-size plot**: Clear ~147bp peak (mononucleosome) + ~300bp (dinucleosome)
- **TSSE distribution with no high-quality mode** → red flag
- Over-filtering removes rare types; under-filtering injects debris

## Grounding

Record: pre/post cell counts, thresholds used, median TSSE/fragments, doublet rate → `EvidenceRecord`

## Honesty

If QC reveals broken library (no banding, uniformly low TSSE), **state data is unusable** - don't push through to pretty UMAP.
