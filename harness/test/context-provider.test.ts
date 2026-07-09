import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClient } from "../harness-component-protocol/HcpClient.ts";
import { getHarnessRegistryPath, loadRegistry } from "../harness-component-protocol/registry/registry.ts";
import { createCapabilityServer } from "../harness-component-protocol/server/capability-server.ts";
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
		const server = createCapabilityServer({
			kind: "context",
			target: "context://{workspace,project}",
			description: "Discover project instruction files and return model-safe context content.",
			provider,
			operations: {
				discover: (p) => p.discover(),
				list: (p) => p.discover(),
				describe: () => ({
					name: "project-context",
					target: "context://project",
					aliases: ["context://workspace"],
					description: "Discover project instruction files and return model-safe context content.",
					operations: ["read", "status"],
				}),
				read: (p) => p.read(),
				call: (p) => p.read(),
				status: (p) => p.status(),
			},
			metadata: {
				implementation: "native-ts",
				source: "magenta",
				origin: "magenta1-general-harness",
			},
		});
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
