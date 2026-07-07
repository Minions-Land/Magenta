# Reference — Running Paper Repos

The discipline for running a published paper's reproduction code and adapting its output to an exact objective evaluator contract.

## The reproduction path

1. **Sanity-check small first** — run on a subset, 1 epoch, confirm the model trains and writes *something* with the right format
2. **Watch intermediate outputs** — shape, dtype, NaNs. Catch mismatches early before a 3-hour run.
3. **Scale gradually** — first 10% of the data, then 50%, then full.
4. **Monitor** — GPU, RAM, disk I/O, logs. Silent warnings often hint at silent failures.
5. **Adapt output to contract** — the repo rarely writes exactly the format the evaluator expects.

## Environment setup patterns

### Pattern A: paper provides environment.yml / requirements.txt

```bash
# Conda:
conda env create -f environment.yml
conda activate <repo-env>
conda list --export > conda.lock  # for reproducibility

# pip:
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
pip freeze > requirements.lock
```

Always pin exact versions in a lockfile. If install fails due to pinned Python 3.7 but you have 3.10, try downgrading Python or look for a Docker image.

### Pattern B: paper provides Docker

```bash
docker pull <registry>/<image>:<tag>
docker run --rm --gpus all -v $(pwd):/workspace -it <image> bash
# inside container:
cd /workspace && python scripts/train.py ...
```

Docker is the most reliable when dependency conflicts exist. Ensure the container sees your data mount and has GPU passthrough (`--gpus all`) if needed.

### Pattern C: no environment provided, just a pip list

Build a minimal `requirements.txt` from the imports in the code + the CUDA/torch/transformers versions mentioned in the paper. Prefer package versions from the time the paper was published (look at the repo commit date).

## Common issues & fixes

### 1. CUDA / PyTorch mismatch

```python
import torch
print(f"PyTorch: {torch.__version__}, CUDA available: {torch.cuda.is_available()}, device_count: {torch.cuda.device_count()}")
```

If `is_available() == False`, the torch build doesn't match your CUDA. Install the right torch wheel for your CUDA version:
```bash
pip install torch==<ver>+cu<XYZ> -f https://download.pytorch.org/whl/torch_stable.html
```

### 2. OOM during training

- Halve the batch size
- Enable gradient checkpointing (if the model supports it)
- Stream data from disk instead of loading everything into RAM
- Use a smaller model variant for the sanity check

### 3. Data path errors

The repo expects data at `/data/` but you cloned it to `./input/`. Read the script's `argparse` or config, override the path:
```bash
python train.py --data_dir ./input/ --output_dir ./output/
```

### 4. Missing pre-trained weights

The repo expects `weights/pretrained.ckpt` but it's not in the repo. Check:
- The paper's README "Download weights from…"
- A separate Zenodo / Google Drive link
- Hugging Face model hub: `<author>/<paper-slug>` (see `huggingface_fetch.md`)

If weights are truly unavailable, you must train from scratch or find a surrogate model.

### 5. The script runs but output is wrong shape

```python
# Repo writes model.ckpt; you need predictions.npy shape (n_samples,)
import torch, numpy as np
model = load_checkpoint("output/model.ckpt")
predictions = model.predict(test_data)  # shape: (n_samples, n_classes) — wrong!
predictions = predictions.argmax(axis=1)  # now (n_samples,)
np.save("predictions.npy", predictions.astype(np.int32))
```

Always verify the output shape/dtype **programmatically** before declaring done:
```python
assert predictions.shape == (expected_n,), f"shape mismatch: {predictions.shape}"
assert predictions.dtype == np.float32, f"dtype mismatch: {predictions.dtype}"
```

## Sanity-check template

Run this **before the full training**:

```bash
# 1. Confirm GPU is visible
nvidia-smi
python -c "import torch; print(torch.cuda.is_available())"

# 2. Confirm data loads and has the expected shape
python -c "from train import load_data; d=load_data('./input/'); print(d.shape, d.dtype)"

# 3. Run 1 epoch
python train.py --data_dir ./input/ --output_dir ./out_sanity/ --epochs 1 --save_every 1

# 4. Check intermediate output shape
python -c "import numpy as np; x=np.load('./out_sanity/checkpoint.npy'); print(x.shape, x.dtype)"
```

If any step fails or produces the wrong shape, stop and fix before scaling.

## Monitoring during training

```bash
# Terminal 1: tail logs
tail -f train.log

# Terminal 2: watch GPU every 2s
watch -n 2 nvidia-smi

# Check disk usage if data is large
du -sh ./output/
```

Silent warnings like `UserWarning: Detected call of lr_scheduler.step()` often hint at a bug in the training loop that will degrade results. Don't ignore them.

## Adapt the output

The repo writes `results.h5ad`, but the evaluator expects `predictions.npy` shape `(N,)`. Adaptation logic:

```python
import scanpy as sc
import numpy as np

adata = sc.read_h5ad("results.h5ad")
# The evaluator scores cluster assignments; extract them:
predictions = adata.obs["leiden"].astype(int).values
assert predictions.shape == (n_cells,), f"wrong shape: {predictions.shape}"
np.save("predictions.npy", predictions)
```

## Record everything

When the run finishes, emit:
- Repo URL + commit SHA
- Environment lockfile (`requirements.lock` or `conda.lock`)
- **Exact command** that produced the output
- Output file path, shape, dtype, file hash (for reproducibility)
- Training logs (loss curves, final metrics)
- Wall-clock time, GPU used

This is your audit trail. See `../../../coding/assets/references/reproducible_snapshot.md` for the full packaging template.

## Pitfalls

- Running on full data before sanity-check small
- Ignoring silent warnings in logs (they often predict a failure 2 hours later)
- Forgetting to adapt output to the exact evaluator contract
- Writing logs/outputs with absolute paths or secrets (scrub before sharing)
- Not pinning environment versions — "it worked on my machine" isn't reproducible
