# Web Search Tool

The `web-search` Tool returns an LLM-readable web search result with source
URLs. Its current Magenta implementation uses no-key DuckDuckGo results first
and a Bing HTML fallback.

```text
HcpClient -> tools/web-search/HcpServer -> tools/web-search/magenta/HcpMagnet -> ProcessTool
```

The Source reads `magenta/web-search.toml` and executes through the selected
`runtime:process` and `sandbox` Capabilities. The descriptor marks the operation
as read-only and network-enabled and supplies the `search-results` render hint;
the coding-agent host owns rendering.

The repository declaration sets `autoload = true`. This does not create a
special built-in assembly route: codegen emits an ordinary Magnet row, and the
same HcpClient assembly pipeline builds and routes it.
