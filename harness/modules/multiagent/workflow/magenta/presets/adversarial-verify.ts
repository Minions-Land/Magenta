/**
 * Preset workflow: Adversarial verification.
 *
 * Generator produces a candidate; N independent verifiers re-check it in
 * parallel. Confidence = passed / N. Confirmed when confidence >= threshold.
 * The confidence is computed here, never self-reported by a model.
 */

const BOOLEAN_VERDICT_SCHEMA = {
	type: "object",
	properties: { verdict: { type: "boolean" }, reason: { type: "string" } },
	required: ["verdict"],
} as const;

function readBooleanField(result: any, field: string): boolean | undefined {
	const s = result.structured as Record<string, unknown> | undefined;
	if (s && typeof s[field] === "boolean") return s[field] as boolean;
	return undefined;
}

export default async function adversarialVerify(args: unknown, ctx: any) {
	const req = args as {
		generator: { task: string };
		verifier: { task: string };
		verifyCount?: number;
		confidenceThreshold?: number;
		maxConcurrent?: number;
	};

	const verifyCount = Math.max(1, req.verifyCount ?? 3);
	const threshold = req.confidenceThreshold ?? 0.8;

	// Generate candidates (wide net).
	const generator = await ctx.agent(req.generator.task, { label: "generate" });

	// Independently verify, N times in parallel. Each returns a boolean verdict.
	const verifiers = await ctx.parallelAgents(
		Array.from(
			{ length: verifyCount },
			(_, i) => () =>
				ctx.agent(`${req.verifier.task}\n\nCandidate(s) to verify:\n${generator.text}`, {
					label: `verify-${i}`,
					guard: ctx.guards.verifier,
					schema: BOOLEAN_VERDICT_SCHEMA,
				}),
		),
		req.maxConcurrent,
	);

	// Confidence = passed / verifyCount. Deterministic, not a model's self-report.
	const passed = verifiers.filter((v: any) => readBooleanField(v, "verdict") === true).length;
	const confidence = passed / verifyCount;

	return {
		outcome: generator,
		confidence,
		terminatedBy: confidence >= threshold ? "completed" : "threshold",
	};
}
