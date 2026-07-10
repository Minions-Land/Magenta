# Package Integration Boundary

This directory is the Magenta3-side integration boundary for domain expert
packages. It intentionally contains no concrete domain package.

Concrete packages are independently managed in the `MagentaPackages`
repository. Magenta3 does not copy or vendor their content, and it does not
hardcode that repository's checkout path.

The reusable Package parsing and overlay interface remains in
[`HarnessComponentProtocol/_magenta/packages/package-overlay.ts`](../HarnessComponentProtocol/_magenta/packages/package-overlay.ts).
Its contract is covered by temporary-package fixtures in the Harness test
suite. External roots enter explicitly through `packagesRoot`; Pi exposes the
same boundary as `DefaultResourceLoaderOptions.harnessPackagesRoot` and the CLI
flag `--harness-packages-root <dir>`. None of these paths make Package a new HCP
role.

See [`templates/harness-package/README.md`](./templates/harness-package/README.md)
for the generic manifest shape.
