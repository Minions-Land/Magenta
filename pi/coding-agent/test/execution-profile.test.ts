import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	getAvailableExecutionProfiles,
	resolveExecutionProfile,
	resolveHarnessCapabilities,
} from "../src/core/execution-profile.ts";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
		...overrides,
	};
}

describe("execution profiles", () => {
	it("maps Ultra to the highest native level without widening provider types", () => {
		expect(resolveExecutionProfile(model(), "ultra")).toBe("high");
		expect(resolveExecutionProfile(model({ thinkingLevelMap: { xhigh: "xhigh" } }), "ultra")).toBe("xhigh");
		expect(resolveExecutionProfile(model({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } }), "ultra")).toBe("max");
		expect(resolveExecutionProfile(model({ reasoning: false }), "ultra")).toBe("off");
	});

	it("appends Ultra after every model's native levels", () => {
		expect(getAvailableExecutionProfiles(model()).at(-1)).toBe("ultra");
		expect(getAvailableExecutionProfiles(model({ reasoning: false }))).toEqual(["off", "ultra"]);
	});

	it("uses explicit Harness overrides before settings and profile defaults", () => {
		expect(resolveHarnessCapabilities("medium")).toEqual({ workflows: false, teammates: false });
		expect(resolveHarnessCapabilities("ultra")).toEqual({ workflows: true, teammates: true });
		expect(resolveHarnessCapabilities("medium", { workflows: true })).toEqual({
			workflows: true,
			teammates: false,
		});
		expect(resolveHarnessCapabilities("ultra", { workflows: false, teammates: false }, { teammates: true })).toEqual({
			workflows: false,
			teammates: true,
		});
	});
});
