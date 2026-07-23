import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
	type ClipboardModule,
	createExecutableClipboardRequires,
	createLazyClipboardNative,
	getPackagedClipboardNativeRequest,
	loadClipboardNative,
} from "../src/utils/clipboard-native.ts";

type ClipboardRequire = (id: string) => unknown;

const fakeClipboard: ClipboardModule = {
	getText: async () => "",
	setText: async () => {},
	hasImage: () => true,
	getImageBinary: async () => [1, 2, 3],
};

describe("loadClipboardNative", () => {
	test("does not load a native addon until first use and caches that result", () => {
		const load = vi.fn(() => fakeClipboard);
		const getClipboard = createLazyClipboardNative(load, () => true);

		expect(load).not.toHaveBeenCalled();
		expect(getClipboard()).toBe(fakeClipboard);
		expect(getClipboard()).toBe(fakeClipboard);
		expect(load).toHaveBeenCalledTimes(1);
	});

	test("does not attempt native loading when the runtime has no clipboard", () => {
		const load = vi.fn(() => fakeClipboard);
		const getClipboard = createLazyClipboardNative(load, () => false);

		expect(getClipboard()).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	test("falls back to the next require root", () => {
		const primary = vi.fn<ClipboardRequire>(() => {
			throw new Error("missing from bundled root");
		});
		const fallback = vi.fn<ClipboardRequire>(() => fakeClipboard);

		expect(loadClipboardNative([primary, fallback])).toBe(fakeClipboard);
		expect(primary).toHaveBeenCalledWith("@mariozechner/clipboard");
		expect(fallback).toHaveBeenCalledWith("@mariozechner/clipboard");
	});

	test("returns null when no require root can load clipboard", () => {
		const missing = vi.fn<ClipboardRequire>(() => {
			throw new Error("missing");
		});

		expect(loadClipboardNative([missing])).toBeNull();
	});

	test("loads a clipboard package stored under the executable runtime resources", async () => {
		const root = await mkdtemp(join(tmpdir(), "magenta-clipboard-runtime-"));
		try {
			const packageRoot = join(root, "runtime", "node_modules", "@mariozechner", "clipboard");
			await mkdir(packageRoot, { recursive: true });
			await writeFile(join(packageRoot, "package.json"), '{"name":"@mariozechner/clipboard","main":"index.js"}\n');
			await writeFile(
				join(packageRoot, "index.js"),
				"module.exports = { getText: async () => '', setText: async () => {}, hasImage: () => true, getImageBinary: async () => [4, 5, 6] };\n",
			);

			const executableRequires = createExecutableClipboardRequires(join(root, "magenta"), "aix", "ppc64");
			const loaded = loadClipboardNative(executableRequires);
			expect(loaded?.hasImage()).toBe(true);
			expect(await loaded?.getImageBinary()).toEqual([4, 5, 6]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("maps released binary targets directly to their native binding files", () => {
		expect(getPackagedClipboardNativeRequest("darwin", "arm64")).toBe(
			"@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node",
		);
		expect(getPackagedClipboardNativeRequest("linux", "x64")).toBe(
			"@mariozechner/clipboard-linux-x64-gnu/clipboard.linux-x64-gnu.node",
		);
		expect(getPackagedClipboardNativeRequest("win32", "x64")).toBe(
			"@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
		);
		expect(getPackagedClipboardNativeRequest("linux", "arm64")).toBeUndefined();
	});
});
