/**
 * Preset workflow: Loop until done.
 *
 * Iterate a refine step, feeding prior findings back and excluding them each
 * round. Stop when a round yields no new finding, or the hard cap is hit. The
 * loop owns termination; a model never declares itself done.
 */
export default async function loopUntilDone(args: unknown, ctx: any) {
	const req = args as {
		initial: string;
		refine: { task: string };
		maxIterations?: number;
	};

	const maxIterations = Math.max(1, req.maxIterations ?? 10);
	const findings: string[] = [];
	let iterations = 0;
	let terminatedBy: "completed" | "max_iterations" | "budget" = "max_iterations";

	// The skeleton owns termination: stop when a round yields no new findings,
	// or when the hard iteration cap is hit. The LLM never decides "I'm done".
	while (iterations < maxIterations) {
		if (ctx.signal?.aborted) {
			terminatedBy = "budget";
			break;
		}
		iterations += 1;
		const priorBlock = findings.length
			? `\n\nAlready-found (exclude these):\n${findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
			: "";
		const result = await ctx.agent(`${req.refine.task}\n\nStarting content:\n${req.initial}${priorBlock}`, {
			...req.refine,
			label: `refine-${iterations}`,
			guard: ctx.guards.refine,
		});

		const newFinding = result.text.trim();
		// "No new findings" is the stop condition, observed by the skeleton.
		if (!result.success || newFinding.length === 0) {
			terminatedBy = "completed";
			break;
		}
		findings.push(newFinding);
	}

	// Return the last outcome (or undefined if no iterations ran, but max >= 1 guarantees at least one).
	// The dispatcher will extract outcome from spawned array.
	return { iterations, terminatedBy };
}
