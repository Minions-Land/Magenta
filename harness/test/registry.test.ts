import { describe, expect, it } from "vitest";
import { getHarnessRegistryPath, loadRegistry } from "../assembly/registry/pi/registry.ts";

describe("harness registry", () => {
	it("locates and loads the package registry", async () => {
		const path = getHarnessRegistryPath();

		expect(path.endsWith("harness.toml")).toBe(true);

		const registry = await loadRegistry(path);
		expect(registry.name).toBe("magenta-harness");
		expect(registry.components.some((component) => component.kind === "memory" && component.name === "memory")).toBe(
			true,
		);
		expect(registry.components.some((component) => component.kind === "tool" && component.name === "bash")).toBe(
			true,
		);
	});
});
