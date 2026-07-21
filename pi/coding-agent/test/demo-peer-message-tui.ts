/**
 * Visual demo: peer message send/receive as they appear in TUI.
 *
 * Run: npx tsx pi/coding-agent/test/demo-peer-message-tui.ts
 *
 * Shows the text formatting for:
 *  1. Sending a message (tool call + result)
 *  2. Receiving messages (custom message injection)
 *  3. Footer with SessionID
 */

import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

initTheme(undefined, false);

// ============================================================================
// Mock session
// ============================================================================

const mockSession = {
	sessionId: "a1b2c3d4",
	state: {
		model: { id: "claude-sonnet-4", provider: "anthropic", contextWindow: 200_000, reasoning: false },
		thinkingLevel: "off",
	},
	sessionManager: {
		getCwd: () => "/Users/test-user/Magenta3",
		getSessionName: () => "",
		getEntries: () => [],
	},
	getContextUsage: () => ({ contextWindow: 200_000, percent: 8.2 }),
	modelRegistry: { isUsingOAuth: () => false },
} as unknown as AgentSession;

const mockFooterData: ReadonlyFooterDataProvider = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

console.log("\n");
console.log("═".repeat(80));
console.log("  PEER MESSAGE TUI RENDERING DEMO");
console.log("═".repeat(80));

// ============================================================================
// 1. SENDING a message (what the agent/user sees when calling send_message)
// ============================================================================

console.log(`\n${theme.fg("accent", "1. SENDING a message")} (tool call + result)\n`);
console.log(theme.fg("dim", "─".repeat(80)));

const sendArgs = {
	to: "e5f6g7h8",
	content:
		"Can you review the parser change in src/core/parser.ts? I'm seeing unexpected behavior with nested expressions.",
};

console.log(theme.fg("toolTitle", "send_message") + theme.fg("dim", "("));
console.log(theme.fg("dim", "  to: ") + theme.fg("syntaxString", `"${sendArgs.to}"`));
console.log(theme.fg("dim", "  content: ") + theme.fg("syntaxString", `"${sendArgs.content.slice(0, 60)}..."`));
console.log(theme.fg("dim", ")"));

console.log(`\n${theme.fg("dim", "Result:")}`);
console.log(theme.fg("toolOutput", "Message m:1a2b3c4d delivered to session e5f6g7h8 — recipient is active."));

// ============================================================================
// 2. RECEIVING messages (injected custom block from drain)
// ============================================================================

console.log(`\n${theme.fg("accent", "2. RECEIVING messages")} (custom message injection)\n`);
console.log(theme.fg("dim", "─".repeat(80)));

const receivedMessage = {
	role: "custom" as const,
	customType: "magenta-peer-message",
	content:
		"📨 You have 2 new messages from teammate agents:\n\n" +
		"— from session e5f6g7h8 (sent 2026-07-06T17:55:12Z, sender currently active):\n" +
		"I looked at parser.ts — the issue is in line 142, the precedence table is missing the `??` operator. I'll push a fix to the branch.\n\n" +
		"— from session z9y8x7w6 (sent 2026-07-06T17:56:03Z, sender offline, last seen 2026-07-06T17:50:00Z):\n" +
		"Hey, I finished the test suite refactor. Let me know when you're ready to merge.",
	display: true,
	details: { count: 2, ids: ["m:aaa", "m:bbb"] },
	timestamp: Date.now(),
};

const receiveComponent = new CustomMessageComponent(receivedMessage, undefined, getMarkdownTheme());
const rendered = receiveComponent.render(80);
for (const line of rendered) {
	console.log(line);
}

// ============================================================================
// 3. Footer with SessionID
// ============================================================================

console.log(`\n${theme.fg("accent", "3. FOOTER")} (SessionID on first line)\n`);
console.log(theme.fg("dim", "─".repeat(80)));

const footer = new FooterComponent(mockSession, mockFooterData);
const footerLines = footer.render(80);
for (const line of footerLines) {
	console.log(line);
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${theme.fg("dim", "─".repeat(80))}`);
console.log(theme.fg("dim", "\nKey points:"));
console.log(`${theme.fg("dim", "  • ")}send_message renders as a standard tool call with recipient presence in result`);
console.log(`${theme.fg("dim", "  • ")}Received messages show in a labeled [magenta-peer-message] block, visually`);
console.log(theme.fg("dim", "    distinct from user/assistant conversation"));
console.log(`${theme.fg("dim", "  • ")}Each message includes sender presence (active/idle/offline + last seen)`);
console.log(`${theme.fg("dim", "  • ")}SessionID sits on footer line 1 after cwd/branch, easy to select & copy`);
console.log(`${theme.fg("dim", "  • ")}followUp delivery: messages arrive at turn start, never interrupt tools`);
console.log("\n");
