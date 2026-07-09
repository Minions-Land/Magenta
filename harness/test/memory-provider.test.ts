import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../hcp-client/HcpClient.ts";
import { createCapabilityServer } from "../hcp-client/server/capability-server.ts";
import { SessionGroundingMemoryProvider } from "../modules/memory/magenta/session-grounding.ts";

describe("session grounding memory provider", () => {
	it("serves Magenta1 session-grounding memory and retains local facts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-session-grounding-"));
		const storePath = join(dir, ".magenta", "memory", "session-grounding.jsonl");
		const provider = new SessionGroundingMemoryProvider({
			workspaceRoot: dir,
			storePath,
			now: () => 42,
		});
		const server = createCapabilityServer({
			kind: "memory",
			target: "memory://session-grounding",
			description: "Session-scoped memory with JSON-lines persistence for lightweight grounding facts.",
			provider,
			operations: {
				discover: (p) => p.discover(),
				list: (p) => p.discover(),
				describe: (p) => p.describe(),
				read: (p) => p.read(),
				get: (p) => p.read(),
				inject: (p) => p.read(),
				retain: (p, req) => p.retain(req.input),
				recall: (p, req) => p.recall(req.input),
				reflect: (p, req) => p.reflect(req.input),
			},
			metadata: {
				implementation: "native-ts",
				source: "magenta",
			},
		});
		const hcp = new HcpClient().register("memory", server);

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
