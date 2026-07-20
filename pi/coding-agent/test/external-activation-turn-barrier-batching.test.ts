import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalActivationEntry } from "../src/core/external-activation-coordinator.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()!.cleanup();
});

function backgroundEntry(id: string): ExternalActivationEntry {
	return {
		key: `bg-shell:${id}`,
		source: { kind: "background", controller: "bg_shell", eventIds: [id] },
		consumeIds: [id],
		message: {
			customType: "bg-shell-return",
			content: `background ${id}`,
			display: true,
			details: { id },
		},
		delivery: "followUp",
		idlePolicy: "activate",
	};
}

function externalCoordinator(harness: Harness) {
	return (harness.session as any)._externalActivations as {
		register: (entry: ExternalActivationEntry) => void;
	};
}


function peerSteerEntry(id: string): ExternalActivationEntry {
	return {
		key: `peer:steer:${id}`,
		source: { kind: "peer", messageIds: [id] },
		consumeIds: [id],
		message: {
			customType: "magenta-peer-message",
			content: `peer ${id}`,
			display: true,
			details: { ids: [id] },
		},
		delivery: "steer",
		idlePolicy: "activate",
	};
}

describe("External activation batching (turnBarrier)", () => {
	it("batches events that complete during an active run into ONE follow-up wake", async () => {
		// A slow tool keeps the run active (streaming) for ~350ms so three staggered
		// bg_shell completions all arrive DURING the run and coalesce behind the turn
		// barrier, flushing as one batch at agent_end.
		let toolResolve: (() => void) | undefined;
		const toolGate = new Promise<void>((resolve) => {
			toolResolve = resolve;
		});
		const slowTool = {
			name: "slow",
			description: "A slow tool",
			label: "slow",
			parameters: Type.Object({}),
			execute: async () => {
				await toolGate;
				return { content: [{ type: "text" as const, text: "slow done" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool], initialActiveToolNames: ["slow"] });
		harnesses.push(harness);

		const agentStarts: number[] = [];
		const followUpBatchSizes: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") agentStarts.push(Date.now());
		});
		const origFollowUpBatch = harness.session.agent.followUpBatch.bind(harness.session.agent);
		vi.spyOn(harness.session.agent, "followUpBatch").mockImplementation((messages) => {
			followUpBatchSizes.push(messages.length);
			return origFollowUpBatch(messages);
		});

		// Turn 1: tool call (keeps run active). Turn 2 (after followups): final text.
		harness.setResponses([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_slow", name: "slow", arguments: {} }],
				stopReason: "toolUse",
			} as any,
			fauxAssistantMessage("acknowledged all three"),
			fauxAssistantMessage("extra"),
		]);

		const runPromise = harness.session.prompt("start slow work");

		// While the slow tool is running, three bg_shell events complete 100ms apart.
		await new Promise((r) => setTimeout(r, 30));
		externalCoordinator(harness).register(backgroundEntry("event1"));
		await new Promise((r) => setTimeout(r, 100));
		externalCoordinator(harness).register(backgroundEntry("event2"));
		await new Promise((r) => setTimeout(r, 100));
		externalCoordinator(harness).register(backgroundEntry("event3"));
		await new Promise((r) => setTimeout(r, 30));

		// Let the slow tool finish -> run reaches agent_end -> turnBarrier releases.
		toolResolve?.();
		await runPromise;
		await new Promise((r) => setTimeout(r, 80));

		console.log(`agent_start count: ${agentStarts.length}`);
		console.log(`followUpBatch sizes: ${JSON.stringify(followUpBatchSizes)}`);

		// The three events were coalesced behind the turn barrier and delivered as one
		// follow-up batch of size 3.
		expect(followUpBatchSizes).toContain(3);
		// They did NOT each trigger a separate follow-up injection.
		expect(followUpBatchSizes.every((size) => size === 3 || size === 0)).toBe(true);
	});

	it("wakes once with ALL ready events, not just the triggering one", async () => {
		// Core user requirement: "pending 的、已完成的，不应该一起回来吗"
		// Event2 completes before event1's timer fires → both should wake together.
		const harness = await createHarness({ initialActiveToolNames: [] });
		harnesses.push(harness);

		const agentStarts: number[] = [];
		const customMsgs: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") agentStarts.push(Date.now());
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				typeof event.message.content === "string"
			) {
				customMsgs.push(event.message.content);
			}
		});

		harness.setResponses([fauxAssistantMessage("ack both")]);

		// Event1 arrives and starts the 50ms timer.
		externalCoordinator(harness).register(backgroundEntry("event1"));
		// 20ms later, event2 arrives (both within the same 50ms window).
		await new Promise((r) => setTimeout(r, 20));
		externalCoordinator(harness).register(backgroundEntry("event2"));
		// Wait for the timer to fire and flush both.
		await new Promise((r) => setTimeout(r, 100));

		console.log(`wake-all test: agent_starts=${agentStarts.length}, messages=[${customMsgs.join(", ")}]`);

		// ONE wake with BOTH events delivered together.
		expect(agentStarts.length).toBe(1);
		expect(customMsgs).toEqual(["background event1", "background event2"]);
	});
	it("lets a steer peer message interrupt mid-run while followUp events stay held", async () => {
		let toolResolve: (() => void) | undefined;
		const toolGate = new Promise<void>((resolve) => {
			toolResolve = resolve;
		});
		const slowTool = {
			name: "slow",
			description: "A slow tool",
			label: "slow",
			parameters: Type.Object({}),
			execute: async () => {
				await toolGate;
				return { content: [{ type: "text" as const, text: "slow done" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool], initialActiveToolNames: ["slow"] });
		harnesses.push(harness);

		const steerSizes: number[] = [];
		const followUpSizes: number[] = [];
		const origSteer = harness.session.agent.steerBatch.bind(harness.session.agent);
		const origFollowUp = harness.session.agent.followUpBatch.bind(harness.session.agent);
		vi.spyOn(harness.session.agent, "steerBatch").mockImplementation((messages) => {
			steerSizes.push(messages.length);
			return origSteer(messages);
		});
		vi.spyOn(harness.session.agent, "followUpBatch").mockImplementation((messages) => {
			followUpSizes.push(messages.length);
			return origFollowUp(messages);
		});

		harness.setResponses([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_slow", name: "slow", arguments: {} }],
				stopReason: "toolUse",
			} as any,
			fauxAssistantMessage("handled steer + followups"),
			fauxAssistantMessage("extra"),
		]);

		const runPromise = harness.session.prompt("start slow work");

		// During the active run: two followUp bg events + one steer peer message.
		await new Promise((r) => setTimeout(r, 30));
		externalCoordinator(harness).register(backgroundEntry("bg1"));
		externalCoordinator(harness).register(peerSteerEntry("urgent"));
		externalCoordinator(harness).register(backgroundEntry("bg2"));
		await new Promise((r) => setTimeout(r, 80));

		// Steer must have passed through mid-run (before the tool releases).
		console.log(`mid-run steer sizes=${JSON.stringify(steerSizes)}, followUp sizes=${JSON.stringify(followUpSizes)}`);
		expect(steerSizes).toContain(1);
		// followUp events are still held behind the turn barrier.
		expect(followUpSizes).toEqual([]);

		toolResolve?.();
		await runPromise;
		await new Promise((r) => setTimeout(r, 80));

		// After agent_end, the two held followUp events flush together as one batch.
		expect(followUpSizes).toContain(2);
	});
});