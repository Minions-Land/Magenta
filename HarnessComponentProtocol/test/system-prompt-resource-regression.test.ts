import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HcpClientbuildsession } from "../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS } from "../.HCP/assembly/sources.generated.ts";
import type { HcpMagnetResource } from "../.HCP/HcpMagnetTypes.ts";
import type { PackageOverlay, PackageResolvedComponent } from "../_magenta/packages/package-overlay.ts";
import { SystemPromptProvider } from "../system-prompt/pi/provider.ts";

function contentOverlay(repoRoot: string): PackageOverlay {
	const packageDir = join(repoRoot, "packages", "AutOmicScience");
	const profileDir = join(packageDir, "general");
	const descriptorDir = join(profileDir, "system-prompt");
	const descriptorPath = join(descriptorDir, "system-prompt.toml");
	mkdirSync(descriptorDir, { recursive: true });
	writeFileSync(
		descriptorPath,
		`kind = "system-prompt"
name = "system-prompt"
source = "AutOmicScience"
content_path = "SYSTEM.md"
`,
	);
	writeFileSync(join(descriptorDir, "SYSTEM.md"), "AutOmicScience system prompt.");

	const component: PackageResolvedComponent = {
		kind: "system-prompt",
		name: "system-prompt",
		source: "AutOmicScience",
		description: "Package content-only system prompt.",
		packageId: "AutOmicScience",
		packageDir,
		profile: "general",
		key: "system-prompt:system-prompt",
		baseDir: profileDir,
		path: descriptorPath,
		sourcePath: join(profileDir, "harness.toml"),
		bundles: [],
		raw: {},
	};
	return {
		repoRoot,
		packagesRoot: join(repoRoot, "packages"),
		selections: [{ packageId: "AutOmicScience", profiles: ["general"] }],
		packages: [],
		components: [component],
		componentMap: new Map([[component.key, component]]),
		overrides: [],
		diagnostics: [],
	};
}

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
		const repoRoot = mkdtempSync(join(tmpdir(), "hcp-system-prompt-resource-"));
		try {
			const overlay = contentOverlay(repoRoot);
			const session = await HcpClientbuildsession({ repoRoot, overlay });
			try {
				expect(session.diagnostics).toEqual([]);
				expect(session.packageResourceAddresses).toEqual(["system-prompt:system-prompt"]);
				expect(session.hcp.resolveCapability("system-prompt")).toBeInstanceOf(SystemPromptProvider);
				expect(session.hcp.resolve("system-prompt:system-prompt")).toBe(session.hcp.resolveModule("system-prompt"));
				expect(session.hcp.resolveInstance<HcpMagnetResource>("system-prompt:system-prompt")).toMatchObject({
					kind: "system-prompt",
					name: "system-prompt",
					source: "AutOmicScience",
					mergeMode: "replace",
					contentPath: join(repoRoot, "packages", "AutOmicScience", "general", "system-prompt", "SYSTEM.md"),
					metadata: { origin: "package", packageId: "AutOmicScience", profile: "general" },
				});
				expect(session.hcp.resolveModule("system-prompt")?.describe().metadata?.slots).toEqual([
					"system-prompt",
					"system-prompt:system-prompt",
				]);
			} finally {
				await session.hcp.dispose();
			}
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("rejects duplicate canonical Resource addresses instead of silently dropping one", async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "hcp-system-prompt-duplicate-"));
		try {
			const overlay = contentOverlay(repoRoot);
			const replacement = overlay.components[0]!;
			const append: PackageResolvedComponent = {
				...replacement,
				kind: "append-system-prompt",
				key: "append-system-prompt:system-prompt",
				path: join(replacement.baseDir, "system-prompt", "append-system-prompt.toml"),
			};
			overlay.components.push(append);
			overlay.componentMap.set(append.key, append);

			const session = await HcpClientbuildsession({ repoRoot, overlay });
			try {
				expect(session.packageResourceAddresses).toEqual(["system-prompt:system-prompt"]);
				expect(session.diagnostics).toContainEqual(
					expect.objectContaining({
						code: "package_component_invalid",
						message: expect.stringContaining("declared more than once"),
					}),
				);
			} finally {
				await session.hcp.dispose();
			}
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});
