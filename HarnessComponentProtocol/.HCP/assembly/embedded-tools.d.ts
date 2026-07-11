/**
 * Embedded fd/rg binaries manager
 *
 * 与 process-tools 类似，Bun 编译时将 fd 和 rg 的 4 个平台二进制嵌入。
 * 首次运行时解压到 ~/.magenta/cache/{fd,rg}/
 */
type ToolName = "fd" | "rg";
/**
 * 获取工具的真实文件路径
 *
 * 如果是 Bun 编译的二进制：
 * 1. 检查缓存目录是否已有有效二进制
 * 2. 如果没有，从嵌入的虚拟路径读取并写入缓存
 * 3. 返回缓存路径
 *
 * 如果是开发环境：
 * 返回相对于当前目录的预编译二进制路径
 */
export declare function getEmbeddedToolPath(tool: ToolName): string | null;
/**
 * 初始化 fd 和 rg 二进制
 * 在 tools-manager 中调用
 */
export declare function initEmbeddedTools(): void;
export {};
//# sourceMappingURL=embedded-tools.d.ts.map