import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpRegistry } from "../assembly/hcp/hcp.ts";
import { SessionGroundingMemoryProvider } from "../memory/magenta/session-grounding.ts";

describe("session grounding memory provider", () => {
	it("serves Magenta1 session-grounding memory and retains local facts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-session-grounding-"));
		const storePath = join(dir, ".magenta", "memory", "session-grounding.jsonl");
		const provider = new SessionGroundingMemoryProvider({
			workspaceRoot: dir,
			storePath,
			now: () => 42,
		});
		const hcp = new HcpRegistry().register("memory", provider.toHcpTarget());

		await expect(hcp.dispatch({ target: "memory://session-grounding", op: "read" })).resolves.toMatchObject({
			name: "session-grounding",
			content: expect.stringContaining("Preserve user-stated architecture boundaries"),
			entries: [],
		});

		await expect(
			hcp.dispatch({
				target: "memory://session-grounding",
				op: "retain",
				input: { text: "Use TypeScript-first migration", tags: ["migration"] },
			}),
		).resolves.toMatchObject({
			target: "memory://session-grounding",
			op: "retain",
			id: "mem-42",
		});

		await expect(
			hcp.dispatch({ target: "memory://session-grounding", op: "recall", input: { query: "typescript" } }),
		).resolves.toMatchObject({
			matches: [{ text: "Use TypeScript-first migration", tags: ["migration"] }],
		});
		await expect(readFile(storePath, "utf-8")).resolves.toContain("TypeScript-first migration");
	});
});
