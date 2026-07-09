import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../harness-component-protocol/HcpClient.ts";
import type { HcpServerRequest } from "../harness-component-protocol/HcpServerTypes.ts";
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
		const server: HcpServer = {
			describe: () => ({
				target: "memory://session-grounding",
				kind: "memory",
				ops: ["discover", "list", "describe", "read", "get", "inject", "retain", "recall", "reflect"],
				description: "Session-scoped memory with JSON-lines persistence for lightweight grounding facts.",
				metadata: {
					implementation: "native-ts",
					source: "magenta",
				},
			}),
			call: async (request: HcpServerRequest) => {
				const op = request.op || "read";
				switch (op) {
					case "discover":
					case "list":
						return provider.discover();
					case "describe":
						return provider.describe();
					case "read":
					case "get":
					case "inject":
						return provider.read();
					case "retain":
						return provider.retain(request.input);
					case "recall":
						return provider.recall(request.input);
					case "reflect":
						return provider.reflect(request.input);
					default:
						throw new Error(`Unknown operation: ${op}`);
				}
			},
			instance: () => provider,
		};
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
