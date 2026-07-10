/**
 * HCP server protocol data types (spec §2).
 *
 * 按照规范§2：全仓只使用 class 与 type。此文件只包含协议数据类型
 * （HcpServerRequest 等），不包含角色抽象。HcpServer 是裸 class，在各
 * <module>/HcpServer.ts 中定义。
 *
 * HCP is the management / assembly layer, NOT the agent loop's hot path
 * (see spec §1/§5). The loop calls `tool.execute()` directly, in-process; it
 * never wraps a tool call into an HCP message. HCP exists purely to discover,
 * configure, and manage components during assembly. Dispatch here is in-process
 * only — there is no transport, no serialization boundary.
 */

/**
 * Address prefix under which capability slots register. A capability slot named
 * `compaction` is reachable at `capability:compaction`; a named slot such as
 * `runtime:process` is reachable at `capability:runtime:process`. The
 * `HcpClient.resolveCapability` method builds this address from the slot name so
 * consumers never spell out the convention (or a source).
 *
 * Naming: HcpClientcapabilityprefix follows the entity tree rule — no
 * HcpClientCapability entity exists, so 'capability' and 'prefix' stay lowercase.
 */
export const HcpClientcapabilityprefix = "capability";

/**
 * Ambient context threaded through an HCP call (assembly-time concerns such as
 * the working directory or a correlation id). Intentionally open-ended.
 */
export type HcpServerContext = {
	/** Working directory the call should be resolved against, if relevant. */
	cwd?: string;
	/** Optional correlation id for tracing an assembly operation. */
	requestId?: string;
	[key: string]: unknown;
};

/**
 * A single management call. `target` is a URI-like address (for example
 * `"tool:read"` or `"native:tool/read"`); the `HcpClient` resolves it by
 * prefix to a registered HcpServer (裸 class).
 */
export type HcpServerRequest = {
	/** URI-like target address. The portion before the first `:` is the prefix. */
	target: string;
	/** Operation to invoke on the target (for example `"describe"` or `"call"`). */
	op: string;
	/** Operation input payload. */
	input?: unknown;
	/** Ambient assembly context. */
	context?: HcpServerContext;
};

/**
 * The result of handling an HcpServerRequest. Today HCP dispatch is in-process
 * with no serialization boundary (spec §1/§5), so a response is simply the
 * operation's return value. This alias names the request/response pair now so
 * the vocabulary is stable; when §3's protocol envelope lands, this becomes a
 * structured result type without renaming call sites.
 */
export type HcpServerResponse<T = unknown> = T;

/**
 * Self-description returned by HcpServer.describe().
 * 这是协议数据类型，不是角色接口。
 */
export type HcpServerDescription = {
	/** The target address this endpoint answers on. */
	target: string;
	/** Component kind (for example `"tool"`). */
	kind: string;
	/** Operations this target supports. */
	ops: string[];
	/** Optional human-readable summary. */
	description?: string;
	/** Optional component metadata for selectors and management UIs. */
	metadata?: Record<string, unknown>;
};
