import { describe, expect, it } from "vitest";
import {
	detectProgressFromChunk,
	detectProgressMarker,
	mergeProgress,
	renderProgressBar,
	stripProgressMarkers,
	timeProgressFraction,
} from "../src/core/background-shell-utils.ts";

describe("detectProgressFromChunk", () => {
	it("parses a percent token", () => {
		expect(detectProgressFromChunk("Downloading 42%")).toBeCloseTo(0.42);
	});

	it("parses a fractional percent", () => {
		expect(detectProgressFromChunk("  7.5% done")).toBeCloseTo(0.075);
	});

	it("uses the last percent token in a chunk", () => {
		expect(detectProgressFromChunk("10% ... 55% ... 90%")).toBeCloseTo(0.9);
	});

	it("parses a bracketed counter", () => {
		expect(detectProgressFromChunk("[123/456] compiling")).toBeCloseTo(123 / 456);
	});

	it("parses a bare counter", () => {
		expect(detectProgressFromChunk("step 3/10")).toBeCloseTo(0.3);
	});

	it("prefers percent over counter when both present", () => {
		expect(detectProgressFromChunk("50% [1/4]")).toBeCloseTo(0.5);
	});

	it("returns undefined when nothing matches", () => {
		expect(detectProgressFromChunk("building the project")).toBeUndefined();
	});

	it("ignores an out-of-range percent", () => {
		expect(detectProgressFromChunk("exit 137%")).toBeUndefined();
	});

	it("ignores a counter whose done exceeds total", () => {
		expect(detectProgressFromChunk("5/3")).toBeUndefined();
	});

	it("ignores a zero-total counter", () => {
		expect(detectProgressFromChunk("0/0")).toBeUndefined();
	});

	it("clamps to full at 100%", () => {
		expect(detectProgressFromChunk("100% complete")).toBe(1);
	});
});

describe("renderProgressBar", () => {
	it("renders an empty bar at 0", () => {
		expect(renderProgressBar(0, 10)).toBe("░░░░░░░░░░ 0%");
	});

	it("renders a full bar at 1", () => {
		expect(renderProgressBar(1, 10)).toBe("▓▓▓▓▓▓▓▓▓▓ 100%");
	});

	it("renders a half bar", () => {
		expect(renderProgressBar(0.5, 10)).toBe("▓▓▓▓▓░░░░░ 50%");
	});

	it("clamps values above 1", () => {
		expect(renderProgressBar(1.5, 10)).toBe("▓▓▓▓▓▓▓▓▓▓ 100%");
	});

	it("clamps negative values", () => {
		expect(renderProgressBar(-0.2, 10)).toBe("░░░░░░░░░░ 0%");
	});

	it("adds no hint for a marker source", () => {
		expect(renderProgressBar({ value: 0.42, source: "marker" }, 10)).toBe("▓▓▓▓░░░░░░ 42%");
	});

	it("adds no hint for an output source", () => {
		expect(renderProgressBar({ value: 0.5, source: "output" }, 10)).toBe("▓▓▓▓▓░░░░░ 50%");
	});

	it("flags a time source as estimated", () => {
		expect(renderProgressBar({ value: 0.3, source: "time" }, 10)).toBe("▓▓▓░░░░░░░ 30% estimated");
	});
});

describe("detectProgressMarker", () => {
	it("parses a fractional marker", () => {
		expect(detectProgressMarker("@@progress 0.42")).toBeCloseTo(0.42);
	});

	it("parses a percent marker", () => {
		expect(detectProgressMarker("@@progress 42%")).toBeCloseTo(0.42);
	});

	it("treats a value above 1 as a percent scale", () => {
		expect(detectProgressMarker("@@progress 75")).toBeCloseTo(0.75);
	});

	it("ignores a trailing note", () => {
		expect(detectProgressMarker("@@progress 0.6 compiling module")).toBeCloseTo(0.6);
	});

	it("uses the last marker across lines", () => {
		expect(detectProgressMarker("@@progress 0.1\nwork\n@@progress 0.9")).toBeCloseTo(0.9);
	});

	it("returns undefined without a marker", () => {
		expect(detectProgressMarker("progress 42%")).toBeUndefined();
	});
});

describe("stripProgressMarkers", () => {
	it("removes marker lines but keeps other output", () => {
		expect(stripProgressMarkers("building\n@@progress 0.5\ndone\n")).toBe("building\ndone\n");
	});

	it("leaves text without markers untouched", () => {
		expect(stripProgressMarkers("no markers here\n")).toBe("no markers here\n");
	});
});

describe("mergeProgress", () => {
	it("adopts the first reading when none exists", () => {
		expect(mergeProgress(undefined, { value: 0.2, source: "output" })).toEqual({ value: 0.2, source: "output" });
	});

	it("lets a higher-priority source override a lower one", () => {
		expect(mergeProgress({ value: 0.2, source: "output" }, { value: 0.9, source: "marker" })).toEqual({
			value: 0.9,
			source: "marker",
		});
	});

	it("does not let a lower-priority source override a higher one", () => {
		expect(mergeProgress({ value: 0.9, source: "marker" }, { value: 0.2, source: "output" })).toEqual({
			value: 0.9,
			source: "marker",
		});
	});

	it("updates the value for an equal-priority source", () => {
		expect(mergeProgress({ value: 0.2, source: "output" }, { value: 0.6, source: "output" })).toEqual({
			value: 0.6,
			source: "output",
		});
	});
});

describe("timeProgressFraction", () => {
	it("returns a fraction of elapsed over expected", () => {
		expect(timeProgressFraction(5000, 10)).toBeCloseTo(0.5);
	});

	it("caps just below full while still running", () => {
		expect(timeProgressFraction(60000, 10)).toBe(0.99);
	});

	it("returns undefined for a non-positive expected time", () => {
		expect(timeProgressFraction(5000, 0)).toBeUndefined();
	});
});
