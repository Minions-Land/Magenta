import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HcpClientbuildsession } from "../.HCP/assembly/session-hcp.ts";
import type { HcpMagnetResource } from "../.HCP/HcpMagnetTypes.ts";
import { parseToml } from "../_magenta/utils/pi/toml.ts";

const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKILL_SOURCES = new Map<string, string>([
	["paper-analysis", "pi"],
	["pptx", "pi"],
	["research-orchestration", "pi"],
	["self-evo", "magenta"],
]);

const context = {
	repoRoot: resolve(HARNESS_ROOT, ".."),
};

describe("HCP skill entity tree", () => {
	it("gives every registered skill slot a Server and its selected source a Magnet", () => {
		for (const [skill, source] of SKILL_SOURCES) {
			const skillRoot = resolve(HARNESS_ROOT, "skills", skill);
			expect(readFileSync(resolve(skillRoot, "HcpServer.ts"), "utf8")).toMatch(/\bexport\s+class\s+HcpServer\b/);
			expect(readFileSync(resolve(skillRoot, source, "HcpMagnet.ts"), "utf8")).toMatch(
				/\bexport\s+class\s+HcpMagnet\b/,
			);

			const descriptor = parseToml(readFileSync(resolve(skillRoot, `${skill}.toml`), "utf8"));
			expect(descriptor).toMatchObject({ kind: "skill", name: skill, source });
		}
	});

	it("keeps the root group and all leaf source slots explicit", async () => {
		const { hcp } = await HcpClientbuildsession(context);
		expect(hcp.modules().filter((module) => module === "skills" || module.startsWith("skills/"))).toEqual([
			"skills",
			"skills/paper-analysis",
			"skills/pptx",
			"skills/research-orchestration",
			"skills/self-evo",
		]);
		expect(hcp.resolveModule("skills/paper-analysis")?.describe().metadata?.slots).toEqual(["skill:paper-analysis"]);
		expect(hcp.resolveModule("skills/self-evo")?.describe().metadata?.slots).toEqual(["skill:self-evo"]);
	});

	it("resolves each skill through its leaf Server to a source Resource", async () => {
		const { hcp } = await HcpClientbuildsession(context);
		expect(hcp.addresses().filter((address) => address.startsWith("skill:"))).toEqual([
			"skill:paper-analysis",
			"skill:pptx",
			"skill:research-orchestration",
			"skill:self-evo",
		]);

		for (const [skill, source] of SKILL_SOURCES) {
			const server = hcp.resolve(`skill:${skill}`);
			expect(server).toBe(hcp.resolveModule(`skills/${skill}`));
			expect(server?.describe()).toMatchObject({
				target: `module:skills/${skill}`,
				kind: "module",
				metadata: { slots: [`skill:${skill}`], componentKind: "skill" },
			});
			await expect(hcp.dispatch({ target: `skill:${skill}`, op: "describe" })).resolves.toMatchObject({
				target: `skill:${skill}`,
				kind: "skill",
				ops: ["describe", "resolve"],
				description: server?.describe().description,
				metadata: { name: skill, source },
			});
			const resource = hcp.resolveInstance<HcpMagnetResource>(`skill:${skill}`);
			expect(resource).toMatchObject({
				kind: "skill",
				name: skill,
				source,
				mergeMode: "replace",
			});
			expect(resource?.contentPath && existsSync(resource.contentPath)).toBe(true);
			await expect(hcp.dispatch({ target: `skill:${skill}`, op: "resolve" })).resolves.toEqual(resource);
		}
	});

	it("keeps source Magnets resource-only and common management in HcpClient", async () => {
		const { hcp } = await HcpClientbuildsession(context);
		for (const [skill] of SKILL_SOURCES) {
			const server = hcp.resolveModule(`skills/${skill}`);
			expect((server as { describeSource?: unknown }).describeSource).toBeUndefined();
			expect((server as { callSource?: unknown }).callSource).toBeUndefined();
		}
	});

	it("does not promote self-evo chapters into independently invocable slots", () => {
		for (const chapter of ["package-forge", "pi-extension-integration", "skill-creator"]) {
			const chapterRoot = resolve(HARNESS_ROOT, "skills", "self-evo", "magenta", chapter);
			expect(existsSync(resolve(chapterRoot, "HcpServer.ts"))).toBe(false);
			expect(existsSync(resolve(chapterRoot, "HcpMagnet.ts"))).toBe(false);
		}
	});
});
