import { describe, expect, test, vi } from "vitest";
import questionExtension from "../examples/extensions/question.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";

describe("question example extension", () => {
	test("registers with executionMode: sequential to avoid parallel UI race (MX-001)", () => {
		let registeredTool: { name: string; executionMode?: "sequential" | "parallel" } | undefined;

		const api = {
			registerTool: vi.fn((definition) => {
				registeredTool = definition;
			}),
		} as unknown as ExtensionAPI;

		questionExtension(api);

		expect(registeredTool).toBeDefined();
		expect(registeredTool?.name).toBe("question");
		expect(registeredTool?.executionMode).toBe("sequential");
	});
});
