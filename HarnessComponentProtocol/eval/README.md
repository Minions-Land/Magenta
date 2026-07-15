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
  scenarios/              - one TOML per scenario (task + variants + scoring)
    long-horizon-coherence.toml
    ultra-orchestration-smoke.toml
  fixtures/               - prompts/specs referenced by scenarios
  runner/
    run.mjs               - execute bounded headless runs and retain artifacts
    plan.mjs              - turn scenario TOML into discrete process arguments
    contract.mjs          - validate JSONL and produce normalized summaries
    *.test.mjs            - dependency-free Node tests
  results/                - timestamped run outputs (gitignored except .keep)
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
| (default)      | component on = no flag             |

Compaction has no first-class CLI off-switch today; the
`long-horizon-coherence` scenario documents the manual setup needed to force it
on/off (a large `--session` history vs. a fresh one) until a flag exists. This
is called out in the scenario file rather than hidden in the runner.

Runs use `--print -p <prompt> --mode json --no-session` so output is
machine-readable and ephemeral. Arguments are passed as an array directly to
`spawn` with `shell: false`; scenario, model, path, and prompt values are never
interpolated into a shell command.

## Headless run contract

Run controls can be declared at scenario scope and overridden by a variant:

| Scenario field | Meaning | Default |
|---|---|---|
| `thinking` | `off` through `ultra` | CLI default |
| `harness_workflows` | Explicit workflow capability override | CLI/profile default |
| `harness_teammates` | Explicit managed-teammate override | CLI/profile default |
| `background_policy` | `cancel`, `wait`, or `error` | `error` |
| `background_wait_timeout_seconds` | CLI background settlement deadline | `60` |
| `cwd` | Absolute path or path relative to the repository root | repository root |
| `wall_timeout_seconds` | Runner process deadline, independent of background waiting | `900` |

`[expect].capabilities` checks values in
`runtime_manifest.execution.harnessCapabilities`. The optional
`active_tools`, `active_tools_include`, and `active_tools_exclude` fields check
`runtime_manifest.tools.active`; `active_tools` is an exact set comparison.
`successful_tools_include` requires matching non-error tool executions.
`require_workflow_sub_agent = true` requires a successful `sub_agent` call with
a structured `workflow` argument, and `teammate_actions_include` requires each
listed managed-teammate lifecycle action to complete successfully. A variant
can replace or extend these through an inline `expect` table.

Every non-empty stdout line must be a JSON object. A run fails when JSON is
malformed; `runtime_manifest` or `run_end` is missing or duplicated; protocol
versions or run IDs disagree; process and reported exits disagree; configured
cwd, execution profile/thinking, background policy, timeout, capabilities, or
active tools do not match the manifest; `run_end` status conflicts with its exit;
the wall deadline fires; or `run_end.background.settled` is not true.

`thinking = "ultra"` specifically requires `execution.profile = "ultra"` while
`execution.thinkingLevel` remains the model's resolved native level, never the
literal value `ultra`.

## Running

```bash
# Validate a scenario's plan without calling any model (no tokens, CI-safe):
node eval/runner/run.mjs ultra-orchestration-smoke --dry-run

# Emit the resolved plan as JSON for CI or another benchmark driver:
node eval/runner/run.mjs ultra-orchestration-smoke --dry-run --json

# Execute the bounded headless run (spends tokens):
node eval/runner/run.mjs ultra-orchestration-smoke --model provider/model --json

# Run focused runner tests:
node --test eval/runner/*.test.mjs
```

`--dry-run` prints the exact argument arrays and scoring plan and exits 0.
With `--json`, dry-run output is one machine-readable resolved plan. A real run
writes `plan.json`, raw `<variant>.stdout.jsonl` and `<variant>.stderr.log`, a
normalized `<variant>.summary.json`, and aggregate `summary.json` under
`results/<scenario>-<timestamp>/`. `--json` prints the aggregate summary as a
single JSON line. Any invalid variant makes the runner exit nonzero; raw streams
and summaries are still retained for diagnosis.

## Scoring

A scenario declares its intended method in the `[scoring]` block. The current
runner records that plan but does not execute scoring automatically. Apply the
Harness `multiagent` verifier patterns (`adversarial_verify` / `tournament`)
where a judgement call is needed, and inspect plain signals such as completion,
token count, or early wrap-up where a mechanical check suffices.

## Adding a scenario

1. Write `scenarios/<name>.toml` (copy the closest existing scenario).
2. Add any prompt/spec to `fixtures/`.
3. Add `[expect]` checks for every capability/tool the task depends on.
4. Reference `<name>` from the target component's
   `[assumption].eval_scenarios` in its module TOML.
5. Validate with `node eval/runner/run.mjs <name> --dry-run --json`.

`ultra-orchestration-smoke` is the smallest orchestration contract: Ultra
thinking, workflow and teammate overrides, required active orchestration tools,
mechanical evidence of a workflow call and teammate `start`/`wait`/`stop`,
wait-for-background settlement, and both background and wall deadlines. A
future SWE-bench adapter may select a checkout/cwd, generate a task prompt, run
this entry, and consume `summary.json`. This directory intentionally does not
implement or vendor the official SWE-bench harness.

## Status

The dry-run path and JSONL contract validator are CI-safe. Real runs execute the
built CLI directly and should be exercised deliberately: they spend tokens and
need credentials configured through the coding-agent authentication flow.
