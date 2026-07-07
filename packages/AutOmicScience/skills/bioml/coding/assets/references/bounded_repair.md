# Reference — Bounded Repair Loop

The controlled way to iterate on a failing local check: bounded, observable, never open-ended.

## When to use

- A unit test, smoke test, type check, or small CLI sanity check fails **deterministically**
- A task asks you to "make this pass" with a concrete command
- A reproduction step fails and you need to diagnose and fix

**Do not use** for:
- Heavy compute (multi-hour training runs)
- Large data pipelines
- Long-running jobs that cannot complete inside a bounded local loop

Split those into a separate step instead.

## The loop structure

Three hard gates: a named failing command, an iteration bound, and a stop condition.

### 1. Name the failing command

```bash
pytest tests/test_model.py::test_output_shape
```

This is the **same command** you will rerun after each fix. Don't switch to a different test mid-loop.

### 2. Set the iteration bound **before editing**

Default: **3 attempts**. For a truly unclear failure, you can raise to 5, but never remove the bound. If 3 (or 5) attempts don't pass, the next attempt almost certainly won't either — you need to escalate (ask for help, split into a subtask, or report as blocked).

### 3. Diagnose before each edit

Run the command, read the error. What failed? What evidence do you have?
- Stack trace → which line threw?
- Assertion failure → what was the actual vs expected value?
- Subprocess exit code → what did `stderr` say?
- Silent success but wrong result → add a print or assertion to surface what's wrong

One coherent diagnosis per iteration. Write it down.

### 4. One fix per iteration

Apply **one** coherent change that addresses the diagnosis. Don't shotgun multiple unrelated edits hoping one sticks.

Examples:
- The model outputs shape `(N, 10)` but the evaluator expects `(N,)` → add `.argmax(axis=1)` before saving
- A test expects a key `"predictions"` but the output dict has `"pred"` → rename the key
- OOM on batch size 64 → halve to 32

### 5. Rerun the same check

Run the **exact same command**. If it passes, optionally run one adjacent fast check for confidence, then stop. If it fails **differently**, start the next iteration from the new evidence.

### 6. Stop cleanly

Stop on:
- **Pass** — the check succeeds
- **Bound exhaustion** — you've hit 3 (or 5) attempts
- **Unclear ownership** — the bug is in a dependency, not your code
- **Missing input** — you need data/weights/config the task didn't provide
- **Next step requires heavy out-of-loop compute** — training a model, processing 100 GB, etc.

### 7. Report

Emit:
- The failing command
- Iteration count
- Final status (pass / bound exhausted / blocked / out-of-scope)
- Changed paths (if any)
- Final failure message (if unresolved)

If blocked, note the **smallest missing input** needed to continue — a config file, a model checkpoint, a data sample.

## Examples

### Example A: Output shape mismatch (passes iteration 2)

```
Command: python evaluate.py --pred predictions.npy --truth ground_truth.npy
Bound: 3

Iteration 1:
  Diagnosis: evaluator expects shape (1000,), got (1000, 10)
  Fix: add predictions.argmax(axis=1) before np.save
  Rerun: still fails — evaluator expects dtype int32, got int64

Iteration 2:
  Diagnosis: dtype mismatch
  Fix: cast to int32 in the np.save call
  Rerun: PASS

Status: pass after 2 iterations
Changed: scripts/predict.py
```

### Example B: Bound exhausted, escalate

```
Command: pytest tests/test_loader.py::test_batch_collate
Bound: 3

Iteration 1:
  Diagnosis: KeyError: 'cell_type' in batch collate
  Fix: add 'cell_type' to the batch dict
  Rerun: now fails with KeyError: 'n_counts'

Iteration 2:
  Diagnosis: missing another key
  Fix: add 'n_counts' to the batch dict
  Rerun: now fails with shape mismatch on 'X'

Iteration 3:
  Diagnosis: X should be (B, G) but got (B, G, 1)
  Fix: squeeze last dim
  Rerun: still fails — now a different key 'raw_counts' is missing

Status: bound exhausted after 3 iterations
Diagnosis: the collate function expects a schema we don't have documented; next step is to read the loader's source or ask for the schema spec.
```

## Pitfalls

- **Resetting the counter** — "it almost worked, let me try one more" → the bound exists to prevent this. If 3 didn't pass, #4 won't either.
- **Changing unrelated code** — editing the model architecture to make a test pass when the test is about output shape
- **Running heavy compute inline** — a 3-hour training run is not a "local check"
- **Hiding failure** — loosening assertions, swallowing errors, or deleting verification to force a pass
- **Switching commands mid-loop** — if `test_A` fails and you pivot to `test_B`, you've abandoned the loop discipline

## Self-update

If a category of failure (e.g., torch dtype mismatches, subprocess hanging) recurs across projects, patch the "common diagnoses" section here with the diagnosis + fix so the next loop lands on it immediately.
