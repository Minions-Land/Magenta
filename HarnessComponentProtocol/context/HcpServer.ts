import type { HcpMagnetBinding } from "../.HCP/HcpMagnetTypes.ts";
import type { HcpServerDescription, HcpServerRequest } from "../.HCP/HcpServerTypes.ts";
import type { ContextFile } from "./magenta/context.ts";

export class HcpServer {
	readonly moduleName = "context";
	readonly description = "Workspace context discovery and loading.";

	private binding(magnet: {
		toCapability?(): unknown;
	}): HcpMagnetBinding<import("./magenta/context.ts").ContextProvider> {
		return magnet.toCapability?.() as HcpMagnetBinding<import("./magenta/context.ts").ContextProvider>;
	}

	describeSource(
		_selector: string,
		magnet: { readonly hotSwappable?: boolean; toCapability?(): unknown },
	): HcpServerDescription {
		const binding = this.binding(magnet);
		return {
			target: "capability:context",
			kind: "context",
			ops: ["discover", "list", "read", "call", "status", "describe"],
			description: "Discover project instruction files and return model-safe context content.",
			metadata: {
				name: binding.name,
				source: binding.source,
				implementation: "native-ts",
				hotSwappable: magnet.hotSwappable ?? false,
			},
		};
	}

	sourceAddresses(): string[] {
		return ["capability:context", "context://workspace", "context://project"];
	}

	callSource(_selector: string, magnet: { toCapability?(): unknown }, request: HcpServerRequest): unknown {
		const provider = this.binding(magnet).instance;
		switch (request.op || "read") {
			case "discover":
			case "list":
				return provider.discover();
			case "describe":
				return {
					name: "project-context",
					target: "context://project",
					aliases: ["context://workspace"],
					description: "Discover project instruction files and return model-safe context content.",
					operations: ["read", "status"],
				};
			case "read":
			case "call":
				return provider.read();
			case "status":
				return provider.status();
			default:
				throw new Error(`Unknown operation: ${request.op} for context capability`);
		}
	}
}

/**
 * The context capability surface consumed by the agent loop. This is the
 * injection surface: the loop calls the source-selected provider instead of
 * statically importing context discovery, so the assembly layer decides which
 * source (magenta, ...) supplies the behavior.
 *
 * This type contains only business logic. The real module HcpServer above owns
 * HCP routing; the provider does not construct or register HCP entities.
 */
export type ContextProvider = {
	/**
	 * Discover and read context files (CLAUDE.md, AGENTS.md, etc.) from the
	 * workspace, expanding imports and sanitizing for model consumption.
	 */
	discoverContextFiles(workspaceRoot: string): Promise<ContextFile[]>;
};

// Re-export supporting types for convenience
export type { ContextFile } from "./magenta/context.ts";
