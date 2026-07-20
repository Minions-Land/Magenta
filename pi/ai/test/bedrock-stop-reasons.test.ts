import { describe, expect, it, vi } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

/**
 * Synthetic tests for Bedrock stop-reason handling (AI-033).
 *
 * The mapStopReason function now returns { stopReason, errorMessage? }
 * to pass unhandled provider stop reasons to the error message.
 */

describe("Bedrock stop-reason error messages", () => {
	it("includes unhandled stop reasons in the error message", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6");
		const context: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		// Mock the BedrockRuntimeClient.send to return a synthetic stream with an unhandled stop reason
		const mockSend = vi.fn(async () => ({
			$metadata: { httpStatusCode: 200 },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield {
					contentBlockStart: {
						contentBlockIndex: 0,
						start: { text: "" },
					},
				};
				yield {
					contentBlockDelta: {
						contentBlockIndex: 0,
						delta: { text: "Hello" },
					},
				};
				yield { contentBlockStop: { contentBlockIndex: 0 } };
				yield { messageStop: { stopReason: "CUSTOM_UNHANDLED_REASON" } };
				yield {
					metadata: {
						usage: {
							inputTokens: 10,
							outputTokens: 5,
							totalTokens: 15,
						},
						metrics: { latencyMs: 100 },
					},
				};
			})(),
		}));

		// Inject the mock by importing BedrockRuntimeClient and stubbing its prototype
		const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
		const originalSend = BedrockRuntimeClient.prototype.send;
		BedrockRuntimeClient.prototype.send = mockSend as any;

		try {
			const s = streamBedrock(model, context, {
				env: { AWS_BEDROCK_SKIP_AUTH: "1" },
			});

			const result = await s.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("CUSTOM_UNHANDLED_REASON");
		} finally {
			BedrockRuntimeClient.prototype.send = originalSend;
		}
	});

	it("does not include error messages for known stop reasons", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6");
		const context: Context = {
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const mockSend = vi.fn(async () => ({
			$metadata: { httpStatusCode: 200 },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield {
					contentBlockStart: {
						contentBlockIndex: 0,
						start: { text: "" },
					},
				};
				yield {
					contentBlockDelta: {
						contentBlockIndex: 0,
						delta: { text: "Hello" },
					},
				};
				yield { contentBlockStop: { contentBlockIndex: 0 } };
				yield { messageStop: { stopReason: "end_turn" } };
				yield {
					metadata: {
						usage: {
							inputTokens: 10,
							outputTokens: 5,
							totalTokens: 15,
						},
						metrics: { latencyMs: 100 },
					},
				};
			})(),
		}));

		const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
		const originalSend = BedrockRuntimeClient.prototype.send;
		BedrockRuntimeClient.prototype.send = mockSend as any;

		try {
			const s = streamBedrock(model, context, {
				env: { AWS_BEDROCK_SKIP_AUTH: "1" },
			});

			const result = await s.result();
			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
			expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		} finally {
			BedrockRuntimeClient.prototype.send = originalSend;
		}
	});
});
