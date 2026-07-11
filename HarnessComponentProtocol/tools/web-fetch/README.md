# Web Fetch Tool

The `web-fetch` Tool retrieves an HTTP(S) URL and returns JSON, plain text, or
lightweight HTML-to-text output with optional line slicing.

```text
HcpClient -> tools/web-fetch/HcpServer -> tools/web-fetch/magenta/HcpMagnet -> ProcessTool
```

The Source reads `magenta/web-fetch.toml`, which reuses the shared process-tool
binary's `read-url` operation. Construction requires the selected
`runtime:process` and `sandbox` Capabilities. The `web-content` render hint is
host metadata; the Harness Tool does not own TUI rendering.

The repository declaration sets `autoload = true`. It still follows the normal
generated Magnet and HcpClient assembly path rather than a Package, transport,
or built-in-specific path.
