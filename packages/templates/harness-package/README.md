# Harness Package Interface

This directory documents the generic package shape. It is intentionally
README-only; concrete domain packages belong in the independently managed
MagentaPackages repository.

```text
<package-root>/
  package.toml
  system-prompt/
    system-prompt.toml
    SYSTEM.md
  skills/
    <capability>/SKILL.md
  tools/
    <tool>/
      <tool>.toml
      <implementation-assets>
```

Rules:

- Keep package components flat in the package-root `package.toml`.
- Put tool implementations, runtimes, environments, locks, and tests under the
  owning `tools/<tool>/` directory.
- Use component kinds such as `skill`, `tool`, `python-runtime`, `env`,
  `system-prompt`, and `append-system-prompt`.
- Register system prompts through a `system-prompt/*.toml` descriptor matching
  `HarnessComponentProtocol/system-prompt/system-prompt.toml`.
- A repeated `kind:name` replaces the earlier selected component; packages do
  not create a fourth HCP role.

The executable parser contract is
[`HarnessComponentProtocol/.HCP/overlay/package-overlay.ts`](../../../HarnessComponentProtocol/.HCP/overlay/package-overlay.ts).
