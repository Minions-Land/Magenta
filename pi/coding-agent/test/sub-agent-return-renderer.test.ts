import { beforeAll, describe, expect, it } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import type { SubAgentEventSnapshot } from "../src/core/tools/sub-agent.ts";
import {
	type SubAgentReturnDetails,
	subAgentReturnRenderer,
} from "../src/modes/interactive/components/sub-agent-return-renderer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("sub-agent-return renderer", () => {
	beforeAll(() => {
		initTheme("default");
	});

	const createReturnMessage = (
		eventData?: SubAgentEventSnapshot[],
		instruction?: string,
	): CustomMessage<SubAgentReturnDetails> => ({
		role: "custom",
		customType: "sub-agent-return",
		content: instruction
			? `${instruction}\n\nSub-agent: agent_001 (test)\nStatus: exited\nRole: general\nCWD: /tmp\nTools: read\nModel: default\nThinking: low\nElapsed: 500ms\nExit code: 0\nSignal: n/a\nPrompt: /tmp/p.md\nLog: /tmp/l.log\nTask: test task\n\nOutput:\nfinding-1\nfinding-2\nfinding-3`
			: "Sub-agent: agent_001 (test)\nStatus: exited\nRole: general\nCWD: /tmp\nTools: read\nModel: default\nThinking: low\nElapsed: 500ms\nExit code: 0\nSignal: n/a\nPrompt: /tmp/p.md\nLog: /tmp/l.log\nTask: test task\n\nOutput:\nfinding-1\nfinding-2\nfinding-3",
		display: true,
		timestamp: Date.now(),
		details: {
			ids: ["agent_001"],
			statuses: ["exited"],
			instruction,
			eventData,
		},
	});

	it("renders collapsed by default when eventData present", () => {
		const eventSnapshot: SubAgentEventSnapshot = {
			id: "agent_001",
			kind: "agent",
			task: "test task",
			role: "general",
			label: "test",
			cwd: "/tmp",
			tools: ["read"],
			model: "default",
			thinking: "low",
			promptPath: "/tmp/p.md",
			logPath: "/tmp/l.log",
			startedAt: Date.now() - 500,
			endedAt: Date.now(),
			status: "exited",
			exitCode: 0,
			signal: null,
			tail: "finding-1\nfinding-2\nfinding-3",
		};

		const msg = createReturnMessage([eventSnapshot], "Findings ready.");
		const component = subAgentReturnRenderer(msg, { expanded: false }, theme);

		expect(component).toBeDefined();
		const rendered = component.render(100);
		const text = rendered.join("\n");

		// Collapsed: compact summary and line-count hint, but never the model instruction
		expect(text).not.toContain("Findings ready");
		expect(text).toContain("Sub-agent agent_001");
		expect(text).toContain("exited");
		expect(text).toContain("3 output lines hidden");
		expect(text).toContain("ctrl+o to expand");

		// Should NOT show full metadata or actual output
		expect(text).not.toContain("Role: general");
		expect(text).not.toContain("finding-1");
	});

	it("renders expanded when requested", () => {
		const eventSnapshot: SubAgentEventSnapshot = {
			id: "agent_001",
			kind: "agent",
			task: "test task",
			role: "general",
			label: "test",
			cwd: "/tmp",
			tools: ["read"],
			model: "default",
			thinking: "low",
			promptPath: "/tmp/p.md",
			logPath: "/tmp/l.log",
			startedAt: Date.now() - 500,
			endedAt: Date.now(),
			status: "exited",
			exitCode: 0,
			signal: null,
			tail: "finding-1\nfinding-2\nfinding-3",
		};

		const msg = createReturnMessage([eventSnapshot], "Findings ready.");
		const component = subAgentReturnRenderer(msg, { expanded: true }, theme);

		expect(component).toBeDefined();
		const rendered = component.render(100);
		const text = rendered.join("\n");

		// Expanded: full metadata and actual output, but still no model instruction
		expect(text).not.toContain("Findings ready");
		expect(text).toContain("Sub-agent: agent_001");
		expect(text).toContain("Role: general");
		expect(text).toContain("CWD: /tmp");
		expect(text).toContain("Output:");
		expect(text).toContain("finding-1");
		expect(text).toContain("finding-2");

		// Should NOT show line-count hint
		expect(text).not.toContain("hidden");
	});

	it("renders multiple events with separator", () => {
		const event1: SubAgentEventSnapshot = {
			id: "agent_001",
			kind: "agent",
			task: "task-1",
			cwd: "/tmp",
			tools: ["read"],
			thinking: "low",
			promptPath: "/tmp/p1.md",
			logPath: "/tmp/l1.log",
			startedAt: Date.now() - 500,
			endedAt: Date.now(),
			status: "exited",
			exitCode: 0,
			signal: null,
			tail: "result-1",
		};
		const event2: SubAgentEventSnapshot = {
			id: "agent_002",
			kind: "agent",
			task: "task-2",
			cwd: "/tmp",
			tools: ["grep"],
			thinking: "low",
			promptPath: "/tmp/p2.md",
			logPath: "/tmp/l2.log",
			startedAt: Date.now() - 400,
			endedAt: Date.now(),
			status: "exited",
			exitCode: 0,
			signal: null,
			tail: "result-2",
		};

		const msg = createReturnMessage([event1, event2], "Both complete.");
		const component = subAgentReturnRenderer(msg, { expanded: false }, theme);

		expect(component).toBeDefined();
		const text = component.render(100).join("\n");
		expect(text).toContain("agent_001");
		expect(text).toContain("agent_002");
		expect(text).toContain("1 output line hidden");
	});

	it("handles workflow events with collapsed result count", () => {
		const workflowSnapshot: SubAgentEventSnapshot = {
			id: "agent_001",
			kind: "workflow",
			task: "workflow-label",
			label: "workflow-label",
			cwd: "/tmp",
			tools: [],
			thinking: "low",
			promptPath: "/tmp/wf.log",
			logPath: "/tmp/wf.log",
			pattern: "fan_out_synthesize",
			workflowResult: {
				pattern: "fan_out_synthesize",
				terminatedBy: "completed",
				workers: [{ workerId: "worker_1", success: true, text: "partial finding", durationMs: 10 }],
				outcome: {
					workerId: "synthesizer",
					success: true,
					text: "final output from workflow",
					durationMs: 20,
				},
			},
			startedAt: Date.now() - 1000,
			endedAt: Date.now(),
			status: "exited",
			exitCode: 0,
			signal: null,
			tail: "",
		};

		const msg = createReturnMessage([workflowSnapshot], "Workflow done.");
		const component = subAgentReturnRenderer(msg, { expanded: false }, theme);

		expect(component).toBeDefined();
		const rendered = component.render(100);
		const text = rendered.join("\n");

		// Collapsed workflow: should show pattern and result line count
		expect(text).toContain("Workflow agent_001");
		expect(text).toContain("fan_out_synthesize");
		expect(text).toContain("result");
		expect(text).toContain("hidden");
		expect(text).toContain("ctrl+o to expand");
	});

	it("stays compact for legacy messages without eventData, expanding to raw content", () => {
		const msg = createReturnMessage(undefined, "No eventData.");

		// Collapsed: compact per-id line, no raw output dump.
		const collapsed = subAgentReturnRenderer(msg, { expanded: false }, theme).render(100).join("\n");
		expect(collapsed).toContain("Sub-agent agent_001: exited (ctrl+o to expand)");
		expect(collapsed).not.toContain("finding-1");

		// Expanded: falls back to the raw content payload.
		const expanded = subAgentReturnRenderer(msg, { expanded: true }, theme).render(100).join("\n");
		expect(expanded).toContain("finding-1");
	});
});
