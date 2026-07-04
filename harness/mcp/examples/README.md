# MCP Examples

Complete examples demonstrating MCP server and client usage.

## Quick Start

### 1. Install MCP SDK

```bash
pip install mcp>=1.28.1
```

### 2. Run the Examples

**Terminal 1 - Start the server:**
```bash
cd harness/mcp/examples
python simple_server.py
```

**Terminal 2 - Run the client:**
```bash
cd harness/mcp/examples
python simple_client.py
```

## Available Examples

### simple_server.py

A basic MCP server demonstrating:
- **Tools**: `echo` and `reverse` commands
- **Resources**: Server configuration accessible via `config://server`
- **Prompts**: `greet` template with formal/informal options

**Usage:**
```bash
python simple_server.py
```

### simple_client.py

A client that connects to `simple_server.py` and:
- Lists all available tools
- Calls the echo and reverse tools
- Reads the configuration resource
- Retrieves and displays prompt templates

**Usage:**
```bash
python simple_client.py
```

## Expected Output

### Server Output
```
Starting example MCP server...
Server capabilities:
  - Tools: echo, reverse
  - Resources: config://server
  - Prompts: greet

Listening on stdio...
```

### Client Output
```
Connecting to MCP server...
Server: simple_server.py

Initializing session...
✓ Connected and initialized

=== Tools ===
Available tools: 2
  - echo: Echo back the input message
  - reverse: Reverse a string

Calling tool: echo
  Result: Echo: Hello from MCP client!

Calling tool: reverse
  Result: emosewa si PCM

=== Resources ===
Available resources: 1
  - config://server: Server Configuration

Reading resource: config://server
  Content:
{
  "name": "example-server",
  "version": "1.0.0",
  "capabilities": [
    "tools",
    "resources",
    "prompts"
  ]
}

=== Prompts ===
Available prompts: 1
  - greet: Generate a greeting message

Getting prompt: greet (formal=False)
  Messages: 1
    Role: user
    Content: Hey World! What's up?

Getting prompt: greet (formal=True)
    Role: user
    Content: Good day, World. How may I assist you today?

✓ All operations completed successfully!
```

## Understanding the Code

### Server Structure

```python
from mcp.server import Server
from mcp.server.stdio import stdio_server

# 1. Create server
server = Server("example-server")

# 2. Define capabilities
@server.list_tools()
async def list_tools():
    return [...]  # Tool definitions

@server.call_tool()
async def call_tool(name, arguments):
    return [...]  # Tool implementations

# 3. Run server
stdio_server(server)
```

### Client Structure

```python
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client

async with stdio_client("server.py") as (read, write):
    async with ClientSession(read, write) as session:
        # Initialize
        await session.initialize()
        
        # Use the session
        tools = await session.list_tools()
        result = await session.call_tool("tool_name", {})
```

## Modifying the Examples

### Adding a New Tool

In `simple_server.py`:

```python
# 1. Add to list_tools()
{
    "name": "uppercase",
    "description": "Convert text to uppercase",
    "inputSchema": {
        "type": "object",
        "properties": {
            "text": {"type": "string"}
        },
        "required": ["text"]
    }
}

# 2. Add to call_tool()
elif name == "uppercase":
    text = arguments["text"]
    return [{"type": "text", "text": text.upper()}]
```

In `simple_client.py`:

```python
# Call the new tool
result = await session.call_tool(
    name="uppercase",
    arguments={"text": "hello world"}
)
```

### Adding a New Resource

```python
# In list_resources()
{
    "uri": "data://metrics",
    "name": "Server Metrics",
    "description": "Current server metrics",
    "mimeType": "application/json"
}

# In read_resource()
elif uri == "data://metrics":
    import json
    metrics = {"requests": 100, "errors": 0}
    return [{
        "uri": uri,
        "mimeType": "application/json",
        "text": json.dumps(metrics)
    }]
```

## Advanced Examples (Future)

Additional examples to be added:

- **http_server.py**: SSE transport server
- **websocket_server.py**: WebSocket transport server
- **authenticated_server.py**: OAuth2 authentication
- **multi_server_client.py**: Connecting to multiple servers
- **streaming_client.py**: Handling streaming responses
- **fastmcp_server.py**: Using the FastMCP framework

## Troubleshooting

### "ModuleNotFoundError: No module named 'mcp'"

Install the MCP SDK:
```bash
pip install mcp
```

### "Connection refused" or timeout errors

Make sure the server is running before starting the client.

### stdio transport issues on Windows

Use Python 3.10+ and ensure the script has proper line endings.

## Next Steps

1. **Explore the SDK**: Read `../client/README.md` and `../server/README.md`
2. **Build Your Own**: Use these examples as templates
3. **Integration**: See `../README.md` for Magenta3 integration patterns

## Resources

- **MCP Specification**: https://spec.modelcontextprotocol.io/
- **Python SDK Docs**: https://py.sdk.modelcontextprotocol.io/
- **GitHub**: https://github.com/modelcontextprotocol/python-sdk
