import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APP_BINARY_NAME,
	getAgentInvocation,
	getExportTemplateDir,
	getInteractiveAssetsDir,
	getThemesDir,
	isBunBinaryUrl,
	resolveAgentInvocation,
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

describe("coding-agent child invocation", () => {
	it.each([
		"/opt/magenta-macos-arm64",
		"/opt/magenta-macos-x64",
		"/opt/magenta-linux-x64",
		"C:\\Magenta\\magenta-windows-x64.exe",
		"/opt/pi",
	])("reuses a compiled executable directly: %s", (executablePath) => {
		const args = ["--mode", "json"];
		expect(
			resolveAgentInvocation(args, {
				isCompiledBinary: true,
				isCliEntrypoint: true,
				executablePath,
				entrypoint: "/$bunfs/root/cli.js",
				fallbackCommand: "magenta",
				pathExists: () => false,
			}),
		).toEqual({ command: executablePath, args });
	});

	it("runs the real development CLI entrypoint through its JavaScript runtime", () => {
		const args = ["--mode", "json"];
		expect(
			resolveAgentInvocation(args, {
				isCompiledBinary: false,
				isCliEntrypoint: true,
				executablePath: "/usr/local/bin/node",
				entrypoint: "/workspace/pi/coding-agent/dist/cli.js",
				fallbackCommand: "pi",
				pathExists: () => true,
			}),
		).toEqual({
			command: "/usr/local/bin/node",
			args: ["/workspace/pi/coding-agent/dist/cli.js", ...args],
		});
	});

	it("uses the configured brand command for an SDK host instead of re-running its script", () => {
		const args = ["--mode", "json"];
		expect(
			resolveAgentInvocation(args, {
				isCompiledBinary: false,
				isCliEntrypoint: false,
				executablePath: "/usr/local/bin/node",
				entrypoint: "/workspace/unrelated-host.js",
				fallbackCommand: "magenta",
				pathExists: () => true,
			}),
		).toEqual({ command: "magenta", args });
	});

	it("takes the live fallback command from package.json piConfig", () => {
		vi.stubEnv("PI_CODING_AGENT", "false");
		const args = ["--mode", "json"];
		expect(getAgentInvocation(args)).toEqual({ command: APP_BINARY_NAME, args });
	});
});
