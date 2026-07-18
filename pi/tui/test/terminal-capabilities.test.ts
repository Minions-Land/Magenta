import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getCapabilities, probeAndCacheCapabilities, resetCapabilitiesCache } from "../src/terminal-image.ts";

/**
 * Tests for the opt-in runtime truecolor probe gating.
 *
 * These tests control COLORTERM/MAGENTA_PROBE_TRUECOLOR explicitly because
 * probeAndCacheCapabilities() re-runs detectCapabilities() internally, which
 * reads COLORTERM. We restore the original env after each test.
 */
describe("probeAndCacheCapabilities gating", () => {
	let savedColorTerm: string | undefined;
	let savedProbeFlag: string | undefined;

	beforeEach(() => {
		savedColorTerm = process.env.COLORTERM;
		savedProbeFlag = process.env.MAGENTA_PROBE_TRUECOLOR;
		resetCapabilitiesCache();
	});

	afterEach(() => {
		if (savedColorTerm === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = savedColorTerm;
		if (savedProbeFlag === undefined) delete process.env.MAGENTA_PROBE_TRUECOLOR;
		else process.env.MAGENTA_PROBE_TRUECOLOR = savedProbeFlag;
		resetCapabilitiesCache();
	});

	it("does not run the probe when MAGENTA_PROBE_TRUECOLOR is unset (default off)", async () => {
		delete process.env.MAGENTA_PROBE_TRUECOLOR;
		delete process.env.COLORTERM; // no truecolor hint

		// With the probe disabled, this returns immediately and leaves the cache
		// to be filled lazily by getCapabilities() (env-only detection).
		await probeAndCacheCapabilities();

		const caps = getCapabilities();
		assert.equal(caps.trueColor, false, "unknown terminal without COLORTERM stays 256-color when probe is off");
	});

	it("respects the COLORTERM hint and skips probing a known-truecolor terminal", async () => {
		process.env.MAGENTA_PROBE_TRUECOLOR = "1";
		process.env.COLORTERM = "truecolor"; // terminal already advertises truecolor

		// Probe is enabled, but detectCapabilities() already reports trueColor=true
		// from the env hint, so probeAndCacheCapabilities short-circuits (no stdin IO).
		await probeAndCacheCapabilities();

		const caps = getCapabilities();
		assert.equal(caps.trueColor, true, "COLORTERM=truecolor is trusted without probing");
	});

	it("is idempotent and non-blocking when probing is disabled", async () => {
		delete process.env.MAGENTA_PROBE_TRUECOLOR;
		delete process.env.COLORTERM;

		const start = Date.now();
		await probeAndCacheCapabilities();
		await probeAndCacheCapabilities();
		await probeAndCacheCapabilities();
		const elapsed = Date.now() - start;

		// Disabled probe must return synchronously-fast (no 100ms timeout waits).
		assert.ok(elapsed < 50, `disabled probe should not block (took ${elapsed}ms)`);
		assert.equal(getCapabilities().trueColor, false);
	});
});
