import type { WorkflowContext } from "../../../modules/multiagent/contract.ts";

/**
 * A sample workflow script fixture for the script-pattern test. Exercises the
 * injected primitives: a phase marker, one agent call, a parallel batch, and a
 * structured return value. The runtime injects `context`; the test drives it
 * with a fake runner so no real pi process is spawned.
 */
export const meta = {
	name: "sample-workflow",
	description: "A minimal workflow used to test the script pattern",
	phases: [{ title: "Work", detail: "one agent + a parallel batch" }],
};

export default async function run(args: unknown, context: WorkflowContext): Promise<unknown> {
	const { topic } = (args as { topic?: string }) ?? {};
	context.phase("Work");
	context.log(`starting on topic: ${topic ?? "(none)"}`);

	// One sequential agent call.
	const lead = await context.agent(`Investigate ${topic}`, { label: "lead", guard: context.guards.synthesizer });

	// A parallel batch of three.
	const batch = await context.parallelAgents(
		[0, 1, 2].map((i) => () => context.agent(`sub-task ${i}`, { label: `sub-${i}` })),
		2,
	);

	return {
		topic,
		leadText: lead.text,
		batchCount: batch.length,
		batchTexts: batch.map((b) => b.text),
	};
}
