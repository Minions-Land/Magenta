# Harness Eval

`test/` verifies **correctness** (does the code do what it says). `eval/`
measures **capability** (does a harness component still earn its place on the
current model). They answer different questions and run on different cadences:
tests run in CI on every change; evals run when a model changes or when we are
deciding whether to add or prune a component.

This directory is the measurement half of the assumption workflow described in
`docs/assumption-metadata.md`. Each component's `[assumption].eval_scenarios`
points here. A `comparison` scenario requests the same task with its target
component on and off; a `smoke` scenario checks one declared runtime contract
without claiming component lift.

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
    artifacts.mjs         - stream private bounded output and prune old results
    execution-gate.mjs    - reject real runs with unresolved isolation
    plan.mjs              - turn scenario TOML into discrete process arguments
    contract.mjs          - validate JSONL and produce normalized summaries
    *.test.mjs            - dependency-free Node tests
  results/                - timestamped run outputs (gitignored except .keep)
```

## How a scenario maps to real runs

The runner drives the built headless CLI (`pi/coding-agent/dist/cli.js`), which
already exposes component-toggle flags. A scenario variant declares boolean
component states; the runner translates known controls into flags. Unknown
component names and non-boolean states fail closed, including unknown truthy
states:

| Component      | "off" flag                         |
|----------------|------------------------------------|
| skills         | `--no-skills`                      |
| prompt-templates | `--no-prompt-templates`          |
| context        | `--no-context-files`               |
| workflows      | `--harness-workflows` / `--no-harness-workflows` |
| multiagent     | `--harness-teammates` / `--no-harness-teammates` |
| (default)      | component on = no flag             |

`kind = "comparison"` is the default. Every variant must explicitly declare
`targets_component`, and the variants must contain both `true` and `false`
target states before a real run is allowed. Single-arm contracts must declare
`kind = "smoke"`; their output is never presented as A/B evidence.

Compaction has no first-class CLI off-switch today, so
`long-horizon-coherence` is currently a planning-only scenario, not a completed
or executable A/B. Its dry-run plan reports
`executionGate.unresolvedManualIsolation` for `compaction-off`. A real run
fails before reading the prompt, calling a model, or creating a result
directory. A `manual_note` documents the missing isolation but never bypasses
the gate; when an actual CLI off-switch exists it must be mapped in
`runner/plan.mjs` so the requested state is present in the spawned argv.

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
a structured `workflow` argument, and `multiagent_actions_include` requires each
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

`--dry-run` prints the exact argument arrays, scoring plan, and structured
execution gate and exits 0, including when manual isolation remains unresolved.
With `--json`, dry-run output is one machine-readable resolved plan. A real run
writes no artifacts and exits nonzero if any requested component-off state has
no executable CLI switch. Otherwise, it writes `plan.json`, raw
`<variant>.stdout.jsonl` and `<variant>.stderr.log`, a
normalized `<variant>.summary.json`, and aggregate `summary.json` under
`results/<scenario>-<timestamp>-<pid>-<id>/`. `--json` prints the aggregate
summary as a single JSON line. Each variant reports `contractValid` separately
from `executionSucceeded`; a structurally consistent nonzero child exit remains
diagnosable but is not a valid eval arm. Any failed arm, invalid contract, or
unexecuted configured scorer makes the runner exit nonzero; raw streams and
summaries are still retained for diagnosis.

Variants currently run once, in declaration order, against the same agent
directory, working tree, and provider cache. The plan and summary therefore set
`comparisonClaimAllowed = false`: these runs are diagnostics, not isolated A/B
evidence. Do not infer component lift until a benchmark driver supplies isolated
environments, counterbalanced order, repetitions, and an executed scorer.

Real-run directories are created with mode `0700`, and every artifact is
created with mode `0600`. Stdout and stderr are streamed to disk with
backpressure while the child is running; each stream's file and in-memory
contract input, as well as every structured plan and summary, are capped at 16
MiB. Crossing a stream cap records retained and observed byte counts, marks the
stream truncated, and invalidates the variant instead of treating a partial
terminal contract as complete. An oversized structured artifact fails before
file creation.

At real-run startup and completion, the runner removes recognized result
artifacts older than seven days and prunes oldest artifacts until the results
tree is at most 200 files and 256 MiB. A private PID marker protects every live
concurrent run from cleanup. Traversal ignores symlink files and directories,
and unknown files under `results/` are not treated as disposable eval output.
Live output can temporarily exceed a tree budget; it becomes eligible for the
next cleanup only after its active marker is released.

## Scoring

A scenario declares its intended method in the `[scoring]` block.
`method = "headless-contract"` is scored automatically from contract validity
and successful execution. Other methods, including `evaluator-agent`, are
recorded as `status = "not_run"`; the runner exits nonzero rather than presenting
an unexecuted scorer as a result. Apply the Harness `multiagent` verifier
patterns (`adversarial_verify` / `tournament`) in a separate, provenance-aware
benchmark driver where a judgement call is needed.

## Adding a scenario

1. Write `scenarios/<name>.toml` (copy the closest existing scenario); declare
   `kind = "smoke"` only for a deliberately non-comparative contract.
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
