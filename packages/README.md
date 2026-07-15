# Package Integration Boundary

This directory is Magenta's integration boundary for domain expert
packages. It intentionally contains no concrete domain package.

Concrete packages are maintained and published in independent GitHub
repositories. Magenta does not vendor their content. The coding-agent host can
acquire a platform-specific `github:owner/repo/Package@version` release,
SHA-256 verify and validate it, and pass its cached package root to this
integration boundary. Local roots use the same boundary.

The reusable Package parsing and overlay interface remains in
[`HarnessComponentProtocol/_magenta/packages/package-overlay-v2.ts`](../HarnessComponentProtocol/_magenta/packages/package-overlay-v2.ts).
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

A schema-v2 role may be supplied as exactly one `.mjs`, `.js`, or `.ts` file;
mixed source and compiled candidates for one role are rejected as ambiguous.
Binary archives should prefer thin, self-contained ESM `HcpServer.mjs` and
`HcpMagnet.mjs` glue around process, MCP, or native payloads. Merely placing or
extracting a package does not execute it: it must be explicitly selected before
ordinary HCP assembly sees its components. Selected role glue is trusted local
in-process code, not sandboxed code. Capability packages can replace only known
HCP slots in this MVP.

No `hcp_role_abi`, package-signature, or replacement-approval manifest fields
are defined yet. Those security and compatibility contracts require follow-up
protocol work rather than speculative fields in the current schema.

See [`templates/harness-package/README.md`](./templates/harness-package/README.md)
for the schema-v2 HCP-isomorphic shape.
