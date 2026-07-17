import type { Api, Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, ThinkingLevel, Context } from "../types.ts";
import { estimateMaxOutputTokens } from "../utils/estimate.ts";
import { clampThinkingLevel } from "../models.ts";

export function buildBaseOptions(_model: Model<Api>, options?: SimpleStreamOptions, apiKey?: string): StreamOptions {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onWirePayload: options?.onWirePayload,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}

/**
 * Blanket clamp xhigh/max to high for budget-based thinking systems that don't
 * support extended levels. Used by adjustMaxTokensForThinking.
 */
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/**
 * Model-aware clamping for Bedrock budget keys. Clamps to the highest supported
 * level per the model's thinkingLevelMap, then further restricts to budget tiers.
 */
export function clampReasoningForBudget<TApi extends Api>(
	model: Model<TApi>,
	effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh" | "max" | "off"> | undefined {
	if (!effort) return undefined;
	const clamped = clampThinkingLevel(model, effort);
	// Budget keys exclude off/xhigh/max.
	if (clamped === "off") return "low";
	return clamped === "xhigh" || clamped === "max" ? "high" : clamped;
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	const defaultBudgets: ThinkingBudgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
	};
	const budgets = { ...defaultBudgets, ...customBudgets };

	const minOutputTokens = 1024;
	const level = clampReasoning(reasoningLevel)!;
	let thinkingBudget = budgets[level]!;
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	}

	return { maxTokens, thinkingBudget };
}

/**
 * Resolve the effective maxTokens for a request, applying a context-aware cap
 * when the caller hasn't specified one. This ensures input + output tokens fit
 * within the model's contextWindow budget.
 *
 * @param context - The request context (system prompt, messages, tools).
 * @param model - The model with contextWindow and maxTokens.
 * @param explicitMaxTokens - The caller's explicit maxTokens value (if any).
 * @returns A maxTokens value capped to fit within the contextWindow.
 */
export function resolveMaxTokens<TApi extends Api>(
	context: Context,
	model: Model<TApi>,
	explicitMaxTokens: number | undefined,
): number {
	if (explicitMaxTokens !== undefined) {
		return explicitMaxTokens;
	}
	return estimateMaxOutputTokens(context, model);
}
