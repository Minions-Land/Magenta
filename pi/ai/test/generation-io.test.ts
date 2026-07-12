import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertMinimumCatalogSize,
	fetchRequiredJson,
	writeGeneratedFilesAtomically,
} from "../scripts/generation-io.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("model generation I/O", () => {
	it("fails required catalogs on HTTP and invalid JSON responses", async () => {
		await expect(
			fetchRequiredJson({
				label: "fixture",
				url: "https://example.invalid/models",
				fetchImpl: async () => new Response("down", { status: 503 }),
			}),
		).rejects.toThrow(/required fixture catalog: HTTP 503/i);
		await expect(
			fetchRequiredJson({
				label: "fixture",
				url: "https://example.invalid/models",
				fetchImpl: async () => new Response("not-json", { status: 200 }),
			}),
		).rejects.toThrow(/invalid JSON/);
	});

	it("rejects an unexpectedly small catalog", () => {
		expect(() => assertMinimumCatalogSize("OpenRouter", 2, 100)).toThrow(/received 2, minimum is 100/);
		expect(() => assertMinimumCatalogSize("OpenRouter", 100, 100)).not.toThrow();
	});

	it("publishes every staged file after all writes succeed", () => {
		const root = mkdtempSync(join(tmpdir(), "magenta-generation-"));
		roots.push(root);
		const first = join(root, "first.ts");
		const second = join(root, "nested", "second.ts");
		writeFileSync(first, "old-first");
		writeGeneratedFilesAtomically([
			{ path: first, content: "new-first" },
			{ path: second, content: "new-second" },
		]);
		expect(readFileSync(first, "utf8")).toBe("new-first");
		expect(readFileSync(second, "utf8")).toBe("new-second");
	});

	it("leaves existing outputs unchanged when staging any file fails", () => {
		const root = mkdtempSync(join(tmpdir(), "magenta-generation-"));
		roots.push(root);
		const existing = join(root, "existing.ts");
		writeFileSync(existing, "stable");
		const parentThatIsAFile = join(root, "not-a-directory");
		writeFileSync(parentThatIsAFile, "block mkdir");

		expect(() =>
			writeGeneratedFilesAtomically([
				{ path: existing, content: "must-not-publish" },
				{ path: join(parentThatIsAFile, "broken.ts"), content: "never-staged" },
			]),
		).toThrow();
		expect(readFileSync(existing, "utf8")).toBe("stable");
		expect(readdirSync(root).some((entry) => entry.startsWith("existing.ts.tmp-"))).toBe(false);
		// The failed parent remains the original file, not a partially-created tree.
		expect(readFileSync(parentThatIsAFile, "utf8")).toBe("block mkdir");
	});
});
