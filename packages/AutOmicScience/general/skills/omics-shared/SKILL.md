---
name: omics-shared
description: Cross-modality scverse foundations — data containers, dataset summary, standard preprocessing, evidence grounding, figure inspection. Load first for any omics task.
requiredTools: [run_python, create_notebook, add_cell, observe_figure, omics_preflight, omics_runtime]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [omics, scverse, shared, anndata, mudata, spatialdata]
---

# Omics Shared — Cross-Modality Foundations

The shared substrate every omics modality (scRNA-seq, spatial, scATAC-seq, multiome) builds on. This skill is loaded automatically for omics analysis; read the modality playbook next.

## How to run compute (read this first)

All standardized analysis runs through one grounded tool, **`omics_runtime`**, which executes a runtime subcommand in the modality's pinned Pixi environment and **records an evidence record automatically**. Prefer it over hand-written `subprocess` calls — that is the only path that captures provenance.

```
omics_runtime(
  subcommand="preprocess",
  modality="scrna",          # selects the pinned env (scrna→task1, spatial→task2, scatac→task4, multiome→task3)
  args={"input": "raw.h5ad", "output": "processed.h5ad"}
)
```

- `args` keys are the subcommand's `--kebab-case` flags (with or without `--`). A value of `""`/`"true"` is a bare store-true flag; `"false"` omits it.
- The tool returns `{subcommand, pythonBin, report, evidence}`. The `report` dict carries the numbers; cite them.
- For analysis with **no** runtime subcommand (a `REFERENCE` method), write it by hand in a `run_python` cell — and still emit a trailing JSON `report` and pass it to `evidence_from_kernel_cell` so it is grounded.
- Runtime helpers live in the `aose_omics_runtime` package (single source of truth), imported by name — e.g. `from aose_omics_runtime.shared.layout import assert_layout`. The `omics_runtime` tool and the test suite resolve the package automatically. To use a helper inside a hand-rolled cell, prefer the matching `omics_runtime` subcommand; if you import it directly, put the package's `.omics-runtime/` on `sys.path` first.

## Maturity legend (used by every modality skill)

Each capability is tagged so you know what actually runs:

- **READY** — backed by a tested `omics_runtime` subcommand. Call the tool.
- **PARTIAL** — runtime subcommand exists but needs heavier deps/GPU, or is newer; verify preflight, then call the tool.
- **REFERENCE** — no runtime subcommand yet; the method doc gives one opinionated, hand-written recipe to run in `run_python`.

## Modality playbooks (read after preflight)

After `omics_preflight` confirms the modality, read its skill and the specific method doc you need:

| Modality | Skill | Method docs |
|----------|-------|-------------|
| scRNA-seq | `task/scrna/skills/omics-scrna/SKILL.md` | `task/scrna/skills/omics-scrna/method/*.md` |
| Spatial | `task/spatial/skills/omics-spatial/SKILL.md` | `task/spatial/skills/omics-spatial/method/*.md` |
| scATAC-seq | `task/scatac/skills/omics-scatac/SKILL.md` | `task/scatac/skills/omics-scatac/method/*.md` |
| Multiome | `task/multiome/skills/omics-multiome/SKILL.md` | `task/multiome/skills/omics-multiome/method/*.md` |

The shared method docs (`general/skills/omics-shared/method/*.md`) cover containers, data context, preprocessing, grounding, visualization, figure inspection, and data acquisition — read them on demand.

## Global rules (always follow)

1. **Preflight first** — call `omics_preflight(modality=...)` before any compute. On a blocker, surface the exact `fix` and stop. Never fake success.
2. **Summarize context once** — run the `summarize` subcommand right after load; thread its text plus the free-text study description into every downstream decision (annotation, DE, composition).
3. **Anti-circular rule** — treat any existing cell-type/label column as **prior annotation**: use it only for post-hoc comparison (ARI/NMI), never copy it as your answer.
4. **Ground every quantitative claim** — every number in a conclusion must trace to an `omics_runtime` report or an `evidence_from_kernel_cell` record. No ungrounded numbers.
5. **`observe_figure` on every figure** — before a figure backs a claim, check it for artifacts, wrong scale, empty axes, or unexpected structure. Re-route on a bad verdict.
6. **Write to `runs/omics/<id>/`** — notebook, `figures/`, `report/`, `evidence.jsonl` all go in the run directory for reproducibility.
7. **Abstain over fabricate** — missing data/deps → a blocker with the fix. An unresolvable cluster → "unknown", not an invented label.

## Data conventions

From `conventions.py`, the single source of truth (import the constants; never hardcode):

- **Raw counts**: `layers["counts"]` · **Normalized**: `X`
- **Embeddings**: `obsm["X_pca"]`, `obsm["X_scVI"]`, `obsm["X_umap"]`, `obsm["X_spectral"]`, … (any `obsm["X_*"]`)
- **Clusters**: `obs["leiden"]` · **Cell types**: `obs["cell_type"]`
- **Batch/condition**: `obs["batch"]`, `obs["condition"]` · **Spatial coords**: `obsm["spatial"]`

For hand-written cells, import helpers from the package-local runtime. The `omics_runtime` tool configures this automatically; if a manual cell needs direct imports, put this package's `.omics-runtime/` directory on `sys.path` first:

```python
import os, sys
runtime_dir = os.environ.get("AOSE_OMICS_RUNTIME_DIR") or ".omics-runtime"
sys.path.insert(0, runtime_dir)
from aose_omics_runtime.shared import conventions, io as omics_io, summarize, preprocess
```

## Judgment this guides

- **Frozen subcommand vs. hand-rolled** — use `omics_runtime` subcommands when the data fits their assumptions (fast, standardized, grounded). Hand-roll only when the data is unusual or the method is `REFERENCE`.
- **What counts as evidence** — any quantitative claim (cluster count, expression value, QC threshold, metric) must trace to a real computation report.
- **When to re-route** — an `observe_figure` verdict of "artifacts", "wrong scale", or "structure unclear" means stop and investigate before reporting.
- **Honesty boundaries** — if the study says "healthy + disease" but no obs column distinguishes them, flag the mismatch; don't invent a split.
