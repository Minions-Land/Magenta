import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

function fixture(label: string) {
	const cwd = mkdtempSync(join(tmpdir(), `pi-test-6260-${label}-`));
	const agentDir = join(cwd, ".pi");
	return { cwd, agentDir };
}

const noop = () => {};

describe("regression #6260: inline extension naming", () => {
	it("displays bare factories with numeric labels", async () => {
		const { cwd, agentDir } = fixture("bare");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [noop, noop],
		});

		await loader.reload();

		const result = loader.getExtensions();

		expect(result.extensions).toHaveLength(2);
		expect(result.extensions[0].path).toBe("<inline:1>");
		expect(result.extensions[1].path).toBe("<inline:2>");
	});

	it("displays named wrappers as <inline:name>", async () => {
		const { cwd, agentDir } = fixture("named");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [
				{ name: "my-provider", factory: noop },
				{ name: "my-commands", factory: noop },
			],
		});

		await loader.reload();

		const result = loader.getExtensions();

		expect(result.extensions).toHaveLength(2);
		expect(result.extensions[0].path).toBe("<inline:my-provider>");
		expect(result.extensions[1].path).toBe("<inline:my-commands>");
	});

	it("supports mixed bare and named factories", async () => {
		const { cwd, agentDir } = fixture("mixed");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [noop, { name: "named-ext", factory: noop }, noop],
		});

		await loader.reload();

		const result = loader.getExtensions();

		expect(result.extensions).toHaveLength(3);
		expect(result.extensions[0].path).toBe("<inline:1>");
		expect(result.extensions[1].path).toBe("<inline:named-ext>");
		expect(result.extensions[2].path).toBe("<inline:3>");
	});
});
