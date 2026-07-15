import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import type { SideChatHandoffRequest, SideChatHandoffResult } from "../src/core/side-chat.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

function request(): SideChatHandoffRequest {
	return {
		confirmed: true,
		origin: "side",
		conversationId: "side-conversation",
		label: "side · queue design",
		context: "Human: promote this discussion",
		messageCount: 1,
		originalBytes: 31,
		truncated: false,
	};
}

describe("AgentSession human Side/BTW handoff", () => {
	it("activates the existing teammate control plane only after the confirmed human action", async () => {
		const harness = await createHarness({ executionProfile: "high" });
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_teammates: {
				startHumanSideHandoff: (
					request: SideChatHandoffRequest,
					ctx: ExtensionCommandContext,
				) => Promise<SideChatHandoffResult>;
			};
			_enqueueHumanSideHandoff: (
				request: SideChatHandoffRequest,
				ctx: ExtensionCommandContext,
			) => Promise<SideChatHandoffResult>;
		};
		const start = vi.spyOn(internals._teammates, "startHumanSideHandoff").mockResolvedValue({
			handoffId: "handoff-1",
			teammateId: "teammate_001",
			sessionId: "child-session",
		} as SideChatHandoffResult);

		expect(harness.session.getActiveToolNames()).not.toContain("teammate_agent");
		expect(harness.session.systemPrompt).not.toContain("Side/BTW invitation");

		const result = await internals._enqueueHumanSideHandoff(request(), {} as ExtensionCommandContext);

		expect(result.teammateId).toBe("teammate_001");
		expect(start).toHaveBeenCalledTimes(1);
		expect(harness.session.getActiveToolNames()).toContain("teammate_agent");
		expect(harness.session.systemPrompt).toContain("teammate_agent");
		expect(harness.session.systemPrompt).not.toContain("Side/BTW invitation");
		expect(harness.session.systemPrompt).not.toContain("human handoff");
	});

	it("honors an explicit teammate capability denial", async () => {
		const harness = await createHarness({
			executionProfile: "high",
			settings: { harness: { teammates: false } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_teammates: { startHumanSideHandoff: (...args: never[]) => Promise<SideChatHandoffResult> };
			_enqueueHumanSideHandoff: (
				request: SideChatHandoffRequest,
				ctx: ExtensionCommandContext,
			) => Promise<SideChatHandoffResult>;
		};
		const start = vi.spyOn(internals._teammates, "startHumanSideHandoff");

		await expect(internals._enqueueHumanSideHandoff(request(), {} as ExtensionCommandContext)).rejects.toThrow(
			"explicitly disabled in settings",
		);
		expect(start).not.toHaveBeenCalled();
		expect(harness.session.getActiveToolNames()).not.toContain("teammate_agent");
	});
});
