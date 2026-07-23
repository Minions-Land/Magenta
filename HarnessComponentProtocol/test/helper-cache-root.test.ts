import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	configureEmbeddedHelperCacheRoot,
	getEmbeddedHelperCacheRoot,
	getEmbeddedHelperTrustedRoot,
	prepareEmbeddedHelperCacheRoot,
} from "../_magenta/utils/pi/helper-cache-root.ts";

let root: string | undefined;
const initialCacheRoot = getEmbeddedHelperCacheRoot();

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	configureEmbeddedHelperCacheRoot(initialCacheRoot);
});

describe("embedded helper cache root", () => {
	it("binds helper materialization to an explicit host-configured root", () => {
		root = mkdtempSync(join(tmpdir(), "magenta-helper-cache-"));
		const cacheRoot = join(root, "state", "cache");
		configureEmbeddedHelperCacheRoot(cacheRoot);

		expect(getEmbeddedHelperCacheRoot()).toBe(cacheRoot);
		expect(getEmbeddedHelperTrustedRoot()).toBe(join(root, "state"));
	});

	it("rejects relative and non-normalized roots", () => {
		expect(() => configureEmbeddedHelperCacheRoot("relative/cache")).toThrow(/absolute normalized/u);
		const temporaryRoot = mkdtempSync(join(tmpdir(), "magenta-helper-cache-"));
		root = temporaryRoot;
		expect(() => configureEmbeddedHelperCacheRoot(`${temporaryRoot}/state/../cache`)).toThrow(/absolute normalized/u);
	});

	it("prepares a private cache tree below an existing trusted root", () => {
		root = mkdtempSync(join(tmpdir(), "magenta-helper-cache-"));
		const cacheRoot = join(root, "fresh-state", "cache");

		prepareEmbeddedHelperCacheRoot(cacheRoot, root);

		expect(lstatSync(join(root, "fresh-state")).isDirectory()).toBe(true);
		expect(lstatSync(cacheRoot).isDirectory()).toBe(true);
		expect(lstatSync(cacheRoot).mode & 0o077).toBe(0);
		expect(getEmbeddedHelperCacheRoot()).toBe(cacheRoot);
	});

	it.runIf(process.platform !== "win32")("rejects an unsafe trusted root without configuring it", () => {
		const temporaryRoot = mkdtempSync(join(tmpdir(), "magenta-helper-cache-"));
		root = temporaryRoot;
		const previous = getEmbeddedHelperCacheRoot();
		chmodSync(temporaryRoot, 0o777);

		expect(() => prepareEmbeddedHelperCacheRoot(join(temporaryRoot, "state", "cache"), temporaryRoot)).toThrow(
			/group\/world-writable/u,
		);
		expect(getEmbeddedHelperCacheRoot()).toBe(previous);
	});

	it("rejects a symbolic-link cache ancestor", () => {
		const temporaryRoot = mkdtempSync(join(tmpdir(), "magenta-helper-cache-"));
		root = temporaryRoot;
		const external = mkdtempSync(join(tmpdir(), "magenta-helper-cache-external-"));
		try {
			symlinkSync(external, join(temporaryRoot, "state"), "dir");
			expect(() => prepareEmbeddedHelperCacheRoot(join(temporaryRoot, "state", "cache"), temporaryRoot)).toThrow(
				/not a real directory/u,
			);
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});
});
