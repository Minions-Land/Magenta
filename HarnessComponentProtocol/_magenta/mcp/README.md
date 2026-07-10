# MCP Support

This private support directory contains the generic Model Context Protocol
client, cache, schema conversion, and `McpTool` product adapter used by Harness
tool Sources.

These files are not HCP roles and therefore do not live in `.HCP/`. A real
Source `HcpMagnet` constructs an `McpTool`, and the owning Module `HcpServer`
remains the only HCP endpoint. MCP transport never owns a Module, Server,
Magnet, address, or parallel selection path.
