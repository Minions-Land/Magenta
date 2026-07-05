# Bundled Extensions Retired

Pi no longer loads built-in extensions from this directory.

Current ownership:

- user and project extensions are still loaded through `src/core/extensions`
- former built-in UX features now live in Pi core/TUI
- SSH remote workspace support now uses `@magenta/harness` from `harness/modules/tools/ssh`

Keep only extension API and loader code under `src/core/extensions`.
