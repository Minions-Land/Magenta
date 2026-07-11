import { describe, expect, it } from "vitest";
import type { PackageOverlay, PackageResolvedComponent } from "../_magenta/packages/package-overlay.ts";
import { ProcessRuntimeProvider } from "../runtime/magenta/process-runtime.ts";
import { ScriptRuntimeProvider } from "../runtime/magenta/script-runtime.ts";
import { SandboxProvider } from "../sandbox/magenta/sandbox.ts";
import { HcpClientbuildpackagesessionfortest } from "./package-test-utils.ts";

const RUNTIME_PROCESS_COMPONENT: PackageResolvedComponent = {
	kind: "runtime",
	name: "process",
	source: "magenta",
	packageId: "RuntimeFixture",
	packageDir: "/repo/packages/RuntimeFixture",
	key: "runtime:process",
	baseDir: "/repo/packages/RuntimeFixture",
	sourcePath: "/repo/packages/RuntimeFixture/runtime/process.toml",
	bundles: [],
	raw: {},
};

const SCRIPT_RUNTIMES_COMPONENT: PackageResolvedComponent = {
	...RUNTIME_PROCESS_COMPONENT,
	name: "script-runtimes",
	key: "runtime:script-runtimes",
	sourcePath: "/repo/packages/RuntimeFixture/runtime/script-runtimes.toml",
};

const BROKEN_SANDBOX_COMPONENT: PackageResolvedComponent = {
	kind: "sandbox",
	name: "sandbox",
	source: "magenta",
	packageId: "RuntimeFixture",
	packageDir: "/repo/packages/RuntimeFixture",
	key: "sandbox:sandbox",
	baseDir: "/repo/packages/RuntimeFixture",
	path: "/repo/packages/RuntimeFixture/sandbox/missing.toml",
	sourcePath: "/repo/packages/RuntimeFixture/sandbox/sandbox.toml",
	bundles: [],
	raw: {},
};

function runtimeOverlay(component = RUNTIME_PROCESS_COMPONENT): PackageOverlay {
	return {
		repoRoot: "/repo",
		packagesRoot: "/repo/packages",
		selections: [{ packageId: "RuntimeFixture" }],
		packages: [],
		components: [component],
		componentMap: new Map([[component.key, component]]),
		overrides: [],
		diagnostics: [],
	};
}

describe("package capability slot merging", () => {
	it("keeps a package runtime override while filling the other default runtime slot", async () => {
		const assembly = await HcpClientbuildpackagesessionfortest({ repoRoot: "/repo", overlay: runtimeOverlay() });
		expect(assembly.diagnostics).toEqual([]);
		const hcp = assembly.hcp;
		const packageProcessRuntime = hcp.resolveCapability("runtime:process");
		expect(packageProcessRuntime).toBeInstanceOf(ProcessRuntimeProvider);
		expect(hcp.resolveCapability("runtime:script-runtimes")).toBeInstanceOf(ScriptRuntimeProvider);
		expect(hcp.resolve("capability:runtime:process")).toBe(hcp.resolveModule("runtime"));
		expect(hcp.resolve("capability:runtime:script-runtimes")).toBe(hcp.resolveModule("runtime"));
		expect(hcp.resolveModule("runtime")?.describe().metadata?.slots).toEqual([
			"runtime:process",
			"runtime:script-runtimes",
		]);
	});

	it("matches a package script runtime override to its exact runtime slot", async () => {
		const assembly = await HcpClientbuildpackagesessionfortest({
			repoRoot: "/repo",
			overlay: runtimeOverlay(SCRIPT_RUNTIMES_COMPONENT),
		});

		expect(assembly.diagnostics).toEqual([]);
		expect(assembly.hcp.resolveCapability("runtime:process")).toBeInstanceOf(ProcessRuntimeProvider);
		expect(assembly.hcp.resolveCapability("runtime:script-runtimes")).toBeInstanceOf(ScriptRuntimeProvider);
	});

	it("rejects a package capability name without a matching HCP slot", async () => {
		const unknownRuntime = {
			...RUNTIME_PROCESS_COMPONENT,
			name: "unknown-runtime",
			key: "runtime:unknown-runtime",
		};
		const assembly = await HcpClientbuildpackagesessionfortest({
			repoRoot: "/repo",
			overlay: runtimeOverlay(unknownRuntime),
		});

		expect(assembly.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "package_component_invalid",
				message: expect.stringContaining("runtime:unknown-runtime"),
			}),
		);
		expect(assembly.hcp.resolveCapability("runtime:process")).toBeInstanceOf(ProcessRuntimeProvider);
	});

	it("fills default capability slots when package sandbox and runtime overrides are broken", async () => {
		const unavailableRuntime = {
			...RUNTIME_PROCESS_COMPONENT,
			source: "missing",
		};
		const components = [BROKEN_SANDBOX_COMPONENT, unavailableRuntime];
		const assembly = await HcpClientbuildpackagesessionfortest({
			repoRoot: "/repo",
			overlay: {
				...runtimeOverlay(),
				components,
				componentMap: new Map(components.map((component) => [component.key, component])),
			},
		});

		expect(assembly.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "component_build_failed",
				module: "sandbox",
				message: expect.stringContaining("missing.toml"),
			}),
		);
		expect(assembly.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "package_component_invalid",
				message: expect.stringContaining("selects unavailable source missing"),
			}),
		);
		expect(assembly.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "component_dependency_missing" }),
		);
		expect(assembly.hcp.resolveCapability("sandbox")).toBeInstanceOf(SandboxProvider);
		expect(assembly.hcp.resolveCapability("runtime:process")).toBeInstanceOf(ProcessRuntimeProvider);
		expect(assembly.hcp.resolveCapability("runtime:script-runtimes")).toBeInstanceOf(ScriptRuntimeProvider);
		expect(assembly.hcp.resolveCapability("hook")).toBeDefined();
	});
});
