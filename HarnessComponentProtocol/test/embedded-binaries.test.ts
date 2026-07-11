import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessToolsBinaryPath, initProcessToolsBinary } from "../_magenta/process-tools/embedded-binaries.ts";

describe("embedded process-tools installation", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("replaces a stale installed helper with the current bundled binary", () => {
		root = mkdtempSync(join(tmpdir(), "magenta-process-tools-"));
		initProcessToolsBinary(root);
		const target = join(
			root,
			"_magenta/process-tools/target/release",
			process.platform === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools",
		);
		expect(existsSync(target)).toBe(true);

		writeFileSync(target, "stale helper");
		initProcessToolsBinary(root);

		expect(readFileSync(target)).toEqual(readFileSync(getProcessToolsBinaryPath()));
	});
});
