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
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
} from "../src/types.ts";

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

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
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

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("tool result normalization", () => {
	it("normalizes null content and preserves additional result fields through the after hook", async () => {
		const schema = Type.Object({});
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "extension_tool",
			label: "Extension tool",
			description: "Untyped extension tool",
			parameters: schema,
			async execute() {
				return {
					content: null,
					details: { source: "extension" },
					addedToolNames: ["dynamic_tool"],
				} as unknown as AgentToolResult<Record<string, never>>;
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			afterToolCall: async () => ({ terminate: false }),
		};

		let providerCalls = 0;
		const stream = agentLoop([user("run")], context, config, undefined, () => {
			const response = new MockAssistantStream();
			queueMicrotask(() => {
				const firstCall = providerCalls === 0;
				const message = firstCall
					? assistant([{ type: "toolCall", id: "call-1", name: "extension_tool", arguments: {} }], "toolUse")
					: assistant([{ type: "text", text: "done" }], "stop");
				providerCalls++;
				response.push({ type: "done", reason: firstCall ? "toolUse" : "stop", message });
			});
			return response;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		const toolEnd = events.find((event) => event.type === "tool_execution_end");
		expect(toolEnd?.type).toBe("tool_execution_end");
		if (toolEnd?.type === "tool_execution_end") {
			expect((toolEnd.result as AgentToolResult<unknown> & { addedToolNames?: string[] }).addedToolNames).toEqual([
				"dynamic_tool",
			]);
		}

		const resultMessage = messages.find((message) => message.role === "toolResult");
		expect(resultMessage?.role).toBe("toolResult");
		if (resultMessage?.role === "toolResult") {
			expect(resultMessage.content).toEqual([]);
			expect(resultMessage.details).toEqual({ source: "extension" });
		}
	});
});
