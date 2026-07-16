#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultHarnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function getPrebuiltBinaryName(platform, arch) {
	if (platform === "darwin" && arch === "arm64") return "magenta-process-tools-macos-arm64";
	if (platform === "darwin" && arch === "x64") return "magenta-process-tools-macos-x64";
	if (platform === "linux" && arch === "x64") return "magenta-process-tools-linux-x64";
	if (platform === "win32" && arch === "x64") return "magenta-process-tools-windows-x64.exe";
	return undefined;
}

export function buildProcessTools({
	arch = process.arch,
	cargo = process.env.CARGO || "cargo",
	harnessRoot = defaultHarnessRoot,
	platform = process.platform,
	spawn = spawnSync,
} = {}) {
	const processToolsRoot = resolve(harnessRoot, "_magenta/process-tools");
	const manifestPath = join(processToolsRoot, "Cargo.toml");
	const targetRoot = join(processToolsRoot, "target");
	const releaseDir = join(targetRoot, "release");
	const targetPath = join(releaseDir, platform === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools");
	const result = spawn(
		cargo,
		["build", "--release", "--locked", "--manifest-path", manifestPath, "--target-dir", targetRoot],
		{
			cwd: harnessRoot,
			stdio: "inherit",
			shell: false,
		},
	);

	if (result.error) {
		if (result.error.code !== "ENOENT") {
			throw new Error(`Unable to start ${cargo}: ${result.error.message}`);
		}

		const prebuiltName = getPrebuiltBinaryName(platform, arch);
		if (!prebuiltName) {
			throw new Error(
				`Cargo is unavailable and no process-tools prebuilt supports ${platform}-${arch}. Install Cargo to build from source.`,
			);
		}

		const prebuiltPath = join(processToolsRoot, "prebuilt", prebuiltName);
		if (!existsSync(prebuiltPath)) {
			throw new Error(`Cargo is unavailable and the process-tools prebuilt is missing: ${prebuiltPath}`);
		}

		mkdirSync(releaseDir, { recursive: true });
		copyFileSync(prebuiltPath, targetPath);
		if (platform !== "win32") chmodSync(targetPath, 0o755);
		console.warn(`[Magenta] Cargo is unavailable; using process-tools prebuilt ${prebuiltName}.`);
		return { path: targetPath, source: "prebuilt" };
	}

	if (result.status !== 0) {
		throw new Error(`Magenta process-tools build failed with status ${result.status ?? "unknown"}`);
	}
	if (!existsSync(targetPath)) {
		throw new Error(`Cargo reported success but did not produce the expected process-tools binary: ${targetPath}`);
	}

	return { path: targetPath, source: "cargo" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	buildProcessTools();
}
