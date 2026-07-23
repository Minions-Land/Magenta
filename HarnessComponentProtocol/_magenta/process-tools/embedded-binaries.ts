/**
 * Embedded process-tools binary manager
 *
 * Bun 编译时将平台特定的 magenta-process-tools 二进制嵌入虚拟文件系统。
 * 首次运行时，此模块会将二进制解压到 ~/.magenta/cache/process-tools/<sha256>/
 * 并返回真实文件路径供 HCP 工具使用。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HcpClientisbunbinaryurl } from "../../HcpClient.ts";
import { isAtomicallyMaterializedExecutable, materializeExecutableAtomically } from "../utils/pi/atomic-executable.ts";
import { materializeLeasedContentAddressedExecutable } from "../utils/pi/helper-cache-maintenance.ts";
import { getEmbeddedHelperCacheRoot, getEmbeddedHelperTrustedRoot } from "../utils/pi/helper-cache-root.ts";
import { registerProcessToolCommandOverride } from "./command-registry.ts";

// 平台检测
const PLATFORM = process.platform;
const ARCH = process.arch;

function getHarnessRoot(): string {
	const isBunBinary = typeof (globalThis as any).Bun !== "undefined" && HcpClientisbunbinaryurl(import.meta.url);
	return resolve(isBunBinary ? dirname(process.execPath) : fileURLToPath(new URL("../..", import.meta.url)));
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

function runtimeBinaryName(): string {
	return PLATFORM === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools";
}

function manifestLogicalCommandPath(hcpRoot: string): string {
	// Manifests intentionally omit .exe; ensureCommandReady adds it in source
	// development, while compiled releases replace this logical path in-process.
	return join(hcpRoot, "_magenta", "process-tools", "target", "release", "magenta-process-tools");
}

function developmentTargetPath(hcpRoot: string): string {
	return join(hcpRoot, "_magenta", "process-tools", "target", "release", runtimeBinaryName());
}

function materializeEmbeddedBinary(embeddedPath: string): string {
	return materializeLeasedContentAddressedExecutable({
		content: readFileSync(embeddedPath),
		cacheDirectory: join(getEmbeddedHelperCacheRoot(), "process-tools"),
		executableName: runtimeBinaryName(),
		trustedRoot: getEmbeddedHelperTrustedRoot(),
	});
}

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

	return materializeEmbeddedBinary(embeddedPath);
}

/**
 * 初始化：确保 process-tools 二进制可用
 * 应在 HcpClient 装配前调用
 *
 * 策略：
 * 1. Bun 编译产物将 helper 提取到内容寻址缓存，并把静态 manifest
 *    命令绑定到本进程的不可变路径。
 * 2. Node/source 开发仍维护 canonical target/release 路径。
 */
export function initProcessToolsBinary(hcpRoot = getHarnessRoot()): string {
	try {
		const embeddedPath = getEmbeddedBinaryPath();
		const binaryPath = embeddedPath ? materializeEmbeddedBinary(embeddedPath) : getProcessToolsBinaryPath();
		if (!existsSync(binaryPath)) {
			throw new Error(`Process-tools binary not found: ${binaryPath}`);
		}

		let selectedPath = binaryPath;
		if (!embeddedPath) {
			const targetBinaryPath = developmentTargetPath(hcpRoot);
			const binaryContent = readFileSync(binaryPath);
			const alreadyCurrent = isAtomicallyMaterializedExecutable(targetBinaryPath, binaryContent);
			materializeExecutableAtomically({
				content: binaryContent,
				destinationPath: targetBinaryPath,
				directoryMode: 0o755,
				trustedRoot: hcpRoot,
			});
			selectedPath = targetBinaryPath;
			// stdout is a machine protocol in JSON/RPC modes; bootstrap diagnostics must
			// never corrupt its framing.
			if (!alreadyCurrent) console.error(`[Magenta] Process-tools binary installed at ${targetBinaryPath}`);
		}

		registerProcessToolCommandOverride(manifestLogicalCommandPath(hcpRoot), selectedPath);
		return selectedPath;
	} catch (error) {
		console.error("[Magenta] Failed to initialize process-tools binary:", error);
		throw error;
	}
}
