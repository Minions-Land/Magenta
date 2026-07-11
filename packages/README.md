# Package Integration Boundary

This directory is the Magenta3-side integration boundary for domain expert
packages. It intentionally contains no concrete domain package.

Concrete packages are independently published from GitHub repositories.
Magenta3 does not vendor their content. A future acquisition layer will own
download, version selection, verification, and caching; the current integration
only consumes a package root that has already been downloaded locally.

The reusable Package parsing and overlay interface remains in
[`HarnessComponentProtocol/_magenta/packages/package-overlay.ts`](../HarnessComponentProtocol/_magenta/packages/package-overlay.ts).
[`HcpClientpackageinputfromoverlay()`](../HarnessComponentProtocol/_magenta/packages/hcp-client-components.ts)
maps selected declarations to ordinary HcpClient component inputs before they
enter generic HCP assembly.
Its contract is covered by temporary-package fixtures in the Harness test
suite. Local roots enter explicitly through `packagesRoot`; Pi exposes the
same boundary as `DefaultResourceLoaderOptions.harnessPackagesRoot` and the CLI
flag `--harness-packages-root <dir>`. None of these paths make Package a new HCP
role or depend on a fixed sibling Package checkout.

See [`templates/harness-package/README.md`](./templates/harness-package/README.md)
for the generic manifest shape.
