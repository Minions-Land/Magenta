---
name: spatial
description: Spatial transcriptomics (Visium / Xenium / MERFISH / …) — loading, spatial QC, spatial statistics + SVGs (squidpy), spatial domains (SpaGCN), deconvolution & mapping (cell2location / Tangram), spatial cell-cell communication (squidpy / COMMOT), gene imputation (Tangram), 2D/3D visualization.
requiredTools: [run_python, create_notebook, add_cell, observe_figure, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, spatial, spatial-transcriptomics, squidpy, spatialdata, visium, xenium, merfish]
extends: omics-shared
---

# Spatial Transcriptomics Analysis

Builds on `omics-shared` (loaded automatically — its rules apply here). Load spatial data through the **`omics_compute`** tool (`read_spatial`, records evidence); the analysis itself is **squidpy** in `run_python` for the statistics / CCC, with heavier methods (cell2location, SpaGCN, COMMOT) run in isolated envs. Read the method doc before running a capability.

## Prerequisites

1. `omics_preflight(modality="spatial")` passes (validates `task2`: squidpy + spatialdata).
2. An AnnData with `obsm["spatial"]` coordinates, or a SpatialData object.
3. A `summarize` report + free-text study description threaded into every biological decision.

## Capability menu (with maturity)

| Capability | Maturity | How | Method doc |
|------------|----------|-----|------------|
| Load spatial data (Visium / Xenium / MERFISH / …) | **READY** | `omics_compute read_spatial` | `method/read_spatial.md` |
| Spatial QC (on-tissue, segmentation, control probes) | **REFERENCE** | scanpy + squidpy | `method/spatial_qc.md` |
| Spatial statistics + SVGs (Moran's I / Ripley / nhood / co-occ) | **REFERENCE** | squidpy | `method/spatial_stats.md` |
| Spatial domains | **PARTIAL** | SpaGCN (Leiden baseline runs) | `method/domains.md` |
| Mapping & deconvolution | **PARTIAL** | cell2location / Tangram | `method/mapping_deconv.md` |
| Spatial cell-cell communication | **REFERENCE** | squidpy `gr.ligrec` (COMMOT) | `method/spatial_ccc.md` |
| Gene imputation (targeted panels) | **PARTIAL** | Tangram | `method/imputation.md` |
| 2D / 3D visualization | **REFERENCE** | squidpy / spatialdata-plot | `method/viz_2d_3d.md` |

Read the method doc before running a capability — each gives the opinionated default, exact parameters, failure modes, and grounding. **squidpy** is the installed workhorse (stats, CCC-ligrec, plotting); **cell2location / SpaGCN / COMMOT / Tangram / SpatialDE** are not in `task2` — install / isolated env per the doc.

## Standard workflow

1. **Preflight & load** — `omics_preflight(modality="spatial")`; `omics_compute(subcommand="read_spatial", modality="spatial", args={"input":"<path>","platform":"visium"})`. Thread the summary + study description forward.
2. **Spatial QC** — scanpy QC + squidpy spatial views; filter off-tissue / low-segmentation cells (`method/spatial_qc.md`).
3. **Cluster / annotate** — reuse the scRNA recipes (`rna`: preprocess → markers → annotation) on the expression, then validate **in space**.
4. **Spatial structure** — SVGs + neighborhood enrichment + co-occurrence via squidpy (`method/spatial_stats.md`); spatial domains (`method/domains.md`).
5. **Composition** — spot deconvolution / reference mapping (`method/mapping_deconv.md`); gene imputation for targeted panels (`method/imputation.md`).
6. **Interactions** — spatial cell-cell communication (`method/spatial_ccc.md`).
7. **Visualize & ground** — every figure via `sq.pl.spatial_scatter` / spatialdata-plot, `observe_figure` before it backs a claim (`method/viz_2d_3d.md`); cite the reports as evidence.

## Spatial-specific rules (on top of omics-shared)

- **Always look in space, not just histograms** — QC, SVGs, domains, and CCC are validated by plotting on `obsm["spatial"]` and `observe_figure`; a histogram hides regional artifacts.
- **Match the method to the resolution** — spot data (Visium) → deconvolution (proportions per spot); single-cell (Xenium/MERFISH) → direct stats / CCC. Don't deconvolve single-cell data or annotate 2 µm bins as cells.
- **Filter control / blank probes** (imaging) before QC — `NegControl*` / `BLANK*` are not genes.
- **Proximity ≠ interaction; autocorrelation ≠ importance** — spatial stats and CCC are hypotheses; ground them and validate against markers / histology.
- **Heavy methods run in isolated envs** — cell2location (GPU), COMMOT (old pins) don't share `task2`; say when a method was not run rather than substituting a weaker one.

## When things go wrong

- **Empty / garbled spatial plot** — wrong platform, missing / wrong-unit coords, or load failure; re-check `read_spatial` + `obsm["spatial"]`.
- **No SVGs / no neighborhood structure** — wrong spatial graph (`coord_type`) or noisy labels; fix the graph / validate annotation (`method/spatial_stats.md`).
- **Speckled, non-contiguous domains** — expression clustering without a spatial term; use SpaGCN or smooth over the spatial graph (`method/domains.md`).
- **Deconvolution flat / one type everywhere** — reference missing cell types or gene-name mismatch (`method/mapping_deconv.md`).
