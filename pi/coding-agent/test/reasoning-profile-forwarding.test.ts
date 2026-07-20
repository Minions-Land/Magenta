import {
	fauxAssistantMessage,
	type Context,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("reasoning profile forwarding", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
	});

	it("forwards native profiles and maps Ultra to the model's highest effort", async () => {
		const harness = await createHarness({ models: [{ id: "reasoning-model", reasoning: true }] });
		harnesses.push(harness);
		harness.getModel().thinkingLevelMap = {
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		};

		const capturedReasoning: Array<SimpleStreamOptions["reasoning"]> = [];
		const capture = (_context: Context, options: StreamOptions | undefined) => {
			capturedReasoning.push((options as SimpleStreamOptions | undefined)?.reasoning);
			return fauxAssistantMessage("ok");
		};
		const profiles = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
		harness.setResponses(Array.from({ length: profiles.length + 1 }, () => capture));

		for (const profile of profiles) {
			harness.session.setExecutionProfile(profile);
			await harness.session.prompt(`use ${profile}`);
		}
		await harness.session.prompt("keep the current profile");

		expect(capturedReasoning).toEqual(["low", "medium", "high", "xhigh", "max", "max", "max"]);
		expect(harness.session.executionProfile).toBe("ultra");
		expect(harness.session.thinkingLevel).toBe("max");
		expect(harness.session.harnessCapabilities).toEqual({ workflows: true, teammates: true });
	});
});
