import assert from "node:assert/strict";
import test from "node:test";
import { assertRealRunIsolation, UNRESOLVED_MANUAL_ISOLATION } from "./execution-gate.mjs";

test("real-run gate accepts a plan with executable isolation", () => {
	assert.doesNotThrow(() =>
		assertRealRunIsolation({
			executionGate: { realRunAllowed: true, unresolvedManualIsolation: [] },
		}),
	);
});

test("real-run gate uses structured blockers instead of warning text", () => {
	const blocker = {
		variant: "compaction-off",
		component: "compaction",
		requestedState: false,
		reason: "no-cli-off-switch",
		manualNote: "documentation only",
	};
	assert.throws(
		() =>
			assertRealRunIsolation({
				executionGate: { realRunAllowed: false, unresolvedManualIsolation: [blocker] },
				variants: [{ name: "compaction-off", warnings: [] }],
			}),
		(error) => {
			assert.equal(error.code, UNRESOLVED_MANUAL_ISOLATION);
			assert.deepEqual(error.unresolvedManualIsolation, [blocker]);
			assert.match(error.message, /compaction-off:compaction/);
			return true;
		},
	);
});
