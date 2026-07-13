import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Markdown } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	AssistantMessageComponent,
	normalizeThinkingTags,
} from "../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

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

	test("keeps the exact backlog thresholds, block boundary, and UTF-16 slicing behavior", () => {
		initTheme("dark");
		const thresholdCases = [
			{ backlog: 9, expected: 1 },
			{ backlog: 10, expected: 3 },
			{ backlog: 49, expected: 3 },
			{ backlog: 50, expected: 8 },
			{ backlog: 199, expected: 8 },
			{ backlog: 200, expected: 20 },
		];
		for (const { backlog, expected } of thresholdCases) {
			const component = new AssistantMessageComponent();
			component.updateContent(createAssistantMessage([{ type: "text", text: "x".repeat(backlog) }]));
			expect(component.advance()).toBe(true);
			const displayed = (component as unknown as { displayedTexts: string[] }).displayedTexts;
			expect(displayed[0]).toHaveLength(expected);
		}

		const blocks = new AssistantMessageComponent();
		blocks.updateContent(
			createAssistantMessage([
				{ type: "text", text: "ab" },
				{ type: "text", text: "x".repeat(100) },
			]),
		);
		expect(blocks.advance()).toBe(true);
		expect((blocks as unknown as { displayedTexts: string[] }).displayedTexts).toEqual(["ab", ""]);

		const emojiTarget = "😀".repeat(5);
		const emoji = new AssistantMessageComponent();
		emoji.updateContent(createAssistantMessage([{ type: "text", text: emojiTarget }]));
		expect(emoji.advance()).toBe(true);
		expect((emoji as unknown as { displayedTexts: string[] }).displayedTexts[0]).toBe(emojiTarget.slice(0, 3));
	});

	test("reuses the active Markdown block while preserving every progressive frame", () => {
		initTheme("dark");
		const target = [
			"# Streaming",
			"",
			"- first item",
			"- second **bold** item",
			"",
			"```ts",
			"const answer = 42;",
			"```",
		].join("\n");
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage([{ type: "text", text: target }]));

		let displayedLength = 0;
		let activeBlock: unknown;
		while (displayedLength < target.length) {
			const backlog = target.length - displayedLength;
			const charsToAdvance = backlog < 10 ? 1 : backlog < 50 ? 3 : backlog < 200 ? 8 : 20;
			displayedLength = Math.min(displayedLength + charsToAdvance, target.length);
			expect(component.advance()).toBe(true);

			const reference = ["", ...new Markdown(target.slice(0, displayedLength), 1, 0, getMarkdownTheme()).render(52)];
			reference[0] = OSC133_ZONE_START + reference[0];
			reference[reference.length - 1] =
				OSC133_ZONE_END + OSC133_ZONE_FINAL + reference[reference.length - 1];
			expect(component.render(52)).toEqual(reference);

			const currentBlock = (
				component as unknown as { displayedBlocks: Array<unknown> }
			).displayedBlocks[0];
			if (activeBlock) expect(currentBlock).toBe(activeBlock);
			activeBlock = currentBlock;
		}
		expect(component.advance()).toBe(false);
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
