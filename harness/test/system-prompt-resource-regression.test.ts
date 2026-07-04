import { describe, expect, it } from "vitest";
import { CAPABILITY_KINDS } from "../hcp/package-overlay/package-overlay.ts";

/**
 * Regression lock for spec §5.1.
 *
 * Codex once added `system-prompt` to CAPABILITY_KINDS, which routed it through
 * capability code-builder resolution (`system-prompt:<source>` must have a
 * builder). The AutOmicScience package declares a content-only system-prompt (a
 * SYSTEM.md via `content_path`, no code provider), so assembly emitted
 * `capability_factory_missing` and a test failed. Root cause: a Resource was
 * classified as a Capability.
 *
 * The fix is structural (system-prompt flows through the resource path, and the
 * Resource primitive now exists — see resource-magnet.test.ts). These tests make
 * the classification intentional so the regression cannot silently return.
 */
describe("§5.1 system-prompt is a Resource, not a Capability", () => {
	it("does NOT list system-prompt as a capability kind", () => {
		// The whole regression was system-prompt being in this set. It must not be.
		expect(CAPABILITY_KINDS.has("system-prompt")).toBe(false);
		expect(CAPABILITY_KINDS.has("append-system-prompt")).toBe(false);
	});

	it("keeps only real code-provider kinds as capabilities", () => {
		// Content/data kinds (system-prompt, skill, prompt, theme, brand) must stay
		// out; only loop-internal code providers belong here (spec §5).
		const kinds = [...CAPABILITY_KINDS].sort();
		expect(kinds).toEqual([
			"compaction",
			"context",
			"hook",
			"memory",
			"policy",
			"prompt-template",
			"runtime",
			"sandbox",
		]);
		for (const dataKind of ["system-prompt", "append-system-prompt", "skill", "theme", "brand"]) {
			expect(CAPABILITY_KINDS.has(dataKind)).toBe(false);
		}
	});
});
