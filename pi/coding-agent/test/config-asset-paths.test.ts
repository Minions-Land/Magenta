import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getExportTemplateDir,
	getInteractiveAssetsDir,
	getThemesDir,
	isBunBinaryUrl,
	resolvePackageCodeDir,
} from "../src/config.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function codeTree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "magenta-config-assets-"));
	temporaryRoots.push(root);
	return root;
}

describe("compiled Node asset paths", () => {
	it("recognizes case-insensitive Bun virtual URLs on Windows", () => {
		expect(isBunBinaryUrl("file:///B:/%7eBun/root/config.js")).toBe(true);
	});

	it("uses dist directly when package.json and assets live inside dist", async () => {
		const root = await codeTree();
		const dist = join(root, "dist");
		await mkdir(join(dist, "modes", "interactive", "theme"), { recursive: true });

		expect(resolvePackageCodeDir(dist, dist)).toBe(dist);
		vi.stubEnv("PI_PACKAGE_DIR", dist);
		expect(getThemesDir()).toBe(join(dist, "modes", "interactive", "theme"));
		expect(getInteractiveAssetsDir()).toBe(join(dist, "modes", "interactive", "assets"));
		expect(getExportTemplateDir()).toBe(join(dist, "core", "export-html"));
		expect(getThemesDir()).not.toContain(join("dist", "dist"));
	});

	it("selects the code tree that contains the running module when src and dist both exist", async () => {
		const root = await codeTree();
		const src = join(root, "src");
		const dist = join(root, "dist");
		await Promise.all([
			mkdir(join(src, "modes"), { recursive: true }),
			mkdir(join(dist, "modes"), { recursive: true }),
		]);

		expect(resolvePackageCodeDir(root, join(src, "config.ts"))).toBe(src);
		expect(resolvePackageCodeDir(root, join(dist, "config.js"))).toBe(dist);
	});
});
