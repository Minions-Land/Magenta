# Package Integration Boundary

This directory is the Magenta3-side integration boundary for domain expert
packages. It intentionally contains no concrete domain package.

Concrete packages will be maintained and published in independent GitHub
repositories. Magenta3 does not vendor their content. A future acquisition
layer will own download, version selection, verification, and caching; the
current integration only consumes a package root that is already present
locally.

The reusable Package parsing and overlay interface remains in
[`HarnessComponentProtocol/_magenta/packages/package-overlay.ts`](../HarnessComponentProtocol/_magenta/packages/package-overlay.ts).
[`HcpClientpackageinputfromoverlay()`](../HarnessComponentProtocol/_magenta/packages/hcp-client-components.ts)
maps selected declarations to ordinary HcpClient component inputs before they
enter generic HCP assembly.
Its contract is covered by temporary-package fixtures in the Harness test
suite. External roots enter through `packagesRoot`; Pi exposes the same
boundary as `DefaultResourceLoaderOptions.harnessPackagesRoot` and the CLI flag
`--harness-packages-root <dir>`. When no override is supplied, the low-level
API falls back only to `<repoRoot>/packages` and the coding-agent checks
`<current-workspace>/packages`. This repository fallback contains the contract
and template, not concrete domain Packages. None of these paths make Package a
new HCP role or scan a fixed sibling checkout.

See [`templates/harness-package/README.md`](./templates/harness-package/README.md)
for the generic manifest shape.
