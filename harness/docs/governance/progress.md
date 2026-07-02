# Harness Governance Progress

Date: 2026-07-02

## Current Status

- Repository branch: `main`.
- Harness baseline before governance edits:
  - `cd harness && npm test`: 23 files, 174 tests passed.
  - `cd harness && npm run build`: passed.
- Governance files and a read-only structure check have been added.
- Package overlay assembly lives under `harness/assembly/package-overlay`, so
  the only package content root is the repository-level `packages/` directory.
- Harness Source names now mean origin Agent names. Magenta/Magenta1-related
  implementation material uses `magenta`.
- Process-backed Magenta tool implementations are owned by their functional
  tool slots, for example `harness/tools/read/magenta/`; `harness/tools/process`
  and root-level `harness/process-tools` are invalid.
- Folded tool sub-operations are now owned by their real capability slots:
  `edit-hashline` and `ast-edit-plan` under `tools/edit/magenta/`,
  `read-anchored` and `read-url` under `tools/read/magenta/`, `glob` and
  `fuzzy-find` under `tools/find/magenta/`, and `ast-grep` under
  `tools/grep/magenta/`.
- `harness/tools` now contains only tool slots with matching `<tool>.toml`
  descriptors. Shared support code moved to `harness/utils/pi/`; the
  `echo-json` smoke manifest moved to `harness/test/fixtures/process-tools/`.
- Non-tools Magenta/Magenta1 implementations have been moved under Module-local
  `magenta/` Source directories: `runtime`, `sandbox`, `hooks`, `policy`,
  `context`, `memory/session-grounding`, `catalog`, and `assembly/hcp-process`.
- Old `*-pack` component kinds have been replaced by capability kinds such as
  `sandbox`, `runtime`, `hook`, `policy`, and `hcp-process`.
- `packages/AutOmicScience` now uses profile-local `general/` and `task/`
  directories; the old internal `domain-harness/` and top-level `skills/`
  split has been removed.
- Harness module assembly work has started: registry descriptors now need to
  model capability slots plus mature-agent implementation sources.

## Completed Investigation

- Audited `harness/` structure, top-level modules, generated directories, tests,
  build script, README files, registry TOML, and public barrel exports.
- Audited Magenta3 root workspace layout, root `tsconfig` aliases, root build and
  check scripts, `pi/coding-agent` ResourceLoader, CLI package selection, and TUI
  harness menu flow.
- Confirmed package overlays enter the app through:
  `DefaultResourceLoader -> loadPackageOverlay -> assemblePackageToolMagnets ->
  Magnet -> AgentTool`.
- Confirmed CLI selection exists through `--harness-package` and environment
  variables `MAGENTA_HARNESS_PACKAGES` / `PI_HARNESS_PACKAGES`.
- Confirmed TUI harness status/registry/catalog menu currently uses
  `loadRegistry()` and `listHarnessSelectionItems()`.
- Cloned and reviewed `/tmp/ModernTSF` for reference. Its registry discipline is
  "TOML config + schema + registry + scaffold + inspect/smoke", not just a
  runtime registry map.

## Findings

- `harness/` is functionally green but operationally noisy: generated `dist`,
  `node_modules`, Rust `target`, and `memory/dist` are present locally but not
  git-tracked.
- `harness/index.ts` exports a broad internal surface; this is convenient but
  weakens the public/internal boundary.
- `harness/package.json` has a long asset-copy build command that is easy to
  forget when modules are added.
- Tests are flat under `harness/test`, while the code now spans assembly,
  runtime, package overlays, tools, session, compaction, and resources.
- Some docs have drifted from implementation details, for example `memory`
  documentation describing `memory/src` while implementation is under
  `memory/pi`.
- `memory` currently has both independent package identity and root harness
  exports; this should be explicitly governed before further expansion.

## Recommended Next Steps

1. Add `harness smoke` for selected package/tool paths through the same Magnet
   and `runtime://process` boundary used by the app.
2. Split the asset-copy build step into a small script with explicit copy rules.
3. Add a scaffold command for harness modules/tools/package profiles.
4. Keep extending `harness inspect` until it mirrors the TUI registry/catalog
   view and reports package diagnostics in the same terms.
5. Only after checks are in place, consider moving tests into grouped
   subdirectories.

## Added In This Pass

- `harness/docs/governance/contract.md`
- `harness/docs/governance/progress.md`
- `harness/docs/governance/log.md`
- `harness/docs/governance/module-layout-plan.md`
- `harness/scripts/check-structure.mjs`
- `harness/scripts/inspect.mjs`
- `harness/scripts/lib/files.mjs`
- `harness/assembly/package-overlay/`
- `harness/test/README.md`
- `harness/test/package-overlay.test.ts`
- `npm run check:structure`
- `npm run inspect`

## Module Assembly Implementation Started

- `loadRegistry()` now includes `modules`, a descriptor view over registered
  capability slots and mature-agent implementation sources.
- `harness inspect` now prints and emits JSON module rows, including source
  implementation states such as `pi:ready`, `contract:inspect-only`, and HCP /
  Magnet `core-exception`.
- `messages` and `types` are registered as read-only `contract` modules.
- The TUI `/harness` menu now includes a registry-driven `Modules` group so
  every registered capability slot can be inspected with its implementation
  sources. Existing switchable rows such as tools/compaction/skills still keep
  their current runtime actions.
- The coding-agent CLI now exposes `--harness-list`, with text and
  `--mode json` output backed by the same HCP registry module descriptors.
  Implementation selection remains intentionally inspect-only until Magnet
  selection contracts are wired.

## Latest Verification

- `cd harness && npm run check:structure`: passed.
- `cd harness && npm run inspect`: passed; 32 components/modules, including 9
  tool modules, 28 ready modules, 2 read-only contract modules, and 2
  HCP/Magnet core exceptions.
- `cd harness && node scripts/inspect.mjs --json`: valid JSON; parsed
  registry/package tool summary and module implementation rows successfully.
- `cd harness && npm test`: 23 files, 174 tests passed.
- `cd harness && npm run build`: passed.
- `git diff --check`: passed.
- `cargo build --release --manifest-path ...`: passed for
  `tools/edit/magenta/process-tools`, `tools/read/magenta/process-tools`,
  `tools/find/magenta/process-tools`, and `tools/grep/magenta/process-tools`.
- Direct process-tool smoke checks passed from the new owner paths:
  `find/magenta ... glob`, `grep/magenta ... ast-grep`, and
  `read/magenta ... read-anchored`.
- Path audit confirmed no source `harness/tools/process`, no root
  `harness/process-tools`, no `harness/tools/support`, no folded tool
  sub-operation directories under `harness/tools`, and package overlay under
  `harness/assembly/package-overlay`.
- `cd pi/coding-agent && npm run build`: passed.
- `cd pi/coding-agent && node dist/cli.js --harness-list`: printed 32 registry
  module rows.
- `cd pi/coding-agent && node dist/cli.js --harness-list --mode json`: emitted
  registry-backed JSON for the same 32 module rows.
- `cd pi/coding-agent && npm test`: 155 files passed, 6 skipped; 1489 tests
  passed, 44 skipped. The visible npm 404 and git repository errors are
  expected negative-case test output; the command exited 0.
- Empty `harness/packages` directory removed; `check:structure` rejects a
  second top-level packages root.

## Open Decisions

- Should `@magenta/memory` remain a separate workspace package, or become a
  pure harness module?
- Should `harness/index.ts` stay a single public barrel, or should it be split
  into stable public exports plus internal module exports?
- Should catalog assembly for migrated process tools be promoted into a CLI
  command, or stay selector/TUI-oriented for now?
- Should the Magenta `process-tools` crate be split into per-tool minimal crates
  or kept duplicated under each tool Source until a shared-source packaging
  model exists? Do not reintroduce `tools/process`.
- Should `mcp/` and `template/` become deferred/scaffold modules, or move under
  support-only documentation?
- Should `assembly/registry` and `assembly/hcp-process` stay under
  `assembly/`, or move to top-level module directories while HCP/Magnet remain
  core exceptions?
