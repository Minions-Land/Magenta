import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	findProcessToolsPrebuildFailures,
	inspectPortableLinuxElf,
} from "../pi/coding-agent/scripts/check-process-tools.mjs";

function makeElf64({ glibc = false, interpreter = false } = {}) {
	const suffix = glibc ? Buffer.from("GLIBC_2.39\0", "ascii") : Buffer.alloc(0);
	const programHeaderOffset = interpreter ? 64 : 0;
	const programHeaderSize = interpreter ? 56 : 0;
	const content = Buffer.alloc((interpreter ? 120 : 64) + suffix.length);
	content.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
	content.writeBigUInt64LE(BigInt(programHeaderOffset), 32);
	content.writeUInt16LE(programHeaderSize, 54);
	content.writeUInt16LE(interpreter ? 1 : 0, 56);
	if (interpreter) content.writeUInt32LE(3, programHeaderOffset);
	suffix.copy(content, content.length - suffix.length);
	return content;
}

test("accepts a static ELF64 Linux process-tools binary", () => {
	assert.deepEqual(inspectPortableLinuxElf(makeElf64()), []);
});

test("rejects a Linux process-tools binary with an interpreter or glibc symbols", () => {
	assert.deepEqual(inspectPortableLinuxElf(makeElf64({ glibc: true, interpreter: true })), [
		"must be statically linked without a PT_INTERP segment",
		"must not depend on versioned glibc symbols",
	]);
});

test("rejects a non-ELF Linux process-tools payload", () => {
	assert.deepEqual(inspectPortableLinuxElf(Buffer.from("not an ELF")), [
		"must be a little-endian ELF64 binary",
	]);
});

test("rejects a process-tools prebuilt that does not match its receipt", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "magenta-process-tools-portability-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const processToolsDirectory = join(root, "_magenta/process-tools/prebuilt");
	const processTools = [
		"magenta-process-tools-macos-arm64",
		"magenta-process-tools-macos-x64",
		"magenta-process-tools-linux-x64",
		"magenta-process-tools-windows-x64.exe",
	];
	await mkdir(processToolsDirectory, { recursive: true });
	const receipt = [];
	for (const name of processTools) {
		const content = name === "magenta-process-tools-linux-x64" ? makeElf64() : Buffer.from(name);
		await writeFile(join(processToolsDirectory, name), content);
		const digest = createHash("sha256").update(content).digest("hex");
		receipt.push(`${name === "magenta-process-tools-linux-x64" ? "0".repeat(64) : digest}  ${name}`);
	}
	await writeFile(join(processToolsDirectory, "SHA256SUMS"), `${receipt.join("\n")}\n`);

	for (const tool of ["fd", "rg"]) {
		const directory = join(root, `_magenta/${tool}/prebuilt`);
		await mkdir(directory, { recursive: true });
		for (const platform of ["macos-arm64", "macos-x64", "linux-x64", "windows-x64.exe"]) {
			await writeFile(join(directory, `${tool}-${platform}`), tool);
		}
	}

	assert.ok(
		findProcessToolsPrebuildFailures(root).includes(
			"process-tools: magenta-process-tools-linux-x64 does not match prebuilt/SHA256SUMS",
		),
	);

	await writeFile(
		join(processToolsDirectory, "SHA256SUMS"),
		`${receipt.filter((line) => !line.endsWith("magenta-process-tools-linux-x64")).join("\n")}\n`,
	);
	assert.ok(
		findProcessToolsPrebuildFailures(root).includes(
			"process-tools: prebuilt/SHA256SUMS is missing magenta-process-tools-linux-x64",
		),
	);
});
