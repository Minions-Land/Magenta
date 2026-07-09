import type { HcpRequest, HcpServer, HcpServerDescription } from "../contract/hcp-server.ts";

/**
 * A capability operation handler that processes an HCP request using a provider instance.
 */
export type CapabilityOperationHandler<TProvider = any> = (
	provider: TProvider,
	request: HcpRequest,
) => unknown | Promise<unknown>;

/**
 * Options for creating a unified HcpServer wrapper around a capability provider.
 */
export interface CapabilityServerOptions<TProvider = any> {
	/** The capability kind (e.g., "hook", "context", "runtime"). */
	kind: string;
	/** The HCP target address (e.g., "hook:magenta", "context:workspace"). */
	target: string;
	/** Human-readable description of this capability. */
	description: string;
	/** The business-logic provider instance (contains no HCP-specific methods). */
	provider: TProvider;
	/**
	 * Map of operation names to handlers. Each handler receives the provider
	 * instance and the HCP request, and returns the operation result.
	 */
	operations: Record<string, CapabilityOperationHandler<TProvider>>;
	/**
	 * Optional custom describe function. If omitted, generates a standard
	 * description from kind/target/operations.
	 */
	describe?: () => HcpServerDescription;
	/**
	 * Optional metadata to include in the describe() output.
	 */
	metadata?: Record<string, unknown>;
}

/**
 * Create a unified HcpServer that wraps a capability provider and routes
 * operations to handler functions. This makes HcpServer an explicit layer:
 * providers contain only business logic, and this adapter handles HCP protocol.
 *
 * Example:
 * ```typescript
 * const server = createCapabilityServer({
 *   kind: "hook",
 *   target: "hook:magenta",
 *   description: "Hook capability",
 *   provider: new HookProvider(),
 *   operations: {
 *     discover: (p) => p.discover(),
 *     run: (p, req) => p.run(targetName(req.target), req.params),
 *   },
 * });
 * ```
 */
export function createCapabilityServer<TProvider = any>(
	options: CapabilityServerOptions<TProvider>,
): HcpServer {
	const { kind, target, description, provider, operations, metadata } = options;

	const describe: () => HcpServerDescription = options.describe
		? options.describe
		: () => ({
				target,
				kind,
				ops: Object.keys(operations),
				description,
				metadata,
		  });

	return {
		describe,
		call: async (request: HcpRequest): Promise<unknown> => {
			const op = request.op || "default";
			const handler = operations[op];
			if (!handler) {
				throw new Error(`Unknown operation: ${op} for ${kind} capability at ${target}`);
			}
			return handler(provider, request);
		},
		instance: <T = unknown>(_selector?: string): T | undefined => provider as unknown as T,
	};
}

/**
 * Extract the name portion from an HCP target address.
 * Handles both "kind:name" and "kind://name" formats.
 * Examples:
 *   "hook:pre-send" → "pre-send"
 *   "hook://pre-tool" → "pre-tool"
 *   "context://workspace" → "workspace"
 */
export function targetName(target: string): string {
	// Handle "kind://name" format
	if (target.includes("://")) {
		const protocolEnd = target.indexOf("://");
		return target.slice(protocolEnd + 3);
	}
	// Handle "kind:name" format
	const colonIndex = target.indexOf(":");
	return colonIndex >= 0 ? target.slice(colonIndex + 1) : target;
}
