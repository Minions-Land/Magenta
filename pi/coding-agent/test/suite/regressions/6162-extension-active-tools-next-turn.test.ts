import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

function toolSwitchExtension(withPromptOverride: boolean | "replace" = false): ExtensionFactory {
	return (pi) => {
		if (withPromptOverride) {
			pi.on("before_agent_start", async (event) => ({
				systemPrompt:
					withPromptOverride === "replace"
						? "extension owns this complete replacement"
						: `${event.systemPrompt}\n\nkeep this run override`,
			}));
		}

		pi.registerTool({
			name: "switch_tools",
			label: "Switch Tools",
			description: "Switch the active extension tool set",
			promptSnippet: "Switch to the next extension tool",
			parameters: Type.Object({}),
			execute: async () => {
				pi.setActiveTools(["after_switch"]);
				return {
					content: [{ type: "text", text: "switched" }],
					details: {},
				};
			},
		});

		pi.registerTool({
			name: "after_switch",
			label: "After Switch",
			description: "Tool that should be available after switching",
			promptSnippet: "Run after the active tool set changes",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "after" }],
				details: {},
			}),
		});
	};
}

describe("extension active tools next-turn refresh", () => {
	it("applies pi.setActiveTools before the next provider request in the same run", async () => {
		const harness = await createHarness({ extensionFactories: [toolSwitchExtension()] });

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);
			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(harness.session.getActiveToolNames()).toEqual(["after_switch"]);
			expect(providerToolNames).toEqual([["switch_tools"], ["after_switch"]]);
		} finally {
			await harness.cleanup();
		}
	});

	it("preserves before_agent_start system prompt overrides when tools change mid-run", async () => {
		const harness = await createHarness({ extensionFactories: [toolSwitchExtension(true)] });

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);
			const providerSystemPrompts: string[] = [];
			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(providerToolNames).toEqual([["switch_tools"], ["after_switch"]]);
			expect(providerSystemPrompts).toHaveLength(2);
			expect(providerSystemPrompts[0]).toContain("keep this run override");
			expect(providerSystemPrompts[1]).toContain("keep this run override");
			expect(providerSystemPrompts[0]).toContain("Switch to the next extension tool");
			expect(providerSystemPrompts[1]).not.toContain("Switch to the next extension tool");
			expect(providerSystemPrompts[1]).toContain("Run after the active tool set changes");
			expect(harness.session.systemPrompt).not.toContain("keep this run override");
			expect(harness.session.systemPrompt).toContain("after_switch");
		} finally {
			await harness.cleanup();
		}
	});

	it("does not guess how to rewrite a complete system prompt replacement", async () => {
		const harness = await createHarness({ extensionFactories: [toolSwitchExtension("replace")] });

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);
			const providerSystemPrompts: string[] = [];
			harness.setResponses([
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(providerSystemPrompts).toEqual([
				"extension owns this complete replacement",
				"extension owns this complete replacement",
			]);
			expect(harness.session.systemPrompt).toContain("Run after the active tool set changes");
		} finally {
			await harness.cleanup();
		}
	});
});
