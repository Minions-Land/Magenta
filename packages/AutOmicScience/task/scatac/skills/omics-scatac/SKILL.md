---
name: omics-scatac
description: Single-cell ATAC-seq — fragment import, ATAC QC (TSS / fragment-size / FRiP / doublets), feature matrix (tiles / MACS3 peaks), spectral (LSI) clustering, motif activity (chromVAR), gene activity, peak–gene linkage, scRNA label transfer.
requiredTools: [run_python, create_notebook, add_cell, observe_figure, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, scatac, single-cell, chromatin, accessibility, snapatac2, chromvar, muon]
extends: omics-shared
---

# scATAC-seq Analysis

Builds on `omics-shared` (loaded automatically — its rules apply here). Run compute through the **`omics_compute`** tool with `modality="scatac"`; it dispatches into the pinned `task4` env and records evidence automatically. Steps without a subcommand are hand-rolled in `run_python` with **snapATAC2** (and **pychromVAR** for motifs) — read the method doc first.

## Prerequisites

1. `omics_preflight(modality="scatac")` passes (validates `task4`: snapATAC2 + MACS3).
2. A fragments file (`fragments.tsv.gz` + `.tbi`) for QC / peak calling, or a pre-built cell×peak/tile AnnData.
3. A `summarize` report + free-text study description threaded into every biological decision.

## Capability menu (with maturity)

| Capability | Maturity | How | Method doc |
|------------|----------|-----|------------|
| Import fragments → cell×feature matrix | **REFERENCE** | snapATAC2 `pp.import_fragments` | `method/import_fragments.md` |
| ATAC QC (TSS, fragment size, FRiP, doublets) | **READY** | `omics_compute atac_qc` | `method/atac_qc.md` |
| Feature matrix (tiles / peaks) | **PARTIAL** | snapATAC2 tiles; peaks via `peak_calling` | `method/feature_matrix.md` |
| Peak calling (MACS3, per-cluster) | **READY** | `omics_compute peak_calling` | `method/peak_calling.md` |
| Spectral (LSI) embedding + Leiden | **REFERENCE** | snapATAC2 `tl.spectral` / `tl.leiden` | `method/dimred_cluster.md` |
| Motif activity (chromVAR) | **REFERENCE** | pychromVAR | `method/motif_enrichment.md` |
| Gene activity scores | **READY** | `omics_compute gene_activity` | `method/gene_activity.md` |
| Peak–gene linkage (co-accessibility) | **REFERENCE** | distance + correlation (muon) | `method/peak_gene_linkage.md` |
| Label transfer / integration from scRNA | **REFERENCE** | gene-activity bridge + scRNA recipes | `method/rna_integration.md` |

Read the method doc before running a capability — each gives the opinionated default, exact parameters, failure modes, and grounding.

> **GRN inference is not a pure-scATAC step.** It needs expression: for TF regulons use **scRNA** (`omics-scrna`, pySCENIC); for enhancer-driven GRN use **multiome** (`omics-multiome`, SCENIC+). Do not infer a GRN from accessibility alone.

## Standard workflow

Run each step through `omics_compute` where a subcommand exists; otherwise hand-roll per the method doc. Read the per-step doc for parameters and decisions.

1. **Preflight & import** — `omics_preflight(modality="scatac")`; import the fragments file into a snapATAC2 AnnData (`method/import_fragments.md`); `omics_compute(subcommand="summarize", modality="scatac", args={"input":"atac.h5ad"})`. Thread the summary + study description forward.
2. **ATAC QC** — `omics_compute(subcommand="atac_qc", modality="scatac", args={"input":"atac.h5ad","output":"qc.h5ad","fragment-file":"fragments.tsv.gz","compute-tsse":"true","compute-frip":"true","filter":"true"})`. See `method/atac_qc.md` for TSSE / nucleosome / FRiP thresholds and the MAD-vs-fixed decision.
3. **Feature matrix** — tile matrix for a first pass, or call peaks per cluster: `omics_compute(subcommand="peak_calling", modality="scatac", args={"input":"qc.h5ad","output":"peaks.bed","fragment-file":"fragments.tsv.gz","mode":"pseudobulk","cluster-column":"leiden"})` (`method/feature_matrix.md`, `method/peak_calling.md`).
4. **Embed & cluster** — snapATAC2 spectral (LSI) embedding, then Leiden on `obsm["X_spectral"]`; drop the depth-correlated first component (`method/dimred_cluster.md`). Plot UMAP and `observe_figure`.
5. **Gene activity** — `omics_compute(subcommand="gene_activity", modality="scatac", args={"input":"qc.h5ad","output":"gene_activity.h5ad"})` for an expression proxy used in annotation / integration (`method/gene_activity.md`).
6. **Motif activity (chromVAR)** — per-cell TF motif deviations via pychromVAR (`method/motif_enrichment.md`).
7. **Linkage / integration (as needed)** — peak–gene links (`method/peak_gene_linkage.md`); label transfer from an scRNA reference via the gene-activity bridge (`method/rna_integration.md`).
8. **Visualize & ground** — plot UMAP colored by clusters / QC / gene-activity markers; `observe_figure` each before it backs a claim; cite the `omics_compute` reports as evidence.

## scATAC-specific rules (on top of omics-shared)

- **TSS enrichment is the primary QC axis** — always compute + report TSSE when a fragments file is present, and gate filtering on it (`method/atac_qc.md`).
- **Spectral (LSI), not PCA** — ATAC is sparse / near-binary; use snapATAC2 spectral embedding and drop the depth-correlated first component (`method/dimred_cluster.md`).
- **Accessibility ≠ expression** — gene activity is a proxy; validate it against markers and say so; never report it as measured expression.
- **Distance ≠ regulation** — a peak near a gene is a hypothesis, not a regulatory link; ground linkage claims and abstain when correlation is weak (`method/peak_gene_linkage.md`).
- **Abstain over guess** — an ambiguous cluster is "unknown", not an invented label.

## When things go wrong

- **TSSE low across all cells** — library quality or wrong genome annotation; check the fragments file + genome build before filtering (`method/atac_qc.md`).
- **Clusters track total counts / TSSE** — technical variation dominates; revisit feature selection or drop the first spectral component (`method/dimred_cluster.md`).
- **Too few peaks after calling** — pseudobulk per cluster has too few cells, or the q-value is too strict; aggregate more cells or relax (`method/peak_calling.md`).
- **Gene activity is noisy** — expected for a proxy; smooth over neighbors or restrict to confident peak–gene links; do not over-interpret single genes.
