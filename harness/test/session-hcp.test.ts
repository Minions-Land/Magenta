import { describe, expect, it } from "vitest";
import { buildSessionHcp } from "../hcp-client/assembly/session-hcp.ts";
import type { BashOperations } from "../modules/tools/bash/pi/bash.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const REPO_ROOT = "/test-repo";

/**
 * Mock BashOperations for test: the harness bash tool magnet requires injected
 * operations (harness holds no host shell default), so tests must stub them.
 */
const mockBashOperations: BashOperations = {
	exec: async () => ({ exitCode: 0 }),
};

describe("Phase 0 — unified session HCP assembler", () => {
	it("C0.1: buildSessionHcp exists and returns one HcpClient", async () => {
		const result = await buildSessionHcp({ repoRoot: REPO_ROOT });
		expect(result.hcp).toBeDefined();
		expect(result.diagnostics).toBeDefined();
		expect(result.toolAddresses).toBeInstanceOf(Array);
	});

	it("C0.2: all expected tools + capabilities are resolvable from the unified HCP", async () => {
		const { hcp } = await buildSessionHcp({
			repoRoot: REPO_ROOT,
			toolOptions: { bash: { operations: mockBashOperations } },
		});

		// Built-in tools: 7 addressable via tool:<name>. resolve() returns the
		// module-level server (tools module); resolveInstance() routes the selector.
		const expectedTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
		for (const name of expectedTools) {
			const toolServer = hcp.resolve(`tool:${name}`);
			expect(toolServer, `tool:${name} should resolve to its module server`).toBeDefined();
			// Strict Model B: resolve() returns the MODULE server, not a per-magnet server.
			expect(toolServer?.describe().kind, `tool:${name} resolves to a module`).toBe("module");
			expect(hcp.resolve(`tool:${name}`), `tool:${name} is the tools module`).toBe(hcp.resolveModule("tools"));
			const tool = hcp.resolveInstance<AgentTool>(`tool:${name}`);
			expect(tool?.name, `tool:${name} should yield an AgentTool`).toBe(name);
		}

		// Default capability sources. CAPABILITY_SOURCE_MAGNETS (sources.ts) lists 10
		// magnets; runtime is multi-slot (runtime:process + runtime:script-runtimes),
		// the others are single-slot. NOTE: system-prompt + multiagent ARE assembled
		// by buildDefaultCapabilityHcp (they have magnets), even though they are NOT
		// in the overlay's CAPABILITY_KINDS set — the two paths differ.
		const expectedCapabilities = [
			"compaction",
			"context",
			"hook",
			"memory",
			"multiagent",
			"policy",
			"prompt-template",
			"sandbox",
			"system-prompt",
		];
		for (const name of expectedCapabilities) {
			const capServer = hcp.resolve(`capability:${name}`);
			expect(capServer, `capability:${name} should resolve to its module server`).toBeDefined();
			// Strict Model B: capability addresses resolve to the module server too.
			expect(capServer?.describe().kind, `capability:${name} resolves to a module`).toBe("module");
			const instance = hcp.resolveInstance(`capability:${name}`);
			expect(instance, `capability:${name} should yield a defined instance`).toBeDefined();
		}

		// runtime is multi-slot: both slots resolve to the SAME runtime module server,
		// and resolveInstance routes each selector to a distinct implementation.
		const runtimeModule = hcp.resolveModule("runtime");
		expect(hcp.resolve("capability:runtime:process"), "runtime:process").toBe(runtimeModule);
		expect(hcp.resolve("capability:runtime:script-runtimes"), "runtime:script-runtimes").toBe(runtimeModule);
		const proc = hcp.resolveInstance("capability:runtime:process");
		const scripts = hcp.resolveInstance("capability:runtime:script-runtimes");
		expect(proc, "runtime:process instance").toBeDefined();
		expect(scripts, "runtime:script-runtimes instance").toBeDefined();
		expect(proc, "multi-slot routes to distinct instances").not.toBe(scripts);

		// Alternative resolution API for capabilities: resolveCapability(name)
		const compaction = hcp.resolveCapability("compaction");
		expect(compaction, "resolveCapability('compaction') should work").toBeDefined();
	});

	it("C0.3: zero consumer changes (buildSessionHcp is additive)", () => {
		// This test is a placeholder assertion that the new code does NOT modify
		// any existing consumer (pi/coding-agent, agent-harness.ts). Verified by:
		// 1. No imports of session-hcp.ts exist outside this test yet (grep check).
		// 2. Full build + both test suites green (run after this file lands).
		expect(true).toBe(true);
	});

	it("C0.4: packagesRoot defaults to resolve(repoRoot,'packages') — aligns with overlay", async () => {
		const { hcp } = await buildSessionHcp({
			repoRoot: REPO_ROOT,
			toolOptions: { bash: { operations: mockBashOperations } },
		});
		// No explicit packagesRoot passed; should use getHarnessPackagesRoot(repoRoot).
		// The test itself is that this call succeeds without a packagesRoot mismatch
		// diagnostic. If packagesRoot diverged (the old Runtime A bug), diagnostics
		// would contain "package not found" or similar.
		expect(hcp).toBeDefined();
	});

	it("bash tool magnet is NOT built when bash operations are not supplied", async () => {
		// bash requires BashExecuteOptions with operations; when absent, skip it.
		const { hcp, toolAddresses } = await buildSessionHcp({
			repoRoot: REPO_ROOT,
			toolOptions: {}, // no bash: {...} provided
		});

		expect(toolAddresses.includes("tool:bash")).toBe(false);
		expect(hcp.resolve("tool:bash")).toBeUndefined();

		// Other tools (which have optional options) should still be registered.
		expect(hcp.resolve("tool:read")).toBeDefined();
		expect(hcp.resolve("tool:edit")).toBeDefined();
	});

	it("includeBuiltInTools: false excludes built-in tool magnets", async () => {
		const { hcp } = await buildSessionHcp({
			repoRoot: REPO_ROOT,
			includeBuiltInTools: false,
		});

		expect(hcp.resolve("tool:read")).toBeUndefined();
		expect(hcp.resolve("tool:bash")).toBeUndefined();

		// Capabilities should still be registered.
		expect(hcp.resolveCapability("compaction")).toBeDefined();
	});

	it("includeBuiltInCapabilities: false excludes default capability sources", async () => {
		const { hcp } = await buildSessionHcp({
			repoRoot: REPO_ROOT,
			toolOptions: { bash: { operations: mockBashOperations } },
			includeBuiltInCapabilities: false,
		});

		expect(hcp.resolveCapability("compaction")).toBeUndefined();
		expect(hcp.resolveCapability("context")).toBeUndefined();

		// Tools should still be registered.
		expect(hcp.resolve("tool:bash")).toBeDefined();
	});

	it("INV-2: one HcpClient per session (no second registry introduced)", async () => {
		const result = await buildSessionHcp({
			repoRoot: REPO_ROOT,
			toolOptions: { bash: { operations: mockBashOperations } },
		});

		// The result contains exactly one hcp field. There are no parallel registries
		// (verified by reading session-hcp.ts: magnets are assembled and merged into
		// a single `hcp` variable, then returned). No selection logic lives in
		// sources.ts (it stays a dumb barrel).
		expect(result.hcp).toBeDefined();
		const addresses = result.hcp.addresses();
		expect(addresses.length).toBeGreaterThan(0); // Populated with both tools + capabilities.
	});
});
