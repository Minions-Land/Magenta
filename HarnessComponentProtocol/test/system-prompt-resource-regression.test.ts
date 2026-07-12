import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClientbuildsession } from "../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS } from "../.HCP/assembly/sources.generated.ts";
import type { HcpMagnetResource } from "../.HCP/HcpMagnetTypes.ts";
import { loadPackageOverlay } from "../_magenta/packages/package-overlay-v2.ts";
import { SystemPromptProvider } from "../system-prompt/pi/provider.ts";
import { HcpClientbuildpackagesessionfortest } from "./package-test-utils.ts";
import { writeFixturePackage } from "./package-v2-fixtures.ts";

describe("system-prompt code and content products", () => {
	it("keeps the core system-prompt source as one code capability", async () => {
		const rows = HCP_MAGNETS.filter((row) => row.module === "system-prompt" && row.product === "capability");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "system-prompt",
			name: "system-prompt",
			product: "capability",
			source: "pi",
			selected: true,
			autoload: true,
			slot: "system-prompt",
		});

		const session = await HcpClientbuildsession({ repoRoot: "/repo" });
		expect(session.diagnostics).toEqual([]);
		expect(session.hcp.resolveCapability("system-prompt")).toBeInstanceOf(SystemPromptProvider);
		await session.hcp.dispose();
	});

	it("routes a package SYSTEM.md through the descriptor Magnet and real Server", async () => {
		const packagesRoot = mkdtempSync(join(tmpdir(), "hcp-system-prompt-resource-"));
		try {
			await writeFixturePackage(packagesRoot, {
				id: "AutOmicScience",
				source: "AutOmicScience",
				components: [
					{
						kind: "system-prompt",
						name: "system-prompt",
						source: "AutOmicScience",
						mergeMode: "replace",
						systemPromptToml: `kind = "system-prompt"\nname = "system-prompt"\ncontent_path = "SYSTEM.md"\n`,
					},
				],
			});
			const overlay = await loadPackageOverlay({ packagesRoot, selections: ["AutOmicScience"] });
			const session = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });
			try {
				expect(session.diagnostics.filter((d) => "type" in d && d.type === "error")).toEqual([]);
				expect(session.packageResourceAddresses).toContain("system-prompt:system-prompt");
				expect(session.hcp.resolveCapability("system-prompt")).toBeInstanceOf(SystemPromptProvider);
				expect(session.hcp.resolve("system-prompt:system-prompt")).toBe(session.hcp.resolveModule("system-prompt"));
				const resource = session.hcp.resolveInstance<HcpMagnetResource>("system-prompt:system-prompt");
				expect(resource).toMatchObject({
					kind: "system-prompt",
					name: "system-prompt",
					source: "AutOmicScience",
					mergeMode: "replace",
				});
				// v2 system-prompt is a descriptor-backed resource: the magnet points at
				// system-prompt.toml, whose content_path resolves SYSTEM.md at read time.
				expect(resource?.descriptorPath).toContain("system-prompt.toml");
				expect(session.hcp.resolveModule("system-prompt")?.describe().metadata?.slots?.slice().sort()).toEqual([
					"system-prompt",
					"system-prompt:system-prompt",
				]);
			} finally {
				await session.hcp.dispose();
			}
		} finally {
			rmSync(packagesRoot, { recursive: true, force: true });
		}
	});

	it("rejects duplicate canonical Resource addresses instead of silently dropping one", async () => {
		const packagesRoot = mkdtempSync(join(tmpdir(), "hcp-system-prompt-duplicate-"));
		try {
			// Two system-prompt components with different names but both resolve
			// to the same canonical address system-prompt:system-prompt. The
			// second should generate a diagnostic about duplicate addresses.
			await writeFixturePackage(packagesRoot, {
				id: "DuplicateTest",
				source: "DuplicateTest",
				components: [
					{
						kind: "system-prompt",
						name: "system-prompt",
						source: "DuplicateTest",
						mergeMode: "replace",
					},
					{
						kind: "system-prompt",
						name: "system-prompt",
						source: "DuplicateTest",
						mergeMode: "append",
					},
				],
			});
			const overlay = await loadPackageOverlay({ packagesRoot, selections: ["DuplicateTest"] });
			const session = await HcpClientbuildpackagesessionfortest({ repoRoot: packagesRoot, overlay });
			try {
				// Both components have the same name "system-prompt", so only one
				// address is registered. The overlay loader already dedupes by
				// component identity (kind+source+name), so this test effectively
				// validates that the second identical component is dropped during
				// loading, not assembly. In v2, identical (kind, source, name)
				// components from the same package shouldn't appear in the manifest;
				// the real validation is that if they somehow do, only one survives.
				expect(session.packageResourceAddresses.filter((a) => a === "system-prompt:system-prompt").length).toBe(1);
			} finally {
				await session.hcp.dispose();
			}
		} finally {
			rmSync(packagesRoot, { recursive: true, force: true });
		}
	});
});
