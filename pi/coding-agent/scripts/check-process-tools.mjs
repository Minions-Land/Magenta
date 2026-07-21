#!/usr/bin/env node

/**
 * Pre-build script: 确保 magenta-process-tools 预编译二进制存在
 * 
 * 在 Bun 编译前检查 HarnessComponentProtocol/_magenta/process-tools/prebuilt/ 
 * 是否包含所有 4 个平台的二进制文件。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const harnessRoot = resolve(__dirname, "../../../HarnessComponentProtocol");

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

export function inspectPortableLinuxElf(content) {
	const failures = [];
	if (
		content.length < 64 ||
		content[0] !== 0x7f ||
		content[1] !== 0x45 ||
		content[2] !== 0x4c ||
		content[3] !== 0x46 ||
		content[4] !== 2 ||
		content[5] !== 1
	) {
		return ["must be a little-endian ELF64 binary"];
	}

	const programHeaderOffset = Number(content.readBigUInt64LE(32));
	const programHeaderSize = content.readUInt16LE(54);
	const programHeaderCount = content.readUInt16LE(56);
	if (!Number.isSafeInteger(programHeaderOffset)) {
		failures.push("has an unsafe ELF program header offset");
	} else if (programHeaderCount > 0 && programHeaderSize < 56) {
		failures.push("has an invalid ELF64 program header size");
	} else if (programHeaderOffset + programHeaderSize * programHeaderCount > content.length) {
		failures.push("has program headers outside the file");
	} else {
		for (let index = 0; index < programHeaderCount; index++) {
			const offset = programHeaderOffset + index * programHeaderSize;
			if (content.readUInt32LE(offset) === 3) {
				failures.push("must be statically linked without a PT_INTERP segment");
				break;
			}
		}
	}

	if (content.includes(Buffer.from("GLIBC_", "ascii"))) {
		failures.push("must not depend on versioned glibc symbols");
	}
	return failures;
}

function inspectPrebuiltReceipt(label, directory, requiredFiles) {
	const failures = [];
	const receiptPath = resolve(directory, "SHA256SUMS");
	if (!existsSync(receiptPath)) return [`${label}: prebuilt/SHA256SUMS`];

	const receiptEntries = new Map();
	for (const line of readFileSync(receiptPath, "utf8").split("\n")) {
		if (!line) continue;
		const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
		if (!match || receiptEntries.has(match[2])) {
			failures.push(`${label}: prebuilt/SHA256SUMS is malformed or contains duplicates`);
			continue;
		}
		receiptEntries.set(match[2], match[1]);
	}
	for (const file of requiredFiles) {
		const expected = receiptEntries.get(file);
		if (!expected) {
			failures.push(`${label}: prebuilt/SHA256SUMS is missing ${file}`);
			continue;
		}
		receiptEntries.delete(file);
		const filePath = resolve(directory, file);
		if (!existsSync(filePath)) continue;
		const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
		if (actual !== expected) failures.push(`${label}: ${file} does not match prebuilt/SHA256SUMS`);
	}
	if (receiptEntries.size > 0) failures.push(`${label}: prebuilt/SHA256SUMS contains unexpected files`);
	return failures;
}

export function findProcessToolsPrebuildFailures(root = harnessRoot) {
	const failures = [];
	const processToolsPrebuiltDir = resolve(root, "_magenta/process-tools/prebuilt");
	for (const binary of requiredBinaries) {
		const binaryPath = resolve(processToolsPrebuiltDir, binary);
		if (!existsSync(binaryPath)) failures.push(`process-tools: ${binary}`);
	}

	const linuxProcessToolsPath = resolve(processToolsPrebuiltDir, "magenta-process-tools-linux-x64");
	if (existsSync(linuxProcessToolsPath)) {
		for (const failure of inspectPortableLinuxElf(readFileSync(linuxProcessToolsPath))) {
			failures.push(`process-tools: magenta-process-tools-linux-x64 ${failure}`);
		}
	}

	failures.push(...inspectPrebuiltReceipt("process-tools", processToolsPrebuiltDir, requiredBinaries));

	const fdPrebuiltDir = resolve(root, "_magenta/fd/prebuilt");
	for (const binary of requiredFdBinaries) {
		if (!existsSync(resolve(fdPrebuiltDir, binary))) failures.push(`fd: ${binary}`);
	}
	failures.push(...inspectPrebuiltReceipt("fd", fdPrebuiltDir, requiredFdBinaries));

	const rgPrebuiltDir = resolve(root, "_magenta/rg/prebuilt");
	for (const binary of requiredRgBinaries) {
		if (!existsSync(resolve(rgPrebuiltDir, binary))) failures.push(`rg: ${binary}`);
	}
	failures.push(...inspectPrebuiltReceipt("rg", rgPrebuiltDir, requiredRgBinaries));
	return failures;
}

function runCheck() {
	const failures = findProcessToolsPrebuildFailures();
	if (failures.length > 0) {
		console.error("❌ 预编译二进制缺失或不兼容：");
		for (const failure of failures) console.error(`   - ${failure}`);
		console.error("");
		console.error("请先运行 GitHub Actions workflow 编译所有平台的二进制：");
		console.error("  gh workflow run build-process-tools.yml");
		console.error("");
		console.error("或者从以下仓库下载预编译版本：");
		console.error("  fd: https://github.com/sharkdp/fd/releases");
		console.error("  rg: https://github.com/BurntSushi/ripgrep/releases");
		return 1;
	}

	console.log("✅ 所有平台的二进制已就绪");
	console.log("");
	for (const [label, binaries] of [
		["magenta-process-tools", requiredBinaries],
		["fd", requiredFdBinaries],
		["rg", requiredRgBinaries],
	]) {
		console.log(`${label}:`);
		for (const binary of binaries) console.log(`   ✓ ${binary}`);
		console.log("");
	}
	return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMain) process.exitCode = runCheck();
