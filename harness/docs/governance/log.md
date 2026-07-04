# Harness Governance Log

## 2026-07-02

### User Direction Captured

- Manage `/Users/mjm/Magenta3/harness` better; it currently feels too messy.
- The review should understand the whole Magenta3 repository, not only
  `harness/`.
- Use the five-sentence loop philosophy:
  gather/reason/act/verify/repeat, role separation, disk state, restart/delete
  when wrong, expose the next bottleneck.
- Reference ModernTSF's registration mechanism, but adapt it to Magenta3.
- Do not use `codex-agent-team`.
- Use true terminal verification; Playwright is only relevant when browser UI
  needs verification.
- Package contents must converge on one root only:
  `/Users/mjm/Magenta3/packages`. The harness-side implementation is named
  `harness/assembly/package-overlay` because it is a loader/adapter module, not another
  package content root.

### Local Evidence

- `harness` tracked source file count: 196 files.
- `harness` current terminal baseline:
  - `npm test`: 23 test files, 174 tests passed.
  - `npm run build`: passed.
- `git status --short --branch` before adding governance docs: `## main`.
- Root `tsconfig.json` maps `@magenta/harness` to `./harness/index.ts` and
  `@magenta/memory` to `./harness/memory/pi/index.ts`.
- `pi/coding-agent/src/core/resource-loader.ts` is the app assembly point for
  harness package overlays.
- `pi/coding-agent/src/cli/args.ts` accepts `--harness-package`.
- `pi/coding-agent/src/modes/interactive/interactive-mode.ts` loads harness
  registry state for `/harness` menu and catalog display.

### ModernTSF Reference Notes

- Repository reviewed locally at `/tmp/ModernTSF`.
- Registry pattern:
  - singleton registry object per kind
  - name-to-module map
  - module-level `register()`
  - schema attached to registered component
  - lazy registration from validated config
- Config pattern:
  - TOML-first configs
  - `extends` deep merge
  - sweep expansion
  - Pydantic validation
- Tooling pattern:
  - `tool/tsf.py` is a single entry for scaffold, inspect, smoke, run, report
  - new component scaffolding generates code, schema, config, registry entry,
    and smoke config together

### Adaptation For Magenta3

- Keep Magenta3's TOML registry and package overlay model.
- Do not replace `harness.toml` with a TypeScript name map.
- Add the missing closed-loop pieces:
  - structure check
  - inspect command
  - scaffold command
  - smoke command for runtime/Magnet/package paths
- Keep HCP/Magnet as the shared abstraction for different languages and
  runtimes.

### Package Root Decision

- `packages/` at the repository root is the only place for actual Magenta3
  domain/brand/harness overlay packages such as `AutOmicScience`.
- `harness/assembly/package-overlay/` owns discovery, profile expansion, resource path
  resolution, and descriptor handoff into Magnet.
- A top-level `harness/packages/` directory is invalid because it creates a
  second "packages" concept and obscures the HCP/Magnet boundary.
- Package overlay is governed as assembly because it is a heuristic,
  precedence-aware discovery and assembly process over repository-level
  `packages/`, not package content itself.

### Package Internal Layout Decision

- Domain packages should prefer a flat package-root layout: `skills/` for
  selectable knowledge modules and `tools/<tool>/` for tool descriptors plus
  tool-owned implementation assets.
- Do not add a `domain-harness/` wrapper inside package contents; it duplicates
  the package's `kind = "domain"` meaning.
- Skills should be named directly by capability, for example
  `skills/omics-shared`, `skills/rna`, `skills/spatial`,
  `skills/scatac-seq`, and `skills/multi-omics`.
- Shared implementation assets should be owned by the package capability they
  implement. For AutOmicScience, the user-facing tool is `omics_compute`, and
  its Python implementation lives under `tools/omics-compute/python/`. Root
  `[[components]]` in `package.toml` can still declare the implementation entry
  points (`python-runtime`, tests, env) for package overlay assembly.
- Pixi environment management is modeled as a package tool capability:
  `tools/omics-environment/` owns `pixi.toml`, `pixi.lock`, and the
  declarative `omics_environment` descriptor.

### Package Template And Runtime Cleanup

- Planner: `packages/` should be the only package content root, and templates
  must teach the package-root component model instead of creating another
  `domain-*` wrapper concept.
- Generator: moved AutOmicScience Python implementation/test assets from
  `general/.omics-runtime` into the package-root tool slot
  `tools/omics-compute/python`, moved implementation/env/test declarations into
  root `package.toml` components, and replaced
  `packages/templates/domain-package` with `packages/templates/harness-package`.
- Evaluator: structure/build/test/inspect passed; package overlay tests passed;
  a copied template overlay assembled successfully; an assembled
  `omics_compute` Magnet executed `python3 -m aose_omics_runtime --help`
  through the tool-owned Python implementation.

### Package Flattening Decision

- Planner: AutOmicScience should not use nested `general/` or `task/` harness
  wrappers because the package itself already names the domain. Modality
  choices should be flat skills, not profile directories.
- Generator: moved skills to package-root `skills/`, removed the
  AutOmicScience profile harness files, moved Pixi files under
  `tools/omics-environment/`, and made `package.toml` declare all skills/tools
  as root components.
- Evaluator: structure and package overlay checks enforce the flat package
  layout for repository packages and the template package.

### Harness Module Assembly Decision

- A harness module directory is a capability slot.
- Source subdirectories under a capability slot represent mature-agent harness
  implementations such as `pi`, `codex`, `jcode`, and `claude-code`; they are
  not merely programming language folders.
- Source names are origin Agent names. Magenta or Magenta1 material uses
  `magenta`, not `magenta-native`, `rust`, `process`, or `package`.
- HCP is the unified management protocol for discovery, selection, state,
  health, and configuration.
- Magnet is the non-invasive bridge that attaches a concrete mature-agent
  implementation to Magenta3 without rewriting that implementation's native
  code or logic.
- `process` is not a capability slot or Source. Magenta process-backed tool
  material belongs under the functional tool slot and origin Source, for example
  `harness/tools/bash/magenta/` or `harness/tools/grep/magenta/`.
- The same rule applies outside `tools`: Magenta/Magenta1 runtime guardrails,
  sandbox profiles, hooks, policies, workspace context, session-grounding
  memory, HCP-process manifests, and catalog inventory live under their owning
  Module's `magenta/` Source directory.
- Old registry kinds such as `sandbox-pack`, `runtime-pack`, `hook-pack`,
  `policy-pack`, and `hcp-process-pack` are deprecated. The Harness Module kind
  should be the capability slot itself: `sandbox`, `runtime`, `hook`, `policy`,
  or `hcp-process`.

### Module Assembly Loop Checkpoint

- Planner: recorded `harness/docs/governance/module-layout-plan.md` as the
  current contract for capability slots, implementation sources, HCP, Magnet,
  TUI, and CLI.
- Generator: added registry-backed module descriptors, registered `messages`
  and `types` as read-only contract modules, added TUI `Modules` inspection, and
  added CLI `--harness-list`.
- Evaluator: ran structure, inspect, harness tests/build, coding-agent
  tests/build, and actual CLI list commands. All verification commands exited 0.
- Current boundary: module/implementation selection is visible and inspectable,
  but alternate implementation switching is not yet active until Magnet
  selection contracts are implemented.

### Tool Capability Folding Decision

- Planner: top-level `harness/tools/<name>` means a selectable tool capability
  slot, not every migrated Magenta1 process manifest. Sub-operations must live
  under the owning tool Source directory.
- Generator: folded `edit-hashline` and `ast-edit-plan` into
  `tools/edit/magenta/`, `read-anchored` and `read-url` into
  `tools/read/magenta/`, `glob` and `fuzzy-find` into `tools/find/magenta/`,
  and `ast-grep` into `tools/grep/magenta/`. Removed `tools/support` by moving
  shared utilities to `utils/pi`; moved `echo-json` to a test fixture manifest.
- Evaluator: structure/build/test/inspect passed; coding-agent build/test and
  CLI `--harness-list` passed; Rust release builds passed for the folded owner
  crates; direct process-tool smokes passed for `glob`, `ast-grep`, and
  `read-anchored`.

### Non-Tool Layout Cleanup Decision

- Planner: apply the same Module -> Source rule outside `tools`. Top-level
  directories must either be registered Harness Modules/core assembly containers
  or explicit support/output locations.
- Generator: removed the empty top-level `mcp/` placeholder, moved the scaffold
  template from `template/` to `scripts/templates/module/`, and moved bundled
  Harness skills from `skills/bundled` to the owning `skills/pi/bundled`
  implementation source. Updated build/copy paths and structure checks to
  reject the old locations.
- Evaluator: harness structure/build/test/inspect passed; coding-agent build,
  focused resource-loader/skills tests, full coding-agent tests, and
  `--harness-list` text/JSON passed.

## 2026-07-04

### Directory rename: `assembly/` → `hcp/`

- Decision: the directory formerly named `assembly/` contains, in its entirety,
  the HCP mechanism (registry, magnet, hcp client/server, package-overlay,
  hcp-process). Renamed the directory to `hcp/` so the name reflects the
  mechanism. Pure path rename; the `kind = "assembly"` component label is a
  semantic role, not a path, so module ids remain `assembly/hcp`,
  `assembly/magnet` (CORE_EXCEPTION_MODULE_IDS unchanged).
- `scripts/` and `utils/` deliberately kept at top level: `scripts/` is
  build/lint tooling (the structure-check referee, cross-module); `utils/` is a
  runtime shared library reused by 8 tools. Neither belongs inside the HCP
  mechanism.

### Tool Search promoted to top-level `tools-search/`

- Moved `tool-search` out of `assembly/` into its own top-level module
  `harness/tools-search/`. Tool Search is a Harness capability in its own right
  (an aggregator above the per-tool magnets: enumerate cheap name+description
  metadata, materialize full schemas on demand), not assembly-time wiring — the
  first concrete instance of the broader Harness Search idea.

### Docs cleanup — superseded governance/status files removed

- Deleted as fully superseded by `hcp-architecture.md` (authoritative) +
  `hcp-rollout-progress.md` (live tracker):
  `hcp-capability-resolver-contract.md` (self-declared SUPERSEDED, old resolver
  model + retired HcpTarget/HcpRegistry names), `progress.md` (second progress
  tracker competing with rollout-progress), `module-layout-plan.md` (its
  `assembly/` open questions are resolved by the rename), and repo-root
  `HCP_MAGNET_STATUS.md` / `HCP_MAGNET_SUMMARY.md` (7/3 codex-session snapshots
  absorbed into the authoritative docs).
- Kept: `hcp-architecture.md`, `hcp-rollout-progress.md`, `contract.md`
  (refreshed `assembly/` → `hcp/` paths), this `log.md` (append-only history),
  and the `docs/design/` extension-migration records (self-marked Complete/Archived).
