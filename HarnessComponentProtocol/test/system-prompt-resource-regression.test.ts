import { describe, expect, it } from "vitest";
import { HcpClientbuildsession } from "../.HCP/assembly/session-hcp.ts";
import { HCP_MAGNETS } from "../.HCP/assembly/sources.generated.ts";
import type { PackageOverlay, PackageResolvedComponent } from "../.HCP/overlay/package-overlay.ts";
import { SystemPromptProvider } from "../system-prompt/pi/provider.ts";

const CONTENT_SYSTEM_PROMPT: PackageResolvedComponent = {
	kind: "system-prompt",
	name: "system-prompt",
	source: "AutOmicScience",
	description: "Package content-only system prompt.",
	packageId: "AutOmicScience",
	profile: "general",
	key: "system-prompt:system-prompt",
	baseDir: "/repo/packages/AutOmicScience/general",
	path: "/repo/packages/AutOmicScience/general/system-prompt/system-prompt.toml",
	sourcePath: "/repo/packages/AutOmicScience/general/harness.toml",
	bundles: [],
	raw: {},
};

function contentOverlay(): PackageOverlay {
	return {
		repoRoot: "/repo",
		packagesRoot: "/repo/packages",
		selections: [{ packageId: "AutOmicScience", profiles: ["general"] }],
		packages: [],
		components: [CONTENT_SYSTEM_PROMPT],
		componentMap: new Map([[CONTENT_SYSTEM_PROMPT.key, CONTENT_SYSTEM_PROMPT]]),
		overrides: [],
		resources: {
			skillPaths: [],
			promptTemplatePaths: [],
			themePaths: [],
			systemPromptPaths: [
				{
					packageId: CONTENT_SYSTEM_PROMPT.packageId,
					profile: CONTENT_SYSTEM_PROMPT.profile,
					name: CONTENT_SYSTEM_PROMPT.name,
					path: CONTENT_SYSTEM_PROMPT.path!,
					sourcePath: CONTENT_SYSTEM_PROMPT.sourcePath,
					component: CONTENT_SYSTEM_PROMPT,
				},
			],
			appendSystemPromptPaths: [],
			brandPaths: [],
		},
		diagnostics: [],
	};
}

describe("system-prompt code and content products", () => {
	it("keeps the core system-prompt source as one code capability", async () => {
		const rows = HCP_MAGNETS.filter((row) => row.module === "system-prompt");
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
	});

	it("keeps a package SYSTEM.md descriptor in the resource flow", async () => {
		const overlay = contentOverlay();
		expect(overlay.resources.systemPromptPaths.map((resource) => resource.component)).toEqual([
			CONTENT_SYSTEM_PROMPT,
		]);

		const session = await HcpClientbuildsession({ repoRoot: "/repo", overlay });
		expect(session.diagnostics).toEqual([]);
		expect(session.hcp.resolveCapability("system-prompt")).toBeInstanceOf(SystemPromptProvider);
		expect(session.hcp.resolveModule("system-prompt")?.describe().metadata?.slots).toEqual(["system-prompt"]);
	});
});
