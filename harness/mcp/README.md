# MCP Integration for Magenta3

Model Context Protocol (MCP) integration for the Magenta3 harness.

## Overview

This directory provides MCP protocol support through the official Anthropic Python SDK.

**Architecture**:
- `client/`: MCP client implementations and utilities
- `server/`: MCP server implementations and utilities
- `examples/`: Example MCP servers and clients

## Installation

The MCP SDK is included in the harness dependencies:

```bash
pip install mcp>=1.28.1
```

## Quick Start

### Running an MCP Server

```python
from mcp.server import Server
from mcp.server.stdio import stdio_server

# Create server
server = Server("example-server")

@server.list_tools()
async def list_tools():
    return [
        {
            "name": "echo",
            "description": "Echo back the input",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": {"type": "string"}
                },
                "required": ["message"]
            }
        }
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "echo":
        return [{"type": "text", "text": arguments["message"]}]
    raise ValueError(f"Unknown tool: {name}")

# Run server
if __name__ == "__main__":
    stdio_server(server)
```

### Connecting as a Client

```python
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client

async def main():
    # Connect to server
    async with stdio_client("path/to/server") as (read, write):
        async with ClientSession(read, write) as session:
            # Initialize
            await session.initialize()
            
            # List available tools
            tools = await session.list_tools()
            print(f"Available tools: {tools}")
            
            # Call a tool
            result = await session.call_tool("echo", {"message": "Hello MCP!"})
            print(f"Result: {result}")

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

## Directory Structure

```
mcp/
├── client/                 # MCP client support
│   ├── README.md          # Client usage guide
│   └── examples/          # Client examples
├── server/                 # MCP server support  
│   ├── README.md          # Server usage guide
│   └── examples/          # Server examples
└── examples/               # Complete MCP examples
    ├── simple_server.py   # Basic server
    ├── simple_client.py   # Basic client
    └── README.md          # Examples documentation
```

## MCP Protocol Features

### Client Features
- **Transport**: stdio, SSE (HTTP), WebSocket
- **Authentication**: OAuth2, client credentials
- **Session Management**: Connection lifecycle, retry logic
- **Streaming**: Server-Sent Events support
- **Tasks**: Experimental task support

### Server Features
- **Tools**: Register and expose callable tools
- **Resources**: Serve resources to clients
- **Prompts**: Provide prompt templates
- **Sampling**: LLM sampling support
- **Authentication**: OAuth2 provider
- **FastMCP**: High-level server framework

## Official Resources

- **Protocol Spec**: https://spec.modelcontextprotocol.io/
- **Python SDK Docs**: https://py.sdk.modelcontextprotocol.io/
- **GitHub**: https://github.com/modelcontextprotocol/python-sdk
- **Homepage**: https://modelcontextprotocol.io

## Integration Notes

### For Magenta3 Harness

The MCP integration allows:
1. **Tool Discovery**: Dynamically discover and invoke external tools via MCP
2. **Resource Access**: Access remote resources through MCP servers
3. **Agent Orchestration**: Connect multiple MCP servers for complex workflows
4. **Extension System**: Build MCP servers as Magenta extensions

### Example: MCP Tool Extension

```python
# harness/extensions/my-mcp-tool/server.py
from mcp.server import Server

server = Server("my-tool")

@server.list_tools()
async def list_tools():
    return [{
        "name": "analyze_data",
        "description": "Analyze data and return insights",
        "inputSchema": {
            "type": "object",
            "properties": {
                "data": {"type": "string"}
            }
        }
    }]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "analyze_data":
        # Your analysis logic
        result = analyze(arguments["data"])
        return [{"type": "text", "text": result}]
```

## Version Information

- **MCP SDK**: v1.28.1 (stable)
- **Protocol Version**: 2024-11-05
- **Python**: >= 3.10

**Note**: v1.x is in maintenance mode. v2.x is in alpha and not recommended for production.

## See Also

- `examples/` - Working examples
- `client/README.md` - Client-specific documentation
- `server/README.md` - Server-specific documentation
