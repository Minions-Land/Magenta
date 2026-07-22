export const UNRESOLVED_MANUAL_ISOLATION = "ERR_EVAL_UNRESOLVED_MANUAL_ISOLATION";

/** Refuse real runs whose requested component state cannot be produced by argv. */
export function assertRealRunIsolation(plan) {
	const gate = plan?.executionGate;
	if (!gate || !Array.isArray(gate.unresolvedManualIsolation)) {
		throw new Error("eval plan is missing its structured execution gate");
	}
	if (gate.unresolvedManualIsolation.length === 0 && gate.realRunAllowed === true) return;

	const blockers = gate.unresolvedManualIsolation;
	const targets = blockers.map(({ variant, component }) => `${variant}:${component}`).join(", ") || "unknown";
	const error = new Error(
		`real eval run refused: unresolved execution isolation for ${targets}; ` +
			"dry-run can inspect this plan, but documentation and implicit defaults do not prove an isolated variant",
	);
	error.code = UNRESOLVED_MANUAL_ISOLATION;
	error.unresolvedManualIsolation = blockers;
	throw error;
}
