# Magenta3 Packages

This directory is reserved for Magenta3 harness overlay packages migrated into the repository. It is intentionally outside npm workspaces.

A package is a domain, brand, or harness bundle with a root `package.toml`. Package selection loads package-declared components; optional profiles remain supported for packages that genuinely need resource subsets. Package selection names packages; it does not load arbitrary external paths.

Use `templates/harness-package/` when creating a new package. The template keeps
skills under package-root `skills/` and tool descriptors plus implementation
assets under package-root `tools/<tool>/`.

See `harness/assembly/package-overlay/README.md` for the current schema and overlay precedence.
