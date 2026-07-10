#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
	harnessRoot,
	"_magenta/process-tools/Cargo.toml",
);
const cargo = process.env.CARGO || "cargo";
const result = spawnSync(
	cargo,
	["build", "--release", "--locked", "--manifest-path", manifestPath],
	{
		cwd: harnessRoot,
		stdio: "inherit",
		shell: process.platform === "win32",
	},
);

if (result.error) {
	throw new Error(`Unable to start ${cargo}: ${result.error.message}`);
}
if (result.status !== 0) {
	throw new Error(`Magenta process-tools build failed with status ${result.status ?? "unknown"}`);
}
