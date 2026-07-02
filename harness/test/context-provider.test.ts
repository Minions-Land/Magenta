import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpRegistry } from "../assembly/hcp/pi/hcp.ts";
import { getHarnessRegistryPath, loadRegistry } from "../assembly/registry/pi/registry.ts";
import { ContextProvider, discoverContextFiles } from "../context/magenta/context.ts";

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
		const hcp = new HcpRegistry().register("context", new ContextProvider({ workspaceRoot: dir }).toHcpTarget());

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

	it("registers context provider in the catalog map", async () => {
		const registry = await loadRegistry(getHarnessRegistryPath());
		const catalog = registry.catalogs[0]?.catalog;

		expect(catalog.entries.find((entry) => entry.id === "runtime-provider:context:workspace")?.migration).toMatchObject({
			state: "integrated",
			component: { kind: "context", name: "workspace", path: "context/context.toml" },
		});
	});
});
