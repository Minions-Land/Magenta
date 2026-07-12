import { describe, expect, it } from "vitest";
import { aggregateWorkerUsage, type WorkerResult, type WorkerUsage } from "../../multiagent/HcpServer.ts";

/**
 * Unit coverage for aggregateWorkerUsage: the helper that rolls per-worker
 * token/cost usage up into a single OrchestrationResult.usage. The key contract
 * is the tri-state return — a real sum when any worker reported usage, and
 * undefined when none did (so consumers can tell "no data" from "zero cost").
 */
describe("aggregateWorkerUsage", () => {
	const usage = (over: Partial<WorkerUsage> & { costTotal?: number } = {}): WorkerUsage => ({
		input: over.input ?? 0,
		output: over.output ?? 0,
		cacheRead: over.cacheRead ?? 0,
		cacheWrite: over.cacheWrite ?? 0,
		cost: over.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: over.costTotal ?? 0,
		},
	});

	const worker = (id: string, u?: WorkerUsage): WorkerResult => ({
		workerId: id,
		text: "",
		durationMs: 1,
		success: true,
		...(u ? { usage: u } : {}),
	});

	it("returns undefined when no worker reported usage", () => {
		expect(aggregateWorkerUsage([worker("a"), worker("b")])).toBeUndefined();
	});

	it("returns undefined for an empty worker list", () => {
		expect(aggregateWorkerUsage([])).toBeUndefined();
	});

	it("sums every field across workers that reported usage", () => {
		const agg = aggregateWorkerUsage([
			worker("a", usage({ input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, costTotal: 0.05 })),
			worker("b", usage({ input: 2000, output: 400, cacheRead: 100, cacheWrite: 20, costTotal: 0.1 })),
		]);
		expect(agg).toEqual({
			input: 3000,
			output: 600,
			cacheRead: 150,
			cacheWrite: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.15000000000000002 },
		});
	});

	it("sums the detailed cost breakdown, not just the total", () => {
		const agg = aggregateWorkerUsage([
			worker("a", usage({ cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 } })),
			worker("b", usage({ cost: { input: 0.02, output: 0.04, cacheRead: 0.006, cacheWrite: 0.002, total: 0.068 } })),
		]);
		expect(agg?.cost.input).toBeCloseTo(0.03);
		expect(agg?.cost.output).toBeCloseTo(0.06);
		expect(agg?.cost.cacheRead).toBeCloseTo(0.009);
		expect(agg?.cost.cacheWrite).toBeCloseTo(0.003);
		expect(agg?.cost.total).toBeCloseTo(0.102);
	});

	it("ignores workers without usage while still aggregating the rest", () => {
		const agg = aggregateWorkerUsage([
			worker("a", usage({ input: 500, output: 100, costTotal: 0.02 })),
			worker("no-usage"),
			worker("b", usage({ input: 500, output: 100, costTotal: 0.02 })),
		]);
		expect(agg?.input).toBe(1000);
		expect(agg?.output).toBe(200);
		expect(agg?.cost.total).toBeCloseTo(0.04);
	});

	it("preserves unknown dynamic pricing while summing known worker costs", () => {
		const agg = aggregateWorkerUsage([
			worker(
				"dynamic",
				usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, unknown: true } }),
			),
			worker("known", usage({ costTotal: 0.04 })),
		]);
		expect(agg?.cost.total).toBeCloseTo(0.04);
		expect(agg?.cost.unknown).toBe(true);
	});
});
