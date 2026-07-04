# MCP Client

MCP client implementations and utilities for connecting to MCP servers.

## Overview

The client module provides tools to connect to and interact with MCP servers using various transport mechanisms.

## Transport Options

### 1. stdio (Standard I/O)

Connect to servers running as subprocesses:

```python
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client

async with stdio_client("/path/to/server") as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        # Use session...
```

### 2. SSE (Server-Sent Events)

Connect to HTTP-based MCP servers:

```python
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client

async with sse_client("http://localhost:8000/sse") as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        # Use session...
```

### 3. WebSocket

Connect to WebSocket-based MCP servers:

```python
from mcp.client.session import ClientSession
from mcp.client.websocket import websocket_client

async with websocket_client("ws://localhost:8000/mcp") as (read, write):
    async with ClientSession(read, write) as session:
        await session.initialize()
        # Use session...
```

## Client Session API

### Initialization

```python
await session.initialize()
```

### Tools

```python
# List available tools
tools_result = await session.list_tools()
tools = tools_result.tools

# Call a tool
result = await session.call_tool(
    name="my_tool",
    arguments={"param": "value"}
)
```

### Resources

```python
# List resources
resources_result = await session.list_resources()
resources = resources_result.resources

# Read a resource
content = await session.read_resource(
    uri="file:///path/to/resource"
)
```

### Prompts

```python
# List prompts
prompts_result = await session.list_prompts()
prompts = prompts_result.prompts

# Get a prompt
prompt = await session.get_prompt(
    name="my_prompt",
    arguments={"param": "value"}
)
```

### Sampling (LLM Integration)

```python
# Request LLM sampling
result = await session.create_message(
    messages=[
        {
            "role": "user",
            "content": {"type": "text", "text": "Hello!"}
        }
    ],
    model_preferences={"hints": [{"name": "claude-3-opus"}]}
)
```

## Authentication

### OAuth2

```python
from mcp.client.session import ClientSession
from mcp.client.auth.oauth2 import OAuth2Authenticator

authenticator = OAuth2Authenticator(
    client_id="your_client_id",
    token_url="https://auth.example.com/token"
)

async with stdio_client("/path/to/server") as (read, write):
    async with ClientSession(
        read, write,
        authenticator=authenticator
    ) as session:
        await session.initialize()
        # Use authenticated session...
```

### Client Credentials

```python
from mcp.client.auth.extensions.client_credentials import ClientCredentials

authenticator = ClientCredentials(
    client_id="your_client_id",
    client_secret="your_secret",
    token_url="https://auth.example.com/token"
)
```

## Session Group (Multiple Servers)

Manage connections to multiple MCP servers:

```python
from mcp.client.session_group import SessionGroup

async with SessionGroup() as group:
    # Add multiple servers
    session1 = await group.add_server("server1", stdio_client("/path/to/server1"))
    session2 = await group.add_server("server2", stdio_client("/path/to/server2"))
    
    # Use any session
    tools1 = await session1.list_tools()
    tools2 = await session2.list_tools()
```

## Error Handling

```python
from mcp.shared.exceptions import McpError

try:
    result = await session.call_tool("tool_name", {})
except McpError as e:
    print(f"MCP Error: {e.code} - {e.message}")
except Exception as e:
    print(f"Unexpected error: {e}")
```

## Experimental Features

### Task Support

```python
from mcp.client.experimental.tasks import TaskHandler

# Enable task support
task_handler = TaskHandler()
async with ClientSession(read, write, task_handler=task_handler) as session:
    await session.initialize()
    # Tasks will be handled automatically
```

## Configuration

### Client Options

```python
from mcp.client.session import ClientSession

session = ClientSession(
    read, write,
    timeout=30.0,              # Request timeout in seconds
    max_retries=3,             # Maximum retry attempts
    retry_delay=1.0,           # Delay between retries
    authenticator=None,        # Optional authenticator
    task_handler=None          # Optional task handler
)
```

## Examples

See `examples/` directory for:
- `simple_client.py` - Basic client usage
- `multi_server_client.py` - Connecting to multiple servers
- `authenticated_client.py` - OAuth2 authentication
- `streaming_client.py` - SSE streaming

## Reference

- **Official Docs**: https://py.sdk.modelcontextprotocol.io/client/
- **Protocol Spec**: https://spec.modelcontextprotocol.io/
- **Source Code**: https://github.com/modelcontextprotocol/python-sdk/tree/main/src/mcp/client
