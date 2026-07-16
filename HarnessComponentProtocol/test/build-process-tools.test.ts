import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type SpawnResult = {
	error?: NodeJS.ErrnoException;
	status: number | null;
};

type BuildProcessTools = (options: {
	arch?: string;
	cargo?: string;
	harnessRoot?: string;
	platform?: string;
	spawn?: (command: string, args: string[]) => SpawnResult;
}) => { path: string; source: "cargo" | "prebuilt" };

const buildScriptUrl = new URL("../scripts/build-process-tools.mjs", import.meta.url);
const { buildProcessTools } = (await import(buildScriptUrl.href)) as { buildProcessTools: BuildProcessTools };

function spawnError(code: string): SpawnResult {
	return {
		error: Object.assign(new Error(`spawn cargo ${code}`), { code }),
		status: null,
	};
}

describe("process-tools build preparation", () => {
	let root: string | undefined;

	function createFixture(prebuiltContent?: string) {
		root = mkdtempSync(join(tmpdir(), "magenta-process-tools-build-"));
		const processToolsRoot = join(root, "_magenta/process-tools");
		const targetPath = join(processToolsRoot, "target/release/magenta-process-tools");
		const prebuiltPath = join(processToolsRoot, "prebuilt/magenta-process-tools-linux-x64");
		if (prebuiltContent !== undefined) {
			mkdirSync(join(processToolsRoot, "prebuilt"), { recursive: true });
			writeFileSync(prebuiltPath, prebuiltContent);
		}
		return { prebuiltPath, processToolsRoot, targetPath };
	}

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it("uses Cargo output when Cargo succeeds", () => {
		const fixture = createFixture("checked-in prebuilt");
		const result = buildProcessTools({
			arch: "x64",
			harnessRoot: root,
			platform: "linux",
			spawn: (_command, args) => {
				const targetDirIndex = args.indexOf("--target-dir");
				expect(args[targetDirIndex + 1]).toBe(join(fixture.processToolsRoot, "target"));
				mkdirSync(join(fixture.processToolsRoot, "target/release"), { recursive: true });
				writeFileSync(fixture.targetPath, "fresh cargo build");
				return { status: 0 };
			},
		});

		expect(result).toEqual({ path: fixture.targetPath, source: "cargo" });
		expect(readFileSync(fixture.targetPath, "utf8")).toBe("fresh cargo build");
	});

	it("copies the platform prebuilt when Cargo is unavailable", () => {
		const fixture = createFixture("checked-in prebuilt");
		mkdirSync(join(fixture.processToolsRoot, "target/release"), { recursive: true });
		writeFileSync(fixture.targetPath, "stale local target");

		const result = buildProcessTools({
			arch: "x64",
			harnessRoot: root,
			platform: "linux",
			spawn: () => spawnError("ENOENT"),
		});

		expect(result).toEqual({ path: fixture.targetPath, source: "prebuilt" });
		expect(readFileSync(fixture.targetPath, "utf8")).toBe("checked-in prebuilt");
		if (process.platform !== "win32") {
			expect(statSync(fixture.targetPath).mode & 0o111).not.toBe(0);
		}
	});

	it("does not hide a Cargo compilation failure behind the prebuilt", () => {
		const fixture = createFixture("checked-in prebuilt");

		expect(() =>
			buildProcessTools({
				arch: "x64",
				harnessRoot: root,
				platform: "linux",
				spawn: () => ({ status: 1 }),
			}),
		).toThrow("Magenta process-tools build failed with status 1");
		expect(() => readFileSync(fixture.targetPath)).toThrow();
	});

	it("does not treat other Cargo spawn errors as absence", () => {
		createFixture("checked-in prebuilt");

		expect(() =>
			buildProcessTools({
				arch: "x64",
				harnessRoot: root,
				platform: "linux",
				spawn: () => spawnError("EACCES"),
			}),
		).toThrow("Unable to start cargo: spawn cargo EACCES");
	});

	it("reports a missing platform prebuilt", () => {
		createFixture();

		expect(() =>
			buildProcessTools({
				arch: "x64",
				harnessRoot: root,
				platform: "linux",
				spawn: () => spawnError("ENOENT"),
			}),
		).toThrow("magenta-process-tools-linux-x64");
	});

	it("fails when Cargo reports success without producing the canonical target", () => {
		const fixture = createFixture("checked-in prebuilt");

		expect(() =>
			buildProcessTools({
				arch: "x64",
				harnessRoot: root,
				platform: "linux",
				spawn: () => ({ status: 0 }),
			}),
		).toThrow(`Cargo reported success but did not produce the expected process-tools binary: ${fixture.targetPath}`);
	});
});
