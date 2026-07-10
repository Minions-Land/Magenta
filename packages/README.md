# Package Integration Boundary

This directory is the Magenta3-side integration boundary for domain expert
packages. It intentionally contains no concrete domain package.

Concrete packages are independently managed in the `MagentaPackages`
repository. Magenta3 does not copy or vendor their content, and it does not
hardcode that repository's checkout path.

The reusable package parsing and overlay interface remains in
[`HarnessComponentProtocol/.HCP/overlay/package-overlay.ts`](../HarnessComponentProtocol/.HCP/overlay/package-overlay.ts).
Its contract is covered by temporary-package fixtures in the Harness test
suite. A future external-root integration can connect MagentaPackages through
that boundary without making a package a new HCP role.

See [`templates/harness-package/README.md`](./templates/harness-package/README.md)
for the generic manifest shape.
