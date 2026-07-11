#!/usr/bin/env node

/**
 * Pre-build script: 确保 magenta-process-tools 预编译二进制存在
 * 
 * 在 Bun 编译前检查 HarnessComponentProtocol/_magenta/process-tools/prebuilt/ 
 * 是否包含所有 4 个平台的二进制文件。
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const harnessRoot = resolve(__dirname, "../../../HarnessComponentProtocol");
const prebuiltDir = resolve(harnessRoot, "_magenta/process-tools/prebuilt");

const requiredBinaries = [
	"magenta-process-tools-macos-arm64",
	"magenta-process-tools-macos-x64",
	"magenta-process-tools-linux-x64",
	"magenta-process-tools-windows-x64.exe",
];

const requiredFdBinaries = [
	"fd-macos-arm64",
	"fd-macos-x64",
	"fd-linux-x64",
	"fd-windows-x64.exe",
];

const requiredRgBinaries = [
	"rg-macos-arm64",
	"rg-macos-x64",
	"rg-linux-x64",
	"rg-windows-x64.exe",
];

let missingBinaries = [];

// 检查 process-tools
for (const binary of requiredBinaries) {
	const binaryPath = resolve(prebuiltDir, binary);
	if (!existsSync(binaryPath)) {
		missingBinaries.push(`process-tools: ${binary}`);
	}
}

// 检查 fd
const fdPrebuiltDir = resolve(harnessRoot, "_magenta/fd/prebuilt");
for (const binary of requiredFdBinaries) {
	const binaryPath = resolve(fdPrebuiltDir, binary);
	if (!existsSync(binaryPath)) {
		missingBinaries.push(`fd: ${binary}`);
	}
}

// 检查 rg
const rgPrebuiltDir = resolve(harnessRoot, "_magenta/rg/prebuilt");
for (const binary of requiredRgBinaries) {
	const binaryPath = resolve(rgPrebuiltDir, binary);
	if (!existsSync(binaryPath)) {
		missingBinaries.push(`rg: ${binary}`);
	}
}

if (missingBinaries.length > 0) {
	console.error("❌ 缺少预编译的二进制文件：");
	for (const binary of missingBinaries) {
		console.error(`   - ${binary}`);
	}
	console.error("");
	console.error("请先运行 GitHub Actions workflow 编译所有平台的二进制：");
	console.error("  gh workflow run build-process-tools.yml");
	console.error("");
	console.error("或者从以下仓库下载预编译版本：");
	console.error("  fd: https://github.com/sharkdp/fd/releases");
	console.error("  rg: https://github.com/BurntSushi/ripgrep/releases");
	process.exit(1);
}

console.log("✅ 所有平台的二进制已就绪");
console.log("");
console.log("magenta-process-tools:");
for (const binary of requiredBinaries) {
	console.log(`   ✓ ${binary}`);
}
console.log("");
console.log("fd:");
for (const binary of requiredFdBinaries) {
	console.log(`   ✓ ${binary}`);
}
console.log("");
console.log("rg:");
for (const binary of requiredRgBinaries) {
	console.log(`   ✓ ${binary}`);
}
