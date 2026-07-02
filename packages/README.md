# Magenta3 Packages

This directory is reserved for Magenta3 harness overlay packages migrated into the repository. It is intentionally outside npm workspaces.

A package is a domain, brand, or harness bundle with a root `package.toml`. Package selection can load the package defaults or a named profile for on-demand task resources. Package selection names packages; it does not load arbitrary external paths.

Use `templates/harness-package/` when creating a new package. The template keeps
package-owned implementation assets at the package root and profile-selected
resources under `general/` or `task/<profile>/`.

See `harness/assembly/package-overlay/README.md` for the current schema and overlay precedence.
