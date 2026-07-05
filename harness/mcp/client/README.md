# MCP Client

TypeScript client wrapper for connecting to MCP servers, built on
`@modelcontextprotocol/sdk`.

## Overview

`McpClient` wraps the SDK `Client` and exposes a small, typed surface for the
verbs the harness uses: connect, list/call tools, list/read resources, and
list/get prompts. `connectMcpClient` is a convenience constructor that connects
in one call.

## Transports

Two transports are supported, selected by the shape of the options object:

### stdio (spawn a subprocess)

```typescript
import { connectMcpClient } from "@magenta/harness-mcp";

const client = await connectMcpClient({
  command: "node",
  args: ["path/to/server.js"],
  env: { SOME_KEY: "value" }, // optional
});
```

### SSE (HTTP Server-Sent Events)

```typescript
const client = await connectMcpClient({
  url: "http://localhost:8000/sse",
  headers: { Authorization: "Bearer ..." }, // optional
});
```

The SDK also ships Streamable HTTP and WebSocket transports; this wrapper does
not wire them.

## API

```typescript
import { McpClient } from "@magenta/harness-mcp";

const client = new McpClient({ name: "my-client", version: "1.0.0" });
await client.connect({ command: "node", args: ["server.js"] });

// Tools
const tools = await client.listTools();               // Tool[]
const result = await client.callTool("echo", { message: "hi" });
console.log(result.content[0].text);

// Resources
const resources = await client.listResources();       // Resource[]
const doc = await client.readResource("config://server");
console.log(doc.contents[0].text);

// Prompts
const prompts = await client.listPrompts();            // Prompt[]
const prompt = await client.getPrompt("greet", { name: "World", formal: "true" });

await client.close();
```

### Methods

| Method | Description |
| --- | --- |
| `connect(transport)` | Connect over stdio or SSE. Throws if already connected. |
| `listTools()` | Return the server's tools. |
| `callTool(name, args?)` | Invoke a tool; returns the SDK `CallToolResult`. |
| `listResources()` | Return the server's resources. |
| `readResource(uri)` | Read a resource by URI. |
| `listPrompts()` | Return the server's prompts. |
| `getPrompt(name, args?)` | Retrieve a rendered prompt. |
| `close()` | Close the connection. |
| `isConnected()` | Whether the client is currently connected. |

All data methods throw if called before `connect()`.

## Notes and limits

- Client capabilities are declared as `roots.listChanged: false` and `sampling: {}`,
  but no sampling/roots handlers or `listChanged` subscriptions are implemented.
- No pagination handling, timeouts, retries, or multi-server session management.

For attracting a server's tools into the harness tool address space without this
wrapper, see the `runtime = "mcp"` integration in the package `README.md`.

## Reference

- Protocol spec: https://spec.modelcontextprotocol.io/
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
