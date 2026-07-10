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
- A source-owned HcpMagnet is the built-in adapter boundary. Native TypeScript,
  process, Python, script, MCP, API, Rust, or future runtime integrations must
  converge into one Tool, Capability, or Resource source product before reaching
  the agent loop; runtime technology does not create a Magnet subtype.
- Everything related to or helping HCP carries the `Hcp` prefix; `.HCP/`
  placement is not an escape hatch. Assembly, registry, overlay, and transport
  are infrastructure rather than Modules, and cannot own Servers or addresses.
- `_magenta/` contains host/shared Magenta support code. Its `session`, `env`,
  `messages`, `types`, and `utils` directories are not Harness Modules, Sources,
  contracts, or generated HCP entities.
- `HcpMagnetProcess` is an injectable JSONL transport for an owning source. It
  is not a Module, source role, or automatically assembled component.
- `runtime://process` is the shared process execution boundary. Package process,
  Python, and script-backed tools must not bypass its sandbox and policy checks.
  A source that explicitly injects `HcpMagnetProcess` must provide equivalent
  runtime policy and sandbox enforcement; the helper itself is not a default
  process Module.
- Repository-level `packages/` retains only the generic package contract and
  templates. Concrete domain expert packages are independently owned and
  versioned in `MagentaPackages`; Magenta3 must not vendor them or hardcode that
  repository's filesystem location. `HarnessComponentProtocol/.HCP/overlay` is
  the generic integration boundary for explicitly supplied package roots, not a
  second package owner.
- Harness Source names are origin-agent names, not programming languages or
  runtime mechanisms. Magenta/Magenta1-related material uses `magenta`; Pi uses
  `pi`; future Codex and Claude Code material should use `codex` and
  `claude-code`.
- A registered component that declares a known Source such as
  `source = "magenta"` or `source = "pi"` must have the corresponding Source
  directory beside its descriptor. Runtime mechanisms and grouped "pack" labels
  must not stand in for Module kinds or Source names.
- Process-backed tools are still tools. Their manifests, adapter code, Rust
  crates, and local build artifacts must live under the owning capability source,
  for example `HarnessComponentProtocol/tools/grep/magenta/process-tools`; a shared
  `HarnessComponentProtocol/tools/process` capability slot is invalid.
- Tool sub-operations are not separate top-level tool modules when they serve
  the same capability slot. For example `edit-hashline` and `ast-edit-plan`
  belong under `tools/edit/<source>/`, `read-anchored` and `read-url` under
  `tools/read/<source>/`, `glob` and `fuzzy-find` under `tools/find/<source>/`,
  and `ast-grep` under `tools/grep/<source>/`.
- `HarnessComponentProtocol/tools/<name>` is reserved for selectable tool capability slots with
  `tools/<name>/<name>.toml`. Shared utility code belongs under
  `HarnessComponentProtocol/_magenta/utils/<source>/`, not under `tools/support`.
- `pi/coding-agent` owns app composition, CLI/TUI surfaces, and ResourceLoader.
  It should consume harness through package-level APIs and should not deep-import
  harness internals.
- `HarnessComponentProtocol/harness.toml` is the built-in component index. Catalogs are selector
  inventories; components are assembled capabilities.
- Generated assembly has one Server map (`HCP_SERVERS`) and one Magnet list
  (`HCP_MAGNETS`). Consumers filter `HCP_MAGNETS`; they do not maintain derived
  Magnet lists or grant core/contract exceptions.
- Tools and skills retain both levels of real ownership: `tools/HcpServer.ts`
  and `skills/HcpServer.ts` are grouping Servers, and every registered tool or
  skill leaf owns its own `HcpServer.ts`.

## Management Model

Manage `HarnessComponentProtocol/` as four layers:

1. Protocol and assembly:
   `HcpClient` (agent-facing router) plus the `.HCP/` plumbing it uses
   (data types, assembly, registry, overlay, and explicit transports).
2. Runtime guardrails:
   `runtime`, `sandbox`, `policy`, `hooks`.
3. Capability modules:
   `tools` and its leaves, `skills` and its leaves, `prompt-templates`,
   `system-prompt`, `compaction`, `context`, `memory`, and `multiagent`.
4. Resource and catalog overlays:
   the repository-level package contract/templates and explicitly configured
   external selector inputs.

`_magenta/` is a separate host/shared support area, not a fifth management
layer and not a place to register pseudo Modules.

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
Magenta3 already has TOML discovery through `harness.toml`, a generic package
overlay boundary, and `ResourceLoader`. Borrow the closed-loop discipline
instead:

- `harness inspect` should explain what is registered and what is executable.
- `harness check:structure` should detect drift between TOML, files, exports,
  docs, and configured package inputs.
- `harness scaffold` should create a module or tool with TOML, README, test
  stub, and registry entry together. Package templates remain generic; domain
  package scaffolding belongs to `MagentaPackages`.
- `harness smoke` should verify a selected package/tool path through the same
  runtime boundary used by the app.

## Verification Gates

For documentation-only governance changes:

- `git status --short --branch`
- Review changed files.

For HarnessComponentProtocol code, registry, runtime, package, or Magnet changes:

- `cd HarnessComponentProtocol && npm run generate:hcp-sources -- --check`
- `cd HarnessComponentProtocol && npm run check:structure`
- `cd HarnessComponentProtocol && npm run build`
- `cd HarnessComponentProtocol && npm test`

For app assembly, CLI, TUI, or ResourceLoader changes:

- `cd pi/coding-agent && npm test`
- `cd pi/coding-agent && npx tsgo --noEmit`
- `cd pi/coding-agent && npm test`

For UI behavior, use Playwright only when a browser or rendered frontend is
actually involved. For this terminal/TUI harness governance work, terminal
verification is the source of truth.
