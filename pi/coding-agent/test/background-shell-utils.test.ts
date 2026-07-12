import { describe, expect, it } from "vitest";
import { truncateModelText } from "../src/core/background-shell-utils.ts";

describe("truncateModelText", () => {
	it("caps UTF-8 bytes while retaining identifying head and recent tail", () => {
		const source = `HEAD-${"中🙂".repeat(4_000)}-TAIL`;
		const result = truncateModelText(source, 1024);

		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(1024);
		expect(result.text).toContain("HEAD-");
		expect(result.text).toContain("-TAIL");
		expect(result.text).toContain("Model-visible result shortened");
		expect(result.text).not.toContain("�");
	});

	it("leaves already bounded text unchanged", () => {
		expect(truncateModelText("small", 32)).toEqual({ text: "small", truncated: false });
	});
});
