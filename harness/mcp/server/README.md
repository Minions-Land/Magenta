# MCP Server

TypeScript server wrapper for building MCP servers, built on
`@modelcontextprotocol/sdk`.

## Overview

`McpServer` wraps the SDK `Server` and manages tools, resources, and prompts in
in-memory maps. It registers the standard request handlers (list/call tools,
list/read resources, list/get prompts) and runs over a stdio transport.
`createMcpServer` is a convenience constructor.

## Quick Start

```typescript
import { createMcpServer } from "@magenta/harness-mcp";

const server = createMcpServer({ name: "example-server", version: "1.0.0" });

server.registerTool(
  {
    name: "echo",
    description: "Echo back the input message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  async (args) => [{ type: "text", text: `Echo: ${args.message}` }],
);

await server.run(); // connects StdioServerTransport and blocks
```

## API

### `registerTool(definition, handler)`

- `definition`: `{ name, description, inputSchema }` — `inputSchema` is a JSON Schema object.
- `handler(args)`: returns an array of content parts (`TextContent | ImageContent | EmbeddedResource`).

### `registerResource(definition, handler)`

- `definition`: `{ uri, name, description?, mimeType? }`.
- `handler(uri)`: returns an array of content parts for the resource.

### `registerPrompt(definition, handler)`

- `definition`: `{ name, description?, arguments? }`.
- `handler(args)`: returns `{ messages: [{ role, content }] }`.

### `run()`

Connects a `StdioServerTransport` and keeps the process alive. stdio is the only
server transport wired here.

### `getServer()`

Returns the underlying SDK `Server` for advanced use (custom handlers,
capabilities, etc.).

## Notes and limits

- stdio transport only (no SSE/HTTP/WebSocket server transport).
- Unknown tool/resource/prompt requests throw a plain `Error` rather than a
  structured `McpError`.
- `run()` blocks on an unresolved promise; there is no graceful shutdown hook.
- No auth, sampling, `listChanged` notifications, or pagination.

## Testing handlers

Register into an `McpServer` and drive it with a client (see `../examples/`),
or pull the underlying `Server` via `getServer()` to exercise handlers directly.

## Reference

- Protocol spec: https://spec.modelcontextprotocol.io/
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
