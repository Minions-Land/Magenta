# Bundled Extensions Moved

Bundled extension implementations are harness-owned assets now.

Use:

```text
harness/extensions/pi/bundled
```

The coding-agent runtime loads built-in extensions through `getBundledExtensionsDir()` exported by `@magenta/harness`. Keep concrete bundled implementations in harness; keep only coding-agent extension APIs and loaders under `src/core/extensions`.
