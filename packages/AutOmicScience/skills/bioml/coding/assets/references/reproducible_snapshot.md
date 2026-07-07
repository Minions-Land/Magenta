# Reference — Reproducible Code Snapshot

Prepare a code bundle that lets any reader reproduce the claimed results — exact commands, pinned dependencies, and traceable artifacts.

## When to build a snapshot

- Submitting a reproduction result for evaluation
- Sharing results that make reproducibility claims
- Archiving a training run you'll need to re-run later

**Skip when:** no code claims (pure analysis with no model), or a throwaway exploration.

## The snapshot contents

A snapshot directory contains:

```
snapshot/
├── README.md            # exact reproduction commands
├── requirements.lock    # pinned dependencies (or conda.lock / uv.lock / environment.yml)
├── src/                 # the code
├── LICENSE              # the license
└── ARTIFACTS.md         # pointer from each result → the artifact that produced it
```

## Procedure

### 1. Write `README.md` with exact commands

Not "run the experiments" — the **specific commands, in order**, that produce each reported number.

```markdown
## Reproduction

### Environment
    conda env create -f environment.yml
    conda activate repro-env

### Download weights
    export HF_ENDPOINT=https://hf-mirror.com
    huggingface-cli download <owner>/<model> --local-dir ./weights/

### Train (produces Table 1 numbers)
    python src/train.py --data ./data/ --output ./output/ --epochs 400 --seed 0

### Evaluate (produces the ARI in Table 1, row 3)
    python src/evaluate.py --pred ./output/predictions.npy --truth ./data/ground_truth.npy
    # Expected output: ARI = 0.847 ± 0.003
```

Every reported number maps to a command.

### 2. Pin the dependency lockfile

```bash
# pip / venv
pip freeze > requirements.lock

# conda
conda env export > environment.yml
conda list --export > conda.lock

# uv
uv pip freeze > requirements.lock
```

Pin **exact versions** — `torch==2.1.0`, not `torch>=2.0`. Include CUDA version in a comment if it matters.

### 3. Pointer to experiment artifacts

For each reported number (table cell, figure), include a pointer to the artifact that produced it:

```markdown
## Artifacts

| Result | Value | Artifact |
|--------|-------|----------|
| Table 1, ARI | 0.847 | `output/run_0/metrics.json` |
| Figure 2, UMAP | — | `output/run_0/umap.pdf` |
| Table 2, ablation | 0.812 | `output/ablation_no_batch/metrics.json` |
```

The reader must be able to trace any claim back to its source data.

### 4. Scrub paths and secrets

- **No absolute paths** — `/Users/me/project/data` → `./data`
- **No API keys / tokens** — remove `HF_TOKEN=hf_...`, replace with `export HF_TOKEN=<your-token>`
- **No institutional hostnames** — internal server names, cluster paths

Document any required placeholders in the README.

```bash
# Quick scrub check:
grep -rn "/Users/\|/home/\|hf_[A-Za-z0-9]\|sk-[A-Za-z0-9]\|api[_-]key" src/ README.md
```

### 5. Include a license

MIT, Apache-2.0, or whatever the project uses. If reproducing someone else's code, respect **their** license — a GPL repo means your snapshot is GPL too.

### 6. Verify reproduction in a clean environment

Run the commands yourself in a fresh env (fresh conda env, or a container):

```bash
conda env create -f environment.yml -n verify-clean
conda activate verify-clean
# ... run the README commands ...
```

If the numbers don't match the paper exactly:
- **Fix the snapshot** (missing seed, wrong data split, undocumented preprocessing), or
- **Honestly document the gap** — "ARI reproduces to 0.84 vs paper's 0.847; difference attributed to stochastic KMeans init, seed-averaged over 5 runs"

Never claim a match you didn't verify.

## Output

A snapshot directory where **every claimed result is traceable** to the exact command and artifact that produced it, runnable in a clean environment.

## Pitfalls

- "Run the experiments" instead of the specific commands
- Unpinned dependencies (`torch>=2.0` — which version actually worked?)
- Absolute paths / secrets / hostnames left in the code
- Claiming reproduction without running in a clean environment
- Forgetting the upstream license when building on someone else's repo
- Missing the random seed — a result that can't be reproduced deterministically isn't reproducible
