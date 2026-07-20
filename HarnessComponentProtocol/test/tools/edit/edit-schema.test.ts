import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { createEditExecute, editSchema } from "../../../tools/edit/pi/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hcp-edit-schema-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit schema replacement fields (CC-021/CU-018)", () => {
	it("accepts extra fields on an individual edit item", () => {
		expect(
			Check(editSchema, {
				path: "file.txt",
				edits: [{ oldText: "before", newText: "after", explanation: "why", startLine: 3 }],
			}),
		).toBe(true);
	});

	it("still rejects extra fields at the top level", () => {
		expect(
			Check(editSchema, {
				path: "file.txt",
				edits: [{ oldText: "before", newText: "after" }],
				dryRun: true,
			}),
		).toBe(false);
	});

	it("still requires oldText and newText on each edit item", () => {
		expect(Check(editSchema, { path: "file.txt", edits: [{ oldText: "before" }] })).toBe(false);
		expect(Check(editSchema, { path: "file.txt", edits: [{ newText: "after" }] })).toBe(false);
	});

	it("executes an edit item that carries extra fields, ignoring them", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "extra.txt");
		await writeFile(filePath, "before\n", "utf8");

		const execute = createEditExecute(dir);
		// Extra fields are accepted by the schema and never reach the diff/patch logic.
		const input = {
			path: "extra.txt",
			edits: [{ oldText: "before", newText: "after", explanation: "model-invented field" }],
		} as unknown as Parameters<typeof execute>[1];

		const result = await execute("tool-1", input);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in extra.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});
