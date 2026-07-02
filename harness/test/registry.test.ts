import { describe, expect, it } from "vitest";
import { getHarnessRegistryPath, listHarnessSelectionItems, loadRegistry } from "../assembly/registry/pi/registry.ts";
import { filterHarnessCatalogEntries, summarizeHarnessCatalogEntries } from "../catalog/pi/catalog.ts";

describe("harness registry", () => {
	it("locates and loads the package registry", async () => {
		const path = getHarnessRegistryPath();

		expect(path.endsWith("harness.toml")).toBe(true);

		const registry = await loadRegistry(path);
		expect(registry.name).toBe("magenta-harness");
		expect(registry.components.some((component) => component.kind === "memory" && component.name === "memory")).toBe(
			true,
		);
		expect(registry.components.some((component) => component.kind === "tool" && component.name === "bash")).toBe(
			true,
		);
		expect(
			registry.components.some(
				(component) => component.kind === "catalog" && component.name === "magenta1-harness-components",
			),
		).toBe(true);
		expect(registry.modules.find((module) => module.id === "tool/bash")).toMatchObject({
			status: "ready",
			implementations: [expect.objectContaining({ source: "pi", status: "ready" })],
		});
		expect(registry.modules.find((module) => module.id === "contract/messages")).toMatchObject({
			status: "inspect-only",
			implementations: [expect.objectContaining({ source: "contract", status: "inspect-only" })],
		});
		expect(registry.modules.find((module) => module.id === "assembly/hcp")).toMatchObject({
			status: "core-exception",
			coreException: true,
		});
		expect(registry.modules.find((module) => module.id === "assembly/magnet")).toMatchObject({
			status: "core-exception",
			coreException: true,
		});
	});

	it("loads the migrated Magenta1 harness catalog with provenance intact", async () => {
		const registry = await loadRegistry(getHarnessRegistryPath());
		const descriptor = registry.catalogs.find((catalog) => catalog.name === "magenta1-harness-components");

		expect(descriptor).toBeDefined();
		expect(descriptor?.catalog.summary.component_count).toBe(111);
		expect(descriptor?.catalog.summary.module_count).toBe(13);
		expect(descriptor?.catalog.entries).toHaveLength(111);
		expect(descriptor?.catalog.summary.by_source).toMatchObject({
			"magenta-native": 72,
			"domain-pack": 17,
			"oh-my-pi": 12,
			lazypi: 4,
			"external-upstream": 4,
			pi: 1,
			opencode: 1,
		});
		expect(descriptor?.catalog.sourceReferences["oh-my-pi"]?.reference_paths).toContain(
			"Reference_Repo/oh-my-pi-main/packages/hashline",
		);
	});

	it("exposes selector-ready catalog items and integration states", async () => {
		const registry = await loadRegistry(getHarnessRegistryPath());
		const catalog = registry.catalogs[0]?.catalog;
		expect(catalog).toBeDefined();

		const summary = summarizeHarnessCatalogEntries(catalog.entries);
		expect(summary.byMigrationState.integrated).toBeGreaterThan(0);
		expect(summary.byMigrationState.available).toBe(10);
		expect(summary.byMigrationState["requires-migration"]).toBe(15);
		expect(summary.byMigrationState["metadata-only"]).toBe(14);
		expect(summary.byMigrationState["external-boundary"]).toBe(9);
		expect(summary.byMigrationState["deferred-domain-pack"]).toBe(17);

		const ohMyPiItems = listHarnessSelectionItems(registry, { origins: ["oh-my-pi"] });
		expect(ohMyPiItems).toHaveLength(12);
		expect(ohMyPiItems.some((item) => item.label === "Lsp" && item.originRel.includes("reference"))).toBe(true);

		const integratedTools = listHarnessSelectionItems(registry, {
			kinds: ["mcp"],
			migrationStates: ["integrated"],
		});
		expect(integratedTools.some((item) => item.id === "general-harness:mcp:Read")).toBe(true);
		expect(integratedTools.find((item) => item.id === "general-harness:mcp:Read")?.component).toMatchObject({
			kind: "tool",
			name: "read",
		});

		const availableProcessTools = listHarnessSelectionItems(registry, {
			kinds: ["mcp", "hcp-process"],
			migrationStates: ["available"],
		});
		expect(availableProcessTools.find((item) => item.id === "general-harness:mcp:AstGrep")?.component).toMatchObject({
			kind: "process-tool",
			path: "tools/process/ast-grep.toml",
		});
		expect(availableProcessTools.find((item) => item.id === "general-harness:mcp:AstGrep")?.readiness).toBe(
			"ready",
		);
		expect(
			availableProcessTools.find((item) => item.id === "general-harness:hcp-process:echo-jsonl")?.component,
		).toMatchObject({
			kind: "hcp-process",
			path: "assembly/hcp-process/echo-jsonl.toml",
		});
		expect(
			availableProcessTools.find((item) => item.id === "general-harness:hcp-process:echo-jsonl")?.readiness,
		).toBe("ready");

		const domainEntries = filterHarnessCatalogEntries(catalog.entries, { origins: ["domain-pack"] });
		expect(domainEntries).toHaveLength(17);
	});

	it("does not expose unported Magenta1 providers as ready selector items", async () => {
		const registry = await loadRegistry(getHarnessRegistryPath());
		const items = listHarnessSelectionItems(registry);

		for (const id of [
			"runtime-provider:trace:session",
			"runtime-provider:shell:session",
			"runtime-provider:capability:catalog",
			"runtime-provider:llm:providers",
			"runtime-provider:mcp:tools",
		]) {
			expect(items.find((item) => item.id === id)).toMatchObject({
				migrationState: "requires-migration",
				readiness: "requires-migration",
				component: undefined,
			});
		}

		expect(items.find((item) => item.id === "general-harness:api:httpbin-get")).toMatchObject({
			migrationState: "metadata-only",
			readiness: "metadata-only",
		});
		expect(items.find((item) => item.id === "general-harness:mcp-server:filesystem")).toMatchObject({
			migrationState: "external-boundary",
			readiness: "external-boundary",
		});
	});

	it("marks session-grounding memory as a migrated HCP target", async () => {
		const registry = await loadRegistry(getHarnessRegistryPath());
		const item = listHarnessSelectionItems(registry).find(
			(candidate) => candidate.id === "general-harness:memory:session-grounding",
		);

		expect(item).toMatchObject({
			migrationState: "integrated",
			readiness: "ready",
			component: {
				kind: "memory",
				name: "session-grounding",
				path: "memory/pi/session-grounding.ts",
			},
		});
	});

	it("marks LazyPi Jobs-derived background Events as covered by the coding-agent extension", async () => {
		const registry = await loadRegistry(getHarnessRegistryPath());
		const eventItems = listHarnessSelectionItems(registry, {
			origins: ["lazypi"],
			migrationStates: ["integrated"],
		});

		expect(eventItems.find((item) => item.id === "general-harness:event:manager")).toMatchObject({
			readiness: "ready",
			component: {
				kind: "coding-agent-extension",
				name: "background-events",
				path: "pi/coding-agent/src/extensions/background-events/event-monitor.ts",
			},
		});
		expect(eventItems.find((item) => item.id === "general-harness:event-tool:bg_shell")).toMatchObject({
			component: {
				kind: "coding-agent-extension-tool",
				name: "bg_shell",
				path: "pi/coding-agent/src/extensions/background-events/background-shell.ts",
			},
		});
		expect(eventItems.find((item) => item.id === "general-harness:event-tool:sub_agent")).toMatchObject({
			component: {
				kind: "coding-agent-extension-tool",
				name: "sub_agent",
				path: "pi/coding-agent/src/extensions/background-events/sub-agents.ts",
			},
		});
	});
});
