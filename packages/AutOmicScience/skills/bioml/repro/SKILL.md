---
name: bioml-repro
disable-model-invocation: true
---

# BioML Reproduction — Run Paper Code & Fetch Weights

> Subskill of `bioml`. Enter here from the parent skill when you need to reproduce a published method by running its paper repo. Read `../SKILL.md` (parent) and `../../omics-shared/SKILL.md` first — their ML-engineering foundations and evidence rules apply here.

The central skill for NatureBench-style tasks: **get the paper's code running, adapt its I/O to the required output, fetch model weights from Hugging Face, and exploit escape hatches when a simpler method already beats the target.**

---

## Prerequisites

1. The paper has a public GitHub repo with reproduction instructions
2. You've confirmed the output contract (shape, dtype, metric, evaluator)
3. You understand the baseline/SOTA score being targeted
4. `omics_preflight(modality="...")` passes (for the appropriate modality if omics data is involved)

---

## The Reproduction Strategy

### Step 0: Check for Escape Hatches First

Before investing days in a complex pipeline, **check whether a simpler method already matches/beats the SOTA** on the exact metric:

- **Single-cell label transfer?** → Try `scANVI` or `scArches` before a bespoke transformer.
- **Multimodal integration?** → Try `scVI` + KMeans or `MultiVI` before a GNN.
- **Sequence modeling?** → Try a frozen `Enformer` / `Borzoi` embedding + linear head before fine-tuning.

If the simple baseline clears the bar, you're done — document it and ship. See `../deep-models/SKILL.md` for the single-cell recipes.

### Step 1: Clone & Inspect the Repo

Use `bash` with `gh` or `git`:

```bash
# Preferred: gh CLI (auto-authenticates)
gh repo clone <owner>/<repo> -- --depth=1

# Fallback: plain git
git clone --depth=1 https://github.com/<owner>/<repo>.git
```

**Inspect before running:**
- README: required dependencies, data paths, entry script
- `requirements.txt` / `environment.yml` / `pyproject.toml` — what environment to build
- `scripts/` or `examples/` — which script generates the output you need
- License (check you can reuse the code)

Document: repo URL, commit SHA, license.

### Step 2: Fetch Model Weights / Datasets

Many repos expect pre-trained weights or datasets from Hugging Face. Read `assets/references/huggingface_fetch.md` for the mirror-aware fetch recipe.

**Quick reference:**
```bash
# Hugging Face model/dataset with mirror (when hf.co is slow/blocked)
export HF_ENDPOINT=https://hf-mirror.com
huggingface-cli download <owner>/<repo> --local-dir ./weights/

# Or use git-lfs with mirror rewrite (for large repos)
export GIT_LFS_SKIP_SMUDGE=1
git clone https://hf-mirror.com/<owner>/<repo> ./weights/
cd weights && git lfs pull --include="*.bin,*.safetensors"
```

**Key:** Magenta's `WebFetch` auto-probes local proxies/VPN, but `huggingface-cli` / `git-lfs` often need explicit mirror env vars. See the reference doc for the full ladder.

For GitHub code/weights: `assets/references/github_fetch.md`.

### Step 3: Build the Environment

Install dependencies **in isolation** (never pollute the main omics env):

```bash
# Conda/mamba
conda env create -f environment.yml
conda activate <env-name>

# Or pip in a venv
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
```

Pin exact versions in the lockfile for reproducibility.

### Step 4: Run the Reproduction Script

Follow the paper's instructions to the letter. Typical pattern:

```bash
python scripts/train.py --data ./data/ --output ./output/ --epochs 50
```

**Sanity-check on small first:**
- Run 1 epoch, confirm loss moves and no OOM
- Check intermediate outputs have the right shape
- Then scale to full run

**Monitor:**
- GPU usage (`nvidia-smi`)
- Disk I/O (if data is large)
- Logs for warnings/errors (silent failures = blocker)

### Step 5: Adapt Output to Contract

The paper's script often writes a checkpoint or intermediate format. You must convert it to the **exact output contract** (`.npy`, `.h5ad`, `.csv`, exact shape/dtype):

```python
# Example: repo writes model.ckpt, you need predictions.npy
import numpy as np
# ... load model, run inference on test set ...
predictions = model.predict(test_data)
assert predictions.shape == (n_samples,), f"wrong shape: {predictions.shape}"
np.save("predictions.npy", predictions.astype(np.float32))
```

**Verify the output:**
- Shape/dtype match exactly
- No NaNs/Infs unless expected
- Matches a known good sample if available

Document: what was converted, any assumptions made.

### Step 6: Score & Ground

Run the task's evaluator (if local) or note the final metric:

```bash
python evaluation/evaluator.py --pred predictions.npy --truth ground_truth.npy
```

Emit the score as an `EvidenceRecord`. If the score is below target, diagnose (bad hyperparams? wrong data split? missing preprocessing?) and iterate.

---

## Detailed Fetch Guides

Complex fetch scenarios (multi-GB LFS repos, auth tokens, rate limits, git-lfs config rewrite) are documented in the reference files. Read them when the simple commands above fail.

- **GitHub fetch** (code, single files, folders) → `assets/references/github_fetch.md`
- **Hugging Face fetch** (models, datasets, LFS) → `assets/references/huggingface_fetch.md`
- **Running paper repos** (env setup, sanity checks, common pitfalls) → `assets/references/run_paper_repo.md`

---

## Pitfalls

- **Skipping the escape-hatch check** — investing in a complex pipeline when `scANVI` already clears the bar.
- **Cloning without `--depth=1`** — pulling full git history for a 10 GB repo.
- **Running on full data before sanity-checking small** — OOMing 3 hours into training.
- **Writing the wrong output shape** — the model trains perfectly but the evaluator scores it zero.
- **Ignoring silent failures** — logs show warnings but the script exits 0; see `../coding/` silent-failure audit.
- **Forgetting the license** — you build on GPL code and cannot share downstream.

---

## When Things Go Wrong

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| **Repo won't install** | Dependency conflict, pinned to old Python | Try the paper's Docker image if provided; or downgrade Python/torch to match |
| **Weights download times out** | Canonical HF is slow/blocked | Use mirror endpoint (see `assets/references/huggingface_fetch.md`) |
| **OOM during training** | Batch size too large, data not streamed | Halve batch size, load data lazily |
| **Output shape wrong** | Misunderstood the contract | Read evaluator.py to see exactly what it expects |
| **Score far below SOTA** | Wrong hyperparams, data leakage, or the baseline was cherry-picked | Check the paper's exact train/test split and config; try the escape-hatch baseline |

---

## Evidence & Reporting

Every reproduction emits:
- **Source**: GitHub repo URL + commit SHA, HF model ID, license
- **Environment**: lockfile (`requirements.txt`, `environment.yml`)
- **Commands**: exact script invocations that produced the output
- **Output**: file path, shape, dtype, hash (for reproducibility)
- **Score**: evaluator output or metric value, as `EvidenceRecord`

See `../coding/assets/references/reproducible_snapshot.md` for the full packaging discipline.
