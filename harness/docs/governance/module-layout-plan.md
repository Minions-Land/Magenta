# Harness Module Layout Plan

Date: 2026-07-02

This plan records the target layout for `harness/` after reviewing
`harness/README.md`, `harness/harness.toml`, the TUI `/harness` menu, and the
CLI flags. The key model is not only "registered modules"; it is a
self-assembling agent harness that can break mature agent harness systems into
capability-level pieces and recombine them.

## User Contract

- HCP is the unified management protocol for discovery, configuration, health,
  state, and selection.
- Magnet is the bridge that attaches a concrete mature-agent implementation to
  the HCP-managed capability without rewriting that implementation's native
  code, language, or logic.
- Every other runtime/capability directory under `harness/` should be modeled as
  a Harness Module capability slot.
- Harness Modules should be visible through the `/harness` TUI surface and have
  an equivalent CLI selection or inspection path for their implementation
  source.
- Support-only directories should be explicitly marked as support and should not
  be confused with selectable modules.

## Core Mental Model

Magenta3 should be able to decompose mature agent harnesses into loose,
capability-level parts and reassemble them. A module directory is therefore a
stable capability slot; its source subdirectories are mature-agent
implementations of that slot. Source names are origin Agent names, not
language/runtime labels. Magenta and Magenta1 material uses `magenta`; Pi
material uses `pi`; future Codex, JCode, and Claude Code material should use
`codex`, `jcode`, and `claude-code`.

Example:

```text
harness/tools/bash/
  bash.toml
  pi/
  magenta/
  codex/
  jcode/
  claude-code/
```

The same pattern should apply beyond tools:

```text
harness/memory/
  memory.toml
  pi/
  codex/
  claude-code/

harness/system-prompt/
  system-prompt.toml
  pi/
  codex/
  jcode/
```

The assembly flow is:

```text
capability slot -> source implementation -> Magnet -> HCP-managed module row -> agent runtime surface
```

This lets Magenta3 assemble combinations such as:

- `tool/bash = codex`
- `tool/edit = pi`
- `memory = claude-code`
- `system-prompt = jcode`
- `session = pi`
- `compaction = codex`

## Current Evidence

- `npm run check:structure`: passed.
- `npm run inspect`: 32 registered components/modules, 1 catalog, and 1
  discovered package overlay.
- The TUI `/harness` menu has current runtime actions for Tools, Compaction,
  Skills, Hooks, Memory, Registry, and Catalog, plus a registry-driven
  `Modules` group for inspecting every registered capability slot and
  implementation source.
- The CLI has `--harness-package` for package profiles and `--harness-list` for
  registry-backed module inspection, but no general `--harness-module`,
  `--harness-impl`, or `--harness-disable` switching yet.
- `listHarnessSelectionItems()` flattens catalog entries, not built-in
  `harness.toml` modules.
- `packages/AutOmicScience` now keeps skills and tools flat under package-root
  `skills/` and `tools/<tool>/` directories, with no `general/` or `task/`
  wrappers.

## Current Mismatches

1. The README says every implementation module follows
   `<module>/<module>.toml`, source-separated implementation directories, and a
   README. Several real modules now follow this, but the source directories are
   currently mostly treated as code origin (`pi`) rather than mature-agent
   implementation choices (`pi`, `codex`, `jcode`, `claude-code`, etc.).
2. `assembly/` mixes core exceptions (`hcp`, `magnet`) with selectable or
   inspectable modules (`registry`, `hcp-process`).
3. `messages/` and `types/` are documented as flat contract modules and are not
   registered. Under the user contract, they should still appear as read-only
   Harness Modules, even if they are not runtime-switchable.
4. `mcp/` was documentation-only and has been removed from the module root.
   Future MCP support should enter as adapter/runtime detail under an owning
   Module Source implementation.
5. Magenta process-tool code must live under its functional module/source
   directory, not as a harness top-level folder or `tools/process` slot.
6. `docs/`, `scripts/`, `test/`, generated `dist/`, `node_modules/`, and Rust
   `target/` are support/output directories. They should be excluded from module
   selection by rule, not by accident.
7. The scaffold template is not a runtime module and now lives under
   `scripts/templates/module/`.

## Target Model

Use three explicit classes:

1. Core assembly exceptions:
   - `assembly/hcp`
   - `assembly/magnet`
2. Harness Modules:
   - Any capability, contract, runtime, registry, package overlay, catalog, or
     tool pack that can be shown in `/harness`.
   - Must have a TOML descriptor, README, registry entry, selector metadata, and
     implementation-source rows.
   - Implementation sources represent mature agent harness origins, not only
     programming languages or runtime technologies.
   - Repository package overlays use the same idea one level up: package-owned
     skills/tools and implementation assets are root `[[components]]` in
     `package.toml`; optional profiles exist only for packages that genuinely
     need resource subsets.
3. Support/output:
   - Development docs, scripts, tests, templates, generated outputs, and local
     dependency/build directories.
   - Must be excluded by structural rules and should be named or documented as
     support.

## Module Inventory Target

Built-in module rows should be generated from HCP/registry descriptors, not
hardcoded in the TUI:

- `tool:*`: selectable enabled/disabled AgentSession tools with selectable
  implementation source (`pi`, `codex`, `jcode`, `claude-code`, package, etc.).
- `compaction`, `skills`, `hooks`, `memory`: existing TUI categories, generated
  from registry data.
- `runtime`, `sandbox`, `policy`, `context`, `env`, `session`,
  `system-prompt`, `prompt-templates`, `loop`, `utils`: currently registered but
  not surfaced as first-class `/harness` module rows or implementation choices.
- `catalog`, `registry`, `hcp-process`:
  inspectable module rows; some are not runtime-switchable.
- `messages`, `types`: register as `contract` modules and show as read-only.
- MCP: no top-level placeholder until an actual capability exists. MCP-backed
  behavior belongs under the owning Module's Source directory and Magnet.

## CLI Target

Add a CLI mirror for the TUI surface:

- `--harness-module <selector>`: enable/load a module or package profile.
- `--harness-impl <module=source>`: choose one implementation source for a
  capability slot, for example `tool/bash=codex` or `memory=claude-code`.
- `--no-harness-module <selector>`: disable a module when runtime-switchable.
- `--harness-list`: print built-in modules, package overlays, and catalog
  candidates.
- Keep `--harness-package <selector>` as a compatibility alias for
  `--harness-module package:<selector>`.

## TUI Target

Replace most hardcoded `/harness` categories with registry-driven rows:

- Built-in modules from HCP/registry module descriptors.
- Implementation choices under each module row.
- Package overlays from `loadPackageOverlay()` discovery.
- Catalog candidates from `listHarnessSelectionItems()`.
- Each row should expose:
  - status: active, registered, inspect-only, deferred, missing, or unsupported
  - source: pi, magenta, codex, jcode, claude-code, contract, or another
    origin-agent name
  - runtime metadata: native TypeScript, Rust process, Python, script, MCP,
    package overlay, or catalog-backed
  - actions: choose implementation, enable, disable, inspect, smoke, or explain
    why not switchable

## Migration Order

1. Add a `HarnessModuleDescriptor` / `HarnessImplementationDescriptor` view
   model in the HCP/registry layer that merges: `harness.toml` components,
   implementation-source directories, tool activation state, package overlays,
   and catalog selector entries.
2. Make each Magnet declare which capability slot and source implementation it
   attaches, and whether it can produce an AgentTool, provider, prompt builder,
   memory backend, or inspect-only HCP target.
3. Extend `harness inspect --json` to emit the same module and implementation
   rows the TUI should render.
4. Refactor the TUI `/harness` menu to render from descriptor rows, keeping
   existing tool/compaction/skills actions as row actions.
5. Add CLI list/select flags against the same descriptor model. `--harness-list`
   is implemented; selection flags are still pending.
6. Register `messages` and `types` as read-only contract modules.
7. Done: removed the empty `mcp/` placeholder and moved the scaffold template to
   `scripts/templates/module/`.
8. Decide whether `assembly/registry` and `assembly/hcp-process` stay under
   `assembly/` or move to top-level module directories for clearer parity with
   README module layout.
9. Add `harness smoke <selector>` after rows are stable.

## Non-Goals For The First Migration

- Do not move HCP or Magnet into the selectable runtime path.
- Do not rewrite mature agent harness implementations just to match Magenta3's
  local style. Adapt them with a custom Magnet.
- Do not make every registered component toggleable. Some modules are
  inspect-only or read-only contracts.
- Do not delete catalog metadata just because it is not loop-ready.
