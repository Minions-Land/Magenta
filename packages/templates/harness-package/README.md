# Harness Package Template

This directory is intentionally README-only.

Create new packages directly under `packages/<PackageName>/` and follow the live
package layout instead of copying a stale scaffold:

```text
packages/<PackageName>/
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

- Keep package components flat at package root in `package.toml`.
- Put tool implementations, runtimes, environments, locks, and tests under the
  owning `tools/<tool>/` directory.
- Use component kinds such as `skill`, `tool`, `python-runtime`, `env`,
  `system-prompt`, and `append-system-prompt`.
- Register system prompts through a `system-prompt/*.toml` descriptor, matching
  `harness/system-prompt/system-prompt.toml`; the descriptor may point to
  package-local Markdown with `content_path`.
- Prefer root components over `general/` or `task/` profile wrappers unless a
  package truly needs optional profile subsets.
- Same `kind:name` components override earlier components in the resolved
  overlay, so package-local prompts and capabilities can intentionally replace
  defaults.

Use `packages/AutOmicScience/` and
`harness/assembly/package-overlay/README.md` as the current executable
reference.
