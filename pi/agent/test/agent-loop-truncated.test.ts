import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

const cases = [
	{ mode: "sequential", form: "structured" },
	{ mode: "parallel", form: "structured" },
	{ mode: "sequential", form: "recovered" },
	{ mode: "parallel", form: "recovered" },
] as const;

describe("length-truncated assistant tool calls", () => {
	it.each(cases)(
		"fails every $form call in $mode mode without tool preflight or execution",
		async ({ mode, form }) => {
			const schema = Type.Object({ value: Type.String() });
			const calls = { executionMode: 0, prepare: 0, before: 0, execute: 0, after: 0 };
			const makeTool = (name: string): AgentTool<typeof schema, Record<string, never>> => ({
				name,
				label: name,
				description: `${name} tool`,
				parameters: schema,
				get executionMode() {
					calls.executionMode++;
					return mode;
				},
				prepareArguments(args) {
					calls.prepare++;
					return args as { value: string };
				},
				async execute() {
					calls.execute++;
					return { content: [{ type: "text", text: "unexpected" }], details: {} };
				},
			});
			const context: AgentContext = {
				systemPrompt: "",
				messages: [],
				tools: [makeTool("alpha"), makeTool("beta")],
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolExecution: mode,
				beforeToolCall: async () => {
					calls.before++;
					return undefined;
				},
				afterToolCall: async () => {
					calls.after++;
					return undefined;
				},
			};

			let providerCalls = 0;
			const stream = agentLoop([createUserMessage("run both")], context, config, undefined, () => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const firstCall = providerCalls === 0;
					const message = firstCall
						? createAssistantMessage(
								form === "structured"
									? [
											{
												type: "toolCall",
												id: "structured-alpha",
												name: "alpha",
												arguments: { value: "a" },
											},
											{
												type: "toolCall",
												id: "structured-beta",
												name: "beta",
												arguments: { value: "b" },
											},
										]
									: [
											{
												type: "text",
												text: '<invoke name="alpha"><parameter name="value">a</parameter></invoke><invoke name="beta"><parameter name="value">b</parameter></invoke>',
											},
										],
								"length",
							)
						: createAssistantMessage([{ type: "text", text: "done" }]);
					providerCalls++;
					response.push({ type: "done", reason: firstCall ? "length" : "stop", message });
				});
				return response;
			});

			const events: AgentEvent[] = [];
			for await (const event of stream) events.push(event);
			const messages = await stream.result();

			expect(calls).toEqual({ executionMode: 0, prepare: 0, before: 0, execute: 0, after: 0 });
			expect(providerCalls).toBe(2);

			const truncatedAssistant = messages.find(
				(message) => message.role === "assistant" && message.stopReason === "length",
			);
			expect(
				truncatedAssistant?.role === "assistant"
					? truncatedAssistant.content.filter((part) => part.type === "toolCall").map((part) => part.name)
					: [],
			).toEqual(["alpha", "beta"]);

			const transcript = events.flatMap((event) => {
				if (event.type === "tool_execution_start") return [`start:${event.toolName}`];
				if (event.type === "tool_execution_end") {
					expect(event.isError).toBe(true);
					expect(event.result.content[0]?.type === "text" ? event.result.content[0].text : "").toContain(
						"output token limit",
					);
					return [`end:${event.toolName}`];
				}
				if (event.type === "message_end" && event.message.role === "toolResult") {
					expect(event.message.isError).toBe(true);
					return [`result:${event.message.toolName}`];
				}
				return [];
			});
			expect(transcript).toEqual([
				"start:alpha",
				"end:alpha",
				"result:alpha",
				"start:beta",
				"end:beta",
				"result:beta",
			]);
		},
	);
});
