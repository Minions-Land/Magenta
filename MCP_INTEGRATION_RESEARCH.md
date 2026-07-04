# MCP Integration Research

**日期**: 2026-07-04  
**任务**: 调研PyPI中的MCP相关扩展，准备整合到Magenta3 harness

---

## 🔍 PyPI MCP生态调研结果

### 1. 核心包：`mcp` (官方SDK)

**包名**: `mcp`  
**版本**: 1.28.1 (stable, v1.x maintenance mode)  
**维护者**: Anthropic, PBC.  
**仓库**: https://github.com/modelcontextprotocol/python-sdk  
**文档**: https://py.sdk.modelcontextprotocol.io/  
**协议网站**: https://modelcontextprotocol.io

#### 特性
- ✅ **Production-ready** (Development Status: 5 - Production/Stable)
- ✅ 完整的Client和Server实现
- ✅ 支持Python 3.10-3.14
- ✅ MIT License

#### 包结构
```
mcp/
├── client/                    # MCP客户端
│   ├── auth/                  # 认证扩展
│   ├── experimental/          # 实验性功能
│   └── stdio/                 # stdio传输
├── server/                    # MCP服务器
│   ├── auth/                  # 服务器认证
│   │   ├── handlers/          # OAuth handlers
│   │   └── middleware/        # Auth middleware
│   ├── experimental/          # 实验性功能
│   ├── fastmcp/               # FastMCP集成
│   │   ├── prompts/
│   │   ├── resources/
│   │   ├── tools/
│   │   └── utilities/
│   └── lowlevel/              # 底层API
├── shared/                    # 共享组件
│   └── experimental/
│       └── tasks/
├── os/                        # OS抽象
│   ├── posix/
│   └── win32/
└── cli/                       # CLI工具
```

#### 依赖
**核心依赖**:
- anyio >= 4.5
- httpx >= 0.27.1, < 1.0.0
- httpx-sse >= 0.4
- jsonschema >= 4.20.0
- pydantic >= 2.11.0, < 3.0.0
- pydantic-settings >= 2.5.2
- pyjwt[crypto] >= 2.10.1
- python-multipart >= 0.0.9
- sse-starlette >= 1.6.1
- starlette >= 0.27
- uvicorn >= 0.31.1 (非emscripten)
- typing-extensions >= 4.9.0

**可选扩展**:
- `[cli]`: python-dotenv, typer
- `[rich]`: rich >= 13.9.4
- `[ws]`: websockets >= 15.0.1

#### 状态说明
- **v1.x**: 当前stable版本，maintenance mode（关键bug修复和安全补丁）
- **v2.x**: alpha阶段 (2.0.0aN)，不推荐生产使用

---

### 2. 增强框架：`fastmcp`

**包名**: `fastmcp`  
**版本**: 3.4.2  
**维护者**: Jeremiah Lowin (Prefect)  
**仓库**: https://github.com/PrefectHQ/fastmcp  
**文档**: https://gofastmcp.com  
**协议**: Apache-2.0

#### 特性
- ✅ "The fast, Pythonic way to build MCP servers and clients"
- ✅ 基于`fastmcp-slim`的便捷包装
- ✅ 支持Python 3.10-3.13
- ✅ 类型安全 (Typing :: Typed)

#### 可选扩展
- `[anthropic]`: Anthropic集成
- `[openai]`: OpenAI集成
- `[azure]`: Azure集成
- `[gemini]`: Google Gemini集成
- `[apps]`: 应用程序支持
- `[code-mode]`: 代码模式
- `[tasks]`: 任务支持

#### 核心依赖
```
fastmcp-slim[client,server] == 3.4.2
```

#### 与官方SDK的关系
- FastMCP是基于官方`mcp`包构建的高级框架
- 提供更简洁的API和便捷功能
- 官方SDK的`mcp/server/fastmcp/`模块已集成部分FastMCP功能

---

### 3. 脚手架工具：`modelcontextprotocol`

**包名**: `modelcontextprotocol`  
**版本**: 1.0.1  
**维护者**: Dheeraj Pai  
**仓库**: https://github.com/leanmcp/modelcontextprotocol  
**协议**: MIT License

#### 特性
- ✅ CLI工具，用于MCP项目脚手架生成
- ✅ 增强的日志记录
- ✅ 基于Jinja2的模板系统
- ✅ 开发状态: Beta

#### 依赖
```
click >= 8.0.0
jinja2 >= 3.1.0
loguru >= 0.7.0
mcp >= 1.2.0          # 依赖官方SDK
posthog >= 3.0.0
rich >= 13.0.0
```

#### 用途
- 快速创建MCP项目结构
- 生成样板代码
- 不是运行时库，而是开发工具

---

### 4. 其他相关包

#### `mcp-server` (v0.1.4)
- 小众包，维护不活跃
- 功能未知，需进一步调查

#### `mcp-client` (v0.0.0)
- 占位包，无实际内容
- 不推荐使用

---

## 📊 推荐整合方案

### 方案A：官方SDK (推荐)

**选择**: `mcp` v1.28.1

**理由**:
1. ✅ **官方维护** - Anthropic官方支持
2. ✅ **Production-ready** - 稳定的v1.x分支
3. ✅ **完整功能** - Client + Server + 认证 + 传输
4. ✅ **良好架构** - 清晰的client/server分离
5. ✅ **活跃维护** - 频繁更新（v1.28.1是2024最新stable）

**目录结构**:
```
harness/mcp/
├── client/                    # 从mcp包提取client模块
│   ├── __init__.py
│   ├── session.py            # MCP客户端会话
│   ├── stdio/                # stdio传输实现
│   └── auth/                 # 认证扩展
├── server/                    # 从mcp包提取server模块
│   ├── __init__.py
│   ├── server.py             # MCP服务器核心
│   ├── fastmcp/              # FastMCP集成
│   └── auth/                 # 服务器认证
├── shared/                    # 共享类型和工具
│   ├── __init__.py
│   └── types.py
├── README.md                  # MCP集成文档
└── examples/                  # 使用示例
    ├── simple_server.py
    └── simple_client.py
```

**依赖管理**:
- 将`mcp`添加到harness的requirements.txt
- 或者直接复制源码到harness目录（如果需要定制）

---

### 方案B：FastMCP (可选扩展)

**选择**: `fastmcp` v3.4.2

**理由**:
- ✅ 更简洁的API
- ✅ 多LLM provider集成（Anthropic, OpenAI, Azure, Gemini）
- ✅ 适合快速开发

**集成方式**:
```
harness/mcp/
├── client/                    # 官方SDK client
├── server/                    # 官方SDK server
└── extensions/
    └── fastmcp/               # FastMCP作为可选扩展
        ├── __init__.py
        └── README.md
```

**依赖**:
```
mcp >= 1.28.1
fastmcp[anthropic,openai] >= 3.4.2  # 可选
```

---

### 方案C：脚手架工具 (开发辅助)

**选择**: `modelcontextprotocol` v1.0.1

**用途**: 仅作为开发工具，不集成到运行时

**使用方式**:
```bash
# 全局安装
pip install modelcontextprotocol

# 生成MCP server模板
mcp create my-server
```

---

## 🎯 最终推荐

### 立即执行

**基础整合 - 官方SDK**:
```
harness/mcp/
├── client/                    # 核心：MCP协议客户端
│   └── (从mcp包提取)
├── server/                    # 核心：MCP Server支持
│   └── (从mcp包提取)
└── README.md                  # 文档和使用指南
```

**依赖**:
```toml
[dependencies]
mcp = "^1.28.1"
```

**工作量**: 2-3小时
- 安装mcp包
- 提取client/server模块到harness
- 创建README和示例
- 编写集成测试

---

### 可选扩展

1. **FastMCP集成** (如果需要简化API)
   - 工作量: +1小时
   - 依赖: `fastmcp >= 3.4.2`

2. **多Provider支持** (Anthropic, OpenAI等)
   - 工作量: +2小时
   - 依赖: `fastmcp[anthropic,openai,azure,gemini]`

---

## 📋 集成步骤

### Step 1: 创建目录结构
```bash
mkdir -p harness/mcp/{client,server,shared,examples}
```

### Step 2: 安装依赖
```bash
pip install mcp==1.28.1
```

### Step 3: 提取核心模块
```bash
# 方式A: 直接依赖mcp包（推荐）
# 在harness/mcp/__init__.py中 re-export

# 方式B: 复制源码（如果需要定制）
cp -r $(python -c "import mcp; print(mcp.__path__[0])")/{client,server,shared} harness/mcp/
```

### Step 4: 创建文档和示例
```bash
# README.md - 使用说明
# examples/simple_server.py - Server示例
# examples/simple_client.py - Client示例
```

### Step 5: 测试验证
```bash
# 运行示例
python harness/mcp/examples/simple_server.py
python harness/mcp/examples/simple_client.py
```

---

## 🔗 参考资源

- **MCP Specification**: https://spec.modelcontextprotocol.io/
- **Python SDK Docs**: https://py.sdk.modelcontextprotocol.io/
- **GitHub Repo**: https://github.com/modelcontextprotocol/python-sdk
- **FastMCP**: https://gofastmcp.com

---

## ⚠️ 注意事项

1. **版本锁定**: 使用v1.x，添加`<2`上界约束
2. **依赖冲突**: 检查pydantic版本兼容性（需要>=2.11.0）
3. **实验性功能**: `experimental/`模块API可能变更
4. **v2迁移**: 关注v2.x稳定版发布，提前准备迁移

---

调研完成！建议立即开始方案A（官方SDK）的整合。✅
