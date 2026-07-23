import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEmptyOrphanMultiagentRegistries } from "../../tools/multiagent/magenta/registry.ts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "magenta-registry-retention-"));
	roots.push(root);
	return root;
}

async function writeRegistry(root: string, parentSessionId: string, records: unknown[] = []): Promise<string> {
	const path = join(root, `${parentSessionId}.json`);
	await writeFile(path, `${JSON.stringify({ schemaVersion: 1, parentSessionId, updatedAt: 1, records })}\n`, {
		mode: 0o600,
	});
	await utimes(path, new Date(1), new Date(1));
	return path;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("empty multiagent registry retention", () => {
	it("deletes only ownership-proven empty orphan registries", async () => {
		if (typeof process.getuid !== "function") return;
		const root = await makeRoot();
		const orphan = await writeRegistry(root, "orphan");
		const live = await writeRegistry(root, "live");
		const nonempty = await writeRegistry(root, "nonempty", [{ schemaVersion: 1 }]);
		const locked = await writeRegistry(root, "locked");
		await mkdir(`${locked}.lock`);
		const recent = await writeRegistry(root, "recent");
		await utimes(recent, new Date(19_950), new Date(19_950));
		await writeFile(join(root, "malformed.json"), "not json");
		await writeFile(
			join(root, "mismatch.json"),
			JSON.stringify({ schemaVersion: 1, parentSessionId: "different", updatedAt: 1, records: [] }),
		);
		await writeFile(
			join(root, "extra.json"),
			JSON.stringify({ schemaVersion: 1, parentSessionId: "extra", updatedAt: 1, records: [], extra: true }),
		);
		const linkedTarget = await writeRegistry(root, "linked-target");
		await link(linkedTarget, join(root, "linked-alias.json"));
		const outside = join(root, "outside.json");
		await writeFile(outside, "outside");
		await symlink(outside, join(root, "symlink.json"));

		const result = await cleanupEmptyOrphanMultiagentRegistries({
			registryDir: root,
			liveParentSessionIds: new Set(["live"]),
			maxAgeMs: 100,
			now: 20_000,
		});

		expect(result.deletedFiles).toBe(1);
		await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(live, "utf8")).resolves.toContain('"parentSessionId":"live"');
		await expect(readFile(nonempty, "utf8")).resolves.toContain('"records":[{');
		await expect(readFile(locked, "utf8")).resolves.toContain('"parentSessionId":"locked"');
		await expect(readFile(recent, "utf8")).resolves.toContain('"parentSessionId":"recent"');
		await expect(readFile(linkedTarget, "utf8")).resolves.toContain('"parentSessionId":"linked-target"');
		await expect(readFile(outside, "utf8")).resolves.toBe("outside");
	});
});
