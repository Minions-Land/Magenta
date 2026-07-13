/**
 * Transport selection for MCP clients.
 *
 * `McpConnection` (in `./tool.ts`) is transport-agnostic: it holds an
 * {@link McpClient} and drives its lease/idle-close lifecycle without knowing
 * whether the bytes travel over a child process or HTTP. This factory is the one
 * place that maps host-supplied {@link McpClientOptions} to a concrete client,
 * keyed on the `transport` discriminant. Absent or `"stdio"` selects the
 * process transport; `"http"` selects streamable-HTTP.
 */

import { type McpClient, type McpClientOptions, McpStdioClient } from "./client.ts";
import { McpHttpClient } from "./http-client.ts";

export function createMcpClient(options: McpClientOptions): McpClient {
	if (options.transport === "http") return new McpHttpClient(options);
	return new McpStdioClient(options);
}
