---
name: omics-shared
description: Cross-modality scverse foundations — data containers, dataset summary, standard preprocessing, evidence grounding, figure inspection. Load first for any omics task.
requiredTools: [run_python, create_notebook, add_cell, observe_figure, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, scverse, shared, anndata, mudata, spatialdata]
---

# Omics Shared — Cross-Modality Foundations

The shared substrate every omics modality (scRNA-seq, spatial, scATAC-seq, multiome) builds on. This skill is loaded automatically for omics analysis; read the modality playbook next.

## How to run compute (read this first)

All standardized analysis runs through one grounded tool, **`omics_compute`**, which executes a compute subcommand in the modality's pinned Pixi environment and **records an evidence record automatically**. Prefer it over hand-written `subprocess` calls — that is the only path that captures provenance.

```
omics_compute(
  subcommand="preprocess",
  modality="scrna",          # selects the pinned env (scrna→task1, spatial→task2, scatac→task4, multiome→task3)
  args={"input": "raw.h5ad", "output": "processed.h5ad"}
)
```

- `args` keys are the subcommand's `--kebab-case` flags (with or without `--`). A value of `""`/`"true"` is a bare store-true flag; `"false"` omits it.
- The tool returns `{subcommand, pythonBin, report, evidence}`. The `report` dict carries the numbers; cite them.
- For analysis with **no** compute subcommand (a `REFERENCE` method), write it by hand in a `run_python` cell — and still emit a trailing JSON `report` and pass it to `evidence_from_kernel_cell` so it is grounded.
- Implementation helpers live in the `aose_omics_runtime` package (single source of truth), imported by name — e.g. `from aose_omics_runtime.shared.layout import assert_layout`. The `omics_compute` tool and the test suite resolve the package automatically. To use a helper inside a hand-rolled cell, prefer the matching `omics_compute` subcommand; if you import it directly, put this package's `tools/omics-compute/python/` on `sys.path` first.

## Maturity legend (used by every modality skill)

Each capability is tagged so you know what actually runs:

- **READY** — backed by a tested `omics_compute` subcommand. Call the tool.
- **PARTIAL** — compute subcommand exists but needs heavier deps/GPU, or is newer; verify preflight, then call the tool.
- **REFERENCE** — no compute subcommand yet; the method doc gives one opinionated, hand-written recipe to run in `run_python`.

## Modality playbooks (read after preflight)

After `omics_preflight` confirms the modality, read its skill and the specific method doc you need. Skills are grouped by three orthogonal axes — pick by **what data you have** (resolution or molecule), then optionally add a **cross-cutting** skill for downstream statistics or ML engineering.

**By resolution (transcriptomics-centric):**

| Modality | Skill | Method docs |
|----------|-------|-------------|
| Single-cell (scRNA / scATAC / multiome) | `skills/single-cell/SKILL.md` | routes to `rna/`, `atac/`, `multiome/` subskills |
| Spatial transcriptomics | `skills/spatial/SKILL.md` | `skills/spatial/assets/references/*.md` |
| Bulk (RNA-seq / epigenomics) | `skills/bulk/SKILL.md` | routes to `rna/`, `epigenomics/` subskills |

**By molecule / assay (beyond transcriptomics):**

| Modality | Skill | Method docs |
|----------|-------|-------------|
| Cancer genomics — DNA variants only (MAF / CNA) | `skills/cancer-genomics/SKILL.md` | `skills/cancer-genomics/assets/references/*.md` |
| Proteomics (Olink / MS) | `skills/proteomics/SKILL.md` | `skills/proteomics/assets/references/*.md` |
| Metabolomics / lipidomics | `skills/metabolomics/SKILL.md` | `skills/metabolomics/assets/references/*.md` |
| Microbiome (16S / metagenomics) | `skills/microbiome/SKILL.md` | `skills/microbiome/assets/references/*.md` |
| Cancer dependency (DepMap / CCLE CRISPR screens) | `skills/cancer-dependency/SKILL.md` | `skills/cancer-dependency/assets/references/*.md` |

**Cross-cutting layers (combine with any data skill above):**

| Layer | Skill | Method docs |
|-------|-------|-------------|
| Survival analysis (KM / Cox on features from any modality) | `skills/clinical-survival/SKILL.md` | `skills/clinical-survival/assets/references/*.md` |
| ML engineering / deep models (reproduce DL methods, foundation models) | `skills/bioml/SKILL.md` | routes to `repro/`, `deep-models/`, `sequence-fm/`, `coding/`, `figure-check/` subskills |

Routing notes for ambiguous cases:
- **Tumor bulk/single-cell RNA-seq** → the resolution skill (`bulk` / `single-cell`), not `cancer-genomics`. `cancer-genomics` handles somatic DNA variants (MAF/CNA) only, not expression.
- **"Associate features with patient survival"** → first the data skill to derive features, then `clinical-survival` for the KM/Cox step.
- **Foundation-model application (scGPT, Geneformer, UCE, perturbation prediction)** → `bioml`, not the resolution skill.

The shared method docs (`skills/omics-shared/assets/references/*.md`) cover containers, data context, preprocessing, grounding, visualization, figure inspection, and data acquisition — read them on demand.

## Global rules (always follow)

1. **Preflight first** — call `omics_preflight(modality=...)` before any compute. On a blocker, surface the exact `fix` and stop. Never fake success.
2. **Summarize context once** — run the `summarize` subcommand right after load; thread its text plus the free-text study description into every downstream decision (annotation, DE, composition).
3. **Anti-circular rule** — treat any existing cell-type/label column as **prior annotation**: use it only for post-hoc comparison (ARI/NMI), never copy it as your answer.
4. **Ground every quantitative claim** — every number in a conclusion must trace to an `omics_compute` report or an `evidence_from_kernel_cell` record. No ungrounded numbers.
5. **`observe_figure` on every figure** — before a figure backs a claim, check it for artifacts, wrong scale, empty axes, or unexpected structure. Re-route on a bad verdict.
6. **Write to `runs/omics/<id>/`** — notebook, `figures/`, `report/`, `evidence.jsonl` all go in the run directory for reproducibility.
7. **Abstain over fabricate** — missing data/deps → a blocker with the fix. An unresolvable cluster → "unknown", not an invented label.

## Data conventions

From `conventions.py`, the single source of truth (import the constants; never hardcode):

- **Raw counts**: `layers["counts"]` · **Normalized**: `X`
- **Embeddings**: `obsm["X_pca"]`, `obsm["X_scVI"]`, `obsm["X_umap"]`, `obsm["X_spectral"]`, … (any `obsm["X_*"]`)
- **Clusters**: `obs["leiden"]` · **Cell types**: `obs["cell_type"]`
- **Batch/condition**: `obs["batch"]`, `obs["condition"]` · **Spatial coords**: `obsm["spatial"]`

For hand-written cells, import helpers from the package-local Python implementation. The `omics_compute` tool configures this automatically; if a manual cell needs direct imports, put this package's `tools/omics-compute/python/` directory on `sys.path` first:

```python
import os, sys
implementation_dir = os.environ.get("AOSE_OMICS_PYTHON_DIR") or "tools/omics-compute/python"
sys.path.insert(0, implementation_dir)
from aose_omics_runtime.shared import conventions, io as omics_io, summarize, preprocess
```

## Judgment this guides

- **Frozen subcommand vs. hand-rolled** — use `omics_compute` subcommands when the data fits their assumptions (fast, standardized, grounded). Hand-roll only when the data is unusual or the method is `REFERENCE`.
- **What counts as evidence** — any quantitative claim (cluster count, expression value, QC threshold, metric) must trace to a real computation report.
- **When to re-route** — an `observe_figure` verdict of "artifacts", "wrong scale", or "structure unclear" means stop and investigate before reporting.
- **Honesty boundaries** — if the study says "healthy + disease" but no obs column distinguishes them, flag the mismatch; don't invent a split.
