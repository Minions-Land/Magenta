/**
 * Fallback recovery for tool calls a model emitted as literal text instead of a
 * structured tool_use block.
 *
 * Occasionally a model finishes a turn with stopReason "stop" (or "length")
 * having written the Anthropic tool-invocation XML — `<invoke name="...">` with
 * `<parameter>` children — into a text block rather than issuing a real tool
 * call. The agent loop then sees no toolCall content and ends the turn, leaving
 * the run stuck. This module detects that XML in assistant text and reconstructs
 * proper ToolCall content so the normal execution path can take over.
 *
 * This is intentionally conservative: it only fires when there are no genuine
 * toolCall blocks, and it only recognizes the specific `<invoke>`/`<parameter>`
 * shape. Anything it cannot parse is left as text.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

type ContentBlock = AssistantMessage["content"][number];
type TextContent = Extract<ContentBlock, { type: "text" }>;
type ToolCall = Extract<ContentBlock, { type: "toolCall" }>;

// Matches a single <invoke name="tool">...</invoke> block, with or without an
// enclosing <function_calls> wrapper. Non-greedy body so adjacent invokes don't
// merge. `name` may use single or double quotes.
const INVOKE_RE = /<invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/invoke\s*>/gi;
const PARAMETER_RE = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter\s*>/gi;

export interface ParsedTextToolCall {
	name: string;
	arguments: Record<string, unknown>;
	/** The full matched substring, so callers can strip it from the text. */
	raw: string;
}

/** Coerce a parameter's text body into a JS value: JSON when it parses, else the trimmed string. */
function coerceParameterValue(rawBody: string): unknown {
	const body = rawBody.trim();
	if (body === "") return "";
	const first = body[0];
	// Only attempt JSON parsing when it plausibly looks like a JSON scalar/array/object.
	if (first === "{" || first === "[" || first === '"') {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	if (body === "true") return true;
	if (body === "false") return false;
	if (body === "null") return null;
	// Numeric literal (integer or float), but not version-like or leading-zero strings.
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(body)) {
		const n = Number(body);
		if (Number.isFinite(n)) return n;
	}
	return body;
}

/**
 * Parse literal `<invoke>` tool-call XML out of a text blob.
 * Returns one entry per well-formed invoke block; returns [] when none are found.
 */
export function parseTextToolCalls(text: string): ParsedTextToolCall[] {
	if (!text.includes("<invoke")) return [];
	const calls: ParsedTextToolCall[] = [];
	for (const invokeMatch of text.matchAll(INVOKE_RE)) {
		const [raw, name, inner] = invokeMatch;
		const args: Record<string, unknown> = {};
		for (const paramMatch of inner.matchAll(PARAMETER_RE)) {
			const [, paramName, paramBody] = paramMatch;
			args[paramName] = coerceParameterValue(paramBody);
		}
		calls.push({ name: name.trim(), arguments: args, raw });
	}
	return calls;
}

/** Generate a synthetic tool-call id; providers normalize arbitrary strings, so a counter suffices. */
function syntheticToolCallId(index: number): string {
	return `recovered_text_toolcall_${index}`;
}

export interface RecoverToolCallsOptions {
	/** Names of tools actually available this turn; recovered calls to unknown tools are ignored. */
	knownToolNames?: ReadonlySet<string>;
}

/**
 * If `message` ended without any structured toolCall but a text block contains
 * literal `<invoke>` tool-call XML, rewrite the content in place: replace the
 * embedded XML with reconstructed ToolCall blocks (and keep any surrounding
 * prose). Returns the number of tool calls recovered (0 when nothing changed).
 *
 * Only mutates when the message has zero genuine toolCall blocks, so a normal
 * tool-using turn is never disturbed.
 */
export function recoverTextToolCalls(message: AssistantMessage, options: RecoverToolCallsOptions = {}): number {
	if (message.content.some((c) => c.type === "toolCall")) return 0;

	const known = options.knownToolNames;
	const newContent: AssistantMessage["content"] = [];
	let recovered = 0;

	for (const block of message.content) {
		if (block.type !== "text") {
			newContent.push(block);
			continue;
		}
		const parsed = parseTextToolCalls(block.text).filter((p) => !known || known.has(p.name));
		if (parsed.length === 0) {
			newContent.push(block);
			continue;
		}

		// Split the text around each recovered invoke block, preserving prose.
		let remaining = block.text;
		for (const call of parsed) {
			const at = remaining.indexOf(call.raw);
			if (at === -1) continue;
			const before = remaining.slice(0, at);
			if (before.trim() !== "") {
				newContent.push({ type: "text", text: before } satisfies TextContent);
			}
			newContent.push({
				type: "toolCall",
				id: syntheticToolCallId(recovered),
				name: call.name,
				arguments: call.arguments,
			} satisfies ToolCall);
			recovered++;
			remaining = remaining.slice(at + call.raw.length);
		}
		if (remaining.trim() !== "") {
			newContent.push({ type: "text", text: remaining } satisfies TextContent);
		}
	}

	if (recovered === 0) return 0;
	message.content = newContent;
	return recovered;
}
