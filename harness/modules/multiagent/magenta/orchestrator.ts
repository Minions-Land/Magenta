/**
 * Orchestrator: the deterministic control-flow skeletons for each pattern.
 *
 * Every pattern here is plain JavaScript control flow — `for`, `await`, `if`.
 * That is the guarantee: the shape, the termination, and each pattern's soul
 * step are code, not prompts. The LLM fills `WorkerSlot` content; it never
 * decides the order, the concurrency, or when to stop.
 */

import type { HcpServer } from "../../../hcp-contract/hcp-server.ts";
import type {
	AdversarialVerifyRequest,
	ClassifyAndActRequest,
	CommonOptions,
	FanOutSynthesizeRequest,
	GenerateAndFilterRequest,
	LoopUntilDoneRequest,
	MultiAgentDiscoverResult,
	MultiAgentProviderContract,
	OrchestrationRequest,
	OrchestrationResult,
	Pattern,
	TournamentRequest,
	WorkerResult,
	WorkerSlot,
} from "../contract.ts";
import { buildSystemPrompt, parallel, type SpawnWorkerOptions, spawnWorker } from "./worker.ts";

/**
 * The two primitives every pattern needs to run workers. Abstracted so the
 * deterministic control flow can be unit-tested with a fake runner — no real pi
 * processes, no tokens, no risk. The default runner spawns real headless pi.
 */
export interface WorkerRunner {
	spawn(options: SpawnWorkerOptions, signal?: AbortSignal): Promise<WorkerResult>;
	parallel(specs: SpawnWorkerOptions[], maxConcurrent: number, signal?: AbortSignal): Promise<WorkerResult[]>;
}

const defaultRunner: WorkerRunner = { spawn: spawnWorker, parallel };

const DEFAULT_MAX_CONCURRENT = 8;
const TARGET = "multiagent://local";

const PATTERNS: Pattern[] = [
	"classify_and_act",
	"fan_out_synthesize",
	"adversarial_verify",
	"generate_and_filter",
	"tournament",
	"loop_until_done",
];

/**
 * Guard prompts hard-code each pattern's soul step. They are prepended to the
 * relevant worker's system prompt so the LLM cannot skip or dilute the step.
 */
const GUARDS = {
	classifier:
		"First determine the type of the input, then handle it according to its type. " +
		"Do not process the input generically without classifying it first. " +
		"Return only the classification label.",
	synthesizer:
		"The following are results from every worker. Merge them into a single " +
		"consolidated artifact. Do not omit any input.",
	verifier:
		"You are an independent verifier. Re-check each reported candidate on its own " +
		"evidence. Prefer missing a real issue over confirming a false one. Return a " +
		"strict boolean verdict per candidate.",
	evaluator:
		"Score the candidate against the stated criteria and return a numeric score. " +
		"Base the score only on the criteria, not on presentation length.",
	judge:
		"You are comparing exactly two candidates. Decide which one is better on the " +
		"stated qualities and return the winner's index (0 or 1) with a brief reason.",
	refine:
		"Findings already discovered in previous rounds are listed below; exclude them. " +
		"Report only NEW findings this round. If there are no new findings, return an " +
		"empty result — do not claim completion on your own judgement.",
} as const;

let workerCounter = 0;
function nextWorkerId(prefix: string): string {
	workerCounter += 1;
	return `${prefix}_${String(workerCounter).padStart(3, "0")}`;
}

/** Build a SpawnWorkerOptions from a slot + guard + common options. */
function slotToSpawn(workerId: string, slot: WorkerSlot, guard: string, common: CommonOptions): SpawnWorkerOptions {
	return {
		workerId,
		prompt: slot.task,
		systemPrompt: buildSystemPrompt(guard, slot),
		// Slot-level overrides win over the orchestration-wide defaults.
		model: slot.model ?? common.model,
		provider: slot.provider,
		tools: slot.tools ?? common.tools,
		thinking: slot.thinking,
		schema: slot.schema,
		cwd: common.cwd,
		isolation: common.isolation,
		timeoutMs: slot.timeoutSeconds !== undefined ? slot.timeoutSeconds * 1000 : undefined,
	};
}

// --- Pattern 2: Fan Out and Synthesize (first full implementation) ---------

async function fanOutSynthesize(
	req: FanOutSynthesizeRequest,
	runner: WorkerRunner,
	signal?: AbortSignal,
): Promise<OrchestrationResult> {
	const maxConcurrent = req.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

	// Fan out: run every worker in parallel over its object.
	const specs = req.workers.map((slot) => slotToSpawn(nextWorkerId("fanout"), slot, "", req));
	const workers = await runner.parallel(specs, maxConcurrent, signal);

	// Synthesize: the guard guarantees the synthesizer receives every result.
	const merged = workers
		.map((r, i) => `--- Worker ${i + 1} (${r.success ? "ok" : "failed"}) ---\n${r.text || r.error || ""}`)
		.join("\n\n");
	const synthSpec = slotToSpawn(nextWorkerId("synth"), req.synthesizer, GUARDS.synthesizer, req);
	synthSpec.prompt = `${req.synthesizer.task}\n\n${merged}`;
	const outcome = await runner.spawn(synthSpec, signal);

	return {
		pattern: "fan_out_synthesize",
		workers: [...workers, outcome],
		outcome,
		terminatedBy: "completed",
	};
}

// --- Shared helpers --------------------------------------------------------

/** Read a boolean verdict from a verifier/done-checker worker's structured output. */
function readBooleanField(result: WorkerResult, field: string): boolean | undefined {
	const s = result.structured as Record<string, unknown> | undefined;
	if (s && typeof s[field] === "boolean") return s[field] as boolean;
	return undefined;
}

/** Read a numeric field (e.g. a score) from a worker's structured output. */
function readNumberField(result: WorkerResult, field: string): number | undefined {
	const s = result.structured as Record<string, unknown> | undefined;
	if (s && typeof s[field] === "number" && Number.isFinite(s[field])) return s[field] as number;
	return undefined;
}

/** Boolean verdict + strict schema for verifier/done-check workers. */
const BOOLEAN_VERDICT_SCHEMA = {
	type: "object",
	properties: { verdict: { type: "boolean" }, reason: { type: "string" } },
	required: ["verdict"],
} as const;

/** Numeric score schema for evaluator workers. */
const SCORE_SCHEMA = {
	type: "object",
	properties: { score: { type: "number" }, reason: { type: "string" } },
	required: ["score"],
} as const;

/** Winner index schema for pairwise judge workers. */
const WINNER_SCHEMA = {
	type: "object",
	properties: { winner: { type: "number", enum: [0, 1] }, reason: { type: "string" } },
	required: ["winner"],
} as const;

/** Merge a slot's own schema with a skeleton-mandated schema (skeleton wins). */
function withSchema(slot: WorkerSlot, schema: unknown): WorkerSlot {
	return { ...slot, schema };
}

// --- Pattern 1: Classify and Act -------------------------------------------

async function classifyAndAct(
	req: ClassifyAndActRequest,
	runner: WorkerRunner,
	signal?: AbortSignal,
): Promise<OrchestrationResult> {
	const labels = Object.keys(req.handlers);

	// Classify first (the soul step). Constrain output to the known label set.
	const classifierSlot = withSchema(req.classifier, {
		type: "object",
		properties: { label: { type: "string", enum: labels } },
		required: ["label"],
	});
	const classSpec = slotToSpawn(nextWorkerId("classify"), classifierSlot, GUARDS.classifier, req);
	classSpec.prompt = `${req.classifier.task}\n\nAvailable labels: ${labels.join(", ")}\n\nInput:\n${req.input}`;
	const classifier = await runner.spawn(classSpec, signal);

	const rawLabel = (classifier.structured as { label?: string } | undefined)?.label ?? classifier.text.trim();
	const label = labels.find((l) => rawLabel === l || rawLabel.includes(l));

	// Route to exactly one handler (or fallback). This is deterministic.
	const handlerSlot = label ? req.handlers[label] : req.fallback;
	if (!handlerSlot) {
		return {
			pattern: "classify_and_act",
			workers: [classifier],
			outcome: classifier,
			terminatedBy: "completed",
		};
	}
	const handlerSpec = slotToSpawn(nextWorkerId("handle"), handlerSlot, "", req);
	handlerSpec.prompt = `${handlerSlot.task}\n\nInput:\n${req.input}`;
	const handler = await runner.spawn(handlerSpec, signal);

	return {
		pattern: "classify_and_act",
		workers: [classifier, handler],
		outcome: handler,
		terminatedBy: "completed",
	};
}

// --- Pattern 3: Adversarial Verification -----------------------------------

async function adversarialVerify(
	req: AdversarialVerifyRequest,
	runner: WorkerRunner,
	signal?: AbortSignal,
): Promise<OrchestrationResult> {
	const verifyCount = Math.max(1, req.verifyCount ?? 3);
	const threshold = req.confidenceThreshold ?? 0.8;
	const maxConcurrent = req.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

	// Generate candidates (wide net).
	const genSpec = slotToSpawn(nextWorkerId("generate"), req.generator, "", req);
	const generator = await runner.spawn(genSpec, signal);

	// Independently verify, N times in parallel. Each returns a boolean verdict.
	const verifierSlot = withSchema(req.verifier, BOOLEAN_VERDICT_SCHEMA);
	const verifierSpecs = Array.from({ length: verifyCount }, () => {
		const spec = slotToSpawn(nextWorkerId("verify"), verifierSlot, GUARDS.verifier, req);
		spec.prompt = `${req.verifier.task}\n\nCandidate(s) to verify:\n${generator.text}`;
		return spec;
	});
	const verifiers = await runner.parallel(verifierSpecs, maxConcurrent, signal);

	// Confidence = passed / verifyCount. Deterministic, not a model's self-report.
	const passed = verifiers.filter((v) => readBooleanField(v, "verdict") === true).length;
	const confidence = passed / verifyCount;

	return {
		pattern: "adversarial_verify",
		workers: [generator, ...verifiers],
		outcome: generator,
		confidence,
		terminatedBy: confidence >= threshold ? "completed" : "threshold",
	};
}

// --- Pattern 4: Generate and Filter ----------------------------------------

async function generateAndFilter(
	req: GenerateAndFilterRequest,
	runner: WorkerRunner,
	signal?: AbortSignal,
): Promise<OrchestrationResult> {
	const count = Math.max(1, req.count);
	const maxConcurrent = req.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

	// Generate `count` independent candidates in parallel.
	const genSpecs = Array.from({ length: count }, () => slotToSpawn(nextWorkerId("gen"), req.generator, "", req));
	const candidates = await runner.parallel(genSpecs, maxConcurrent, signal);

	// Score each candidate by explicit criteria (evaluator returns a number).
	const evalSlot = withSchema(req.evaluator, SCORE_SCHEMA);
	const evalSpecs = candidates.map((c) => {
		const spec = slotToSpawn(nextWorkerId("eval"), evalSlot, GUARDS.evaluator, req);
		spec.prompt = `${req.evaluator.task}\n\nCandidate to score:\n${c.text}`;
		return spec;
	});
	const evaluations = await runner.parallel(evalSpecs, maxConcurrent, signal);

	// Rank by score, keep top-K. Ranking is deterministic in the skeleton.
	const ranked = candidates
		.map((candidate, i) => ({ candidate, score: readNumberField(evaluations[i], "score") ?? -Infinity }))
		.sort((a, b) => b.score - a.score);
	const keepTop = Math.max(1, req.keepTop ?? 1);
	const finalists = ranked.slice(0, keepTop).map((r) => r.candidate);
	const winner = finalists[0];

	return {
		pattern: "generate_and_filter",
		workers: [...candidates, ...evaluations],
		outcome: winner,
		// Top-K candidates by score when keepTop > 1; `outcome` is always the top one.
		...(finalists.length > 1 ? { finalists } : {}),
		terminatedBy: "completed",
	};
}

// --- Pattern 5: Tournament (pairwise elimination bracket) -------------------

async function tournament(
	req: TournamentRequest,
	runner: WorkerRunner,
	signal?: AbortSignal,
): Promise<OrchestrationResult> {
	const maxConcurrent = req.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

	// Generate all approaches in parallel.
	const approachSpecs = req.approaches.map((slot) => slotToSpawn(nextWorkerId("appr"), slot, "", req));
	const approaches = await runner.parallel(approachSpecs, maxConcurrent, signal);

	const allWorkers: WorkerResult[] = [...approaches];
	const judgeSlot = withSchema(req.judge, WINNER_SCHEMA);

	// Elimination bracket: pairwise matches, winner advances, until one remains.
	// N candidates -> exactly N-1 comparisons. Byes carry over on odd counts.
	let round = approaches.slice();
	while (round.length > 1) {
		const nextRound: WorkerResult[] = [];
		for (let i = 0; i < round.length; i += 2) {
			const a = round[i];
			const b = round[i + 1];
			if (!b) {
				nextRound.push(a); // bye
				continue;
			}
			const spec = slotToSpawn(nextWorkerId("judge"), judgeSlot, GUARDS.judge, req);
			spec.prompt = `${req.judge.task}\n\nCandidate 0:\n${a.text}\n\nCandidate 1:\n${b.text}`;
			const verdict = await runner.spawn(spec, signal);
			allWorkers.push(verdict);
			const winnerIdx = readNumberField(verdict, "winner");
			nextRound.push(winnerIdx === 1 ? b : a);
		}
		round = nextRound;
	}

	return {
		pattern: "tournament",
		workers: allWorkers,
		outcome: round[0],
		terminatedBy: "completed",
	};
}

// --- Pattern 6: Loop Until Done --------------------------------------------

async function loopUntilDone(
	req: LoopUntilDoneRequest,
	runner: WorkerRunner,
	signal?: AbortSignal,
): Promise<OrchestrationResult> {
	const maxIterations = Math.max(1, req.maxIterations ?? 10);
	const workers: WorkerResult[] = [];
	const findings: string[] = [];
	let iterations = 0;
	let terminatedBy: OrchestrationResult["terminatedBy"] = "max_iterations";

	// The skeleton owns termination: stop when a round yields no new findings,
	// or when the hard iteration cap is hit. The LLM never decides "I'm done".
	while (iterations < maxIterations) {
		if (signal?.aborted) {
			terminatedBy = "budget";
			break;
		}
		iterations += 1;
		const spec = slotToSpawn(nextWorkerId("refine"), req.refine, GUARDS.refine, req);
		const priorBlock = findings.length
			? `\n\nAlready-found (exclude these):\n${findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}`
			: "";
		spec.prompt = `${req.refine.task}\n\nStarting content:\n${req.initial}${priorBlock}`;
		const result = await runner.spawn(spec, signal);
		workers.push(result);

		const newFinding = result.text.trim();
		// "No new findings" is the stop condition, observed by the skeleton.
		if (!result.success || newFinding.length === 0) {
			terminatedBy = "completed";
			break;
		}
		findings.push(newFinding);
	}

	return {
		pattern: "loop_until_done",
		workers,
		outcome: workers[workers.length - 1],
		iterations,
		terminatedBy,
	};
}

/** The magenta multi-agent orchestration provider. */
export class MultiAgentOrchestrator implements MultiAgentProviderContract {
	private readonly defaultCwd: string;
	private readonly runner: WorkerRunner;

	constructor(options: { cwd?: string; runner?: WorkerRunner } = {}) {
		this.defaultCwd = options.cwd ?? process.cwd();
		// Injectable so deterministic skeletons can be tested without spawning pi.
		this.runner = options.runner ?? defaultRunner;
	}

	discover(): MultiAgentDiscoverResult {
		return { provider: "multiagent", targets: [TARGET], patterns: PATTERNS };
	}

	async orchestrate(request: OrchestrationRequest, signal?: AbortSignal): Promise<OrchestrationResult> {
		const req = { cwd: this.defaultCwd, ...request } as OrchestrationRequest;
		const runner = this.runner;
		switch (req.pattern) {
			case "fan_out_synthesize":
				return fanOutSynthesize(req as FanOutSynthesizeRequest, runner, signal);
			case "classify_and_act":
				return classifyAndAct(req as ClassifyAndActRequest, runner, signal);
			case "adversarial_verify":
				return adversarialVerify(req as AdversarialVerifyRequest, runner, signal);
			case "generate_and_filter":
				return generateAndFilter(req as GenerateAndFilterRequest, runner, signal);
			case "tournament":
				return tournament(req as TournamentRequest, runner, signal);
			case "loop_until_done":
				return loopUntilDone(req as LoopUntilDoneRequest, runner, signal);
			default: {
				const exhaustive: never = req;
				throw new Error(`Unknown pattern: ${JSON.stringify(exhaustive)}`);
			}
		}
	}

	toHcpServer(): HcpServer {
		const provider = this;
		return {
			describe() {
				return {
					target: TARGET,
					kind: "multiagent",
					ops: ["discover", "orchestrate"],
					description: "Deterministic multi-agent orchestration workflows.",
					metadata: { patterns: PATTERNS },
				};
			},
			async call(request: import("../../../hcp-contract/hcp-server.ts").HcpRequest) {
				switch (request.op) {
					case "discover":
						return provider.discover();
					case "orchestrate":
						return provider.orchestrate(request.input as OrchestrationRequest);
					default:
						throw new Error(`Unsupported op: ${request.op}`);
				}
			},
			instance<T>(): T {
				return provider as unknown as T;
			},
		};
	}
}
