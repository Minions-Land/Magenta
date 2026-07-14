#!/usr/bin/env node
// Deterministic entrypoint for the native TypeScript 7 compiler.
//
// Why this exists: once a classic-TypeScript-API consumer (e.g.
// `@typescript/typescript6`, which depends on `@typescript/old` = real
// `typescript@6.x`) is installed alongside native `typescript@7`, both
// packages ship a `tsc` binary. npm's bin linking resolves that name
// conflict deterministically in favor of `@typescript/old`, so a bare
// `tsc` on PATH silently runs the slow JS compiler instead of native 7 —
// regardless of workspace or install order (verified with a clean
// `npm install`). Resolving the `typescript` package by name from this
// file's own location (not the caller's cwd) sidesteps that collision
// entirely and always reaches native 7.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const nativeTscBin = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");

const result = spawnSync(process.execPath, [nativeTscBin, ...process.argv.slice(2)], {
	stdio: "inherit",
});

if (result.error) {
	console.error(result.error);
	process.exit(1);
}
process.exit(result.status ?? 1);
