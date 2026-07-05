import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseTextToolCalls, recoverTextToolCalls } from "../src/recover-text-tool-calls.ts";

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

describe("parseTextToolCalls", () => {
	it("returns [] when no invoke markup present", () => {
		expect(parseTextToolCalls("just some prose")).toEqual([]);
	});

	it("parses a bare invoke block (no function_calls wrapper)", () => {
		// This is the exact shape observed in the stuck AOSE session.
		const text = [
			"call",
			'<invoke name="omics_compute">',
			'<parameter name="args">{"input": "a.h5ad", "output": "m.csv", "groupby": "leiden"}</parameter>',
			'<parameter name="modality">scrna</parameter>',
			'<parameter name="subcommand">marker_table</parameter>',
			"</invoke>",
		].join("\n");
		const calls = parseTextToolCalls(text);
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("omics_compute");
		expect(calls[0].arguments).toEqual({
			args: { input: "a.h5ad", output: "m.csv", groupby: "leiden" },
			modality: "scrna",
			subcommand: "marker_table",
		});
	});

	it("parses inside a <function_calls> wrapper with multiple invokes", () => {
		const text = [
			"<function_calls>",
			'<invoke name="read"><parameter name="path">a.txt</parameter></invoke>',
			'<invoke name="read"><parameter name="path">b.txt</parameter></invoke>',
			"</function_calls>",
		].join("\n");
		const calls = parseTextToolCalls(text);
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.arguments.path)).toEqual(["a.txt", "b.txt"]);
	});

	it("coerces scalar parameter bodies", () => {
		const text =
			'<invoke name="t"><parameter name="n">42</parameter><parameter name="b">true</parameter><parameter name="s">hello</parameter></invoke>';
		const [call] = parseTextToolCalls(text);
		expect(call.arguments).toEqual({ n: 42, b: true, s: "hello" });
	});

	it("keeps a malformed JSON body as a string", () => {
		const text = '<invoke name="t"><parameter name="x">{not json}</parameter></invoke>';
		const [call] = parseTextToolCalls(text);
		expect(call.arguments.x).toBe("{not json}");
	});

	it("handles single-quoted attribute names", () => {
		const text = "<invoke name='t'><parameter name='p'>v</parameter></invoke>";
		const [call] = parseTextToolCalls(text);
		expect(call.name).toBe("t");
		expect(call.arguments.p).toBe("v");
	});
});

describe("recoverTextToolCalls", () => {
	it("rewrites text-form invoke into a real toolCall and preserves surrounding prose", () => {
		const msg = assistantMessage([
			{
				type: "text",
				text: 'Step 3: markers\n\ncall\n<invoke name="omics_compute"><parameter name="subcommand">marker_table</parameter></invoke>',
			},
		]);
		const n = recoverTextToolCalls(msg);
		expect(n).toBe(1);
		// prose block, then toolCall block
		expect(msg.content[0]).toMatchObject({ type: "text" });
		expect(msg.content[0].type === "text" && msg.content[0].text).toContain("Step 3: markers");
		expect(msg.content[1]).toMatchObject({
			type: "toolCall",
			name: "omics_compute",
			arguments: { subcommand: "marker_table" },
		});
	});

	it("is a no-op when a genuine toolCall already exists", () => {
		const msg = assistantMessage([
			{ type: "text", text: '<invoke name="x"></invoke>' },
			{ type: "toolCall", id: "real", name: "x", arguments: {} },
		]);
		const before = JSON.stringify(msg.content);
		expect(recoverTextToolCalls(msg)).toBe(0);
		expect(JSON.stringify(msg.content)).toBe(before);
	});

	it("ignores recovered calls to unknown tools when knownToolNames given", () => {
		const msg = assistantMessage([
			{ type: "text", text: '<invoke name="not_a_tool"><parameter name="a">1</parameter></invoke>' },
		]);
		expect(recoverTextToolCalls(msg, { knownToolNames: new Set(["read", "write"]) })).toBe(0);
	});

	it("recovers a known tool while filtering an unknown one", () => {
		const msg = assistantMessage([
			{
				type: "text",
				text: '<invoke name="ghost"><parameter name="a">1</parameter></invoke><invoke name="read"><parameter name="path">x</parameter></invoke>',
			},
		]);
		expect(recoverTextToolCalls(msg, { knownToolNames: new Set(["read"]) })).toBe(1);
		const toolCalls = msg.content.filter((c) => c.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].type === "toolCall" && toolCalls[0].name).toBe("read");
	});

	it("drops an empty text block after extraction", () => {
		const msg = assistantMessage([
			{ type: "text", text: '<invoke name="read"><parameter name="path">x</parameter></invoke>' },
		]);
		recoverTextToolCalls(msg);
		expect(msg.content).toHaveLength(1);
		expect(msg.content[0].type).toBe("toolCall");
	});
});
