import { describe, expect, it } from "vitest";
import { parallelAgents, pipeline } from "../../multiagent/workflow/magenta/worker.ts";

/**
 * Tests for the Phase 1 primitives (Claude Code style API): parallelAgents and
 * pipeline. These are pure control-flow combinators over async task functions —
 * they spawn no pi processes, so we test them with plain async fakes that record
 * ordering, concurrency, and result-collection semantics.
 *
 * `agent()` itself is a thin wrapper over spawnWorker (covered by worker-safety
 * and integration paths); its system-prompt assembly is exercised indirectly.
 * Here we focus on the two combinators whose correctness is pure and testable
 * without launching anything.
 */

describe("parallelAgents", () => {
	it("returns results in INPUT order regardless of completion order", async () => {
		// Task 0 resolves slowly, task 1 fast — result order must still be [0,1].
		const tasks = [
			() => new Promise<string>((r) => setTimeout(() => r("slow-0"), 20)),
			() => new Promise<string>((r) => setTimeout(() => r("fast-1"), 1)),
		];
		const results = await parallelAgents(tasks);
		expect(results).toEqual(["slow-0", "fast-1"]);
	});

	it("respects the concurrency cap (never more than N in flight)", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const makeTask = () => async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return "done";
		};
		const tasks = Array.from({ length: 10 }, makeTask);
		await parallelAgents(tasks, 3);
		expect(maxInFlight).toBeLessThanOrEqual(3);
	});

	it("runs every task exactly once", async () => {
		let runCount = 0;
		const tasks = Array.from({ length: 7 }, () => async () => {
			runCount++;
			return runCount;
		});
		const results = await parallelAgents(tasks, 2);
		expect(runCount).toBe(7);
		expect(results.length).toBe(7);
	});

	it("handles an empty task list", async () => {
		const results = await parallelAgents<string>([]);
		expect(results).toEqual([]);
	});

	it("clamps a non-positive concurrency to at least 1", async () => {
		const tasks = [async () => "a", async () => "b"];
		const results = await parallelAgents(tasks, 0);
		expect(results).toEqual(["a", "b"]);
	});
});

describe("pipeline", () => {
	it("applies fn to every item and collects results", async () => {
		const items = [1, 2, 3, 4];
		const results = await pipeline(items, async (n) => n * 10, 2);
		// Completion order is not guaranteed, so compare as a set.
		expect(results.slice().sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
	});

	it("passes the index to fn", async () => {
		const items = ["a", "b", "c"];
		const results = await pipeline(items, async (s, i) => `${s}${i}`, 3);
		expect(results.slice().sort()).toEqual(["a0", "b1", "c2"]);
	});

	it("respects the concurrency cap", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const items = Array.from({ length: 12 }, (_, i) => i);
		await pipeline(
			items,
			async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 3));
				inFlight--;
			},
			4,
		);
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});

	it("handles an empty item list", async () => {
		const results = await pipeline<number, number>([], async (n) => n);
		expect(results).toEqual([]);
	});
});
