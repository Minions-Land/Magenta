import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../harness-component-protocol/HcpClient.ts";
import type { HcpServerRequest } from "../harness-component-protocol/HcpServerTypes.ts";
import { ContextProvider, discoverContextFiles } from "../modules/context/magenta/context.ts";

describe("context provider", () => {
	it("discovers selected and sticky context files with local imports", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-context-"));
		await mkdir(join(dir, ".magenta"), { recursive: true });
		await mkdir(join(dir, ".claude"), { recursive: true });
		await writeFile(join(dir, "AGENTS.md"), "root agents");
		await writeFile(join(dir, ".claude", "CLAUDE.md"), "claude @extra.md\n```text\n@ignored.md\n```");
		await writeFile(join(dir, ".claude", "extra.md"), "imported context");
		await writeFile(join(dir, ".claude", "ignored.md"), "must stay fenced");
		await writeFile(join(dir, ".magenta", "RULES.md"), "sticky rules");

		const files = await discoverContextFiles(dir);

		expect(files).toHaveLength(2);
		expect(files[0]).toMatchObject({
			provider: "claude",
			sticky: false,
			content: expect.stringContaining("imported context"),
		});
		expect(files[0]?.content).toContain("@ignored.md");
		expect(files[0]?.content).not.toContain("must stay fenced");
		expect(files[1]).toMatchObject({
			provider: "magenta",
			sticky: true,
			content: "sticky rules",
		});
	});

	it("serves context through context://workspace and context://project", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magenta-context-hcp-"));
		await writeFile(join(dir, "AGENTS.md"), "Use HCP target runtime words.");
		const provider = new ContextProvider({ workspaceRoot: dir });
		const server: HcpServer = {
			describe: () => ({
				target: "context://{workspace,project}",
				kind: "context",
				ops: ["discover", "list", "describe", "read", "call", "status"],
				description: "Discover project instruction files and return model-safe context content.",
				metadata: {
					implementation: "native-ts",
					source: "magenta",
					origin: "magenta1-general-harness",
				},
			}),
			call: async (request: HcpServerRequest) => {
				const op = request.op || "read";
				switch (op) {
					case "discover":
					case "list":
						return provider.discover();
					case "describe":
						return {
							name: "project-context",
							target: "context://project",
							aliases: ["context://workspace"],
							description: "Discover project instruction files and return model-safe context content.",
							operations: ["read", "status"],
						};
					case "read":
					case "call":
						return provider.read();
					case "status":
						return provider.status();
					default:
						throw new Error(`Unknown operation: ${op}`);
				}
			},
			instance: () => provider,
		};
		const hcp = new HcpClient().register("context", server);

		await expect(hcp.dispatch({ target: "context://workspace", op: "status" })).resolves.toMatchObject({
			target: "context://project",
			count: 1,
			files: [{ provider: "agents-md", sticky: false }],
		});
		await expect(hcp.dispatch({ target: "context://project", op: "read" })).resolves.toMatchObject({
			name: "project-context",
			count: 1,
			content: expect.not.stringContaining("HCP"),
		});
	});
});
