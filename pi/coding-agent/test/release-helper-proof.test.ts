import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createReleaseEmbeddedHelperProof,
	handleReleaseHelperProofCommand,
} from "../src/cli/release-helper-proof-command.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "magenta-release-helper-proof-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	delete process.env.MAGENTA_RELEASE_HELPER_PROOF;
	for (const path of temporaryDirectories.splice(0)) await rm(path, { force: true, recursive: true });
});

describe("release embedded helper proof", () => {
	it("reports exactly the three helpers materialized from the isolated cache", async () => {
		const root = await temporaryDirectory();
		const cacheRoot = join(root, "cache");
		const paths = {
			fd: join(cacheRoot, "fd", "fd"),
			"process-tools": join(cacheRoot, "process-tools", "magenta-process-tools"),
			rg: join(cacheRoot, "rg", "rg"),
		};
		for (const [kind, path] of Object.entries(paths)) {
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, `signed ${kind}\n`);
		}

		const proof = createReleaseEmbeddedHelperProof({
			architecture: "arm64",
			cacheRoot,
			getFdPath: () => paths.fd,
			getProcessToolsPath: () => paths["process-tools"],
			getRgPath: () => paths.rg,
			platform: "darwin",
		});

		expect(proof).toMatchObject({
			schema: "magenta.release-embedded-helper-proof.v1",
			platform: "darwin",
			architecture: "arm64",
		});
		expect(proof.helpers.map(({ kind }) => kind)).toEqual(["fd", "process-tools", "rg"]);
		for (const helper of proof.helpers) {
			expect(helper.sha256).toBe(createHash("sha256").update(`signed ${helper.kind}\n`).digest("hex"));
			expect(helper.size).toBeGreaterThan(0);
		}
	});

	it("creates a secure helper cache for a completely fresh state root", async () => {
		const root = await temporaryDirectory();
		const cacheRoot = join(root, "new-home", ".magenta", "cache");
		const helper = (kind: "fd" | "process-tools" | "rg", executableName: string) => () => {
			if (!lstatSync(cacheRoot).isDirectory()) throw new Error("release proof did not prepare its cache");
			const path = join(cacheRoot, kind, executableName);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `signed ${kind}\n`);
			return path;
		};

		const proof = createReleaseEmbeddedHelperProof({
			architecture: "arm64",
			cacheRoot,
			getFdPath: helper("fd", "fd"),
			getProcessToolsPath: helper("process-tools", "magenta-process-tools"),
			getRgPath: helper("rg", "rg"),
			platform: "darwin",
			trustedRoot: root,
		});

		expect(proof.helpers.map(({ kind }) => kind)).toEqual(["fd", "process-tools", "rg"]);
		expect(lstatSync(join(root, "new-home")).mode & 0o077).toBe(0);
		expect(lstatSync(join(root, "new-home", ".magenta")).mode & 0o077).toBe(0);
	});

	it("rejects helpers outside the cache and symbolic-link substitutions", async () => {
		const root = await temporaryDirectory();
		const cacheRoot = join(root, "cache");
		const fd = join(cacheRoot, "fd", "fd");
		const processTools = join(cacheRoot, "process-tools", "magenta-process-tools");
		const rg = join(cacheRoot, "rg", "rg");
		for (const path of [fd, processTools, rg]) {
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, path);
		}
		const outside = join(root, "outside");
		await writeFile(outside, "outside");
		expect(() =>
			createReleaseEmbeddedHelperProof({
				architecture: "x64",
				cacheRoot,
				getFdPath: () => outside,
				getProcessToolsPath: () => processTools,
				getRgPath: () => rg,
				platform: "darwin",
			}),
		).toThrow(/isolated embedded cache/u);

		await rm(fd);
		await symlink(outside, fd);
		expect(() =>
			createReleaseEmbeddedHelperProof({
				architecture: "arm64",
				cacheRoot,
				getFdPath: () => fd,
				getProcessToolsPath: () => processTools,
				getRgPath: () => rg,
				platform: "darwin",
			}),
		).toThrow(/not a regular file/u);
	});

	it("keeps the command unavailable outside the explicit release proof mode", () => {
		expect(() => handleReleaseHelperProofCommand([])).toThrow(/MAGENTA_RELEASE_HELPER_PROOF=1/u);
	});
});
