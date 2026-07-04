# MCP Server

MCP server implementations and utilities for building MCP-compliant servers.

## Overview

The server module provides tools to build MCP servers that expose tools, resources, and prompts to clients.

## Quick Start

### Basic Server

```python
from mcp.server import Server
from mcp.server.stdio import stdio_server

# Create server
server = Server("my-server")

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

# Run with stdio transport
if __name__ == "__main__":
    stdio_server(server)
```

## Server Capabilities

### 1. Tools

Expose callable functions to clients:

```python
@server.list_tools()
async def list_tools():
    return [
        {
            "name": "calculate",
            "description": "Perform calculations",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Math expression to evaluate"
                    }
                },
                "required": ["expression"]
            }
        }
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "calculate":
        result = eval(arguments["expression"])
        return [{"type": "text", "text": str(result)}]
    raise ValueError(f"Unknown tool: {name}")
```

### 2. Resources

Serve resources (files, data, etc.):

```python
@server.list_resources()
async def list_resources():
    return [
        {
            "uri": "file:///data/config.json",
            "name": "Configuration",
            "description": "Server configuration file",
            "mimeType": "application/json"
        }
    ]

@server.read_resource()
async def read_resource(uri: str):
    if uri == "file:///data/config.json":
        with open("config.json") as f:
            content = f.read()
        return [{"uri": uri, "mimeType": "application/json", "text": content}]
    raise ValueError(f"Unknown resource: {uri}")
```

### 3. Prompts

Provide prompt templates:

```python
@server.list_prompts()
async def list_prompts():
    return [
        {
            "name": "code_review",
            "description": "Review code for issues",
            "arguments": [
                {
                    "name": "code",
                    "description": "Code to review",
                    "required": True
                }
            ]
        }
    ]

@server.get_prompt()
async def get_prompt(name: str, arguments: dict):
    if name == "code_review":
        code = arguments["code"]
        return {
            "messages": [
                {
                    "role": "user",
                    "content": {
                        "type": "text",
                        "text": f"Review this code:\n\n{code}"
                    }
                }
            ]
        }
    raise ValueError(f"Unknown prompt: {name}")
```

### 4. Sampling (LLM Integration)

Handle LLM sampling requests:

```python
@server.create_message()
async def create_message(messages: list, model_preferences: dict):
    # Call your LLM here
    # For example, using Anthropic:
    from anthropic import Anthropic
    
    client = Anthropic()
    response = client.messages.create(
        model="claude-3-opus-20240229",
        messages=messages,
        max_tokens=1024
    )
    
    return {
        "role": "assistant",
        "content": response.content
    }
```

## Transport Options

### stdio (Standard I/O)

Default transport for subprocess-based servers:

```python
from mcp.server.stdio import stdio_server

if __name__ == "__main__":
    stdio_server(server)
```

### SSE (Server-Sent Events)

HTTP-based transport using SSE:

```python
from mcp.server import create_app_with_auth
from starlette.applications import Starlette

app = Starlette()

# Add MCP routes
create_app_with_auth(
    server=server,
    app=app,
    auth_provider=None  # Optional auth provider
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

## FastMCP Framework

High-level framework for rapid server development:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-fast-server")

@mcp.tool()
async def greet(name: str) -> str:
    """Greet someone by name."""
    return f"Hello, {name}!"

@mcp.resource("config://settings")
async def get_settings():
    """Get server settings."""
    return {"debug": True, "port": 8000}

if __name__ == "__main__":
    mcp.run()
```

### FastMCP Features

- **Decorators**: Simple `@mcp.tool()`, `@mcp.resource()`, `@mcp.prompt()`
- **Type Hints**: Automatic schema generation from type hints
- **Validation**: Built-in request/response validation
- **Utilities**: Helper functions for common tasks

## Authentication

### OAuth2 Provider

```python
from mcp.server.auth import OAuth2Provider, AuthSettings

auth_provider = OAuth2Provider(
    settings=AuthSettings(
        issuer="https://auth.example.com",
        client_id="server_client_id",
        client_secret="server_secret"
    )
)

# Use with SSE transport
create_app_with_auth(
    server=server,
    app=app,
    auth_provider=auth_provider
)
```

### Bearer Token Authentication

```python
from mcp.server.auth.middleware.bearer_auth import BearerAuthMiddleware

middleware = BearerAuthMiddleware(
    validate_token=lambda token: token == "secret_token"
)

# Add to Starlette app
app.add_middleware(middleware)
```

## Error Handling

```python
from mcp.shared.exceptions import McpError

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    try:
        if name == "divide":
            a = arguments["a"]
            b = arguments["b"]
            if b == 0:
                raise McpError(
                    code="INVALID_PARAMS",
                    message="Division by zero"
                )
            return [{"type": "text", "text": str(a / b)}]
    except KeyError as e:
        raise McpError(
            code="INVALID_PARAMS",
            message=f"Missing parameter: {e}"
        )
```

## Logging

```python
import logging
from mcp.server import Server

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

server = Server("my-server")

@server.call_tool()
async def call_tool(name: str, arguments: dict):
    logger.info(f"Tool called: {name} with {arguments}")
    # ... handle tool
```

## Experimental Features

### Task Support

```python
from mcp.server.experimental.task_support import TaskSupport

server = Server("my-server")
task_support = TaskSupport(server)

@task_support.task("long_running_task")
async def handle_task(params: dict):
    # Long-running operation
    for i in range(10):
        await asyncio.sleep(1)
        # Update progress
        await task_support.update_progress(i * 10)
    return {"status": "completed"}
```

## Server Configuration

```python
from mcp.server import Server, ServerCapabilities

server = Server(
    name="my-server",
    version="1.0.0",
    capabilities=ServerCapabilities(
        tools={"list_changed": True},
        resources={"subscribe": True, "list_changed": True},
        prompts={"list_changed": True},
        sampling={}
    )
)
```

## Testing

### Unit Tests

```python
import pytest
from mcp.server import Server

@pytest.mark.asyncio
async def test_tool():
    server = Server("test-server")
    
    @server.list_tools()
    async def list_tools():
        return [{"name": "echo", "inputSchema": {...}}]
    
    @server.call_tool()
    async def call_tool(name: str, arguments: dict):
        return [{"type": "text", "text": arguments["message"]}]
    
    # Test list_tools
    tools = await server._list_tools_handler()
    assert len(tools) == 1
    assert tools[0]["name"] == "echo"
    
    # Test call_tool
    result = await server._call_tool_handler("echo", {"message": "test"})
    assert result[0]["text"] == "test"
```

## Examples

See `examples/` directory for:
- `simple_server.py` - Basic server with tools
- `resource_server.py` - Server exposing resources
- `prompt_server.py` - Server providing prompts
- `fastmcp_server.py` - FastMCP framework example
- `authenticated_server.py` - OAuth2 authentication

## Best Practices

1. **Error Handling**: Always validate inputs and provide clear error messages
2. **Type Safety**: Use type hints for better IDE support and validation
3. **Documentation**: Provide clear descriptions for tools, resources, and prompts
4. **Security**: Validate all inputs, sanitize file paths, use authentication
5. **Performance**: Use async/await for I/O operations
6. **Logging**: Log important events for debugging
7. **Testing**: Write unit tests for your handlers

## Reference

- **Official Docs**: https://py.sdk.modelcontextprotocol.io/server/
- **Protocol Spec**: https://spec.modelcontextprotocol.io/
- **Source Code**: https://github.com/modelcontextprotocol/python-sdk/tree/main/src/mcp/server
