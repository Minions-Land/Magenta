import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProcessToolCommandOverride } from "../_magenta/process-tools/command-registry.ts";
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
		expect(HcpClientisbunbinaryurl("file:///Users/test-user/Magenta3/HarnessComponentProtocol/HcpClient.ts")).toBe(
			false,
		);
	});
});

describe("embedded process-tools installation", () => {
	let root: string | undefined;

	function currentPrebuiltName(): string | undefined {
		if (process.platform === "darwin" && process.arch === "arm64") return "magenta-process-tools-macos-arm64";
		if (process.platform === "darwin" && process.arch === "x64") return "magenta-process-tools-macos-x64";
		if (process.platform === "linux" && process.arch === "x64") return "magenta-process-tools-linux-x64";
		if (process.platform === "win32" && process.arch === "x64") return "magenta-process-tools-windows-x64.exe";
		return undefined;
	}

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("prefers a local release build over the checked-in prebuilt", () => {
		const prebuiltName = currentPrebuiltName();
		if (!prebuiltName) return;

		root = mkdtempSync(join(tmpdir(), "magenta-process-tools-"));
		const releaseDir = join(root, "_magenta/process-tools/target/release");
		const prebuiltDir = join(root, "_magenta/process-tools/prebuilt");
		const releasePath = join(
			releaseDir,
			process.platform === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools",
		);
		mkdirSync(releaseDir, { recursive: true });
		mkdirSync(prebuiltDir, { recursive: true });
		writeFileSync(releasePath, "local cargo build");
		writeFileSync(join(prebuiltDir, prebuiltName), "checked-in prebuilt");

		expect(getProcessToolsBinaryPath(root)).toBe(releasePath);
	});

	it("falls back to the checked-in prebuilt when no local release exists", () => {
		const prebuiltName = currentPrebuiltName();
		if (!prebuiltName) return;

		root = mkdtempSync(join(tmpdir(), "magenta-process-tools-"));
		const prebuiltDir = join(root, "_magenta/process-tools/prebuilt");
		const prebuiltPath = join(prebuiltDir, prebuiltName);
		mkdirSync(prebuiltDir, { recursive: true });
		writeFileSync(prebuiltPath, "checked-in prebuilt");

		expect(getProcessToolsBinaryPath(root)).toBe(prebuiltPath);
	});

	it("replaces a stale helper without writing bootstrap diagnostics to stdout", () => {
		root = mkdtempSync(join(tmpdir(), "magenta-process-tools-"));
		const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const target = join(
				root,
				"_magenta/process-tools/target/release",
				process.platform === "win32" ? "magenta-process-tools.exe" : "magenta-process-tools",
			);
			const logicalCommand = join(root, "_magenta/process-tools/target/release", "magenta-process-tools");
			expect(initProcessToolsBinary(root)).toBe(target);
			expect(existsSync(target)).toBe(true);
			expect(resolveProcessToolCommandOverride(logicalCommand)).toBe(target);

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

	it("normalizes the default source harness root before atomic materialization", () => {
		const installed = initProcessToolsBinary();
		expect(installed).toBe(resolve(installed));
		expect(existsSync(installed)).toBe(true);
	});
});
