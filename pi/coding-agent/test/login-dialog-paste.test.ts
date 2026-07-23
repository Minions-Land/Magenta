import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("api-key login dialog paste", () => {
	beforeAll(() => initTheme("dark"));

	it("captures a bracketed-paste API key when the dialog is focused", async () => {
		const fakeTui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(fakeTui, "anthropic", () => {}, "Anthropic");
		dialog.focused = true;

		const pending = dialog.showPrompt("Enter API key:");
		const key = "sk-ant-api03-EXAMPLE_Key-1234567890";
		// The terminal forwards a paste to the focused component wrapped in bracketed-paste markers.
		dialog.handleInput(`\x1b[200~${key}\x1b[201~`);
		dialog.handleInput("\n");

		expect(await pending).toBe(key);
	});
});
