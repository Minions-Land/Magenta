---
name: bioml
description: Bioinformatics machine-learning engineering — reproduce published DL methods (single-cell foundation models, sequence models, spatial GNNs), fetch code/weights from GitHub & Hugging Face, run and adapt paper repos to exact output files, and apply ML-engineering discipline (bounded repair, honest error paths, reproducible snapshots, publication-grade figures). Use when a task requires training or reproducing a machine-learning model on omics data rather than a standard scanpy/tabular analysis.
requiredTools: [run_python, bash, read, write, WebFetch, observe_figure, omics_preflight, omics_compute]
evidencePolicy: required
outputSchema: grounded_response
minConfidence: medium
tags: [bioml, machine-learning, deep-learning, reproduction, scvi-tools, huggingface, github, model-training]
extends: omics-shared
---

# BioML — Bioinformatics Machine-Learning Engineering

BioML covers the tasks where the deliverable is a **trained or reproduced machine-learning model** on biological data — not a standard analytical write-up. Think: reproduce SATURN / scPoli / scVI / a sequence foundation model / a spatial GNN to a tight objective metric, or build a competitive DL baseline on omics data.

Builds on `omics-shared` (loaded automatically — its evidence/grounding rules apply). This parent skill provides the ML-engineering mental model and routes to modality-specific subskills.

---

## The Core Insight (read this first)

For most BioML reproduction tasks, **the winning move is not to reinvent the method**. In priority order:

1. **Run the paper's public repo.** Clone the GitHub repo, install its environment, adapt its I/O to the required output file/shape. → `repro/SKILL.md`
2. **Use a mature simpler method that already matches or beats the target.** A well-tuned `scVI` + KMeans, `scANVI`, or a task-specific CNN often equals or beats a bespoke model at a fraction of the effort. → `deep-models/SKILL.md`
3. **Exploit escape hatches.** Sometimes a strong baseline beats the "SOTA" method on the exact metric being scored. Always check whether a simpler path clears the bar before committing to a heavy pipeline.

Only reimplement from scratch when no repo runs and no simpler method fits. The #1 capability here is **ML-engineering: get the paper's code running, get its weights, adapt the outputs** — the domain method is secondary.

---

## Routing: Which Subskill?

| You need to… | Subskill | What it covers |
|--------------|----------|----------------|
| **Reproduce a published method** — clone a repo, fetch model weights/datasets, run and adapt it | `repro/SKILL.md` | GitHub fetch, Hugging Face fetch (with mirror emphasis), running paper repos, escape-hatch awareness |
| **Build/train a single-cell deep model** — scVI, scANVI, scArches, scPoli, scGPT, contrastiveVI, SATURN | `deep-models/SKILL.md` | scvi-tools / scArches / foundation-model recipes, reference mapping, label transfer, integration |
| **Build/apply a DNA/RNA/protein sequence model** — NT, DNABERT, HyenaDNA, Borzoi, RNA-FM, ESM-2, GPN | `sequence-fm/SKILL.md` | Sequence foundation models, tokenization, finetune vs zero-shot, FASTA loaders, CNN escape hatches |
| **Write and verify ML code** — plan, implement, repair a failing check, test, package a reproducible snapshot | `coding/SKILL.md` | coding methodology (plan → implement → simplify → test), bounded repair loop, silent-failure & type audits, reproducible code snapshot |
| **Produce or audit publication figures** — matplotlib discipline, vector-font compliance, layout audit | `figure-check/SKILL.md` | academic-plotting rcParams/Type-42 gate, chart-type selection, pixel-level layout audit |

The subskills are chapters of this skill and cannot be invoked independently. Read the one that matches your current step.

---

## Shared BioML Foundations

### 1. Environment & Compute Reality

- **Confirm the environment before training.** GPU availability (`nvidia-smi`), CUDA/torch versions, available RAM/disk. Many BioML tasks are bound by **data size + wall-clock**, not GPU FLOPs.
- **Stream, don't load blindly.** Multi-GB datasets: read shapes/metadata first, load lazily or in chunks. A 116 GB dataset does not fit in memory.
- **Prefer the package's pinned envs** — run compute through `omics_compute` / pixi environments where the standardized path exists; only build a fresh env when the paper repo demands it.
- **Sanity-check small before scaling.** Train on a subset / few epochs, confirm the loss moves and the output shape is right, then scale.

### 2. Reproduce to an EXACT Output Contract

BioML benchmark tasks are scored by an objective evaluator against hidden ground truth. Therefore:

- **Read the required output spec first** — file name, format (`.npy` / `.h5ad` / `.csv`), array shape, dtype, and the exact metric (ARI, Pearson, MCC, cosine, silhouette…).
- **Match the contract exactly.** A model that trains perfectly but writes the wrong shape scores zero. Verify the output shape/dtype programmatically before declaring done.
- **Know the baseline.** If the score is normalized against a published SOTA, find that number and target it explicitly.

### 3. Honest ML, No Faked Success

- **Never fabricate metrics.** Every reported number comes from a real run against real data, cited as evidence.
- **Surface failures.** A training run that diverged, a repo that would not install, an OOM — report it as a blocker, do not paper over it. (See `coding/` silent-failure discipline.)
- **Ground every claim** — loss curves, metric values, output artifacts → `EvidenceRecord` and cite exact numbers.

### 4. Fetch Discipline (code & weights)

- Getting the paper's code and weights is usually step one. Use `repro/`'s fetch recipes.
- **GitHub**: prefer `gh api` / `gh repo clone --depth=1`; fall back to `raw.githubusercontent.com`.
- **Hugging Face**: emphasize **mirror endpoints** when the canonical host is slow/blocked; the environment's `WebFetch`/network layer already probes local proxies automatically, but `hf`/`git-lfs` paths often need an explicit mirror + `GIT_LFS_SKIP_SMUDGE=1`.
- Always record: source repo + commit SHA, where bytes landed, and the **license** (it gates whether you can reuse the code/weights downstream).

### 5. Evidence & Grounding (from omics-shared)

- Every quantitative claim → emit a trailing JSON `report`, cite exact numbers.
- Every figure → `observe_figure` before it backs a claim (see `figure-check/`).
- Preserve provenance: repo SHA, env lockfile, exact reproduction commands (see `coding/` snapshot discipline).

---

## Next Steps

Identify your current step and read the matching subskill. A typical reproduction flows: `repro/` (get code+weights running) → `deep-models/` (if it's a single-cell model) → `coding/` (implement/repair/test the glue + package it) → `figure-check/` (if the deliverable includes figures).
