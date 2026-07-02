# Harness Governance Progress

Date: 2026-07-02

## Current Status

- Repository branch: `main`.
- Harness baseline before governance edits:
  - `cd harness && npm test`: 23 files, 174 tests passed.
  - `cd harness && npm run build`: passed.
- Governance files and a read-only structure check have been added.
- The former `harness/packages` module has been renamed to
  `harness/package-overlay` so the only package content root is the
  repository-level `packages/` directory.
- `packages/AutOmicScience` now uses profile-local `general/` and `task/`
  directories; the old internal `domain-harness/` and top-level `skills/`
  split has been removed.

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
- `harness/scripts/check-structure.mjs`
- `harness/scripts/inspect.mjs`
- `harness/scripts/lib/files.mjs`
- `harness/package-overlay/`
- `harness/test/README.md`
- `harness/test/package-overlay.test.ts`
- `npm run check:structure`
- `npm run inspect`

## Latest Verification

- `cd harness && npm run check:structure`: passed.
- `cd harness && npm run inspect`: passed.
- `cd harness && node scripts/inspect.mjs --json`: valid JSON; parsed
  registry/package tool summary successfully.
- `cd harness && npm test`: 23 files, 174 tests passed.
- `cd harness && npm run build`: passed.
- Empty `harness/packages` directory removed; `check:structure` rejects a
  second top-level packages root.

## Open Decisions

- Should `@magenta/memory` remain a separate workspace package, or become a
  pure harness module?
- Should `harness/index.ts` stay a single public barrel, or should it be split
  into stable public exports plus internal module exports?
- Should catalog assembly for migrated process tools be promoted into a CLI
  command, or stay selector/TUI-oriented for now?
