/**
 * Reusable snippet: Contract negotiation (best-practice loop opener).
 *
 * Before starting the main work, have generator and evaluator negotiate what
 * \"done\" means as a checklist of testable assertions. This snippet shows the
 * two-phase pattern: draft (generator proposes), review (evaluator critiques).
 * The workflow then uses the agreed assertions for grading in REFLECT.
 *
 * Adapt this pattern for any multi-iteration loop where \"done\" is non-obvious.
 *
 * Usage:
 *   1. Copy this snippet into your workflow script.
 *   2. Replace `objective` with your task's actual goal.
 *   3. Expand/adjust the generator/evaluator prompts for your domain.
 *   4. Write the final contract to disk (contract.md or ctx.log()).
 *   5. Reference the contract assertions in your REFLECT phase.
 */

export async function negotiateContract(ctx: any, objective: string): Promise<string[]> {
	// Phase 1: Generator drafts the completion criteria
	const draft = await ctx.agent(
		`You are the Generator. The objective is:\n\n${objective}\n\n` +
			`Draft a numbered list of testable assertions (completion criteria) that define ` +
			`when the work is done. Each assertion must be checkable as PASS / FAIL / UNCLEAR. ` +
			`Be concrete: "all test cases pass" not "quality is good". Return as a JSON array of strings.`,
		{
			label: "contract-draft",
			schema: { type: "object", properties: { assertions: { type: "array", items: { type: "string" } } } },
			guard: ctx.guards.generator,
		},
	);

	const proposed = (draft.structured?.assertions as string[]) || [];
	if (proposed.length === 0) throw new Error("Generator returned zero assertions");

	// Phase 2: Evaluator reviews and pushes back
	const review = await ctx.agent(
		`You are the Evaluator. The Generator proposed these completion criteria:\n\n` +
			proposed.map((a, i) => `${i + 1}. ${a}`).join("\n") +
			`\n\nCritique them: which are vague? Which are untestable? Which edge cases are missing? ` +
			`Return your revised list as a JSON array (add/remove/reword as needed).`,
		{
			label: "contract-review",
			schema: { type: "object", properties: { assertions: { type: "array", items: { type: "string" } } } },
			guard: ctx.guards.evaluator,
		},
	);

	const finalized = (review.structured?.assertions as string[]) || proposed;

	// Log the contract for auditability
	ctx.log(`Contract finalized: ${finalized.length} assertions`);
	finalized.forEach((a, i) => {
		ctx.log(`  ${i + 1}. ${a}`);
	});

	return finalized;
}
