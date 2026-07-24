/**
 * Preset workflow: Fan out and synthesize.
 *
 * Runs all workers in parallel, then feeds every result into a synthesizer that
 * merges them into one consolidated artifact.
 */
export default async function fanOutSynthesize(args: unknown, ctx: any) {
	const req = args as {
		workers: Array<{ task: string }>;
		synthesizer: { task: string };
		maxConcurrent?: number;
	};

	const results = await ctx.parallelAgents(
		req.workers.map((w: any, i: number) => () => ctx.agent(w.task, { ...w, label: `fanout-${i}` })),
		req.maxConcurrent,
	);
	if (!results.some((result: any) => result.success)) {
		return {
			outcome: results[0] ?? {
				workerId: "fanout",
				text: "",
				durationMs: 0,
				success: false,
				error: "fan-out had no successful workers",
			},
			terminatedBy: "budget",
		};
	}

	const merged = results
		.map(
			(r: any, i: number) => `--- Worker ${i + 1} (${r.success ? "ok" : "failed"}) ---\n${r.text || r.error || ""}`,
		)
		.join("\n\n");

	const outcome = await ctx.agent(`${req.synthesizer.task}\n\n${merged}`, {
		...req.synthesizer,
		label: "synth",
		guard: ctx.guards.synthesizer,
	});

	return { outcome, terminatedBy: outcome.success ? "completed" : "budget" };
}
