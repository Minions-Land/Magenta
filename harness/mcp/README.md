# MCP Directory

This directory is **reserved for future MCP (Model Context Protocol) implementations** of harness components.

## Purpose

MCP is a protocol for connecting AI assistants to external data sources and tools. When Magenta integrates MCP support, implementations will live here following the standard harness module pattern:

```
harness/<module>/
  <module>.toml       — Registration metadata
  pi/                 — Pi-sourced TypeScript implementations
  mcp/                — MCP-sourced implementations (future)
  rust/               — Rust-sourced implementations (future)
  README.md           — Module documentation
```

## Status

Currently **empty** — no MCP implementations exist yet.

## Future Use Cases

When MCP support is added, this directory will enable:

1. **MCP-based tools**: Tools provided by external MCP servers
   - Database query tools from a database MCP server
   - API tools from a service-specific MCP server
   - File system tools from a remote MCP server

2. **MCP transport layer**: Connect to MCP servers via:
   - Stdio (subprocess)
   - HTTP/SSE (remote servers)
   - WebSocket (bidirectional streaming)

3. **Tool discovery**: Dynamically discover tools from connected MCP servers

## Design Principles

When MCP implementations arrive:

- **Source separation**: MCP implementations will live in `<module>/mcp/` subdirectories, not mixed with `pi/` code
- **Magnet adaptation**: MCP tools will be wrapped by `McpMagnet` connectors to expose the standard `AgentTool` interface
- **HCP management**: MCP connections will be managed via HCP, not on the agent loop hot path
- **No pi dependency**: MCP implementations won't require pi-specific code

## References

- MCP Specification: https://modelcontextprotocol.io/
- Harness architecture: `harness/README.md`
- Component template: `harness/template/`

## Related Modules

- **magnet/** — Connectors that adapt implementations (will include `McpMagnet`)
- **hcp/** — Management layer for component discovery and lifecycle
- **registry/** — TOML-based component registration

---

This placeholder ensures the directory structure is documented and prevents accidental misuse before MCP support is implemented.
