# Changelog

所有 Magenta CLI 的重要更改都会记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [0.0.6] - 2026-07-11

### 重大改进
- **所有工具开箱即用**：内嵌 fd 和 rg 二进制，实现 100% 工具可用性
- **自动化发布流程**：GitHub Actions 自动构建和发布

### 新增
- 内嵌 fd (v10.2.0) 和 rg (v14.1.1) 的 4 平台预编译二进制
- 创建 `embedded-tools.ts` 统一管理 fd/rg/process-tools 的内嵌式分发
- 添加 GitHub Actions release workflow 自动化发布
- 构建检查脚本验证所有工具（process-tools/fd/rg）的二进制完整性

### 修复
- 修复 find 工具缺少 fd 二进制的问题
- 修复 grep 工具缺少 rg 二进制的问题

### 变更
- 清理 README.md，移除上游项目引用
- 更新安装说明为一键脚本 + GitHub Releases
- 二进制大小增加约 30MB（fd ~10MB + rg ~20MB）

### 工具可用性提升
| 版本 | 可用工具 | 失败工具 | 可用率 |
|------|---------|---------|-------|
| v0.0.4 | 10/25 | 15 | 40% |
| v0.0.5 | 22/25 | 3 (find/grep/lsp) | 88% |
| **v0.0.6** | **25/25** | **0** | **100%** |

## [0.0.5] - 2026-07-11

### 重大改进
- **内嵌式单文件分发**：将 4 平台的 `magenta-process-tools` 二进制嵌入主程序
- **自动解压机制**：首次运行时自动提取到 `~/.magenta/cache/process-tools/`
- **零配置开箱即用**：所有核心工具（bash/read/write/edit/grep/web-search）无需额外设置

### 新增
- GitHub Actions CI 自动化四平台交叉编译
- 构建前检查脚本确保所有平台二进制就绪
- 内嵌式二进制管理器处理提取、缓存、路径解析

### 修复
- 修复所有平台缺少 `magenta-process-tools` 二进制的问题
- 修复 Bun 编译环境下 `HCP_ROOT` 路径解析错误
- 修复安装脚本未下载运行时资源包的问题

### 变更
- 清理 CHANGELOG，移除上游 Pi 项目的历史记录
- 资源包从 4MB 缩减到 3.8MB（process-tools 已内嵌到主程序）
- 二进制大小增加到 114-147MB（包含嵌入的 4 个平台 process-tools）

## [未发布]

### 新增
- GitHub Actions CI 自动化四平台交叉编译 `magenta-process-tools`

### 修复
- 修复所有平台缺少 `magenta-process-tools` 二进制的问题
- 修复 Bun 编译环境下 `HCP_ROOT` 路径解析错误
- 修复安装脚本未下载运行时资源包的问题

## [0.0.4] - 2026-07-11

### 修复
- 修复 v0.0.3 的 HCP 组件资源未打包问题
- 修复二进制启动时报错 `ENOENT: sandbox/sandbox.toml`
- 优化安装脚本，支持平台特定资源包下载

### 已知问题
- macOS arm64 之外的平台缺少预编译的 `magenta-process-tools` 二进制
- 部分核心工具（bash/read/write/edit/grep/web-search）可能无法工作

## [0.0.3] - 2026-07-10

### 修复
- 修复发布包缺少 HarnessComponentProtocol 资源的问题

### 已知问题
- 所有平台启动失败，缺少 sandbox/tools/policy/runtime 资源

## [0.0.2] - 2026-07-09

### 新增
- 四平台二进制发布（macOS arm64/x64, Linux x64, Windows x64）
- 一键安装脚本
- 基础功能验证

## [0.0.1] - 2026-07-08

### 新增
- Magenta CLI 初始版本
- 基于 Pi Coding Agent 架构
- 多模型支持（Google、Anthropic、OpenAI 等）
- 交互式 TUI 模式
- 文件操作工具（read、write、edit、bash、grep）
- 会话管理和历史记录
- 子代理和后台任务支持
- 技能系统（paper-analysis、pptx、research-orchestration）
