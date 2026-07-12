/**
 * Preset workflow: Classify and act.
 *
 * Classify the input into one of the handler labels (soul step), then route to
 * exactly the matching handler, or a fallback. Returns the handler's result, or
 * the classifier's result when nothing matched and no fallback was given.
 */
export default async function classifyAndAct(args: unknown, ctx: any) {
	const req = args as {
		input: string;
		classifier: { task: string };
		handlers: Record<string, { task: string }>;
		fallback?: { task: string };
	};

	const labels = Object.keys(req.handlers);
	const classified = await ctx.agent(
		`${req.classifier.task}\n\nAvailable labels: ${labels.join(", ")}\n\nInput:\n${req.input}`,
		{
			...req.classifier,
			label: "classify",
			guard: ctx.guards.classifier,
			schema: { type: "object", properties: { label: { type: "string", enum: labels } }, required: ["label"] },
		},
	);

	const rawLabel = (classified.structured as { label?: string } | undefined)?.label ?? classified.text.trim();
	const label = labels.find((l) => rawLabel === l || rawLabel.includes(l));
	const handlerSlot = label ? req.handlers[label] : req.fallback;
	if (!handlerSlot) {
		return { outcome: classified, terminatedBy: "completed" };
	}

	const handler = await ctx.agent(`${handlerSlot.task}\n\nInput:\n${req.input}`, { ...handlerSlot, label: "handle" });
	return { outcome: handler, terminatedBy: "completed" };
}
