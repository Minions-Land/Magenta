/**
 * Embedded fd/rg binaries manager
 *
 * 与 process-tools 类似，Bun 编译时将 fd 和 rg 的 4 个平台二进制嵌入。
 * 首次运行时解压到 ~/.magenta/cache/{fd,rg}/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const PLATFORM = process.platform;
const ARCH = process.arch;
// 确定当前平台的二进制文件名
function getEmbeddedBinaryName(tool) {
    const isWindows = PLATFORM === "win32";
    const ext = isWindows ? ".exe" : "";
    if (PLATFORM === "darwin") {
        const archSuffix = ARCH === "arm64" ? "macos-arm64" : "macos-x64";
        return `${tool}-${archSuffix}${ext}`;
    }
    else if (PLATFORM === "linux") {
        return `${tool}-linux-x64${ext}`;
    }
    else if (PLATFORM === "win32") {
        return `${tool}-windows-x64${ext}`;
    }
    throw new Error(`Unsupported platform: ${PLATFORM} ${ARCH}`);
}
// 动态导入嵌入的二进制
function getEmbeddedBinaryPath(tool) {
    try {
        if (PLATFORM === "darwin" && ARCH === "arm64") {
            if (tool === "fd")
                return require("../../_magenta/fd/prebuilt/fd-macos-arm64");
            if (tool === "rg")
                return require("../../_magenta/rg/prebuilt/rg-macos-arm64");
        }
        else if (PLATFORM === "darwin" && ARCH === "x64") {
            if (tool === "fd")
                return require("../../_magenta/fd/prebuilt/fd-macos-x64");
            if (tool === "rg")
                return require("../../_magenta/rg/prebuilt/rg-macos-x64");
        }
        else if (PLATFORM === "linux" && ARCH === "x64") {
            if (tool === "fd")
                return require("../../_magenta/fd/prebuilt/fd-linux-x64");
            if (tool === "rg")
                return require("../../_magenta/rg/prebuilt/rg-linux-x64");
        }
        else if (PLATFORM === "win32" && ARCH === "x64") {
            if (tool === "fd")
                return require("../../_magenta/fd/prebuilt/fd-windows-x64.exe");
            if (tool === "rg")
                return require("../../_magenta/rg/prebuilt/rg-windows-x64.exe");
        }
    }
    catch {
        return null;
    }
    return null;
}
// 缓存目录
function getCacheDir(tool) {
    return join(homedir(), ".magenta", "cache", tool);
}
function getCacheBinaryPath(tool) {
    const cacheDir = getCacheDir(tool);
    const binaryName = PLATFORM === "win32" ? `${tool}.exe` : tool;
    return join(cacheDir, binaryName);
}
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
export function getEmbeddedToolPath(tool) {
    const embeddedPath = getEmbeddedBinaryPath(tool);
    // 开发环境或非嵌入场景
    if (!embeddedPath) {
        const devPath = join(process.cwd(), `HarnessComponentProtocol/_magenta/${tool}/prebuilt`, getEmbeddedBinaryName(tool));
        if (existsSync(devPath)) {
            return devPath;
        }
        return null;
    }
    // 嵌入场景：检查缓存
    const cachePath = getCacheBinaryPath(tool);
    if (existsSync(cachePath)) {
        // 验证缓存文件的完整性
        try {
            const embeddedContent = readFileSync(embeddedPath);
            const cachedContent = readFileSync(cachePath);
            const embeddedHash = createHash("sha256").update(embeddedContent).digest("hex");
            const cachedHash = createHash("sha256").update(cachedContent).digest("hex");
            if (embeddedHash === cachedHash) {
                return cachePath;
            }
        }
        catch {
            // 缓存文件损坏，重新提取
        }
    }
    // 提取嵌入的二进制到缓存
    const cacheDir = getCacheDir(tool);
    mkdirSync(cacheDir, { recursive: true });
    const embeddedContent = readFileSync(embeddedPath);
    writeFileSync(cachePath, embeddedContent);
    chmodSync(cachePath, 0o755);
    return cachePath;
}
/**
 * 初始化 fd 和 rg 二进制
 * 在 tools-manager 中调用
 */
export function initEmbeddedTools() {
    // 静默初始化，不输出日志（避免干扰用户）
    try {
        getEmbeddedToolPath("fd");
        getEmbeddedToolPath("rg");
    }
    catch {
        // 忽略错误，fallback 到 tools-manager 的下载逻辑
    }
}
//# sourceMappingURL=embedded-tools.js.map