/**
 * Embedded process-tools binary manager
 *
 * Bun 编译时将平台特定的 magenta-process-tools 二进制嵌入虚拟文件系统。
 * 首次运行时，此模块会将二进制解压到 ~/.magenta/cache/process-tools/
 * 并返回真实文件路径供 HCP 工具使用。
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HcpClientisbunbinaryurl } from "../../HcpClient.ts";

// 平台检测
const PLATFORM = process.platform;
const ARCH = process.arch;

function getHarnessRoot(): string {
	const isBunBinary = typeof (globalThis as any).Bun !== "undefined" && HcpClientisbunbinaryurl(import.meta.url);
	return isBunBinary ? dirname(process.execPath) : fileURLToPath(new URL("../..", import.meta.url));
}

// 确定当前平台的二进制文件名
function getEmbeddedBinaryName(): string {
	if (PLATFORM === "darwin" && ARCH === "arm64") return "magenta-process-tools-macos-arm64";
	if (PLATFORM === "darwin" && ARCH === "x64") return "magenta-process-tools-macos-x64";
	if (PLATFORM === "linux" && ARCH === "x64") return "magenta-process-tools-linux-x64";
	if (PLATFORM === "win32" && ARCH === "x64") return "magenta-process-tools-windows-x64.exe";
	throw new Error(`Unsupported process-tools platform: ${PLATFORM} ${ARCH}`);
}

// 动态导入嵌入的二进制（编译时条件导入）
function getEmbeddedBinaryPath(): string | null {
	const isBunBinary = typeof (globalThis as any).Bun !== "undefined" && HcpClientisbunbinaryurl(import.meta.url);
	if (!isBunBinary) return null;

	try {
		// Bun 编译时，会根据 target 平台只打包对应的二进制
		// 这里的路径会在编译时被解析为虚拟路径
		if (PLATFORM === "darwin" && ARCH === "arm64") {
			return require("./prebuilt/magenta-process-tools-macos-arm64");
		} else if (PLATFORM === "darwin" && ARCH === "x64") {
			return require("./prebuilt/magenta-process-tools-macos-x64");
		} else if (PLATFORM === "linux" && ARCH === "x64") {
			return require("./prebuilt/magenta-process-tools-linux-x64");
		} else if (PLATFORM === "win32" && ARCH === "x64") {
			return require("./prebuilt/magenta-process-tools-windows-x64.exe");
		}
	} catch {
		// 开发环境或未嵌入场景
		return null;
	}

	return null;
}

// 缓存目录
const CACHE_DIR = join(homedir(), ".magenta", "cache", "process-tools");
const CACHE_BINARY_PATH = join(CACHE_DIR, PLATFORM === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools");

/**
 * 获取 magenta-process-tools 的真实文件路径
 *
 * 如果是 Bun 编译的二进制：
 * 1. 检查缓存目录是否已有有效二进制
 * 2. 如果没有，从嵌入的虚拟路径读取并写入缓存
 * 3. 返回缓存路径
 *
 * 如果是开发环境：
 * 优先返回本地构建目标，不存在时回退到当前平台的预编译二进制
 */
export function getProcessToolsBinaryPath(harnessRoot = getHarnessRoot()): string {
	const embeddedPath = getEmbeddedBinaryPath();

	// 开发环境优先使用 Cargo 或构建回退准备好的 canonical target。
	if (!embeddedPath) {
		const releasePath = join(
			harnessRoot,
			"_magenta/process-tools/target/release",
			PLATFORM === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools",
		);
		if (existsSync(releasePath)) {
			return releasePath;
		}

		const prebuiltPath = join(harnessRoot, "_magenta/process-tools/prebuilt", getEmbeddedBinaryName());
		if (existsSync(prebuiltPath)) {
			return prebuiltPath;
		}
		return releasePath;
	}

	// 嵌入场景：检查缓存
	if (existsSync(CACHE_BINARY_PATH)) {
		// 验证缓存文件的完整性（比较文件大小或哈希）
		try {
			const embeddedContent = readFileSync(embeddedPath);
			const cachedContent = readFileSync(CACHE_BINARY_PATH);

			const embeddedHash = createHash("sha256").update(embeddedContent).digest("hex");
			const cachedHash = createHash("sha256").update(cachedContent).digest("hex");

			if (embeddedHash === cachedHash) {
				return CACHE_BINARY_PATH;
			}
		} catch {
			// 缓存文件损坏，重新提取
		}
	}

	// 提取嵌入的二进制到缓存
	console.error(`[Magenta] Extracting process-tools binary to ${CACHE_DIR}...`);
	mkdirSync(CACHE_DIR, { recursive: true });

	const embeddedContent = readFileSync(embeddedPath);
	writeFileSync(CACHE_BINARY_PATH, embeddedContent);
	chmodSync(CACHE_BINARY_PATH, 0o755); // 添加执行权限

	console.error(`[Magenta] Process-tools binary ready at ${CACHE_BINARY_PATH}`);
	return CACHE_BINARY_PATH;
}

/**
 * 初始化：确保 process-tools 二进制可用
 * 应在 HcpClient 装配前调用
 *
 * 策略：
 * 1. 在 Bun 编译的二进制中，从嵌入路径提取到缓存
 * 2. 安装到 HCP_ROOT/_magenta/process-tools/target/release/
 * 3. 这样 .toml 中的相对路径 "../../../_magenta/process-tools/target/release/magenta-process-tools" 可以正常工作
 */
export function initProcessToolsBinary(hcpRoot = getHarnessRoot()): void {
	try {
		const binaryPath = getProcessToolsBinaryPath();
		if (!existsSync(binaryPath)) {
			throw new Error(`Process-tools binary not found: ${binaryPath}`);
		}

		// Tool manifests resolve ../../../_magenta from HCP_ROOT/tools/<tool>/magenta.
		const targetDir = join(hcpRoot, "_magenta", "process-tools", "target", "release");
		mkdirSync(targetDir, { recursive: true });

		const targetBinaryPath = join(
			targetDir,
			PLATFORM === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools",
		);

		// Keep the installed helper in lockstep with the binary bundled by the
		// current Magenta version. A path-only check would leave an older helper in
		// place forever after upgrades.
		if (existsSync(targetBinaryPath)) {
			try {
				const sourceHash = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
				const targetHash = createHash("sha256").update(readFileSync(targetBinaryPath)).digest("hex");
				if (sourceHash === targetHash) return;
			} catch {
				// Replace unreadable or incomplete targets below.
			}
		}

		// 复制二进制到目标位置（Windows 不支持符号链接，统一用复制）
		const binaryContent = readFileSync(binaryPath);
		writeFileSync(targetBinaryPath, binaryContent);
		chmodSync(targetBinaryPath, 0o755);

		// stdout is a machine protocol in JSON/RPC modes; bootstrap diagnostics must
		// never corrupt its framing.
		console.error(`[Magenta] Process-tools binary installed at ${targetBinaryPath}`);
	} catch (error) {
		console.error("[Magenta] Failed to initialize process-tools binary:", error);
		throw error;
	}
}
