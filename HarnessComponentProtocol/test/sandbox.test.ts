import { describe, expect, it } from "vitest";
import { HCP_MAGNETS } from "../.HCP/assembly/sources.generated.ts";
import { HcpClient } from "../HcpClient.ts";
import * as sandboxServer from "../sandbox/HcpServer.ts";
import * as sandboxMagenta from "../sandbox/magenta/HcpMagnet.ts";
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
		const descriptorPath = new URL("../sandbox/sandbox.toml", import.meta.url).pathname;
		const magnet = new sandboxMagenta.HcpMagnet({
			repoRoot: process.cwd(),
			packagesRoot: process.cwd(),
			kind: "sandbox",
			name: "sandbox",
			source: "magenta",
			descriptorPath,
		});
		const hcp = new HcpClient();
		hcp.registerModule(new sandboxServer.HcpServer(), new Map([["sandbox", magnet]]));

		expect(hcp.addresses()).toEqual(
			expect.arrayContaining([
				"capability:sandbox",
				"sandbox://profiles",
				"sandbox://readonly-fs",
				"hook://sandbox-select",
			]),
		);
		await expect(hcp.dispatch({ target: "sandbox://profiles", op: "discover" })).resolves.toMatchObject({
			provider: "sandbox",
			selectionTarget: "hook://sandbox-select",
		});
		await expect(hcp.dispatch({ target: "capability:sandbox", op: "describe" })).resolves.toMatchObject({
			target: "capability:sandbox",
			metadata: { source: "magenta" },
		});
		await expect(hcp.dispatch({ target: "hook://sandbox-select", op: "describe" })).resolves.toMatchObject({
			target: "hook://sandbox-select",
			metadata: { source: "magenta" },
		});

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

	it("is declared in the generated HCP rows", () => {
		expect(HCP_MAGNETS.find((component) => component.kind === "sandbox")).toMatchObject({
			name: "sandbox",
			source: "magenta",
		});
	});
});
