# Show Tool

`show` validates local file paths or HTTP(S) URLs and returns typed content
references for a host preview surface. It does not render a floating window
itself; the coding-agent TUI interprets the returned `file-preview` details.

## HCP Ownership

```text
HcpClient -> tools/show/HcpServer -> tools/show/pi/HcpMagnet -> AgentTool
```

`show.toml` declares the Tool and selects the `pi` Source. The Source builds a
normal native Tool through `createShowExecute(cwd)`.

## Input

```typescript
show({ url: "./output/diagram.png" });
show({ url: ["./diagram.png", "./design.md", "https://example.com/report.pdf"] });
```

The tool accepts one string or an array. Local inputs are resolved from the
bound working directory and must identify existing files. Remote inputs must be
HTTP(S) URLs.

## Result

Each returned `ContentItem` contains:

- `type`: `image`, `pdf`, `html`, `markdown`, `code`, `chart`, or `file`;
- `url`: the absolute local path or original remote URL;
- `filename`: the display name; and
- an optional `mimeType` inferred from the extension.

The host may display these as links, inline content, or a preview overlay. That
rendering behavior belongs to `pi/coding-agent`, not this Harness Tool.
