# Harness Governance Contract

Date: 2026-07-02

This contract records how Magenta3 harness should be managed while HCP, Magnet,
package overlays, process runtimes, and UI selection keep evolving.

## Operating Principles

1. The loop matters more than the prompt: harness work must follow gather,
   reason, act, verify, repeat.
2. Roles stay separate even in one coding session:
   - Planner defines contracts, invariants, migration order, and success gates.
   - Generator edits code, docs, scripts, or tests against the contract.
   - Evaluator checks behavior with terminal evidence and records gaps.
3. Long-running state lives on disk. Use this directory for durable contract,
   progress, and log records instead of relying on chat context.
4. Restarting or deleting harness code is allowed when evidence shows the
   abstraction is wrong or obsolete. Do not preserve scaffolding just because it
   exists.
5. The current bottleneck must be made visible. Planning, implementation,
   verification, and taste can each become the weak point; the governance loop
   should expose the next one.

## Architectural Invariants

- HCP is the management, discovery, and control plane. It is not the tool
  execution hot path.
- Magnet is the adapter boundary. Any native TypeScript, process, Python,
  script, MCP, API, Rust, or future runtime integration must converge into the
  Magnet contract before reaching the agent loop.
- `runtime://process` is the shared process execution boundary. Package process,
  Python, HCP JSONL, and script-backed tools must not bypass its sandbox and
  policy checks.
- Repository-level `packages/` is the only package content root. The harness
  module for package discovery and profile expansion is `harness/assembly/package-overlay`;
  there must not be a second content root under `harness/packages`.
- Harness Source names are origin-agent names, not programming languages or
  runtime mechanisms. Magenta/Magenta1-related material uses `magenta`; Pi uses
  `pi`; future Codex and Claude Code material should use `codex` and
  `claude-code`.
- A registered non-contract component that declares a known Source such as
  `source = "magenta"` or `source = "pi"` must have the corresponding Source
  directory beside its descriptor. Runtime mechanisms and grouped "pack" labels
  must not stand in for Module kinds or Source names.
- Process-backed tools are still tools. Their manifests, adapter code, Rust
  crates, and local build artifacts must live under the owning capability source,
  for example `harness/tools/ast-grep/magenta/process-tools`; a shared
  `harness/tools/process` capability slot is invalid.
- `pi/coding-agent` owns app composition, CLI/TUI surfaces, and ResourceLoader.
  It should consume harness through package-level APIs and should not deep-import
  harness internals.
- `harness/harness.toml` is the built-in component index. Catalogs are selector
  inventories; components are assembled capabilities.

## Management Model

Manage `harness/` as four layers:

1. Protocol and assembly:
   `assembly/hcp`, `assembly/magnet`, `assembly/registry`,
   `assembly/package-overlay`.
2. Runtime guardrails:
   `runtime`, `sandbox`, `policy`, `hooks`.
3. Capability modules:
   `tools`, `skills`, `prompt-templates`, `system-prompt`, `compaction`,
   `session`, `context`, `memory`, `env`, `utils`.
4. Resource and catalog overlays:
   `catalog`, `skills/bundled`, repository-level `packages/`.

New functionality must declare which layer it belongs to before code is added.

## ModernTSF Lessons To Borrow

ModernTSF's useful pattern is a closed loop:

- declarative TOML config
- typed validation/schema
- registry entry
- scaffold tool for new components
- inspect/smoke command for verification
- agent-facing docs that point to the same tools

For Magenta3, do not copy ModernTSF's Python `NAME_MAP` pattern directly.
Magenta3 already has TOML discovery through `harness.toml`, package overlays,
and `ResourceLoader`. Borrow the closed-loop discipline instead:

- `harness inspect` should explain what is registered and what is executable.
- `harness check:structure` should detect drift between TOML, files, exports,
  docs, and package overlays.
- `harness scaffold` should create a module/tool/package profile with TOML,
  README, test stub, and registry entry together.
- `harness smoke` should verify a selected package/tool path through the same
  runtime boundary used by the app.

## Verification Gates

For documentation-only governance changes:

- `git status --short --branch`
- Review changed files.

For harness code, registry, runtime, package, or Magnet changes:

- `cd harness && npm test`
- `cd harness && npm run build`

For app assembly, CLI, TUI, or ResourceLoader changes:

- `cd pi/coding-agent && npm test`
- `cd pi/coding-agent && npm run build`

For UI behavior, use Playwright only when a browser or rendered frontend is
actually involved. For this terminal/TUI harness governance work, terminal
verification is the source of truth.
