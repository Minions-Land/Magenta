# MCP Integration for Pi Coding Agent - Research Report

**日期**: 2026-07-04  
**任务**: 调研并集成MCP (Model Context Protocol) 到 pi coding agent

---

## 🔍 调研发现

### 官方TypeScript SDK

**包名**: `@modelcontextprotocol/sdk`  
**版本**: 1.29.0 (latest)  
**维护者**: Anthropic (jspahrsummers, pcarleton, fweinberger, thedsp, ashwin-ant, ochafik-ant)  
**仓库**: https://github.com/modelcontextprotocol/typescript-sdk  
**主页**: https://modelcontextprotocol.io  
**协议**: MIT License

---

## 📦 MCP生态系统 (npm)

### 1. 核心SDK

#### `@modelcontextprotocol/sdk` (v1.29.0)
**描述**: Model Context Protocol implementation for TypeScript  
**用途**: 核心SDK，提供Client和Server实现

#### `@modelcontextprotocol/server` 
**描述**: Server-specific package  
**用途**: 仅包含Server实现的子包

#### `@modelcontextprotocol/inspector` (v0.22.0)
**描述**: Model Context Protocol inspector  
**用途**: MCP调试和检查工具

#### `@modelcontextprotocol/ext-apps` (v1.7.4)
**描述**: MCP Apps SDK — Enable MCP servers to display interactive user interfaces  
**用途**: MCP server的UI扩展能力

---

### 2. 工具和代理

#### `mcp-proxy` (v6.5.2)
**描述**: A TypeScript SSE proxy for MCP servers that use stdio transport  
**用途**: stdio到SSE的代理转换

#### `@playwright/mcp` (v0.0.77)
**描述**: Playwright Tools for MCP  
**用途**: Playwright自动化工具的MCP集成

#### `chrome-devtools-mcp` (v1.5.0)
**描述**: MCP server for Chrome DevTools  
**用途**: Chrome DevTools的MCP服务器

---

### 3. 框架集成

#### `@hono/mcp` (v0.3.0)
**描述**: MCP Middleware for Hono  
**用途**: Hono框架的MCP中间件

---

## 🎯 整合方案

### 目录结构

```
harness/mcp/
├── client/                      # MCP客户端
│   ├── README.md               # 客户端文档
│   └── client.ts               # 客户端实现/封装
├── server/                      # MCP服务器
│   ├── README.md               # 服务器文档
│   └── server.ts               # 服务器实现/封装
├── package.json                 # MCP专用依赖
├── tsconfig.json               # TypeScript配置
└── README.md                    # 总体文档
```

---

## 📋 实施计划

### Phase 1: 安装核心依赖

```bash
cd harness/mcp
npm init -y
npm install @modelcontextprotocol/sdk@^1.29.0
npm install --save-dev @types/node typescript
```

### Phase 2: Client实现

创建 `client/client.ts`:
```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class McpClient {
  private client: Client;
  
  constructor(serverCommand: string, args: string[] = []) {
    const transport = new StdioClientTransport({
      command: serverCommand,
      args: args
    });
    
    this.client = new Client({
      name: "pi-mcp-client",
      version: "1.0.0"
    }, {
      capabilities: {}
    });
  }
  
  async connect() {
    await this.client.connect(transport);
  }
  
  async listTools() {
    return await this.client.listTools();
  }
  
  async callTool(name: string, args: any) {
    return await this.client.callTool({ name, arguments: args });
  }
  
  async listResources() {
    return await this.client.listResources();
  }
  
  async readResource(uri: string) {
    return await this.client.readResource({ uri });
  }
  
  async close() {
    await this.client.close();
  }
}
```

### Phase 3: Server实现

创建 `server/server.ts`:
```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export class McpServer {
  private server: Server;
  
  constructor(name: string, version: string = "1.0.0") {
    this.server = new Server({
      name,
      version
    }, {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      }
    });
  }
  
  registerTool(
    name: string,
    description: string,
    inputSchema: any,
    handler: (args: any) => Promise<any>
  ) {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name, description, inputSchema }]
    }));
    
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === name) {
        const result = await handler(request.params.arguments);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    });
  }
  
  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
```

### Phase 4: Pi Extension集成

创建 `harness/extensions/mcp-client.ts`:
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpClient } from "../mcp/client/client.js";

export default function (pi: ExtensionAPI) {
  const mcpClients = new Map<string, McpClient>();
  
  // Register tool: Connect to MCP server
  pi.registerTool({
    name: "mcp_connect",
    label: "Connect to MCP Server",
    description: "Connect to an MCP server",
    parameters: Type.Object({
      name: Type.String({ description: "Client name/ID" }),
      command: Type.String({ description: "Server command" }),
      args: Type.Optional(Type.Array(Type.String()))
    }),
    handler: async (input, ctx) => {
      const client = new McpClient(input.command, input.args || []);
      await client.connect();
      mcpClients.set(input.name, client);
      return { success: true, message: `Connected to ${input.name}` };
    }
  });
  
  // Register tool: List MCP tools
  pi.registerTool({
    name: "mcp_list_tools",
    label: "List MCP Tools",
    description: "List available tools from an MCP server",
    parameters: Type.Object({
      client: Type.String({ description: "Client name/ID" })
    }),
    handler: async (input, ctx) => {
      const client = mcpClients.get(input.client);
      if (!client) throw new Error(`MCP client not found: ${input.client}`);
      
      const tools = await client.listTools();
      return { tools };
    }
  });
  
  // Register tool: Call MCP tool
  pi.registerTool({
    name: "mcp_call_tool",
    label: "Call MCP Tool",
    description: "Call a tool on an MCP server",
    parameters: Type.Object({
      client: Type.String({ description: "Client name/ID" }),
      tool: Type.String({ description: "Tool name" }),
      arguments: Type.Any({ description: "Tool arguments" })
    }),
    handler: async (input, ctx) => {
      const client = mcpClients.get(input.client);
      if (!client) throw new Error(`MCP client not found: ${input.client}`);
      
      const result = await client.callTool(input.tool, input.arguments);
      return result;
    }
  });
  
  // Cleanup on session end
  pi.on("session_end", async () => {
    for (const [name, client] of mcpClients) {
      await client.close();
    }
    mcpClients.clear();
  });
}
```

---

## 🚀 使用场景

### 场景1: 连接到外部MCP工具

```typescript
// 用户通过pi连接到MCP服务器
await mcp_connect({
  name: "github-tools",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"]
});

// 列出可用工具
const tools = await mcp_list_tools({ client: "github-tools" });

// 调用工具
await mcp_call_tool({
  client: "github-tools",
  tool: "create_issue",
  arguments: {
    repo: "owner/repo",
    title: "Bug report",
    body: "Description..."
  }
});
```

### 场景2: Pi作为MCP Server

```typescript
// harness/extensions/mcp-server.ts
import { McpServer } from "../mcp/server/server.js";

const server = new McpServer("pi-tools");

// 暴露pi的工具给外部MCP客户端
server.registerTool(
  "execute_command",
  "Execute a shell command",
  {
    type: "object",
    properties: {
      command: { type: "string" }
    }
  },
  async (args) => {
    // 调用pi的bash工具
    return await executeBashTool(args.command);
  }
);

await server.start();
```

---

## ⚡ 优势

1. **标准协议**: MCP是Anthropic推出的标准协议
2. **生态丰富**: 已有大量MCP服务器可直接使用
3. **双向集成**: 
   - Pi可以作为Client连接外部MCP服务器
   - Pi可以作为Server暴露工具给外部
4. **类型安全**: TypeScript原生支持
5. **异步设计**: 完全异步，适合pi的架构

---

## 📚 参考资源

- **Protocol Spec**: https://spec.modelcontextprotocol.io/
- **TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **官方文档**: https://modelcontextprotocol.io
- **MCP Servers目录**: https://github.com/modelcontextprotocol/servers

---

## ✅ 下一步

1. **创建package.json和安装依赖**
2. **实现Client封装**
3. **实现Server封装**
4. **创建Pi extension集成**
5. **编写示例和文档**
6. **测试验证**

工作量估算: **4-6小时**
