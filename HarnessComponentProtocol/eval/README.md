# Harness Eval

`test/` verifies **correctness** (does the code do what it says). `eval/`
measures **capability** (does a harness component still earn its place on the
current model). They answer different questions and run on different cadences:
tests run in CI on every change; evals run when a model changes or when we are
deciding whether to add or prune a component.

This directory is the measurement half of the assumption workflow described in
`docs/assumption-metadata.md`. Each component's `[assumption].eval_scenarios`
points here; each scenario measures one component's contribution by running the
same task with the component on and off and comparing a signal.

## Layout

```
eval/
  README.md
  scenarios/              — one TOML per scenario (task + variants + scoring)
    long-horizon-coherence.toml
  fixtures/               — prompts/specs referenced by scenarios
    long-build-spec.md
  runner/
    run.mjs               — resolve a scenario into concrete CLI runs (A/B)
    plan.mjs              — shared: turn a scenario TOML into a run plan
  results/                — timestamped run outputs (gitignored except .keep)
```

## How a scenario maps to real runs

The runner drives the built headless CLI (`pi/coding-agent/dist/cli.js`), which
already exposes component-toggle flags. A scenario variant declares which
components are on; the runner translates that into flags:

| Component      | "off" flag                         |
|----------------|------------------------------------|
| skills         | `--no-skills`                      |
| prompt-templates | `--no-prompt-templates`          |
| context        | `--no-context-files`               |
| a tool         | `--exclude-tools <name>`           |
| (default)      | component on = no flag             |

Compaction has no first-class CLI off-switch today; the
`long-horizon-coherence` scenario documents the manual setup needed to force it
on/off (a large `--session` history vs. a fresh one) until a flag exists. This
is called out in the scenario file rather than hidden in the runner.

Runs use `--print -p <prompt> --mode json --no-session` so output is
machine-readable and ephemeral.

## Running

```bash
# Validate a scenario's plan without calling any model (no tokens, CI-safe):
node eval/runner/run.mjs long-horizon-coherence --dry-run

# Execute the A/B runs against the current model (spends tokens):
node eval/runner/run.mjs long-horizon-coherence --model claude-opus-4-5
```

`--dry-run` prints the exact CLI invocations and the scoring plan and exits 0.
It is the CI-safe smoke test that the eval plumbing is intact. A real run writes
per-variant transcripts and `plan.json` to
`results/<scenario>-<timestamp>/`, then prints instructions for applying the
scenario's scoring method manually.

## Scoring

A scenario declares its intended method in the `[scoring]` block. The current
runner records that plan but does not execute scoring automatically. Apply the
Harness `multiagent` verifier patterns (`adversarial_verify` / `tournament`)
where a judgement call is needed, and inspect plain signals such as completion,
token count, or early wrap-up where a mechanical check suffices.

## Adding a scenario

1. Write `scenarios/<name>.toml` (copy `long-horizon-coherence.toml`).
2. Add any prompt/spec to `fixtures/`.
3. Reference `<name>` from the target component's
   `[assumption].eval_scenarios` in its module TOML.
4. Validate with `node eval/runner/run.mjs <name> --dry-run`.

## Status

This is a scaffold with one worked scenario. The runner's dry-run path is fully
functional and CI-safe. The real-run path shells out to the built CLI; it is
wired but should be exercised deliberately (it spends tokens and needs
credentials configured through the coding-agent authentication flow).
