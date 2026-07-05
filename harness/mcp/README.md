# MCP Integration for Magenta3

Model Context Protocol (MCP) integration for the Magenta3 harness.

## Overview

This directory provides MCP protocol support in **TypeScript**, built on the
official `@modelcontextprotocol/sdk` (npm). It exposes thin, ergonomic wrappers
for building MCP servers and connecting to them as a client.

**Architecture**:
- `client/client.ts`: `McpClient` / `connectMcpClient` — connect to an MCP server over stdio or SSE.
- `server/server.ts`: `McpServer` / `createMcpServer` — build an MCP server (stdio transport) exposing tools, resources, and prompts.
- `index.ts`: barrel re-exporting both wrappers plus common SDK types.
- `examples/`: runnable JavaScript examples (`simple-server.js`, `simple-client.js`).

This wrapper package is a low-level building block. For attracting an external
MCP server's tools into the harness tool address space, see
[HCP integration](#hcp-integration-runtime--mcp) below, which does not depend on
this package or the SDK.

## Installation

This is an npm workspace package. Its runtime dependency is the MCP TypeScript
SDK:

```json
"dependencies": { "@modelcontextprotocol/sdk": "^1.29.0" }
```

Build it with `npm run build` (emits `dist/`).

## Quick Start

### Building an MCP server

```typescript
import { createMcpServer } from "@magenta/harness-mcp";

const server = createMcpServer({ name: "example-server", version: "0.1.0" });

server.registerTool(
  {
    name: "echo",
    description: "Echo back the input",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  async (args) => [{ type: "text", text: String(args.message) }],
);

await server.run(); // connects a StdioServerTransport and blocks
```

### Connecting as a client

```typescript
import { connectMcpClient } from "@magenta/harness-mcp";

// stdio: spawn a server process
const client = await connectMcpClient({
  command: "node",
  args: ["path/to/server.js"],
});

const tools = await client.listTools();
const result = await client.callTool("echo", { message: "Hello MCP!" });
await client.close();
```

An SSE transport is also supported by passing `{ url, headers? }` instead of
`{ command, args }`.

### Running the examples

```bash
npm run build
node examples/simple-server.js   # in one terminal
node examples/simple-client.js   # in another
```

## Capabilities and limits

The wrappers implement the subset of MCP the harness uses today:

- **Client transports**: stdio and SSE. (Streamable HTTP and WebSocket, which the
  SDK ships, are not wired here.)
- **Server transport**: stdio only.
- **Primitives**: tools, resources, and prompts (list + call/read/get).
- **Not implemented**: OAuth/auth flows, sampling and roots callbacks,
  `listChanged` notifications, progress/cancellation, response pagination, and
  multi-server session management. Add these against the SDK if a future
  integration needs them.

## HCP integration (`runtime = "mcp"`)

The harness can attract an external MCP server's tools directly into the HCP tool
address space, independent of this wrapper package. A package declares an MCP
server as a `tool` component whose descriptor sets `runtime = "mcp"`:

```toml
# packages/<pkg>/tools/<server>/<server>.toml
kind = "tool"
name = "bio_api"          # used as the server name; also the tool name prefix source
runtime = "mcp"
command = "packages/<pkg>/tools/<server>/target/release/<server-bin>"  # repo-relative, absolute, or PATH lookup
args = []
name_prefix = "bio"       # optional: exposed tools become `bio_<remoteTool>`
timeout_ms = 30000        # optional: per-request timeout

[env]                     # optional: extra environment for the spawned server
SOME_API_KEY = "..."
```

At assembly time the harness spawns the server over stdio, runs the MCP
`initialize` handshake, calls `tools/list`, and produces **one HCP tool magnet
per remote tool** (all sharing one long-lived connection). Remote tool names are
namespaced with `name_prefix` to avoid collisions with built-in tools.

Implementation:
- `hcp-magnet/mcp-client.ts` — dependency-free stdio JSON-RPC client
  (`initialize`, `tools/list`, `tools/call`).
- `hcp-magnet/mcp.ts` — `McpConnection` (shared connection lifecycle) and
  `McpToolMagnet` (one remote tool → one `AgentTool`), plus `createMcpToolMagnets`.
- `hcp-magnet/package-tool.ts` — the `runtime = "mcp"` cable.

This path deliberately does **not** depend on `@modelcontextprotocol/sdk`,
keeping the harness core's dependency surface minimal.

## Official resources

- Protocol spec: https://spec.modelcontextprotocol.io/
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Homepage: https://modelcontextprotocol.io

## See also

- `client/README.md` — client wrapper details
- `server/README.md` — server wrapper details
- `examples/README.md` — runnable examples
