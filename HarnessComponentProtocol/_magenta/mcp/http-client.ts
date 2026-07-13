/**
 * MCP client over the Streamable HTTP transport (MCP spec 2025-03-26).
 *
 * A single endpoint receives JSON-RPC 2.0 requests via HTTP POST. The server may
 * answer either with a plain `application/json` body (one JSON-RPC message) or a
 * `text/event-stream` (SSE) body carrying one or more JSON-RPC messages. Session
 * continuity is a `Mcp-Session-Id` header the server issues on `initialize` and
 * the client echoes on every subsequent request.
 *
 * This is a dependency-free implementation built on the global `fetch` and a
 * hand-written SSE frame parser. It intentionally supports only what the harness
 * needs — `initialize`, `tools/list`, `tools/call` — and mirrors the dispatch
 * logic of the official Rust SDK (`rmcp`) `post_message`: content-type routing,
 * session capture, `202/204` accepted-notification handling, and treating a
 * malformed `application/json` body as an accepted response.
 *
 * Out of scope (matching the stdio client): server-initiated requests, sampling,
 * roots, the standalone GET stream, resumability via `Last-Event-Id`, and OAuth.
 */

import {
	type McpHttpClientOptions,
	type McpToolCallResult,
	type McpToolSchema,
	validateMcpToolSchemas,
} from "./client.ts";
import { JsonRpcPeer, type JsonRpcResponse } from "./jsonrpc.ts";
import { parseSseFrames } from "./sse.ts";

/** MCP protocol revision this client advertises during initialization. */
const MCP_PROTOCOL_VERSION = "2025-03-26";
const HEADER_SESSION_ID = "mcp-session-id";
const EVENT_STREAM_MIME = "text/event-stream";
const JSON_MIME = "application/json";

/**
 * Header names the transport owns; user-supplied `headers` may not override them
 * (mirrors rmcp's reserved-header rule). Comparison is case-insensitive.
 */
const RESERVED_HEADERS = new Set(["accept", "content-type", HEADER_SESSION_ID]);

export class McpHttpClient {
	private readonly options: McpHttpClientOptions;
	private readonly peer: JsonRpcPeer;
	private sessionId?: string;
	private initialized = false;
	private closed = false;

	constructor(options: McpHttpClientOptions) {
		this.options = options;
		this.peer = new JsonRpcPeer({ requestTimeoutMs: options.requestTimeoutMs });
	}

	get isConnected(): boolean {
		return this.initialized && !this.closed;
	}

	async connect(): Promise<void> {
		if (this.initialized) return;
		if (this.closed) throw new Error("McpHttpClient has been closed and cannot reconnect");
		await this.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: {
				name: this.options.clientName ?? "magenta-harness-mcp",
				version: this.options.clientVersion ?? "0.1.0",
			},
		});
		// Per the MCP lifecycle, the client sends `notifications/initialized`
		// after a successful `initialize` response.
		await this.notify("notifications/initialized", {});
		this.initialized = true;
	}

	async listTools(): Promise<McpToolSchema[]> {
		this.ensureConnected();
		const result = await this.request("tools/list", {});
		if (!result || typeof result !== "object" || Array.isArray(result) || !("tools" in result)) {
			throw new Error("MCP tools/list result must be an object with a tools array");
		}
		return validateMcpToolSchemas((result as { tools: unknown }).tools);
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
		this.ensureConnected();
		const result = (await this.request("tools/call", {
			name,
			arguments: args ?? {},
		})) as McpToolCallResult | undefined;
		return result ?? { content: [] };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.initialized = false;
		this.peer.failAll(new Error("MCP HTTP client closed"));
		// Best-effort: tell the server to drop the session. Ignore all errors —
		// a server that does not support DELETE simply keeps its own timeout.
		if (this.sessionId) {
			try {
				await fetch(this.options.url, {
					method: "DELETE",
					headers: this.buildHeaders(),
					signal: this.options.signal,
				});
			} catch {
				// server may not support session deletion; nothing to do.
			}
		}
	}

	private ensureConnected(): void {
		if (!this.initialized || this.closed) {
			throw new Error("McpHttpClient is not connected; call connect() first");
		}
	}

	/**
	 * POST one JSON-RPC request and resolve with its `result`. The promise is
	 * returned synchronously (and thus awaited immediately by callers) while the
	 * HTTP exchange runs as a side-effect that feeds the peer; this mirrors the
	 * stdio client and avoids a window where a timeout could reject an
	 * as-yet-unawaited promise. Response routing follows the streamable-HTTP
	 * contract: capture any session id, treat `202/204` as an accepted
	 * notification, parse a JSON body directly, and pump an SSE body until the
	 * matching id settles.
	 */
	private request(method: string, params: unknown): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("McpHttpClient is closed"));
		const { id, payload, promise } = this.peer.createRequest(method, params);
		void this.dispatch(id, payload, method);
		return promise;
	}

	private async dispatch(id: number, payload: string, method: string): Promise<void> {
		try {
			const response = await fetch(this.options.url, {
				method: "POST",
				headers: this.buildHeaders(),
				body: payload,
				signal: this.options.signal,
			});
			this.captureSessionId(response);
			await this.consumeResponse(response, method);
		} catch (error) {
			this.peer.failRequest(id, error instanceof Error ? error : new Error(String(error)));
		}
	}

	/** POST a JSON-RPC notification. Notifications never await a response. */
	private async notify(method: string, params: unknown): Promise<void> {
		if (this.closed) return;
		const response = await fetch(this.options.url, {
			method: "POST",
			headers: this.buildHeaders(),
			body: this.peer.createNotification(method, params),
			signal: this.options.signal,
		});
		this.captureSessionId(response);
		// Drain any body so the connection can be reused; a notification carries
		// no id, so nothing is dispatched to the peer.
		if (response.body) await response.text().catch(() => undefined);
	}

	private async consumeResponse(response: Response, method: string): Promise<void> {
		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

		if (response.status === 202 || response.status === 204) {
			// Accepted with no JSON-RPC payload (server chose not to answer inline).
			return;
		}

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			// A non-2xx response may still carry a valid JSON-RPC error payload.
			if (contentType.startsWith(JSON_MIME) && body) {
				try {
					this.peer.handleParsed(JSON.parse(body) as JsonRpcResponse);
					return;
				} catch {
					// fall through to a generic transport error below
				}
			}
			throw new Error(`MCP HTTP ${method} failed: HTTP ${response.status}${body ? `: ${body.slice(0, 512)}` : ""}`);
		}

		if (contentType.startsWith(EVENT_STREAM_MIME)) {
			await this.pumpSse(response, method);
			return;
		}

		if (contentType.startsWith(JSON_MIME)) {
			const body = await response.text();
			try {
				this.peer.handleParsed(JSON.parse(body) as JsonRpcResponse);
			} catch {
				// A 200 with an unparsable body (e.g. an ack to a request that the
				// server treated as a notification) is treated as accepted.
			}
			return;
		}

		// Unknown content type: drain and treat as accepted rather than hang.
		await response.text().catch(() => undefined);
	}

	/**
	 * Read an SSE body incrementally, dispatching each JSON-RPC message to the
	 * peer. Stops once the peer has no more pending requests (the response we were
	 * waiting for arrived) or the stream ends.
	 */
	private async pumpSse(response: Response, method: string): Promise<void> {
		if (!response.body) throw new Error(`MCP HTTP ${method}: event-stream response had no body`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const { frames, remaining } = parseSseFrames(buffer);
				buffer = remaining;
				for (const frame of frames) {
					if (frame.data === undefined) continue;
					this.peer.handleMessage(frame.data);
				}
				// Once nothing is awaiting a response, the message we needed has
				// arrived; stop reading so the request can settle promptly.
				if (!this.peer.hasPending) break;
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			accept: `${EVENT_STREAM_MIME}, ${JSON_MIME}`,
			"content-type": JSON_MIME,
		};
		for (const [key, value] of Object.entries(this.options.headers ?? {})) {
			if (RESERVED_HEADERS.has(key.toLowerCase())) continue;
			headers[key] = value;
		}
		if (this.sessionId) headers[HEADER_SESSION_ID] = this.sessionId;
		return headers;
	}

	private captureSessionId(response: Response): void {
		const id = response.headers.get(HEADER_SESSION_ID);
		if (id) this.sessionId = id;
	}
}
