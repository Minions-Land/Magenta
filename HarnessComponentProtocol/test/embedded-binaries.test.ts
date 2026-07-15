import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessToolsBinaryPath, initProcessToolsBinary } from "../_magenta/process-tools/embedded-binaries.ts";
import { HcpClientisbunbinaryurl } from "../HcpClient.ts";

describe("Bun compiled-binary URL detection", () => {
	it.each([
		"file:///$bunfs/root/HarnessComponentProtocol/HcpClient.ts",
		"file:///B:/~BUN/root/magenta-windows-x64.exe",
		"file:///B:/%7EBUN/root/magenta-windows-x64.exe",
		"file:///B:/%7eBun/root/magenta-windows-x64.exe",
	])("recognizes Bun virtual URL %s", (url) => {
		expect(HcpClientisbunbinaryurl(url)).toBe(true);
	});

	it("does not classify a regular source URL as a compiled binary", () => {
		expect(HcpClientisbunbinaryurl("file:///Users/mjm/Magenta3/HarnessComponentProtocol/HcpClient.ts")).toBe(false);
	});
});

describe("embedded process-tools installation", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("replaces a stale helper without writing bootstrap diagnostics to stdout", () => {
		root = mkdtempSync(join(tmpdir(), "magenta-process-tools-"));
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			initProcessToolsBinary(root);
			const target = join(
				root,
				"_magenta/process-tools/target/release",
				process.platform === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools",
			);
			expect(existsSync(target)).toBe(true);

			writeFileSync(target, "stale helper");
			initProcessToolsBinary(root);

			expect(readFileSync(target).equals(readFileSync(getProcessToolsBinaryPath()))).toBe(true);
			expect(stdout).not.toHaveBeenCalled();
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Process-tools binary installed at"));
		} finally {
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});
});
