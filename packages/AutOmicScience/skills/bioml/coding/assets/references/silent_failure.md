# Reference — Silent Failure Audit

Honest error paths: a failure must be observable by whoever can act on it. Fallback behavior is acceptable only when it's explicit, traceable, and safe. Critical for ML code, where a "successful" run can silently produce garbage.

## When to audit

- Code introduces or changes exception handling, subprocess calls, network requests (weight/data fetching), config loading, or model checkpointing
- A training run "passes" (exits 0) but the metrics look wrong
- A data loader silently returns fewer samples than expected
- Before handing off a reproduction result

## The three classifications

Each fallback path gets one label:

| Label | Meaning |
|-------|---------|
| **verified** | Safe recovery, and the recovery is observable (logged, raised, or recorded) |
| **patched** | A silent failure converted into an explicit error / warning / structured status |
| **accepted fallback** | Graceful degradation with a clear, logged reason the caller can still act on |

Observability forms: logging, a raised exception, a structured status value, or a persisted diagnostic artifact. Pick the form that fits the call site.

## Procedure

### 1. Search the changed code first

Grep for the usual silent-failure patterns:

```bash
# Python
grep -n "except" changed_file.py           # bare/broad except?
grep -n "return None\|return \[\]\|return {}" changed_file.py  # silent empty returns?
grep -n "pass  #\|except.*pass" changed_file.py  # swallowed exceptions?
```

Inspect: `except` blocks, `return None`/empty collections, default config fallbacks, subprocess handling, JSON/YAML parsing, network calls, model loading.

### 2. Classify each fallback

- **Safe recovery** — retry a flaky network fetch, fall back to CPU when GPU unavailable (and log it)
- **Deferred work** — skip an optional step, record that it was skipped
- **Optional capability loss** — a nice-to-have feature unavailable, logged
- **Hidden failure** — the dangerous one: an error swallowed and converted to fake success

### 3. Check observability

A real failure needs one of: a log line, a raised exception, a structured status, or a diagnostic file. Ask: *if this fails in production, will the person who can fix it know?*

### 4. Preserve useful tolerance

Don't turn graceful degradation into a hard crash when the caller can still make a correct decision. A `try: import cupy except ImportError: use numpy` with a log line is fine — don't "fix" it into a fatal error.

### 5. Patch high-confidence issues

Convert silent failures to explicit errors/warnings/status in the local style:

```python
# Before (silent):
try:
    weights = torch.load(path)
except Exception:
    weights = None   # caller has no idea the load failed

# After (patched):
try:
    weights = torch.load(path)
except FileNotFoundError as e:
    raise RuntimeError(f"Model weights not found at {path}; fetch them first (see repro/)") from e
except Exception as e:
    raise RuntimeError(f"Failed to load weights from {path}: {e}") from e
```

### 6. Verify a negative path

Add or run a focused test that exercises the failure — e.g., load from a missing path and assert it raises, not returns None.

### 7. Report

Each silent-failure risk as `verified` / `patched` / `accepted fallback`, with the evidence path and the reason the caller can (or cannot) act on it.

## ML-specific silent-failure traps

| Trap | Why it's dangerous | Fix |
|------|-------------------|-----|
| Training loop that diverges (NaN loss) but exits 0 | You ship a model that predicts garbage | Assert loss is finite each epoch; raise on NaN |
| `except: pass` around a data augmentation | Silently drops samples, biases the dataset | Log skipped samples; fail if the drop rate exceeds a threshold |
| Model outputs zeros because weights didn't load | Evaluator scores 0, you blame the method | Assert weights loaded (check a param norm > 0) |
| `torch.load` on a corrupt checkpoint returns partial state | Model runs but with random layers | Verify all expected keys are in the state_dict |
| Fallback to CPU when GPU OOMs, silently | 100× slower, looks like a hang | Log the fallback explicitly; consider it a warning |
| Metric computed on the wrong axis, returns a plausible number | Wrong result that looks right | Assert metric is in the expected range; cross-check on a known sample |

## Pitfalls

- Turning optional best-effort behavior into a hard failure
- **Logging secrets or tokens** while improving diagnostics (never echo HF_TOKEN, API keys)
- Raising inside cleanup paths where a clearer status return is safer
- Auditing only Python exceptions and missing shell return codes (`subprocess.run(..., check=True)` or check `.returncode`)
- Trusting a "0 loss" or "1.0 accuracy" without cross-checking — often a bug, not success
