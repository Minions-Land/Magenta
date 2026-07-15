# Harness Package Interface

This directory documents the generic schema-v2 package shape. It is
intentionally README-only; concrete domain packages live in independent GitHub
repositories and may be loaded from a local root or a verified GitHub release.

```text
<package-root>/
  package.toml
  system-prompt/HcpServer.{mjs,js,ts}
  system-prompt/<source>/
    HcpMagnet.{mjs,js,ts}
    system-prompt.toml
    SYSTEM.md
  skills/<skill>/
    HcpServer.{mjs,js,ts}
    <source>/
      HcpMagnet.{mjs,js,ts}
      SKILL.md
  tools/<tool>/
    HcpServer.{mjs,js,ts}
    <source>/
      HcpMagnet.{mjs,js,ts}
      <tool>.toml
      <implementation-assets>
```

Rules:

- Use `schema_version = "magenta.package.v2"` and declare every component in
  the package-root `package.toml`.
- Every contributed Module has exactly one bare `HcpServer.mjs`,
  `HcpServer.js`, or `HcpServer.ts`; every Source has exactly one corresponding
  `HcpMagnet` role. Paths carry identity, while the named exported class names
  stay exactly `HcpServer` and `HcpMagnet`. Mixed compiled/source candidates in
  one role directory are rejected as ambiguous rather than ordered by priority.
- Resource magnets return `toResource()` with `contentPath` or inline content.
  Tool magnets return `toTool()`; their static `build()` uses the injected
  `HcpClientbuildtools` setting so the host can construct sandboxed products
  without replacing the package's real Source Magnet.
- Put tool implementations, runtimes, environments, locks, and tests under the
  owning `tools/<tool>/` directory.
- Tool `command` values may be absolute, a bare executable resolved through
  `PATH`, or a descriptor-relative path such as `./bin/server`; relative paths
  must remain inside the actual Package directory.
- Use component kinds such as `skill`, `tool`, `python-runtime`, `env`,
  `system-prompt`, and `append-system-prompt`.
- Platform-specific native commands may use `command_windows`,
  `command_macos`, or `command_linux`, with `command` as the fallback.
- A package may declare the same `kind:name` from different Sources; duplicate
  `kind:name:source` declarations are invalid. After Source selection, a later
  resolved `kind:name` address replaces the earlier one. Capability replacement
  is limited to known generated HCP slots in this MVP. Packages do not create a
  fourth HCP role.

For binary-oriented archives, prefer thin, self-contained ESM
`HcpServer.mjs`/`HcpMagnet.mjs` glue around process, MCP, or native payloads.
Downloading or placing an archive is not activation: the package must be
explicitly selected before it is assembled. Selected role glue runs in-process
as trusted local code and is not sandboxed; sandbox policy applies to adapted
Tool payloads.

The current schema intentionally defines no `hcp_role_abi`, signature, or
replacement-approval fields. ABI negotiation, archive/package signature
verification, and explicit approval policy for Capability replacement remain
follow-up protocol work.

The executable parser contract is
[`HarnessComponentProtocol/_magenta/packages/package-overlay-v2.ts`](../../../HarnessComponentProtocol/_magenta/packages/package-overlay-v2.ts).
