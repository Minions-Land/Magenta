import type { TokenUsage as BedrockTokenUsage } from "@aws-sdk/client-bedrock-runtime";
import type { GenerateContentResponseUsageMetadata } from "@google/genai";
import type { Usage } from "../types.ts";

function nonNegative(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function emptyCost(): Usage["cost"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function normalizeInclusivePromptUsage(options: {
	promptTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cacheWrite1hTokens?: number;
	additionalInputTokens?: number;
	totalTokens?: number;
}): Usage {
	const promptTokens = nonNegative(options.promptTokens);
	const cacheRead = Math.min(promptTokens, nonNegative(options.cacheReadTokens));
	const cacheWrite = Math.min(promptTokens - cacheRead, nonNegative(options.cacheWriteTokens));
	const cacheWrite1h = Math.min(cacheWrite, nonNegative(options.cacheWrite1hTokens));
	const input = promptTokens - cacheRead - cacheWrite + nonNegative(options.additionalInputTokens);
	const output = nonNegative(options.outputTokens);
	const componentTotal = input + output + cacheRead + cacheWrite;
	const reportedTotal = nonNegative(options.totalTokens);

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(cacheWrite1h > 0 ? { cacheWrite1h } : {}),
		totalTokens: reportedTotal || componentTotal,
		cost: emptyCost(),
	};
}

/** Bedrock inputTokens includes cache reads and writes; expose disjoint Usage components. */
export function normalizeBedrockTokenUsage(usage: BedrockTokenUsage): Usage {
	return normalizeInclusivePromptUsage({
		promptTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadInputTokens,
		cacheWriteTokens: usage.cacheWriteInputTokens,
		cacheWrite1hTokens: usage.cacheDetails
			?.filter((detail) => detail.ttl === "1h")
			.reduce((total, detail) => total + nonNegative(detail.inputTokens), 0),
		totalTokens: usage.totalTokens,
	});
}

/** Google reports tool-use results outside promptTokenCount but includes them in totalTokenCount. */
export function normalizeGoogleTokenUsage(usage: GenerateContentResponseUsageMetadata): Usage {
	return normalizeInclusivePromptUsage({
		promptTokens: usage.promptTokenCount,
		outputTokens: nonNegative(usage.candidatesTokenCount) + nonNegative(usage.thoughtsTokenCount),
		cacheReadTokens: usage.cachedContentTokenCount,
		additionalInputTokens: usage.toolUsePromptTokenCount,
		totalTokens: usage.totalTokenCount,
	});
}
