# Brand Registry

Magenta3 keeps product identity in `brands/` and applies it to package metadata
with `scripts/sync-brand.mjs`. This is a build-time synchronization mechanism,
not a runtime plugin or HCP role.

## Layout

```text
brands/
  registry.toml              active brand and registered config paths
  brand.interface.ts         TypeScript shape of a brand config
  magenta/magenta.brand.ts   Magenta values
  pi/pi.brand.ts             Pi values
  template/template.brand.ts starting point for another brand
```

`brands/registry.toml` currently selects:

```toml
active = "magenta"
```

The active Magenta configuration supplies, among other values:

- product name: `Magenta`
- CLI binary: `magenta`
- config directory: `.magenta`
- product version: `0.0.1`
- Pi infrastructure version: `0.80.2`

Treat source files and package manifests as authoritative for current values;
do not copy version numbers into unrelated documents unless needed.

## Synchronization

Preview the active brand without writing files:

```bash
npm run sync-brand -- --dry-run
```

Apply it:

```bash
npm run sync-brand
npm install
npm run build
```

Preview another registered brand without changing `registry.toml`:

```bash
npm run sync-brand -- --brand=pi --dry-run
```

The script synchronizes:

- root and workspace package versions
- `@magenta/harness` and `@magenta/memory` package names
- Pi package names when `renamePiPackages` is enabled
- workspace dependency versions
- `pi/coding-agent/package.json` `piConfig` values
- the coding-agent binary name

It does not currently rewrite TUI theme source, welcome text, documentation, or
repository URLs. Fields present in `BrandConfig` are not necessarily wired into
every runtime surface.

## Version Layers

The configuration distinguishes product and infrastructure versions:

| Layer | Current owner |
|---|---|
| Product | Root package, `@magenta/harness`, and `@magenta/memory` |
| Infrastructure | Vendored `@earendil-works/pi-*` workspaces |

This lets the vendored Pi foundation track its upstream-compatible version
while Magenta-owned workspaces evolve under the product version. The CLI
`--version` value comes from the coding-agent package, so it currently reports
the infrastructure package version rather than a composite product report.

## Adding A Brand

1. Copy `brands/template/` to a new directory.
2. Rename and fill the `*.brand.ts` file using `BrandConfig`.
3. Add a matching `[[brands]]` entry to `brands/registry.toml`.
4. Run a dry synchronization and review every proposed manifest change.
5. Apply synchronization, update the lockfile with `npm install`, then build
   and test.

Example registry entry:

```toml
[[brands]]
name = "example"
path = "example/example.brand.ts"
description = "Example product brand"
```

## Contribution Rules

- Do not hand-edit synchronized manifest fields without updating or accounting
  for the brand source.
- Run `git diff` after synchronization; it can touch several package manifests.
- Keep provider/model behavior, Harness Sources, and runtime feature selection
  out of the brand registry.
- Do not treat brand names as HCP Source aliases unless an actual Source is
  declared under the Harness entity tree.
- Update placeholder URLs in a brand config before using it for distribution.

Implementation details and the full `BrandConfig` shape are documented in
[`../brands/README.md`](../brands/README.md).
