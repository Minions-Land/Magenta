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

let missingBinaries = [];

for (const binary of requiredBinaries) {
	const binaryPath = resolve(prebuiltDir, binary);
	if (!existsSync(binaryPath)) {
		missingBinaries.push(binary);
	}
}

if (missingBinaries.length > 0) {
	console.error("❌ 缺少预编译的 magenta-process-tools 二进制文件：");
	for (const binary of missingBinaries) {
		console.error(`   - ${binary}`);
	}
	console.error("");
	console.error("请先运行 GitHub Actions workflow 编译所有平台的二进制：");
	console.error("  gh workflow run build-process-tools.yml");
	console.error("");
	console.error("或者手动编译本地平台：");
	console.error("  cd HarnessComponentProtocol/_magenta/process-tools");
	console.error("  cargo build --release");
	console.error("  mkdir -p prebuilt");
	console.error("  cp target/release/magenta-process-tools* prebuilt/");
	process.exit(1);
}

console.log("✅ 所有平台的 magenta-process-tools 二进制已就绪");
for (const binary of requiredBinaries) {
	console.log(`   ✓ ${binary}`);
}
