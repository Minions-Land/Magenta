---
name: bioml-coding
disable-model-invocation: true
---

# BioML Coding — ML Engineering Discipline

> Subskill of `bioml`. Enter here from the parent skill when you write, repair, or package ML code for a reproduction or training task. Read `../SKILL.md` (parent) and `../../omics-shared/SKILL.md` first — their ML-engineering foundations and evidence rules apply here.

The coding methodology for BioML work: plan before writing, implement surgically, repair failing checks in a bounded loop, keep error paths honest, and package a reproducible snapshot. Adapted for the ML-reproduction context where the deliverable is a trained model producing an exact output.

---

## The Coding Loop

BioML code goes through four phases. Not every task needs all four — a one-line fix skips straight to the edit.

```
Plan → Implement → (Repair if failing) → Simplify → Snapshot
```

### Phase 1: Plan (before writing any non-trivial code)

**Skip when:** the spec is concrete (file path + acceptance criteria) or it's a single-line fix.

1. **Read the territory first.** Read the file you'll touch, its callers, shared utilities. For a paper repo, read the entry script and its config before editing.
2. **Surface assumptions.** State them explicitly. If multiple interpretations exist, present them — don't pick silently.
3. **Choose the simplest approach.** No features beyond what's asked. No abstractions for single-use code. No error handling for impossible scenarios.
4. **Scope surgical changes.** Touch only what you must. Match existing style. Every changed line traces to the task.
5. **Define verifiable success.** Turn the task into a concrete check: "make the model output shape `(N,)` and the evaluator score ≥ baseline."

Output: a 3–6 line plan with per-step verification criteria.

### Phase 2: Implement

1. **Match the existing codebase.** Prefer local patterns over new abstractions. Read nearby naming, helper APIs, error handling, typing, test style.
2. **Small, integrated change.** Translate the task into the smallest change that fits the codebase.
3. **For ML code specifically:**
   - Set random seeds (`torch.manual_seed`, `np.random.seed`) for reproducibility
   - Verify tensor/array shapes at boundaries
   - Guard against silent NaN propagation
4. **Run the project's quality gate** after each coherent change — whatever the repo defines (formatter, linter, type checker, test runner).

### Phase 3: Repair (when a check fails) → see `assets/references/bounded_repair.md`

A failing test/type-check/CLI-check gets a **bounded** diagnose-fix-verify loop:
- Name the failing command
- Set an iteration bound (default 3) **before** editing
- Diagnose before each edit; one coherent fix per iteration
- Rerun the same check; stop on pass or bound exhaustion
- **Never** loosen assertions or swallow errors to force a pass

**Do not** run heavy compute / long training inside the repair loop — split that into its own step.

### Phase 4: Simplify (optional, after it works)

**Skip when:** diff is ≤5 lines, or the user said "ship as-is".

- Only the files you touched. Remove duplication, flatten nesting, clarify names.
- **Protect contracts:** function signatures, CLI behavior, file formats, output shapes — unchanged.
- Re-run the Phase 2 baseline checks. If any break, the simplification changed behavior — revert it.

---

## Honest Error Paths → see `assets/references/silent_failure.md`

ML code is full of silent-failure traps: a training run that diverged but exited 0, an `except: pass` around a data loader, a fallback that returns zeros. Audit changed code for:

- `except` blocks that swallow or downgrade errors
- `return None` / empty arrays on failure
- subprocess calls whose return code is ignored
- config/data loading with silent defaults

Classify each as **verified** (safe, observable), **patched** (converted to explicit error/warning), or **accepted fallback** (graceful degradation with a clear reason). A failure must be observable by whoever can act on it. **Never fake a successful training run.**

---

## Type & Contract Safety

For Python ML code that changes data shapes, config models, or public helpers:

- Check **boundary conversions** — JSON/YAML loading, env vars, subprocess output, HTTP responses, numpy/torch dtype casts, optional fields. That's where mismatches live.
- Prefer the project's configured type tool (`mypy`, `pyright`, `ty`) on the narrowest useful scope. Fall back to manual inspection + existing tests.
- Fix real mismatches (wrong defaults, unsafe casts, forgotten `None`) rather than suppressing diagnostics.

---

## Test Coverage

One focused behavior test beats chasing line coverage.

1. **Map changed behavior** — what user/task-visible behaviors the diff changes, including failure paths.
2. **Find existing tests** — read nearby tests, match local style.
3. **Prioritize gaps:** output shape/dtype contracts, data-loading edge cases, metric computation, config defaults, CLI behavior.
4. **Fast and isolated** — no live external services, no dependence on a prior training run. Use small fixtures / synthetic data.
5. **Cover negative paths** — the OOM guard, the NaN check, the wrong-shape rejection.

---

## Reproducible Snapshot → see `assets/references/reproducible_snapshot.md`

Before submitting or sharing a reproduction result, package a snapshot so any reader can reproduce the claimed numbers:

- `README.md` with the **exact commands** (not "run the experiments") that produce each reported number, in order
- Dependency lockfile with pinned versions (`requirements.lock`, `conda.lock`, `uv.lock`)
- Pointer from each reported number → the artifact that produced it
- Scrub absolute paths, API keys, hostnames — replace with documented placeholders
- License
- **Verify reproduction** in a clean environment; if numbers don't match, fix the snapshot or honestly document the gap

---

## Pitfalls

- Starting to code before the approach or the output contract is clear
- "Improving" adjacent code you weren't asked to touch
- Resetting the repair-loop counter to "try one more time" — the bound exists to prevent drift
- Hiding a failing metric by loosening the assertion or swallowing the error
- Adding slow tests (that train a model) to the fast unit suite
- Shipping a snapshot with absolute paths or an unpinned environment
