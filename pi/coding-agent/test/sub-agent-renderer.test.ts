import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { subAgentRenderer } from "../src/core/tools/sub-agent-renderer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("sub-agent renderer", () => {
	beforeAll(() => {
		initTheme("default");
	});

	const mockContext: ToolRenderContext = {
		args: {},
		toolCallId: "test-call",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: "/test",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};

	it("should render multi-agent start as activity gallery", () => {
		const result = {
			content: [
				{
					type: "text",
					text: `Started 3 sub-agents concurrently with automatic return to main agent:
agent_001	running	msg-delivery	/Users/mjm/.magenta/agent/tmp/sub-agents/agent_001-2026-07-06T06-28-37-603Z.log
agent_002	running	tree-branch	/Users/mjm/.magenta/agent/tmp/sub-agents/agent_002-2026-07-06T06-28-37-620Z.log
agent_003	running	cross-session	/Users/mjm/.magenta/agent/tmp/sub-agents/agent_003-2026-07-06T06-28-37-624Z.log
Parent progress: /Users/mjm/.magenta/agent/tmp/sub-agents/main-tool-progress.md`,
				},
			],
		};

		const component = subAgentRenderer.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			theme,
			mockContext,
		);

		expect(component).toBeDefined();
		const rendered = component!.render(80);
		const text = rendered.join("\n");

		// Should use activity/gallery format with agent IDs and labels
		expect(text).toContain("agent_001");
		expect(text).toContain("agent_002");
		expect(text).toContain("agent_003");
		expect(text).toContain("msg-delivery");
		expect(text).toContain("tree-branch");
		expect(text).toContain("cross-session");
		expect(text).toContain("Parent progress");
	});

	it("should render collapsed output with fold indicator", () => {
		const result = {
			content: [
				{
					type: "text",
					text: `Sub-agent: agent_001
Status: exited
Role: general
CWD: /test
Tools: read,grep,find

Output:
Line 1
Line 2
Line 3
Line 4
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11
Line 12
Line 13
Line 14
Line 15`,
				},
			],
		};

		const component = subAgentRenderer.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			theme,
			mockContext,
		);

		expect(component).toBeDefined();
		const rendered = component!.render(80);
		const text = rendered.join("\n");

		// Should show header
		expect(text).toContain("Sub-agent: agent_001");
		expect(text).toContain("Status: exited");

		// Should show fold indicator
		expect(text).toContain("more lines");
		expect(text).toContain("to expand");
	});

	it("should render expanded output without fold indicator", () => {
		const result = {
			content: [
				{
					type: "text",
					text: `Sub-agent: agent_001
Status: exited
Role: general
CWD: /test
Tools: read,grep,find

Output:
Line 1
Line 2
Line 3
Line 4
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11
Line 12`,
				},
			],
		};

		const component = subAgentRenderer.renderResult?.(
			result,
			{ expanded: true, isPartial: false },
			theme,
			mockContext,
		);

		expect(component).toBeDefined();
		const rendered = component!.render(80);
		const text = rendered.join("\n");

		// Should show all lines
		expect(text).toContain("Line 1");
		expect(text).toContain("Line 12");

		// Should show collapse hint
		expect(text).toContain("to collapse");
	});

	it("should render short output without fold indicators", () => {
		const result = {
			content: [
				{
					type: "text",
					text: `Sub-agent: agent_001
Status: exited
Role: general
CWD: /test
Tools: read,grep,find

Output:
Line 1
Line 2
Line 3`,
				},
			],
		};

		const component = subAgentRenderer.renderResult?.(
			result,
			{ expanded: false, isPartial: false },
			theme,
			mockContext,
		);

		expect(component).toBeDefined();
		const rendered = component!.render(80);
		const text = rendered.join("\n");

		// Should show all lines without fold indicator
		expect(text).toContain("Line 1");
		expect(text).toContain("Line 3");
		expect(text).not.toContain("more lines");
	});

	it("should handle output with no content", () => {
		const result = {
			content: [
				{
					type: "text",
					text: `Sub-agent: agent_001
Status: running
Role: general`,
				},
			],
		};

		const component = subAgentRenderer.renderResult?.(
			result,
			{ expanded: false, isPartial: true },
			theme,
			mockContext,
		);

		expect(component).toBeDefined();
		const rendered = component!.render(80);
		const text = rendered.join("\n");

		expect(text).toContain("Sub-agent: agent_001");
		expect(text).toContain("Status: running");
	});
});
