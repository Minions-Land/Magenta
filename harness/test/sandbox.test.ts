import { describe, expect, it } from "vitest";
import { HcpClient } from "../hcp/hcp/hcp.ts";
import { getHarnessRegistryPath, loadRegistry } from "../hcp/registry/registry.ts";
import { loadSandboxProviderFromPack, selectSandboxProfile } from "../sandbox/magenta/sandbox.ts";

describe("sandbox provider", () => {
	it("loads migrated Magenta1 sandbox profiles", async () => {
		const provider = await loadSandboxProviderFromPack(new URL("../sandbox/sandbox.toml", import.meta.url).pathname);
		const discovered = provider.discover();

		expect(discovered.targets).toEqual([
			"sandbox://network-read",
			"sandbox://readonly-fs",
			"sandbox://restricted",
			"sandbox://trusted",
			"sandbox://workspace-write",
		]);
		expect(provider.get("readonly-fs")).toMatchObject({
			name: "readonly-fs",
			network: "deny",
			fs_read: ["."],
			fs_write: [],
			origin: "magenta1-general-harness",
		});
		expect(provider.get("trusted").env_allowlist).toContain("CUDA_VISIBLE_DEVICES");
	});

	it("matches Magenta1 sandbox-select priority", () => {
		expect(selectSandboxProfile({ tool: { read_only: true, tags: [] } }).profile).toBe("readonly-fs");
		expect(selectSandboxProfile({ tool: { read_only: true, tags: ["workspace-write"] } }).profile).toBe(
			"workspace-write",
		);
		expect(
			selectSandboxProfile({ tool: { read_only: true, tags: ["network-read", "workspace-write"] } }).profile,
		).toBe("network-read");
		expect(selectSandboxProfile({ tool: { read_only: true, tags: ["trusted", "network-read"] } }).profile).toBe(
			"trusted",
		);
		expect(selectSandboxProfile({ tool: { destructive: true, tags: [] } }).profile).toBe("restricted");
	});

	it("selects writable sandbox profiles for write and edit operations without write tags", () => {
		expect(selectSandboxProfile({ tool: { operation: "write", tags: [] } })).toMatchObject({
			profile: "workspace-write",
			reason: { workspace_write: true },
		});
		expect(selectSandboxProfile({ tool: { operation: "edit", tags: [] } })).toMatchObject({
			profile: "workspace-write",
			reason: { workspace_write: true },
		});
	});

	it("registers sandbox and sandbox-select as HCP targets", async () => {
		const provider = await loadSandboxProviderFromPack(new URL("../sandbox/sandbox.toml", import.meta.url).pathname);
		const hcp = new HcpClient()
			.register("sandbox", provider.toSandboxHcpServer())
			.registerExact("hook://sandbox-select", provider.toSandboxSelectHcpServer());

		await expect(hcp.dispatch({ target: "sandbox://readonly-fs", op: "describe" })).resolves.toMatchObject({
			name: "readonly-fs",
			max_wall_seconds: 300,
		});
		await expect(
			hcp.dispatch({
				target: "hook://sandbox-select",
				op: "run",
				input: { tool: { read_only: true, tags: ["network-read"] } },
			}),
		).resolves.toMatchObject({
			profile: "network-read",
			reason: { read_only: true, network_read: true },
		});
		await expect(
			hcp.dispatch({
				target: "sandbox://restricted",
				op: "resolve",
				input: { tool: { read_only: true, tags: [] } },
			}),
		).resolves.toMatchObject({
			selection: { profile: "restricted" },
			profile: { name: "restricted" },
		});
	});

	it("is registered in the harness registry and catalog integration map", async () => {
		const registry = await loadRegistry(getHarnessRegistryPath());

		expect(registry.components.find((component) => component.kind === "sandbox")).toMatchObject({
			name: "sandbox",
		});

		const catalog = registry.catalogs[0]?.catalog;
		const readonly = catalog.entries.find((entry) => entry.id === "general-harness:sandbox:readonly-fs");
		const hook = catalog.entries.find((entry) => entry.id === "general-harness:hook:sandbox-select");

		expect(readonly?.migration).toMatchObject({
			state: "integrated",
			component: { kind: "sandbox", name: "readonly-fs", path: "sandbox/magenta/readonly-fs.toml" },
		});
		expect(hook?.migration).toMatchObject({
			state: "integrated",
			component: { kind: "hook", name: "sandbox-select", path: "sandbox/magenta/sandbox.ts" },
		});
	});
});
