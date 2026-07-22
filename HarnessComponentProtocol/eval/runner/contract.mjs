// Validate and normalize the versioned headless JSONL terminal contract.

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonLines(stdout) {
	const events = [];
	const errors = [];
	for (const [index, raw] of stdout.split(/\r?\n/).entries()) {
		if (!raw.trim()) continue;
		try {
			const event = JSON.parse(raw);
			if (!isRecord(event)) errors.push(`stdout line ${index + 1} is not a JSON object`);
			else events.push(event);
		} catch (error) {
			errors.push(`stdout line ${index + 1} is malformed JSON: ${error.message}`);
		}
	}
	return { events, errors };
}

function oneEvent(events, type, errors) {
	const matches = events.filter((event) => event.type === type);
	if (matches.length === 0) errors.push(`missing ${type} event`);
	if (matches.length > 1) errors.push(`duplicate ${type} event (${matches.length} found)`);
	return matches.length === 1 ? matches[0] : undefined;
}

function sortedStrings(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string").sort() : [];
}

function checkExpectations(manifest, expect, errors) {
	if (!manifest) return;
	const capabilities = manifest.execution?.harnessCapabilities;
	for (const [name, expected] of Object.entries(expect.capabilities ?? {})) {
		const actual = capabilities?.[name];
		if (actual !== expected) errors.push(`capability ${name} expected ${expected}, got ${String(actual)}`);
	}

	const active = sortedStrings(manifest.tools?.active);
	if (expect.activeTools !== undefined) {
		const exact = sortedStrings(expect.activeTools);
		if (JSON.stringify(active) !== JSON.stringify(exact)) {
			errors.push(`active tools expected exactly [${exact.join(", ")}], got [${active.join(", ")}]`);
		}
	}
	for (const name of expect.activeToolsInclude ?? []) {
		if (!active.includes(name)) errors.push(`expected active tool '${name}' is missing`);
	}
	for (const name of expect.activeToolsExclude ?? []) {
		if (active.includes(name)) errors.push(`unexpected active tool '${name}' is active`);
	}
}

function checkToolEvidence(events, expect, errors) {
	const successfulIds = new Set(
		events
			.filter((event) => event.type === "tool_execution_end" && event.isError === false && typeof event.toolCallId === "string")
			.map((event) => event.toolCallId),
	);
	const successfulStarts = events.filter(
		(event) =>
			event.type === "tool_execution_start" &&
			typeof event.toolCallId === "string" &&
			typeof event.toolName === "string" &&
			successfulIds.has(event.toolCallId),
	);
	for (const toolName of expect.successfulToolsInclude ?? []) {
		if (!successfulStarts.some((event) => event.toolName === toolName)) {
			errors.push(`expected successful tool '${toolName}' was not observed`);
		}
	}
	if (
		expect.requireWorkflowSubAgent &&
		!successfulStarts.some(
			(event) =>
				event.toolName === "sub_agent" &&
				event.args !== null &&
				typeof event.args === "object" &&
				event.args.workflow !== null &&
				typeof event.args.workflow === "object",
		)
	) {
		errors.push("expected a successful workflow-based sub_agent call");
	}
	for (const action of expect.multiagentActionsInclude ?? []) {
		if (
			!successfulStarts.some(
				(event) =>
					event.toolName === "multiagent" &&
					event.args !== null &&
					typeof event.args === "object" &&
					event.args.action === action,
			)
		) {
			errors.push(`expected successful multiagent action '${action}' was not observed`);
		}
	}
	return successfulStarts.map((event) => ({
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		action:
			event.args !== null && typeof event.args === "object" && typeof event.args.action === "string"
				? event.args.action
				: undefined,
		workflow: event.toolName === "sub_agent" && event.args !== null && typeof event.args === "object" && !!event.args.workflow,
	}));
}

function eventCounts(events) {
	const counts = {};
	for (const event of events) {
		const type = typeof event.type === "string" ? event.type : "<missing>";
		counts[type] = (counts[type] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function validateAndNormalizeResult(result, variant) {
	const { events, errors } = parseJsonLines(result.stdout);
	if (result.spawnError) errors.push(`process spawn failed: ${result.spawnError}`);
	if (result.timedOut) errors.push(`wall timeout exceeded (${variant.wallTimeoutMs}ms)`);
	if (result.stdoutTruncated) {
		errors.push(`stdout exceeded the ${result.outputLimitBytes}-byte capture limit; raw output and contract input are truncated`);
	}
	if (result.stderrTruncated) {
		errors.push(`stderr exceeded the ${result.outputLimitBytes}-byte capture limit; raw diagnostics are truncated`);
	}
	for (const stream of ["stdout", "stderr"]) {
		if (result.captureErrors?.[stream]) errors.push(`${stream} capture failed: ${result.captureErrors[stream]}`);
	}

	const manifest = oneEvent(events, "runtime_manifest", errors);
	const runEnd = oneEvent(events, "run_end", errors);
	if (manifest && manifest.protocolVersion !== 1) {
		errors.push(`runtime_manifest protocolVersion expected 1, got ${String(manifest.protocolVersion)}`);
	}
	if (runEnd && runEnd.protocolVersion !== 1) {
		errors.push(`run_end protocolVersion expected 1, got ${String(runEnd.protocolVersion)}`);
	}
	if (manifest && runEnd && manifest.runId !== runEnd.runId) {
		errors.push(`runId mismatch: runtime_manifest=${String(manifest.runId)}, run_end=${String(runEnd.runId)}`);
	}
	if (manifest && manifest.cwd !== variant.cwd) {
		errors.push(`cwd expected ${variant.cwd}, got ${String(manifest.cwd)}`);
	}
	const configuredThinking = variant.configuration.thinking;
	if (configuredThinking === "ultra") {
		if (manifest?.execution?.profile !== "ultra") {
			errors.push(`execution profile expected ultra, got ${String(manifest?.execution?.profile)}`);
		}
		const nativeThinking = manifest?.execution?.thinkingLevel;
		if (typeof nativeThinking !== "string" || nativeThinking === "ultra") {
			errors.push(`Ultra must resolve to a native thinking level, got ${String(nativeThinking)}`);
		}
	} else if (configuredThinking !== undefined && manifest?.execution?.thinkingLevel !== configuredThinking) {
		errors.push(`thinking level expected ${configuredThinking}, got ${String(manifest?.execution?.thinkingLevel)}`);
	}
	if (runEnd && result.code !== runEnd.exitCode) {
		errors.push(`exit mismatch: process=${String(result.code)}, run_end=${String(runEnd.exitCode)}`);
	}
	if (runEnd && ((runEnd.status === "success") !== (runEnd.exitCode === 0))) {
		errors.push(`run_end status/exit mismatch: status=${String(runEnd.status)}, exitCode=${String(runEnd.exitCode)}`);
	}
	if (runEnd?.background?.settled !== true) errors.push("background work was not settled at run_end");
	if (runEnd?.background?.events?.some((event) => event?.status === "running")) {
		errors.push("run_end contains background events that are still running");
	}
	if (runEnd && runEnd.background?.policy !== variant.configuration.backgroundPolicy) {
		errors.push(
			`run_end background policy expected ${variant.configuration.backgroundPolicy}, got ${String(runEnd.background?.policy)}`,
		);
	}
	if (manifest?.policies?.background?.policy !== variant.configuration.backgroundPolicy) {
		errors.push(
			`background policy expected ${variant.configuration.backgroundPolicy}, got ${String(manifest?.policies?.background?.policy)}`,
		);
	}
	const expectedWaitMs = variant.configuration.backgroundWaitTimeoutSeconds * 1000;
	if (manifest?.policies?.background?.waitTimeoutMs !== expectedWaitMs) {
		errors.push(
			`background wait timeout expected ${expectedWaitMs}ms, got ${String(manifest?.policies?.background?.waitTimeoutMs)}`,
		);
	}
	checkExpectations(manifest, variant.expect, errors);
	const toolEvidence = checkToolEvidence(events, variant.expect, errors);
	const contractValid = errors.length === 0;
	const executionSucceeded =
		contractValid && result.code === 0 && runEnd?.status === "success" && runEnd.exitCode === 0;

	return {
		schemaVersion: 1,
		variant: variant.name,
		contractValid,
		executionSucceeded,
		// Backward-compatible aggregate: a structurally valid failed process is not a valid eval arm.
		valid: contractValid && executionSucceeded,
		errors,
		process: {
			exitCode: result.code ?? null,
			signal: result.signal ?? null,
			timedOut: result.timedOut,
			streams: {
				stdout: {
					bytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout ?? ""),
					observedBytes: result.stdoutObservedBytes ?? Buffer.byteLength(result.stdout ?? ""),
					limitBytes: result.outputLimitBytes ?? null,
					truncated: result.stdoutTruncated ?? false,
				},
				stderr: {
					bytes: result.stderrBytes ?? Buffer.byteLength(result.stderr ?? ""),
					observedBytes: result.stderrObservedBytes ?? Buffer.byteLength(result.stderr ?? ""),
					limitBytes: result.outputLimitBytes ?? null,
					truncated: result.stderrTruncated ?? false,
				},
			},
		},
		runtime: manifest
			? {
					protocolVersion: manifest.protocolVersion ?? null,
					runId: manifest.runId ?? null,
					product: manifest.product ?? null,
					cwd: manifest.cwd ?? null,
					model: manifest.model ?? null,
					execution: manifest.execution ?? null,
					activeTools: sortedStrings(manifest.tools?.active),
					policies: manifest.policies ?? null,
				}
			: null,
		outcome: runEnd
			? {
					status: runEnd.status ?? null,
					exitCode: runEnd.exitCode ?? null,
					durationMs: runEnd.durationMs ?? null,
					stopReason: runEnd.stopReason ?? null,
					error: runEnd.error ?? null,
					stats: runEnd.stats ?? null,
					background: runEnd.background ?? null,
				}
			: null,
		eventCounts: eventCounts(events),
		toolEvidence,
	};
}

/** Aggregate arm validity without presenting an unexecuted scorer as evidence. */
export function summarizeEvalRun(plan, summaries, { model = null, resultsDirectory = null } = {}) {
	const contractValid = summaries.every((summary) => summary.contractValid);
	const executionSucceeded = summaries.every((summary) => summary.executionSucceeded);
	const scoringMethod = typeof plan.scoring?.method === "string" ? plan.scoring.method : null;
	const scoring =
		scoringMethod === "headless-contract"
			? {
					method: scoringMethod,
					status: contractValid && executionSucceeded ? "passed" : "failed",
					automatic: true,
				}
			: {
					method: scoringMethod,
					status: "not_run",
					automatic: false,
				};
	return {
		schemaVersion: 1,
		scenario: plan.name,
		contractValid,
		executionSucceeded,
		scoring,
		evidence: {
			comparisonClaimAllowed: plan.evidenceGate?.comparisonClaimAllowed === true,
			reasons: plan.evidenceGate?.reasons ?? [],
		},
		valid: contractValid && executionSucceeded && scoring.status === "passed",
		model,
		resultsDirectory,
		variants: summaries,
	};
}
