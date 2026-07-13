import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	AssistantMessageComponent,
	normalizeThinkingTags,
} from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});
});

describe("normalizeThinkingTags", () => {
	test("converts a text block wrapped in <thinking> tags into a thinking block", () => {
		const result = normalizeThinkingTags([
			{ type: "text", text: "<thinking>Inspecting HCP compaction core</thinking>" },
		]);
		expect(result).toEqual([{ type: "thinking", thinking: "Inspecting HCP compaction core" }]);
	});

	test("splits leading reasoning from trailing answer text", () => {
		const result = normalizeThinkingTags([
			{ type: "text", text: "<thinking>plan the change</thinking>Here is the answer." },
		]);
		expect(result).toEqual([
			{ type: "thinking", thinking: "plan the change" },
			{ type: "text", text: "Here is the answer." },
		]);
	});

	test("treats an unterminated <thinking> block (streaming) as reasoning", () => {
		const result = normalizeThinkingTags([{ type: "text", text: "<thinking>partial reasoning still stre" }]);
		expect(result).toEqual([{ type: "thinking", thinking: "partial reasoning still stre" }]);
	});

	test("leaves <thinking> appearing mid-text untouched", () => {
		const content: AssistantMessage["content"] = [
			{ type: "text", text: "Use a literal <thinking> tag in your prompt like this." },
		];
		expect(normalizeThinkingTags(content)).toEqual(content);
	});

	test("leaves fenced code examples that start with a <thinking> tag untouched", () => {
		const content: AssistantMessage["content"] = [
			{ type: "text", text: "```html\n<thinking>example</thinking>\n```" },
		];
		expect(normalizeThinkingTags(content)).toEqual(content);
	});

	test("does not modify proper thinking or tool-call blocks", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "real reasoning" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
		];
		expect(normalizeThinkingTags(content)).toEqual(content);
	});

	test("handles leading whitespace before the opening tag", () => {
		const result = normalizeThinkingTags([{ type: "text", text: "  \n<thinking>indented</thinking>" }]);
		expect(result).toEqual([{ type: "thinking", thinking: "indented" }]);
	});
});
