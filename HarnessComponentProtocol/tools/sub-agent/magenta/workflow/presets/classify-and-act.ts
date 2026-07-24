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
			schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
		},
	);

	if (!classified.success) return { outcome: classified, terminatedBy: "budget" };

	const rawLabel = (classified.structured as { label?: unknown } | undefined)?.label;
	const label = typeof rawLabel === "string" && labels.includes(rawLabel) ? rawLabel : undefined;
	const handlerSlot = label ? req.handlers[label] : req.fallback;
	if (!handlerSlot) {
		return {
			outcome: {
				...classified,
				success: false,
				error:
					typeof rawLabel === "string"
						? `classifier returned unknown label ${JSON.stringify(rawLabel)}`
						: "classifier did not return a structured label",
			},
			terminatedBy: "budget",
		};
	}

	const handler = await ctx.agent(`${handlerSlot.task}\n\nInput:\n${req.input}`, { ...handlerSlot, label: "handle" });
	return { outcome: handler, terminatedBy: handler.success ? "completed" : "budget" };
}
