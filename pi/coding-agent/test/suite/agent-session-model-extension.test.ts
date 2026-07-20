import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildSystemPromptOptions, ExtensionAPI } from "../../src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedModelSwitchContext(harness: Harness, totalTokens: number): void {
	const now = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "context before model switch" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("old model response", { timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function useCompactionSummaryStream(harness: Harness, summary: string): string[] {
	const modelIds: string[] = [];
	harness.session.agent.streamFn = (model) => {
		modelIds.push(model.id);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage(summary),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(10),
				},
			});
		});
		return stream;
	};
	return modelIds;
}

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("setModel saves the model and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getDefaultProvider()).toBe(nextModel.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe(nextModel.id);
		expect(modelEvents).toEqual(["faux-1->faux-2:set"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
	});

	it("compacts with the previous model before committing a target with a smaller threshold", async () => {
		const lifecycle: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 20, keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", name: "Large", contextWindow: 1000 },
				{ id: "faux-2", name: "Small", contextWindow: 100 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_compact", async (event) => {
						lifecycle.push(`compact:${event.reason}`);
					});
					pi.on("model_select", async (event) => {
						lifecycle.push(`model:${event.previousModel?.id}->${event.model.id}`);
					});
				},
			],
		});
		harnesses.push(harness);
		seedModelSwitchContext(harness, 90);
		const compactionModelIds = useCompactionSummaryStream(harness, "summary before switching");

		await harness.session.setModel(harness.getModel("faux-2")!);

		expect(compactionModelIds.length).toBeGreaterThan(0);
		expect(new Set(compactionModelIds)).toEqual(new Set(["faux-1"]));
		expect(harness.session.model?.id).toBe("faux-2");
		expect(lifecycle).toEqual(["compact:threshold", "model:faux-1->faux-2"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "compaction" || entry.type === "model_change")
				.map((entry) => entry.type),
		).toEqual(["compaction", "model_change"]);
		expect(harness.eventsOfType("compaction_start").at(-1)?.reason).toBe("threshold");
	});

	it("switches without compaction when current context is at the target threshold", async () => {
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 20, keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", contextWindow: 1000 },
				{ id: "faux-2", contextWindow: 100 },
			],
		});
		harnesses.push(harness);
		seedModelSwitchContext(harness, 80);

		await harness.session.setModel(harness.getModel("faux-2")!);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("honors disabled auto-compaction during model switching", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", contextWindow: 1000 },
				{ id: "faux-2", contextWindow: 100 },
			],
		});
		harnesses.push(harness);
		seedModelSwitchContext(harness, 90);

		await harness.session.setModel(harness.getModel("faux-2")!);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("keeps the previous model when pre-switch compaction is cancelled", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 20, keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", contextWindow: 1000 },
				{ id: "faux-2", contextWindow: 100 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
					pi.on("model_select", async (event) => {
						modelEvents.push(event.model.id);
					});
				},
			],
		});
		harnesses.push(harness);
		seedModelSwitchContext(harness, 90);
		const defaultProviderBeforeSwitch = harness.settingsManager.getDefaultProvider();
		const defaultModelBeforeSwitch = harness.settingsManager.getDefaultModel();

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow("Compaction cancelled");

		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.settingsManager.getDefaultProvider()).toBe(defaultProviderBeforeSwitch);
		expect(harness.settingsManager.getDefaultModel()).toBe(defaultModelBeforeSwitch);
		expect(modelEvents).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: true,
		});
	});

	it("rejects a smaller target when the freshly compacted summary still exceeds its threshold", async () => {
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 1, keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", contextWindow: 1000 },
				{ id: "faux-2", contextWindow: 5 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "long compacted summary ".repeat(20),
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedModelSwitchContext(harness, 90);
		await harness.session.compact();
		const compactionStartsBeforeSwitch = harness.eventsOfType("compaction_start").length;

		expect(harness.session.getContextUsage()?.tokens).toBeNull();
		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			"Compacted context is still too large",
		);

		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(compactionStartsBeforeSwitch);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("rejects an overlapping model switch while pre-switch compaction is in progress", async () => {
		let markCompactionStarted!: () => void;
		let releaseCompaction!: () => void;
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		const compactionRelease = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 20, keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", contextWindow: 1000 },
				{ id: "faux-2", contextWindow: 100 },
				{ id: "faux-3", contextWindow: 1000 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionRelease;
						return {
							compaction: {
								summary: "summary after overlap guard",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedModelSwitchContext(harness, 90);

		const firstSwitch = harness.session.setModel(harness.getModel("faux-2")!);
		await compactionStarted;
		const overlappingSwitch = harness.session.setModel(harness.getModel("faux-3")!);
		releaseCompaction();

		await expect(overlappingSwitch).rejects.toThrow("A model switch is already in progress");
		await firstSwitch;
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(1);
	});

	it("applies pre-switch compaction when cycling scoped models", async () => {
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 20, keepRecentTokens: 1 } },
			models: [
				{ id: "faux-1", contextWindow: 1000 },
				{ id: "faux-2", contextWindow: 100 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary before scoped cycle",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedModelSwitchContext(harness, 90);
		harness.session.setScopedModels([{ model: harness.getModel("faux-1")! }, { model: harness.getModel("faux-2")! }]);

		const result = await harness.session.cycleModel();

		expect(result?.model.id).toBe("faux-2");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("cycles through scoped models and preserves the scoped thinking preference", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		harness.session.setScopedModels([{ model: modelOne, thinkingLevel: "high" }, { model: modelTwo }] as Array<{
			model: Model<string>;
			thinkingLevel?: ThinkingLevel;
		}>);
		harness.session.setThinkingLevel("high");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("clamps thinking levels to model capabilities and cycles available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: false }] });
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.executionProfile).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBe("ultra");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.harnessCapabilities).toEqual({ workflows: true, teammates: true });
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows extension tool_call handlers to block tool execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "Blocked by test" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const errorText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(errorText);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Blocked by test");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("allows extension tool_result handlers to modify tool results", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async () => ({
						content: [{ type: "text", text: "patched result" }],
						details: { patched: true },
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("patched result");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.details?.patched === true),
		).toBeDefined();
	});

	it("allows extension context handlers to modify messages before the LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? { ...message, content: [{ type: "text", text: "rewritten" }], timestamp: message.timestamp }
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUserText = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("original");

		expect(providerUserText).toBe("rewritten");
		const storedUserMessage = harness.session.messages.find((message) => message.role === "user");
		expect(storedUserMessage?.role).toBe("user");
		if (storedUserMessage?.role === "user") {
			expect(storedUserMessage.content).toEqual([{ type: "text", text: "original" }]);
		}
	});

	it("allows extension input handlers to transform or handle input", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const transformedHarness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async (event) => {
						if (event.text === "ping") {
							return { action: "handled" };
						}
						return { action: "transform", text: `transformed:${event.text}` };
					});
				},
			],
		});
		harnesses.push(transformedHarness);
		let providerUserText = "";
		transformedHarness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await transformedHarness.session.prompt("hello");
		await transformedHarness.session.prompt("ping");

		expect(providerUserText).toBe("transformed:hello");
		expect(transformedHarness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(extensionApi).toBeDefined();
	});

	it("allows extension commands to inspect live system prompt options", async () => {
		const seenOptions: BuildSystemPromptOptions[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("inspect-options", {
						description: "Inspect system prompt options",
						handler: async (_args, ctx) => {
							const options = ctx.getSystemPromptOptions();
							seenOptions.push(options);
							options.selectedTools?.push("mutated_tool");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/inspect-options");
		await harness.session.prompt("/inspect-options");

		expect(seenOptions).toHaveLength(2);
		expect(seenOptions[0]).toBe(seenOptions[1]);
		expect(seenOptions[0]?.cwd).toBe(harness.tempDir);
		expect(seenOptions[0]?.selectedTools).toContain("read");
		expect(seenOptions[1]?.selectedTools).toContain("mutated_tool");
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "injected",
							display: true,
							details: { injected: true },
						},
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					pi.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});
});
