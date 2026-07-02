import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionContext } from "../../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionGroupComponent } from "../../../src/modes/interactive/components/tool-execution-group.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	pendingToolGroups: Map<string, ToolExecutionGroupComponent>;
	streamingToolGroup?: ToolExecutionGroupComponent;
	streamingComponent?: unknown;
	streamingMessage?: AssistantMessage;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	runtimeHost: {
		session: {
			retryAttempt: number;
			settingsManager: {
				getShowImages(): boolean;
				getImageWidthCells(): number;
				getCodeBlockIndent(): number;
			};
			sessionManager: { getCwd(): string };
			getToolDefinition(toolName: string): undefined;
		};
	};
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
};

type RenderSessionContext = (
	this: RenderSessionContextThis,
	sessionContext: SessionContext,
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	const fakeThis = Object.create(InteractiveMode.prototype) as Record<string, unknown>;
	Object.defineProperties(fakeThis, {
		pendingTools: { value: new Map<string, ToolExecutionComponent>(), writable: true },
		pendingToolGroups: { value: new Map<string, ToolExecutionGroupComponent>(), writable: true },
		streamingToolGroup: { value: undefined, writable: true },
		streamingComponent: { value: undefined, writable: true },
		streamingMessage: { value: undefined, writable: true },
		chatContainer: { value: chatContainer, writable: true },
		footer: { value: { invalidate: vi.fn() }, writable: true },
		ui: { value: { requestRender: vi.fn() } as unknown as TUI, writable: true },
		runtimeHost: {
			value: {
				session: {
					retryAttempt: 0,
					settingsManager: {
						getShowImages: () => false,
						getImageWidthCells: () => 60,
						getCodeBlockIndent: () => 0,
					},
					sessionManager: { getCwd: () => process.cwd() },
					getToolDefinition: (_toolName: string) => undefined,
				},
			},
			writable: true,
		},
		toolOutputExpanded: { value: false, writable: true },
		isInitialized: { value: true, writable: true },
		updateEditorBorderColor: { value: vi.fn(), writable: true },
		addMessageToChat: {
			value(message: AgentMessage) {
				chatContainer.addChild(new Text(message.role, 0, 0));
			},
			writable: true,
		},
	});
	return fakeThis as RenderSessionContextThis;
}

function createAssistantToolCallMessage(
	toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [
		{ id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { delayMs: 10_000 } },
	],
): AssistantMessage {
	return {
		role: "assistant",
		content: toolCalls.map((toolCall) => ({ type: "toolCall", ...toolCall })),
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionContext(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		thinkingLevel: "off",
		model: null,
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionContext", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		renderSessionContext.call(fakeThis, createSessionContext([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
		});

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;

		renderSessionContext.call(
			fakeThis,
			createSessionContext([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});

	test("groups final-message tool calls before later execution events arrive", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const firstId = "tool-final-1";
		const secondId = "tool-final-2";
		const assistant = createAssistantToolCallMessage([
			{ id: firstId, name: "bash", arguments: { command: "npm test" } },
			{ id: secondId, name: "read", arguments: { path: "src/index.ts" } },
		]);

		await handleEvent.call(fakeThis, {
			type: "message_start",
			message: {
				...assistant,
				content: [],
			},
		});
		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: assistant,
		});

		const groups = fakeThis.chatContainer.children.filter((child) => child instanceof ToolExecutionGroupComponent);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.size).toBe(2);
		expect(fakeThis.pendingToolGroups.get(firstId)).toBe(groups[0]);
		expect(fakeThis.pendingToolGroups.get(secondId)).toBe(groups[0]);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolCallId: firstId,
			toolName: "bash",
			args: { command: "npm test" },
		});
		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: firstId,
			toolName: "bash",
			result: { content: [{ type: "text", text: "TESTS_DONE" }], details: undefined },
			isError: false,
		});

		const rendered = renderChat(fakeThis.chatContainer);
		expect(rendered).toContain("activity");
		expect(rendered).toContain("tools ×2");
		expect(rendered).toContain("✓1");
		expect(rendered).toContain("·1");
		expect(fakeThis.pendingTools.has(firstId)).toBe(false);
		expect(fakeThis.pendingTools.has(secondId)).toBe(true);
		expect(fakeThis.pendingToolGroups.has(firstId)).toBe(false);
		expect(fakeThis.pendingToolGroups.get(secondId)).toBe(groups[0]);
	});
});
