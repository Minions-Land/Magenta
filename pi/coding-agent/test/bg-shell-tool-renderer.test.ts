import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { BackgroundShellEventSnapshot } from "../src/core/tools/bg-shell.ts";
import { bgShellRenderer } from "../src/core/tools/bg-shell-renderer.ts";
import { registerBuiltinRenderers } from "../src/core/tools/register-builtin-renderers.ts";
import { getRenderer } from "../src/core/tools/renderer-registry.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const eventData: BackgroundShellEventSnapshot = {
	id: "bg_001",
	command: "npm test",
	cwd: "/tmp/project",
	logPath: "/tmp/bg_001.log",
	startedAt: 1_000,
	endedAt: 3_000,
	status: "failed",
	exitCode: 1,
	signal: null,
	error: "exit code 1",
	tail: "first line\nlast line",
};

const details = { action: "wait", id: eventData.id, status: eventData.status, eventData };

function render(expanded: boolean): string {
	return stripAnsi(
		bgShellRenderer
			.renderResult?.(
				{ content: [{ type: "text", text: "model output" }], details },
				{ expanded, isPartial: false },
				theme,
				{
					args: {},
					toolCallId: "call-1",
					lastComponent: undefined,
					invalidate: () => {},
					state: {},
					cwd: "/tmp/project",
					executionStarted: true,
					argsComplete: true,
					isPartial: false,
					expanded,
					showImages: false,
					isError: false,
				},
			)
			?.render(120)
			.join("\n") ?? "",
	);
}

describe("bg-shell direct tool renderer", () => {
	beforeAll(() => {
		initTheme("default");
		registerBuiltinRenderers();
	});

	it("renders a compact action/status/elapsed summary with a short tail", () => {
		const text = render(false);
		expect(text).toContain("wait bg_001: failed (2s)");
		expect(text).toContain("first line");
		expect(text).toContain("last line");
		expect(text).not.toContain("Command: npm test");
		expect(text).not.toContain("/tmp/project");
		expect(text).not.toContain("/tmp/bg_001.log");
		expect(text).not.toContain("model output");
	});

	it("expands from eventData without exposing the model-facing payload", () => {
		const text = render(true);
		expect(text).toContain("Command: npm test");
		expect(text).toContain("CWD: /tmp/project");
		expect(text).toContain("Log: /tmp/bg_001.log");
		expect(text).toContain("last line");
		expect(text).not.toContain("model output");
	});

	it("keeps legacy results compact and routes native renderKind through HTML", () => {
		const legacy = stripAnsi(
			bgShellRenderer
				.renderResult?.(
					{
						content: [{ type: "text", text: "raw legacy payload" }],
						details: { action: "status", id: "bg_9", status: "exited" },
					},
					{ expanded: false, isPartial: false },
					theme,
					{
						args: {},
						toolCallId: "call-legacy",
						lastComponent: undefined,
						invalidate: () => {},
						state: {},
						cwd: "/tmp",
						executionStarted: true,
						argsComplete: true,
						isPartial: false,
						expanded: false,
						showImages: false,
						isError: false,
					},
				)
				?.render(120)
				.join("\n") ?? "",
		);
		expect(legacy).toContain("status bg_9: exited");
		expect(legacy).not.toContain("raw legacy payload");
		expect(getRenderer("bg-shell")).toBe(bgShellRenderer);

		const definition = {
			name: "native_bg_shell",
			label: "native_bg_shell",
			description: "native",
			parameters: Type.Any(),
			renderKind: "bg-shell",
			execute: async () => ({ content: [], details: {} }),
		} as unknown as ToolDefinition;
		const html = createToolHtmlRenderer({ getToolDefinition: () => definition, theme, cwd: "/tmp" });
		const output = html.renderResult("call-html", "native_bg_shell", [], details, false);
		expect(output?.collapsed).toContain("wait bg_001: failed");
		expect(output?.collapsed).not.toContain("npm test");
		expect(output?.expanded).toContain("Command: npm test");

		const component = new ToolExecutionComponent(
			"native_bg_shell",
			"call-tui",
			{ action: "wait", eventId: "bg_001" },
			{},
			definition,
			{ requestRender: () => {} } as never,
			"/tmp",
		);
		component.updateResult({ content: [], details, isError: false });
		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("wait bg_001: failed");
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Command: npm test");
	});
});
