# Magenta3 Packages

This directory is reserved for Magenta3 harness overlay packages migrated into the repository. It is intentionally outside npm workspaces.

A package is a domain, brand, or harness bundle with a root `package.toml`. Package selection loads package-declared components; optional profiles remain supported for packages that genuinely need resource subsets. Package selection names packages; it does not load arbitrary external paths.

Use `templates/harness-package/README.md` when creating a new package. The
template is README-only on purpose; copy the current package rules instead of a
stale scaffold. Keep skills under package-root `skills/`, system prompts under
`system-prompt/` with a module descriptor such as `system-prompt.toml`, and tool
descriptors plus implementation assets under package-root `tools/<tool>/`.

See `harness/assembly/package-overlay/README.md` for the current schema and overlay precedence.
