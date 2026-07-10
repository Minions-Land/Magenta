import type { HcpMagnetBinding } from "../.HCP/HcpMagnetTypes.ts";
import type { HcpServerDescription, HcpServerRequest } from "../.HCP/HcpServerTypes.ts";

export class HcpServer {
	readonly moduleName = "sandbox";
	readonly description = "Sandbox profile selection and policy enforcement.";

	private binding(magnet: { toCapability?(): unknown }): HcpMagnetBinding<SandboxProvider> {
		return magnet.toCapability?.() as HcpMagnetBinding<SandboxProvider>;
	}

	describeSource(
		_selector: string,
		magnet: { readonly hotSwappable?: boolean; toCapability?(): unknown },
	): HcpServerDescription {
		const binding = this.binding(magnet);
		return {
			target: "capability:sandbox",
			kind: binding.kind,
			ops: ["discover", "list", "describe", "get", "resolve"],
			description: "Sandbox profile provider migrated from Magenta1 general-harness.",
			metadata: {
				name: binding.name,
				implementation: "native-ts",
				source: binding.source,
				origin: "magenta1-general-harness",
				enforcement: "not-ported",
				hotSwappable: magnet.hotSwappable ?? false,
			},
		};
	}

	sourceAddresses(_selector: string, magnet: { toCapability?(): unknown }): string[] {
		const provider = this.binding(magnet).instance;
		return ["capability:sandbox", "sandbox://profiles", "hook://sandbox-select", ...provider.discover().targets];
	}

	callSource(
		selector: string,
		magnet: { readonly hotSwappable?: boolean; toCapability?(): unknown },
		request: HcpServerRequest,
	): unknown {
		const binding = this.binding(magnet);
		const provider = binding.instance;
		const op = request.op || "describe";

		if (request.target === "hook://sandbox-select") {
			switch (op) {
				case "describe":
					return this.describeSandboxSelect(binding.source);
				case "run":
				case "call":
				case "select":
					return provider.resolve(request.input).selection;
				default:
					throw new Error(`unsupported sandbox-select operation ${request.op}`);
			}
		}

		if (request.target === "capability:sandbox" || request.target === "sandbox://profiles") {
			switch (op) {
				case "discover":
				case "list":
					return provider.discover();
				case "describe":
					return request.target === "capability:sandbox"
						? this.describeSource(selector, magnet)
						: this.describeSandboxProfiles();
				case "get":
					return provider.get(this.profileFromInput(request.input));
				case "resolve":
					return provider.resolve(request.input);
				default:
					throw new Error(`unsupported sandbox operation ${request.op}`);
			}
		}

		const name = this.profileName(request.target);
		switch (op) {
			case "discover":
			case "list":
				return provider.discover();
			case "describe":
			case "get":
				return provider.get(name);
			case "resolve":
				return provider.resolve(request.input, name);
			default:
				throw new Error(`unsupported sandbox operation ${request.op}`);
		}
	}

	private describeSandboxProfiles(): HcpServerDescription {
		return {
			target: "sandbox://profiles",
			kind: "sandbox",
			ops: ["discover", "list", "describe", "get", "resolve"],
			description: "Discover and resolve available sandbox profiles.",
			metadata: {
				implementation: "native-ts",
				enforcement: "not-ported",
			},
		};
	}

	private describeSandboxSelect(source: string): HcpServerDescription {
		return {
			target: "hook://sandbox-select",
			kind: "hook",
			ops: ["run", "call", "select", "describe"],
			description: "Select a sandbox profile for a tool descriptor.",
			metadata: {
				implementation: "native-ts",
				source,
				origin: "magenta1-general-harness",
				output: "{ profile, reason }",
			},
		};
	}

	private profileName(target: string): string {
		if (!target.startsWith("sandbox://")) {
			throw new Error(`unsupported sandbox target ${target}`);
		}
		return target.slice("sandbox://".length);
	}

	private profileFromInput(input: unknown): string {
		if (input && typeof input === "object" && !Array.isArray(input)) {
			const record = input as Record<string, unknown>;
			const name = typeof record.name === "string" ? record.name : record.profile;
			if (typeof name === "string") return name;
		}
		throw new Error("sandbox get operation requires input.name or input.profile");
	}
}

export type SandboxNetworkPolicy = "deny" | "allowlist" | "allow" | string;

export type SandboxProfile = {
	kind: "sandbox" | string;
	name: string;
	description: string;
	fs_read: string[];
	fs_write: string[];
	network: SandboxNetworkPolicy;
	network_allowlist: string[];
	max_memory_mb: number;
	max_wall_seconds: number;
	env_allowlist: string[];
	backend: string;
	source?: string;
	origin?: string;
	origin_rel?: string;
	path?: string;
};

export type SandboxSelectionTool = {
	read_only?: boolean;
	destructive?: boolean;
	tags?: string[];
	operation?: string;
	name?: string;
};

export type SandboxSelection = {
	profile: string;
	reason: {
		read_only: boolean;
		destructive: boolean;
		trusted: boolean;
		network_read: boolean;
		workspace_write: boolean;
	};
};

export type SandboxDiscoverResult = {
	provider: "sandbox";
	targets: string[];
	profiles: SandboxProfile[];
	selectionTarget: "hook://sandbox-select";
	enforcement: "not-ported";
};

export type SandboxProviderOptions = {
	profiles: SandboxProfile[];
};

export type SandboxProvider = {
	get(name: string): SandboxProfile;
	list(): SandboxProfile[];
	discover(): SandboxDiscoverResult;
	resolve(input: unknown, fallbackName?: string): { selection: SandboxSelection; profile: SandboxProfile };
};
