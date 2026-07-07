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
		req.workers.map((w: any, i: number) => () => ctx.agent(w.task, { label: `fanout-${i}` })),
		req.maxConcurrent,
	);

	const merged = results
		.map((r: any, i: number) => `--- Worker ${i + 1} (${r.success ? "ok" : "failed"}) ---\n${r.text || r.error || ""}`)
		.join("\n\n");

	const outcome = await ctx.agent(`${req.synthesizer.task}\n\n${merged}`, {
		label: "synth",
		guard: ctx.guards.synthesizer,
	});

	return { outcome, terminatedBy: "completed" };
}
