import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HcpClient, SystemPromptProvider } from "@magenta/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader, type ResourceLoader } from "../src/core/resource-loader.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

describe("system-prompt ResourceLoader boundary", () => {
	it("exposes bundled feature policy without injecting operational text into append Resources", async () => {
		const root = mkdtempSync(join(tmpdir(), "magenta-system-prompt-loader-"));
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			includeBundledResources: true,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		try {
			await loader.reload();
			expect(loader.getAppendSystemPrompt()).toEqual([]);
			expect(loader.getBundledPromptFeatures()).toEqual({ backgroundWork: true });
		} finally {
			await loader.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("AgentSession system-prompt capability resolution", () => {
	it("uses the selected session-HCP provider on the normal path", async () => {
		const provider: SystemPromptProvider = {
			buildSystemPrompt: vi.fn(() => "HCP SELECTED PROMPT"),
			formatSkillsForSystemPrompt: vi.fn(() => ""),
			loadDescriptor: vi.fn(async () => ({ diagnostics: [] })),
		};
		const resolveCapability = vi.fn((slot: string) => (slot === "system-prompt" ? provider : undefined));
		const hcp = {
			resolveCapability,
			describeAll: () => [],
			addresses: () => [],
			resolveInstance: () => undefined,
		} as unknown as HcpClient;
		const resourceLoader: ResourceLoader = {
			...createTestResourceLoader(),
			HcpClientgetsession: () => hcp,
			getBundledPromptFeatures: () => ({ backgroundWork: true }),
		};

		const harness = await createHarness({ resourceLoader, initialActiveToolNames: [] });
		harnesses.push(harness);

		expect(harness.session.systemPrompt).toBe("HCP SELECTED PROMPT");
		expect(provider.buildSystemPrompt).toHaveBeenCalledOnce();
		expect(provider.buildSystemPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				selectedTools: [],
				bundledPromptFeatures: { backgroundWork: true },
			}),
		);
		expect(resolveCapability).toHaveBeenCalledWith("system-prompt");
	});

	it("uses the compatibility facade only when the loader has no HCP", async () => {
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader(),
			initialActiveToolNames: [],
		});
		harnesses.push(harness);

		expect(harness.session.systemPrompt).toContain("You are Magenta");
		expect(harness.session.systemPrompt).toContain("Agent collaboration principles:");
	});

	it("runs HCP lifecycle hooks even when no Pi extension registered the corresponding event", async () => {
		const hookCalls: string[] = [];
		const provider: SystemPromptProvider = {
			buildSystemPrompt: () => "HCP PROMPT",
			formatSkillsForSystemPrompt: () => "",
			loadDescriptor: async () => ({ diagnostics: [] }),
		};
		const hookProvider = {
			discover: () => ({ provider: "test", targets: [], lifecycle_targets: [], hooks: [] }),
			run: (name: string) => {
				hookCalls.push(name);
				return { hook: name, status: "ok", actions: [] };
			},
			describeHook: (name: string) => ({ name, target: `hook://${name}`, kind: "lifecycle" }),
		};
		const hcp = {
			resolveCapability: (slot: string) => {
				if (slot === "system-prompt") return provider;
				if (slot === "hook") return hookProvider;
				return undefined;
			},
			describeAll: () => [],
			addresses: () => [],
			resolveInstance: () => undefined,
		} as unknown as HcpClient;
		const resourceLoader: ResourceLoader = {
			...createTestResourceLoader(),
			HcpClientgetsession: () => hcp,
		};
		const harness = await createHarness({ resourceLoader, initialActiveToolNames: [] });
		harnesses.push(harness);

		await harness.session.agent.onPayload?.({ probe: true }, harness.getModel());
		expect(hookCalls).toContain("pre-llm");

		const toolCall = { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "README.md" } };
		await harness.session.agent.beforeToolCall?.({ toolCall, args: toolCall.arguments } as never);
		await harness.session.agent.afterToolCall?.({
			toolCall,
			args: toolCall.arguments,
			result: { content: [{ type: "text", text: "ok" }], details: undefined },
			isError: false,
		} as never);

		expect(hookCalls).toEqual(expect.arrayContaining(["pre-tool", "post-tool"]));
	});

	it("throws instead of falling back when an existing HCP loses the required slot", async () => {
		let available = true;
		const provider: SystemPromptProvider = {
			buildSystemPrompt: () => "HCP PROMPT",
			formatSkillsForSystemPrompt: () => "",
			loadDescriptor: async () => ({ diagnostics: [] }),
		};
		const hcp = {
			resolveCapability: (slot: string) => (available && slot === "system-prompt" ? provider : undefined),
			describeAll: () => [],
			addresses: () => [],
			resolveInstance: () => undefined,
		} as unknown as HcpClient;
		const resourceLoader: ResourceLoader = {
			...createTestResourceLoader(),
			HcpClientgetsession: () => hcp,
		};
		const harness = await createHarness({ resourceLoader, initialActiveToolNames: [] });
		harnesses.push(harness);

		available = false;
		expect(() => harness.session.setActiveToolsByName([])).toThrow(
			'Session HCP is missing required capability slot "system-prompt"',
		);
	});
});
