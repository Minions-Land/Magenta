---
name: bulk-rna
description: Bulk RNA-seq — count-based differential expression (DESeq2 / pyDESeq2 / edgeR / limma-voom with covariates + LFC shrinkage), normalization (TMM / VST / logCPM), pathway enrichment (pre-ranked GSEA + hypergeometric ORA vs MSigDB Hallmark), and co-expression networks (WGCNA). Use for bulk or pseudobulk gene-count matrices with sample metadata, not single-cell scanpy pipelines.
requiredTools: [run_python, bash, read, write]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, bulk-rna, rna-seq, differential-expression, deseq2, gsea, wgcna, enrichment]
extends: omics-shared
---

# Bulk RNA-seq Analysis

Builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply). **Reuse existing
`omics_compute` subcommands wherever they apply** — dataset load/summary (`load_dataset`, `summarize`),
gene-set **enrichment** (`enrichment --method ora|gsea`), and **pathway/TF activity** (`pathway_activity`,
decoupler) all run through the tool and are grounded automatically; provision the env with `omics_preflight`.
Those subcommands take an h5ad, so `load_dataset` your count matrix (samples × genes) into AnnData first.

The count-model steps that have **no** subcommand — normalization, DESeq2/edgeR/limma DE, WGCNA — are
**REFERENCE**: hand-write them in a `run_python` cell and emit a trailing JSON `report` for grounding (or via
`bash` — `python - <<'PY' … PY` / `Rscript -e '…'` — if the notebook tool isn't loaded), then cite the numbers.

Bulk RNA-seq is **counts-first tabular** analysis (a gene × sample count matrix + a sample metadata table),
not AnnData/scanpy. Use a count-based statistical model — this is the standard of the field (see the DESeq2
/ edgeR / limma-voom vignettes). The conventions below are ordinary bulk RNA-seq best practice.

## Prerequisites

1. A **raw integer count** matrix (genes × samples) — do not start DE from TPM/FPKM/normalized values.
2. A **sample metadata** table aligning each column to its condition + covariates (batch, sex, age, RIN, …).
3. Packages available in the active env: **Python** `pydeseq2`, `gseapy`, `decoupler`, `statsmodels`,
   `pandas`, `scipy`; **R** (via `Rscript`) `DESeq2`, `edgeR`, `limma`, `WGCNA`. Install any that are missing.

## Capability menu (all REFERENCE — hand-rolled, read the method doc first)

| Capability | Maturity | How | Method doc |
|---|---|---|---|
| Load any-format matrix → h5ad; dataset summary/context | **READY** | `omics_compute load_dataset` / `summarize` | `../omics-shared/assets/references/data_context.md` |
| Gene-set **enrichment** — ORA or pre-ranked GSEA vs a collection (e.g. Hallmark) | **READY** | `omics_compute enrichment --method ora\|gsea` (or hand-rolled gseapy for full control) | `assets/references/enrichment.md` |
| Pathway / TF activity per sample (decoupler; progeny / msigdb / collectri) | **READY** | `omics_compute pathway_activity` | `assets/references/enrichment.md` |
| Count normalization + low-expression filtering (VST / rlog / TMM+logCPM) | **REFERENCE** | `run_python` / `Rscript` | `assets/references/normalization.md` |
| Differential expression (DESeq2 / pyDESeq2 / edgeR / limma-voom) + covariate design + **LFC shrinkage** + FDR | **REFERENCE** | `run_python` / `Rscript` | `assets/references/de.md` |
| Pseudobulk DE (sum raw counts per sample/donor → count-based DE) | **REFERENCE** | `run_python` | `assets/references/de.md` |
| Co-expression networks (**WGCNA**: soft-power, signed TOM, module eigengenes, module–trait) | **REFERENCE** | `Rscript` (WGCNA) | `assets/references/coexpression.md` |

**READY** = call the grounded `omics_compute` subcommand — a deterministic, standardized step where a tested
function beats re-writing boilerplate. **REFERENCE** = the DE-model design, contrasts, normalization choice,
and network parameters are **study-specific judgment calls**, so read the method doc and **write code adapted
to this dataset** — these are deliberately *not* canned functions. Always read the method doc first (it
carries the judgment: ranking metric, collection, thresholds, interpretation) even when a subcommand exists.

## Standard workflow

1. **Load & align** — read the count matrix + metadata; confirm samples align (same order/ids); drop
   feature-summary rows (e.g. HTSeq `__no_feature`); confirm counts are **raw integers**. Summarize dims +
   group sizes and thread them forward (`../omics-shared/assets/references/data_context.md`).
2. **Filter & normalize** — low-expression filter (`filterByExpr`-style) → the *right* normalization for
   the goal: **VST/rlog** for clustering/PCA/heatmaps; **size-factors / TMM+logCPM** as the model input for
   DE. Do not z-score raw counts, and do not feed log-CPM to a t-test as the primary DE. (`assets/references/normalization.md`)
3. **Differential expression** — a count-based model (DESeq2/pyDESeq2/edgeR/limma-voom) with a **design
   matrix that includes the relevant covariates**; apply **LFC shrinkage** (apeglm/ashr); BH-FDR; when the
   question is "which genes change most", rank by **shrunken |log2FC| (effect size)** with an FDR gate.
   For single-cell-derived data, **pseudobulk** = sum raw counts per donor first. (`assets/references/de.md`)
4. **Enrichment** — **pre-ranked GSEA** (rank by log2FC or shrunken LFC) against **MSigDB Hallmark (H)**,
   report NES + adjusted-p; or **ORA** (Fisher/hypergeometric) with an explicitly-stated background universe
   + BH-FDR. (`assets/references/enrichment.md`)
5. **Networks (if asked)** — WGCNA on VST/TMM-logCPM data: justified soft-power, signed adjacency, TOM,
   module eigengenes, module–trait association. (`assets/references/coexpression.md`)
6. **Ground** — cite exact numbers (log2FC, padj, NES, module sizes) from the emitted report; `observe_figure`
   any volcano/MA/heatmap before it backs a claim.

## Bulk-RNA best practice (on top of omics-shared)

- **Use a count-based DE model.** DESeq2/edgeR/limma-voom (negative-binomial / voom variance modeling) are
  the field standard. A Welch t-test or OLS on log-CPM is statistically weaker (it ignores the count
  mean–variance relationship); use a count model when one can run, and note it if you cannot.
- **Shrink the fold changes** (apeglm/ashr) before ranking or GSEA; unshrunk LFC over-weights low-count genes.
- **Rank by effect size when asked "which change most"** — sort by shrunken |log2FC| (with an FDR gate),
  not by adjusted p; effect size and significance are separate axes, so report both.
- **Model the covariates in the design** — batch/sex/age/RIN/library-prep/site/genotype-PCs when present;
  an unmodeled confound is the most common silent error.
- **Pseudobulk before DE** for single-cell data: sum **raw** counts per (donor × group), then run a
  count-based model on the pseudobulk matrix — not a per-cell test.
- **State your conventions** — normalization, shrinkage estimator, ranking metric, FDR method, background
  universe. A result is only interpretable and reproducible alongside its method.
- **GSEA ranks by log2FoldChange** (or shrunken LFC), and use the **Hallmark (H)** collection when Hallmark
  pathways are requested.
- **ORA background = the tested universe** (whole genome, or all expressed/background genes) — state which;
  the wrong universe shifts every p-value.

## When things go wrong

- **All genes significant / p-values look uniform** → normalized values were fed to a count model, or the
  design is missing covariates; re-check the input is raw counts + the model formula.
- **Volcano one-sided / FC orientation wrong** → verify the contrast direction (which level is numerator):
  DESeq2 `contrast=(factor, test, ref)` → positive = up in `test`.
- **Infinite / NA log2FC** → a group has zero counts; report it explicitly (name the gene) rather than
  dropping it silently.
- **GSEA returns nothing / all NES ≈ 0** → ranking metric or gene-id namespace mismatch (symbol vs Ensembl);
  align ids to the gene-set namespace first.
- **WGCNA collapses to one giant module** → soft-power too low or unsigned network; re-pick power via
  `pickSoftThreshold` scale-free fit, use a signed TOM.

## Provenance

Every recipe here is standard bulk RNA-seq methodology traceable to external field authorities (DESeq2 /
edgeR / limma vignettes, the GSEA/MSigDB and WGCNA papers) — see the `## Sources` block in each method doc.

