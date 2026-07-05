import { describe, expect, it } from "vitest";
import {
	buildDefaultCapabilityHcp,
	type CapabilityBuilderTable,
	capabilityBindingKey,
	createCapabilityMagnet,
} from "../hcp-client/assembly/capability.ts";
import { HcpClient } from "../hcp-client/hcp-client.ts";
import { CapabilityMagnet } from "../hcp-magnet/universal.ts";

const CONTEXT = { repoRoot: "/repo", packagesRoot: "/repo/packages" };

describe("capability magnet infrastructure", () => {
	it("selects the implementation by declared source", async () => {
		// A single selection table offering two sources for the same kind. Injected
		// per-call — no global registry to populate or reset.
		const builders: CapabilityBuilderTable = {
			"fixture-cap:pi": () => ({ label: "pi-impl" }),
			"fixture-cap:magenta": () => ({ label: "magenta-impl" }),
		};

		const pi = await createCapabilityMagnet({
			component: { kind: "fixture-cap", name: "fixture-cap", source: "pi" },
			context: CONTEXT,
			builders,
		});
		expect(pi.diagnostics).toEqual([]);
		const piBinding = pi.magnet?.toCapability?.();
		expect(piBinding).toMatchObject({ kind: "fixture-cap", source: "pi" });
		expect((piBinding?.instance as { label: string }).label).toBe("pi-impl");

		// Same component, different declared source -> a different impl. Proves
		// the assembly layer SELECTS the source rather than hardcoding it.
		const magenta = await createCapabilityMagnet({
			component: { kind: "fixture-cap", name: "fixture-cap", source: "magenta" },
			context: CONTEXT,
			builders,
		});
		expect((magenta.magnet?.toCapability?.().instance as { label: string }).label).toBe("magenta-impl");
	});

	it("diagnoses a missing builder instead of throwing", async () => {
		const result = await createCapabilityMagnet({
			component: { kind: "fixture-missing", name: "fixture-missing", source: "pi" },
			context: CONTEXT,
			builders: {},
		});
		expect(result.magnet).toBeUndefined();
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.code).toBe("capability_factory_missing");
	});

	it("diagnoses a missing source", async () => {
		const result = await createCapabilityMagnet({
			component: { kind: "fixture-cap", name: "fixture-cap", source: "" },
			context: CONTEXT,
			builders: { "fixture-cap:pi": () => ({}) },
		});
		expect(result.diagnostics[0]?.code).toBe("capability_source_missing");
	});

	it("reports builder failures as diagnostics", async () => {
		const result = await createCapabilityMagnet({
			component: { kind: "fixture-boom", name: "fixture-boom", source: "pi" },
			context: CONTEXT,
			builders: {
				"fixture-boom:pi": () => {
					throw new Error("kaboom");
				},
			},
		});
		expect(result.magnet).toBeUndefined();
		expect(result.diagnostics[0]?.code).toBe("capability_factory_failed");
		expect(result.diagnostics[0]?.message).toContain("kaboom");
	});

	it("exposes the capability over HCP under its own kind, never as a tool", async () => {
		const { magnet } = await createCapabilityMagnet({
			component: { kind: "fixture-hcp", name: "fixture-hcp", source: "pi", description: "demo" },
			context: CONTEXT,
			builders: { "fixture-hcp:pi": () => ({ ping: () => "pong" }) },
		});
		if (!magnet) throw new Error("expected magnet");

		// One-of invariant: capability magnets never produce a tool.
		expect(magnet.toTool).toBeUndefined();
		expect(typeof magnet.toCapability).toBe("function");

		// A capability registers under the `capability:<kind>` address convention,
		// so HcpClient.resolveCapability(kind) finds it by slot name alone.
		const hcp = new HcpClient().registerExact("capability:fixture-hcp", magnet.toHcpServer!());
		const description = await hcp.dispatch({ target: "capability:fixture-hcp", op: "describe" });
		expect(description).toMatchObject({
			target: "capability:fixture-hcp",
			kind: "fixture-hcp",
			metadata: { source: "pi" },
		});
		// resolveCapability hands back the same instance the binding carries.
		expect(hcp.resolveCapability("fixture-hcp")).toBe(magnet.toCapability!().instance);
	});

	it("refuses the toTool HCP op for a capability magnet", async () => {
		const magnet = new CapabilityMagnet({
			descriptor: {
				target: "fixture-notool://fixture-notool",
				kind: "fixture-notool",
				name: "fixture-notool",
				implementation: "capability:pi",
			},
			source: "pi",
			instance: {},
		});
		const hcp = new HcpClient().register("fixture-notool", magnet.toHcpServer());
		await expect(hcp.dispatch({ target: "fixture-notool://fixture-notool", op: "toTool" })).rejects.toThrow(
			/does not produce an AgentTool/,
		);
	});
});

describe("HcpClient.resolveCapability", () => {
	// A minimal target that carries a typed instance — the shape a capability
	// magnet's toHcpServer() produces. Hand-built here so these tests are
	// independent of the capability-factory machinery.
	function capabilityTarget<T>(name: string, instance: T) {
		return {
			describe: () => ({ target: `capability:${name}`, kind: name, ops: [] }),
			call: () => undefined,
			instance: <U>() => instance as unknown as U,
		};
	}

	it("resolves a slot name to the registered instance under capability:<name>", () => {
		const impl = { compact: () => "done" };
		const hcp = new HcpClient().registerExact("capability:compaction", capabilityTarget("compaction", impl));
		// The consumer passes only the slot name — no address prefix, no source.
		expect(hcp.resolveCapability<typeof impl>("compaction")).toBe(impl);
	});

	it("resolves a named slot under capability:<kind>:<name>", () => {
		const impl = { runtime: "process" };
		const hcp = new HcpClient().registerExact(
			"capability:runtime:process",
			capabilityTarget("runtime:process", impl),
		);
		expect(hcp.resolveCapability<typeof impl>("runtime:process")).toBe(impl);
	});

	it("accepts a bare-name registration as a fallback address", () => {
		const impl = { note: "bare" };
		const hcp = new HcpClient().registerExact("memory", capabilityTarget("memory", impl));
		expect(hcp.resolveCapability<typeof impl>("memory")).toBe(impl);
	});

	it("returns undefined when no target is registered for the name", () => {
		const hcp = new HcpClient();
		expect(hcp.resolveCapability("absent")).toBeUndefined();
	});

	it("returns undefined when the resolved target exposes no instance", () => {
		// An inspect-only / management-only target has no instance() accessor.
		const inspectOnly = {
			describe: () => ({ target: "capability:context", kind: "context", ops: ["describe"] }),
			call: () => undefined,
		};
		const hcp = new HcpClient().registerExact("capability:context", inspectOnly);
		expect(hcp.resolveCapability("context")).toBeUndefined();
	});

	it("resolves via a prefix-registered capability target", () => {
		// register() (prefix) rather than registerExact(): capability:* all route
		// to this target, and instance() still hands back the typed impl.
		const impl = { via: "prefix" };
		const hcp = new HcpClient().register("capability", capabilityTarget("session", impl));
		expect(hcp.resolveCapability<typeof impl>("session")).toBe(impl);
	});
});

describe("capability slot keys", () => {
	it("uses kind for single-slot capabilities and kind:name for runtime", () => {
		expect(capabilityBindingKey({ kind: "policy", name: "policy" })).toBe("policy");
		expect(capabilityBindingKey({ kind: "runtime", name: "process" })).toBe("runtime:process");
	});
});

describe("context capability", () => {
	it("resolves context by name via HCP using the builtin magenta source", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);

		expect(diagnostics).toEqual([]);
		const contextProvider = hcp.resolveCapability("context");
		expect(contextProvider).toBeDefined();
		expect(typeof contextProvider).toBe("object");
		// The magenta ContextProvider has discoverContextFiles and toHcpServer methods.
		expect(typeof (contextProvider as any).discoverContextFiles).toBe("function");
		expect(typeof (contextProvider as any).toHcpServer).toBe("function");
	});

	it("assembles context from the magenta source and contributes no tools", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "context", name: "workspace", source: "magenta" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});

		expect(diagnostics).toEqual([]);
		expect(magnet).toBeDefined();
		// Capability magnets never produce tools — they only expose a capability binding.
		expect(magnet?.toTool).toBeUndefined();
		expect(typeof magnet?.toCapability).toBe("function");

		const binding = magnet?.toCapability?.();
		expect(binding).toMatchObject({ kind: "context", name: "workspace", source: "magenta" });
	});
});

describe("hook capability", () => {
	it("resolves hook by name via HCP using the builtin magenta source", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);

		expect(diagnostics).toEqual([]);
		const hookProvider = hcp.resolveCapability("hook");
		expect(hookProvider).toBeDefined();
		expect(typeof hookProvider).toBe("object");
		expect(typeof (hookProvider as any).discover).toBe("function");
		expect(typeof (hookProvider as any).describeHook).toBe("function");
		expect(typeof (hookProvider as any).run).toBe("function");
		expect((hookProvider as any).describeHook("pre-tool")).toMatchObject({
			name: "pre-tool",
			target: "hook://pre-tool",
		});
	});

	it("assembles hook from the magenta source and contributes no tools", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "hook", name: "hooks", source: "magenta" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});

		expect(diagnostics).toEqual([]);
		expect(magnet).toBeDefined();
		expect(magnet?.toTool).toBeUndefined();
		expect(typeof magnet?.toCapability).toBe("function");

		const binding = magnet?.toCapability?.();
		expect(binding).toMatchObject({ kind: "hook", name: "hooks", source: "magenta" });
	});
});

describe("memory capability", () => {
	it("resolves memory by name via HCP using the builtin magenta source", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);

		expect(diagnostics).toEqual([]);
		const memoryProvider = hcp.resolveCapability("memory");
		expect(memoryProvider).toBeDefined();
		expect(typeof memoryProvider).toBe("object");
		// The magenta SessionGroundingMemoryProvider has read/retain/recall/reflect and toHcpServer methods.
		expect(typeof (memoryProvider as any).read).toBe("function");
		expect(typeof (memoryProvider as any).retain).toBe("function");
		expect(typeof (memoryProvider as any).recall).toBe("function");
		expect(typeof (memoryProvider as any).reflect).toBe("function");
		expect(typeof (memoryProvider as any).toHcpServer).toBe("function");
	});

	it("assembles memory from the magenta source and contributes no tools", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "memory", name: "memory", source: "magenta" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});

		expect(diagnostics).toEqual([]);
		expect(magnet).toBeDefined();
		// Capability magnets never produce tools — they only expose a capability binding.
		expect(magnet?.toTool).toBeUndefined();
		expect(typeof magnet?.toCapability).toBe("function");

		const binding = magnet?.toCapability?.();
		expect(binding).toMatchObject({ kind: "memory", name: "memory", source: "magenta" });
	});
});

describe("policy capability", () => {
	it("resolves policy by name via HCP using the builtin magenta source", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);

		expect(diagnostics).toEqual([]);
		const policyProvider = hcp.resolveCapability("policy");
		expect(policyProvider).toBeDefined();
		expect(typeof policyProvider).toBe("object");
		expect(typeof (policyProvider as any).decideApproval).toBe("function");
		expect(typeof (policyProvider as any).classifyShellCommand).toBe("function");
		expect(typeof (policyProvider as any).toHcpServers).toBe("function");
		expect((policyProvider as any).decideApproval({ tool: { name: "Read", read_only: true } })).toMatchObject({
			decision: "allow",
			target: "approval://policy",
		});
		expect((policyProvider as any).classifyShellCommand({ command: "echo hello > out.txt" })).toMatchObject({
			decision: "prompt",
			target: "shell://policy",
		});
	});

	it("assembles policy from the magenta source and contributes no tools", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "policy", name: "policy", source: "magenta" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});

		expect(diagnostics).toEqual([]);
		expect(magnet).toBeDefined();
		expect(magnet?.toTool).toBeUndefined();
		expect(typeof magnet?.toCapability).toBe("function");

		const binding = magnet?.toCapability?.();
		expect(binding).toMatchObject({ kind: "policy", name: "policy", source: "magenta" });
		expect(typeof (binding?.instance as any).decideApproval).toBe("function");
	});
});

describe("prompt-template capability", () => {
	it("resolves prompt-template by name via HCP using the builtin pi source", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);

		expect(diagnostics).toEqual([]);
		const provider = hcp.resolveCapability("prompt-template");
		expect(provider).toBeDefined();
		expect(typeof provider).toBe("object");
		expect(typeof (provider as any).load).toBe("function");
		expect(typeof (provider as any).loadSourced).toBe("function");
		expect(typeof (provider as any).formatPromptTemplateInvocation).toBe("function");
		expect((provider as any).formatPromptTemplateInvocation({ name: "review", content: "Review $1" }, ["a.ts"])).toBe(
			"Review a.ts",
		);
	});

	it("assembles prompt-template from the pi source and contributes no tools", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "prompt-template", name: "prompt-templates", source: "pi" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});

		expect(diagnostics).toEqual([]);
		expect(magnet).toBeDefined();
		expect(magnet?.toTool).toBeUndefined();
		expect(typeof magnet?.toCapability).toBe("function");
		expect(magnet?.toCapability?.()).toMatchObject({
			kind: "prompt-template",
			name: "prompt-templates",
			source: "pi",
		});
	});
});

describe("runtime capability", () => {
	it("resolves named runtime slots via HCP using the builtin magenta source", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);

		expect(diagnostics).toEqual([]);
		const processRuntime = hcp.resolveCapability("runtime:process");
		expect(processRuntime).toBeDefined();
		expect(typeof processRuntime).toBe("object");
		expect(typeof (processRuntime as any).exec).toBe("function");
		expect(typeof (processRuntime as any).policyStatus).toBe("function");

		const scriptRuntime = hcp.resolveCapability("runtime:script-runtimes");
		expect(scriptRuntime).toBeDefined();
		expect(typeof scriptRuntime).toBe("object");
		expect(typeof (scriptRuntime as any).execRuntime).toBe("function");
		expect((scriptRuntime as any).describeRuntime("node")).toMatchObject({
			target: "runtime://node",
			compiled_to: "runtime://process",
		});
	});

	it("assembles runtime providers from the magenta source as named capabilities", async () => {
		const processResult = await createCapabilityMagnet({
			component: { kind: "runtime", name: "process", source: "magenta" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});
		expect(processResult.diagnostics).toEqual([]);
		expect(processResult.magnet?.toTool).toBeUndefined();
		expect(processResult.magnet?.toCapability?.()).toMatchObject({
			kind: "runtime",
			name: "process",
			source: "magenta",
		});
		expect(processResult.magnet?.toHcpServer?.().describe()).toMatchObject({
			target: "capability:runtime:process",
			kind: "runtime",
		});

		const scripts = await createCapabilityMagnet({
			component: { kind: "runtime", name: "script-runtimes", source: "magenta" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});
		expect(scripts.diagnostics).toEqual([]);
		expect(scripts.magnet?.toTool).toBeUndefined();
		expect(scripts.magnet?.toHcpServer?.().describe()).toMatchObject({
			target: "capability:runtime:script-runtimes",
			kind: "runtime",
		});
	});
});

describe("sandbox capability", () => {
	it("resolves sandbox by name via HCP using the builtin magenta source", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);

		expect(diagnostics).toEqual([]);
		const sandboxProvider = hcp.resolveCapability("sandbox");
		expect(sandboxProvider).toBeDefined();
		expect(typeof sandboxProvider).toBe("object");
		expect(typeof (sandboxProvider as any).list).toBe("function");
		expect(typeof (sandboxProvider as any).resolve).toBe("function");
		expect(typeof (sandboxProvider as any).toSandboxHcpServer).toBe("function");
		expect((sandboxProvider as any).resolve({ tool: { read_only: true, tags: [] } })).toMatchObject({
			selection: { profile: "readonly-fs" },
		});
	});

	it("assembles sandbox from the magenta source and contributes no tools", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "sandbox", name: "sandbox", source: "magenta" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});

		expect(diagnostics).toEqual([]);
		expect(magnet).toBeDefined();
		expect(magnet?.toTool).toBeUndefined();
		expect(typeof magnet?.toCapability).toBe("function");

		const binding = magnet?.toCapability?.();
		expect(binding).toMatchObject({ kind: "sandbox", name: "sandbox", source: "magenta" });
	});
});

describe("system-prompt capability", () => {
	it("resolves system-prompt by name via HCP using the builtin pi source", async () => {
		const context = { repoRoot: process.cwd(), packagesRoot: process.cwd() };
		const { hcp, diagnostics } = await buildDefaultCapabilityHcp(context);

		expect(diagnostics).toEqual([]);
		const provider = hcp.resolveCapability("system-prompt");
		expect(provider).toBeDefined();
		expect(typeof provider).toBe("object");
		expect(typeof (provider as any).formatSkillsForSystemPrompt).toBe("function");
		expect(typeof (provider as any).loadDescriptor).toBe("function");
		expect(
			(provider as any).formatSkillsForSystemPrompt([
				{ name: "inspect", description: "Inspect", content: "", filePath: "/skills/inspect/SKILL.md" },
			]),
		).toContain("<name>inspect</name>");
	});

	it("assembles system-prompt from the pi source and contributes no tools", async () => {
		const { magnet, diagnostics } = await createCapabilityMagnet({
			component: { kind: "system-prompt", name: "system-prompt", source: "pi" },
			context: { repoRoot: process.cwd(), packagesRoot: process.cwd() },
		});

		expect(diagnostics).toEqual([]);
		expect(magnet).toBeDefined();
		expect(magnet?.toTool).toBeUndefined();
		expect(typeof magnet?.toCapability).toBe("function");
		expect(magnet?.toCapability?.()).toMatchObject({
			kind: "system-prompt",
			name: "system-prompt",
			source: "pi",
		});
	});
});
