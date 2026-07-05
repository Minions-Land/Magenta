# MCP Examples

Runnable TypeScript/JavaScript examples demonstrating the `@magenta/harness-mcp`
server and client wrappers.

## Quick Start

### 1. Build the package

The examples import from `../dist/index.js`, so build first:

```bash
cd harness/mcp
npm install
npm run build
```

### 2. Run the client (it spawns the server for you)

```bash
node examples/simple-client.js
```

`simple-client.js` launches `simple-server.js` over stdio, so you only need to
run the client. To run the server on its own (it listens on stdio and waits):

```bash
node examples/simple-server.js
```

## Available Examples

### `simple-server.js`

A basic MCP server built with `createMcpServer`, demonstrating:
- **Tools**: `echo` (echoes a message) and `reverse` (reverses a string)
- **Resources**: server configuration at `config://server`
- **Prompts**: `greet` with an optional `formal` argument

### `simple-client.js`

A client built with `connectMcpClient` that spawns `simple-server.js` and:
- lists and calls the `echo` and `reverse` tools,
- lists and reads the `config://server` resource,
- lists and retrieves the `greet` prompt in informal and formal forms,
- closes the connection cleanly.

## Understanding the Code

### Server

```typescript
import { createMcpServer } from "../dist/index.js";

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

await server.run(); // stdio transport; blocks
```

### Client

```typescript
import { connectMcpClient } from "../dist/index.js";

const client = await connectMcpClient({
  command: "node",
  args: ["examples/simple-server.js"],
});

const tools = await client.listTools();
const result = await client.callTool("echo", { message: "hi" });
console.log(result.content[0].text);
await client.close();
```

## Troubleshooting

- **`Cannot find module '../dist/index.js'`**: run `npm run build` in `harness/mcp` first.
- **Client hangs**: the client spawns the server itself; make sure `node` is on PATH.

## Next Steps

- `../client/README.md` — client wrapper reference
- `../server/README.md` — server wrapper reference
- `../README.md` — package overview and the HCP `runtime = "mcp"` integration
