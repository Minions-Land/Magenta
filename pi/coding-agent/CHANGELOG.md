# Changelog

所有 Magenta CLI 的重要更改都会记录在这个文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

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
