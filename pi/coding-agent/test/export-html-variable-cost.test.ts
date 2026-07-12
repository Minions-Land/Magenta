import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("export HTML variable pricing", () => {
	it("does not render provider-unknown charges as zero dollars", () => {
		const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf8");

		expect(template).toContain("if (msg.usage.cost.unknown)");
		expect(template).toContain("cost.total += msg.usage.cost.total || 0");
		expect(template).toContain("globalStats.costUnknown ? 'cost?'");
	});
});
