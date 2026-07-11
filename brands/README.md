# Brand build configuration

`brands/` contains build-time product metadata used by
[`scripts/sync-brand.mjs`](../scripts/sync-brand.mjs). It is not a runtime
plugin registry and it does not add an HCP role.

```text
brands/
  registry.toml
  brand.interface.ts
  magenta/magenta.brand.ts
  pi/pi.brand.ts
  template/template.brand.ts
```

`registry.toml` selects one named configuration. The active configuration is
currently `magenta`.

## What synchronization changes

Run the script from the repository root:

```bash
npm run sync-brand -- --dry-run
npm run sync-brand
npm run sync-brand -- --brand=pi --dry-run
```

The script synchronizes the fields that are wired today:

- root, Harness, memory, and Pi workspace package versions;
- package names and internal dependency versions;
- `pi/coding-agent/package.json` `piConfig` and npm binary name;
- the standalone binary output name in the coding-agent build script.

It does not currently generate runtime themes, rewrite documentation, or apply
the configured welcome text and URLs. Treat those fields as source metadata
until code explicitly consumes them. `infra.harnessVersion` is also
informational today: the sync script versions `@magenta/harness` with the
selected product version.

Always inspect the resulting diff. A real synchronization changes tracked
package manifests, so follow it with:

```bash
npm install
npm run build
npm run check
```

## Adding a configuration

1. Copy `brands/template/` to `brands/<name>/`.
2. Rename and edit `<name>.brand.ts` so it exports `BRAND_CONFIG` satisfying
   `BrandConfig`.
3. Add the path to `brands/registry.toml`.
4. Preview with `npm run sync-brand -- --brand=<name> --dry-run`.
5. Run the synchronization only after reviewing the preview and expected
   package-name changes.

Changing brand metadata is a build operation. It does not change the HCP
runtime law: `HcpClient -> HcpServer -> HcpMagnet`.
