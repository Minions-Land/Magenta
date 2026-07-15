import { beforeAll, describe, expect, it, vi } from "vitest";
import { SideChatOverlay, type SideChatOverlayResult } from "../src/modes/interactive/components/side-chat-overlay.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeTui() {
	return { requestRender: vi.fn(), terminal: { rows: 48 } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 30; index++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for SideChatOverlay state");
}

describe("SideChatOverlay", () => {
	beforeAll(() => initTheme("dark"));

	it("preserves and renders multiline bracketed paste, then submits the expanded text", async () => {
		const sent: string[] = [];
		const overlay = new SideChatOverlay(fakeTui() as never, theme, vi.fn(), async (text) => {
			sent.push(text);
			return "received";
		});
		overlay.focused = true;

		overlay.handleInput("\x1b[200~first");
		overlay.handleInput(" line\nsecond line");
		overlay.handleInput("\x1b[201~");
		expect(overlay.input).toBe("first line\nsecond line");
		const rendered = stripAnsi(overlay.render(100).join("\n"));
		expect(rendered).toContain("first line");
		expect(rendered).toContain("second line");

		overlay.handleInput("\r");
		await waitFor(() => sent.length === 1 && overlay.messages.some((message) => message.text === "received"));
		expect(sent).toEqual(["first line\nsecond line"]);
		expect(overlay.input).toBe("");
	});

	it("uses Ctrl+C to copy the draft or latest message and reserves Escape for close", async () => {
		const copied: string[] = [];
		const results: SideChatOverlayResult[] = [];
		const overlay = new SideChatOverlay(
			fakeTui() as never,
			theme,
			(result) => results.push(result),
			async () => "answer",
			{
				initialMessages: [{ role: "assistant", text: "latest answer" }],
				onCopy: async (text) => {
					copied.push(text);
				},
			},
		);

		overlay.input = "draft text";
		overlay.handleInput("\x03");
		await waitFor(() => copied.length === 1);
		expect(copied).toEqual(["draft text"]);
		expect(results).toHaveLength(0);

		overlay.input = "";
		overlay.handleInput("\x03");
		await waitFor(() => copied.length === 2);
		expect(copied[1]).toBe("latest answer");

		overlay.handleInput("\x1b");
		expect(results).toEqual([{ action: "close", draft: "" }]);
	});

	it("emits a fixed human enqueue action without turning transcript text into a command", () => {
		const results: SideChatOverlayResult[] = [];
		const overlay = new SideChatOverlay(
			fakeTui() as never,
			theme,
			(result) => results.push(result),
			async () => "answer",
			{
				initialMessages: [
					{ role: "user", text: "Please promote this discussion" },
					{ role: "assistant", text: "The host must confirm that action." },
				],
				initialDraft: "keep this draft",
			},
		);

		overlay.handleInput("\x14");

		expect(results).toEqual([{ action: "enqueue", draft: "keep this draft" }]);
	});
});
