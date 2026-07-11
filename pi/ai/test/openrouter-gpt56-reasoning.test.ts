import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, ModelThinkingLevel } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

async function captureReasoning(reasoning?: ModelThinkingLevel): Promise<{ effort?: string } | undefined> {
	let captured: { reasoning?: { effort?: string } } | undefined;
	const model = {
		...getModel("openrouter", "openai/gpt-5.6-sol"),
		baseUrl: "http://127.0.0.1:9",
	};
	const stream = streamSimple(model, context, {
		apiKey: "test-key",
		reasoning: reasoning === "off" ? undefined : reasoning,
		onPayload: (payload) => {
			captured = payload as typeof captured;
		},
	});

	await stream.result();
	return captured?.reasoning;
}

describe("OpenRouter GPT-5.6 reasoning", () => {
	it("sends max as the provider reasoning effort", async () => {
		await expect(captureReasoning("max")).resolves.toEqual({ effort: "max" });
	});

	it("maps thinking off to none", async () => {
		await expect(captureReasoning("off")).resolves.toEqual({ effort: "none" });
	});
});
