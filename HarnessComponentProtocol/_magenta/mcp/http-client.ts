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
 * session capture, accepted-notification handling, and strict JSON-RPC response
 * validation for request POSTs.
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
const HEADER_PROTOCOL_VERSION = "mcp-protocol-version";
const EVENT_STREAM_MIME = "text/event-stream";
const JSON_MIME = "application/json";
const REDACTED = "[REDACTED]";
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Query/header keys whose values are credentials or session identifiers. */
const SECRET_KEY_PATTERN =
	/^(?:auth(?:orization)?|auth[-_]?token|api[-_]?key|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|private[-_]?key|password|passwd|credential|credentials|session(?:[-_]?id)?|mcp[-_]?session[-_]?id|sig(?:nature)?|key)$/iu;

function isSecretKey(value: string): boolean {
	try {
		return SECRET_KEY_PATTERN.test(decodeURIComponent(value.replace(/\+/g, " ")));
	} catch {
		return SECRET_KEY_PATTERN.test(value);
	}
}

function addDecodedSecret(secrets: Set<string>, value: string): void {
	if (!value || value === REDACTED) return;
	secrets.add(value);
	try {
		const decoded = decodeURIComponent(value);
		if (decoded && decoded !== value) secrets.add(decoded);
	} catch {
		// Keep the raw value when it is not URI encoded.
	}
}

/**
 * Sanitizes every error string produced by the HTTP transport. The remote MCP
 * endpoint is allowed to echo request headers, URL credentials, or session
 * identifiers in an error body; none of those values should reach a TUI or
 * persisted diagnostic. This is intentionally transport-local so stdio MCP
 * keeps its historical error semantics.
 */
class McpHttpErrorRedactor {
	private readonly secrets = new Set<string>();

	constructor(url: string, headers: Record<string, string> | undefined) {
		this.addUrlSecrets(url);
		for (const [key, value] of Object.entries(headers ?? {})) {
			addDecodedSecret(this.secrets, value);
			// Servers and proxies sometimes echo only the credential portion of an
			// Authorization header (without the `Bearer`/`Basic` scheme). Track both
			// forms so a stripped token cannot escape exact-value redaction.
			if (/^(?:proxy-)?authorization$/iu.test(key)) {
				const credential = value.match(/^\s*[A-Za-z][A-Za-z\d._~-]*\s+(.+?)\s*$/u)?.[1];
				if (credential) addDecodedSecret(this.secrets, credential);
			}
		}
	}

	addSessionId(value: string): void {
		addDecodedSecret(this.secrets, value);
	}

	redact(value: string): string {
		let result = value;
		// Exact values come first and are sorted longest-first so a short token that
		// is a substring of a longer header cannot leave a partial credential behind.
		for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
			if (secret.length > 0) result = result.split(secret).join(REDACTED);
		}

		// Redact URL userinfo even when it was not parseable at construction time.
		result = result.replace(/([a-z][a-z\d+.-]*:\/\/)[^/\s@]+@/giu, `$1${REDACTED}@`);
		// Redact common secret query parameters in arbitrary echoed URLs/text.
		result = result.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/gu, (match, separator, key, _queryValue) =>
			isSecretKey(String(key)) ? `${separator}${key}=${REDACTED}` : match,
		);
		// Redact bearer tokens and key/value forms that are not valid JSON.
		result = result.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, `$1${REDACTED}`);
		result = result.replace(
			/\b(?:authorization|auth[-_]?token|api[-_]?key|x[-_]?api[-_]?key|token|secret|client[-_]?secret|private[-_]?key|password|session(?:[-_]?id)?|key)\b\s*[:=]\s*([^\s,;}&#]+)/giu,
			(_match, _keyValue) => `${REDACTED}`,
		);
		// Finally cover quoted and unquoted JSON-ish key/value pairs. Keep the key
		// and separator for useful diagnostics while replacing only the value.
		result = result.replace(
			/(\\?["']?)([A-Za-z][\w-]*)(\\?["']?)(\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s&#]+)/giu,
			(match, open, key, close, separator, _value) =>
				isSecretKey(String(key)) ? `${open}${key}${close}${separator}${JSON.stringify(REDACTED)}` : match,
		);
		return result;
	}

	private addUrlSecrets(rawUrl: string): void {
		try {
			const parsed = new URL(rawUrl);
			addDecodedSecret(this.secrets, parsed.username);
			addDecodedSecret(this.secrets, parsed.password);
			for (const [key, value] of parsed.searchParams) {
				if (isSecretKey(key)) addDecodedSecret(this.secrets, value);
			}
		} catch {
			// A malformed URL will fail at fetch time; generic redaction still applies.
		}
	}
}

/**
 * Header names the transport owns; user-supplied `headers` may not override them
 * (mirrors rmcp's reserved-header rule). Comparison is case-insensitive.
 */
const RESERVED_HEADERS = new Set(["accept", "content-type", HEADER_SESSION_ID, HEADER_PROTOCOL_VERSION]);

class McpHttpSessionExpiredError extends Error {
	readonly expiredSessionId: string;

	constructor(expiredSessionId: string) {
		super("MCP HTTP session expired; reinitialization is required");
		this.name = "McpHttpSessionExpiredError";
		this.expiredSessionId = expiredSessionId;
	}
}

type McpHttpActiveRequest = {
	controller: AbortController;
	detachExternalSignal: () => void;
};

async function readResponseTextLimited(response: Response, context: string): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let receivedBytes = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > MAX_HTTP_RESPONSE_BYTES) {
				throw new Error(`MCP HTTP ${context} response exceeded the ${MAX_HTTP_RESPONSE_BYTES}-byte safety limit`);
			}
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

export class McpHttpClient {
	private readonly options: McpHttpClientOptions;
	private readonly redactor: McpHttpErrorRedactor;
	private readonly peer: JsonRpcPeer;
	private readonly requestTimeoutMs: number;
	private readonly activeRequests = new Map<number, McpHttpActiveRequest>();
	private readonly activeOperations = new Set<AbortController>();
	private sessionId?: string;
	private protocolVersion?: string;
	private initialized = false;
	private closed = false;
	private connectPromise?: Promise<void>;

	constructor(options: McpHttpClientOptions) {
		this.options = options;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.redactor = new McpHttpErrorRedactor(options.url, options.headers);
		this.peer = new JsonRpcPeer({
			requestTimeoutMs: this.requestTimeoutMs,
			sanitizeErrorMessage: (message) => this.redactor.redact(message),
		});
	}

	get isConnected(): boolean {
		return this.initialized && !this.closed;
	}

	async connect(): Promise<void> {
		if (this.initialized) return;
		if (this.closed) throw new Error("McpHttpClient has been closed and cannot reconnect");
		if (!this.connectPromise) {
			this.connectPromise = this.connectOnce().finally(() => {
				this.connectPromise = undefined;
			});
		}
		await this.connectPromise;
	}

	private async connectOnce(): Promise<void> {
		this.initialized = false;
		this.sessionId = undefined;
		this.protocolVersion = undefined;
		try {
			const result = (await this.request("initialize", {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: {
					name: this.options.clientName ?? "magenta-harness-mcp",
					version: this.options.clientVersion ?? "0.1.0",
				},
			})) as { protocolVersion?: unknown } | undefined;
			if (result?.protocolVersion !== MCP_PROTOCOL_VERSION) {
				throw this.safeError(
					new Error(
						`MCP server negotiated unsupported protocol version ${JSON.stringify(result?.protocolVersion)}; expected ${MCP_PROTOCOL_VERSION}`,
					),
				);
			}
			if (this.closed) throw new Error("McpHttpClient was closed while connecting");
			this.protocolVersion = MCP_PROTOCOL_VERSION;
			// Per the MCP lifecycle, the client sends `notifications/initialized`
			// after a successful `initialize` response.
			await this.notify("notifications/initialized", {});
			if (this.closed) throw new Error("McpHttpClient was closed while connecting");
			this.initialized = true;
		} catch (error) {
			this.initialized = false;
			this.sessionId = undefined;
			this.protocolVersion = undefined;
			throw this.safeError(error);
		}
	}

	async listTools(): Promise<McpToolSchema[]> {
		this.ensureConnected();
		const result = await this.requestWithSessionRecovery("tools/list", {});
		if (!result || typeof result !== "object" || Array.isArray(result) || !("tools" in result)) {
			throw new Error("MCP tools/list result must be an object with a tools array");
		}
		return validateMcpToolSchemas((result as { tools: unknown }).tools);
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
		this.ensureConnected();
		const result = (await this.requestWithSessionRecovery(
			"tools/call",
			{
				name,
				arguments: args ?? {},
			},
			{ retryAfterRecovery: false },
		)) as McpToolCallResult | undefined;
		return result ?? { content: [] };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		const connecting = this.connectPromise;
		this.closed = true;
		this.initialized = false;
		this.peer.failAll(new Error("MCP HTTP client closed"));
		for (const { controller } of this.activeRequests.values()) {
			controller.abort(new Error("MCP HTTP client closed"));
		}
		for (const controller of this.activeOperations) {
			controller.abort(new Error("MCP HTTP client closed"));
		}
		await connecting?.catch(() => undefined);
		// Best-effort: tell the server to drop the session. Ignore all errors —
		// a server that does not support DELETE simply keeps its own timeout.
		if (this.sessionId) {
			try {
				await this.runWithTimeout("session DELETE", async (signal) => {
					const response = await fetch(this.options.url, {
						method: "DELETE",
						headers: this.buildHeaders(),
						signal,
						redirect: "manual",
					});
					await response.body?.cancel().catch(() => undefined);
				});
			} catch {
				// server may not support session deletion; nothing to do.
			}
		}
		this.sessionId = undefined;
		this.protocolVersion = undefined;
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
	 * contract: capture the session id established by successful initialization,
	 * parse a JSON body directly, and pump an SSE body until the matching id
	 * settles. A request POST must carry a JSON-RPC response; `202/204` are only
	 * accepted by the separate notification path.
	 */
	private request(method: string, params: unknown): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("McpHttpClient is closed"));
		const active = this.createActiveRequest();
		const { id, payload, promise } = this.peer.createRequest(method, params, {
			onTimeout: () => active.controller.abort(new Error(`MCP HTTP ${method} timed out`)),
		});
		this.activeRequests.set(id, active);
		void this.dispatch(id, payload, method, active);
		return promise;
	}

	private async dispatch(id: number, payload: string, method: string, active: McpHttpActiveRequest): Promise<void> {
		const requestSessionId = this.sessionId;
		try {
			const response = await fetch(this.options.url, {
				method: "POST",
				headers: this.buildHeaders(),
				body: payload,
				signal: active.controller.signal,
				redirect: "manual",
			});
			await this.consumeResponse(response, method, id, requestSessionId);
		} catch (error) {
			this.peer.failRequest(id, this.safeError(error));
		} finally {
			active.detachExternalSignal();
			if (this.activeRequests.get(id) === active) this.activeRequests.delete(id);
		}
	}

	/** POST a JSON-RPC notification and require an accepted HTTP response. */
	private async notify(method: string, params: unknown): Promise<void> {
		if (this.closed) return;
		await this.runWithTimeout(method, async (signal) => {
			const response = await fetch(this.options.url, {
				method: "POST",
				headers: this.buildHeaders(),
				body: this.peer.createNotification(method, params),
				signal,
				redirect: "manual",
			});
			const body = await readResponseTextLimited(response, method);
			if (!response.ok) throw this.responseError(method, response.status, body);
		});
	}

	private async consumeResponse(
		response: Response,
		method: string,
		id: number,
		requestSessionId: string | undefined,
	): Promise<void> {
		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

		if (response.status === 202 || response.status === 204) {
			throw new Error(`MCP HTTP ${method} returned HTTP ${response.status} without a JSON-RPC response`);
		}

		if (response.status === 404 && requestSessionId) {
			await response.body?.cancel().catch(() => undefined);
			throw new McpHttpSessionExpiredError(requestSessionId);
		}
		// The MCP session id is established by a successful initialize response.
		// Never let a late response from an older session overwrite a newer one
		// created by concurrent recovery.
		if (response.ok && method === "initialize") this.captureSessionId(response);

		if (!response.ok) {
			const body = await readResponseTextLimited(response, method);
			// A non-2xx response may still carry the matching JSON-RPC error
			// payload. A success result must never turn an HTTP failure into success,
			// and a response for another concurrent request must not settle it here.
			if (contentType.startsWith(JSON_MIME) && body) {
				try {
					const parsed = JSON.parse(body) as JsonRpcResponse;
					if (parsed.id === id && parsed.error && this.peer.handleParsed(parsed)) return;
				} catch {
					// fall through to a generic transport error below
				}
			}
			throw this.responseError(method, response.status, body);
		}

		if (contentType.startsWith(EVENT_STREAM_MIME)) {
			await this.pumpSse(response, method, id);
			return;
		}

		if (contentType.startsWith(JSON_MIME)) {
			const body = await readResponseTextLimited(response, method);
			let parsed: JsonRpcResponse;
			try {
				parsed = JSON.parse(body) as JsonRpcResponse;
			} catch {
				throw new Error(`MCP HTTP ${method} returned invalid JSON`);
			}
			if (parsed.id !== id) {
				throw new Error(`MCP HTTP ${method} returned a JSON-RPC response that did not match request id ${id}`);
			}
			if (!this.peer.handleParsed(parsed)) {
				throw new Error(`MCP HTTP ${method} returned an invalid JSON-RPC response for request id ${id}`);
			}
			return;
		}

		const body = await readResponseTextLimited(response, method);
		const safeBody = this.redactor.redact(body).slice(0, 512);
		throw new Error(
			`MCP HTTP ${method} returned unsupported content type ${JSON.stringify(contentType || "(missing)")}${
				safeBody ? `: ${safeBody}` : ""
			}`,
		);
	}

	/**
	 * Read an SSE body incrementally, dispatching each JSON-RPC message to the
	 * peer. Stops once the peer has no more pending requests (the response we were
	 * waiting for arrived) or the stream ends.
	 */
	private async pumpSse(response: Response, method: string, id: number): Promise<void> {
		if (!response.body) throw new Error(`MCP HTTP ${method}: event-stream response had no body`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let matched = false;
		let receivedBytes = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				receivedBytes += value.byteLength;
				if (receivedBytes > MAX_HTTP_RESPONSE_BYTES) {
					throw new Error(
						`MCP HTTP ${method} event stream exceeded the ${MAX_HTTP_RESPONSE_BYTES}-byte safety limit`,
					);
				}
				buffer += decoder.decode(value, { stream: true });
				const { frames, remaining } = parseSseFrames(buffer);
				buffer = remaining;
				for (const frame of frames) {
					if (frame.data === undefined) continue;
					let parsed: JsonRpcResponse;
					try {
						parsed = JSON.parse(frame.data) as JsonRpcResponse;
					} catch {
						continue;
					}
					if (parsed.id !== id) continue;
					if (!this.peer.handleParsed(parsed)) {
						throw new Error(`MCP HTTP ${method} returned an invalid JSON-RPC SSE response for request id ${id}`);
					}
					matched = true;
					break;
				}
				if (matched) break;
			}
			if (!matched && this.peer.hasPendingRequest(id)) {
				throw new Error(`MCP HTTP ${method} event stream ended without a response for request id ${id}`);
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
		if (this.protocolVersion) headers[HEADER_PROTOCOL_VERSION] = this.protocolVersion;
		return headers;
	}

	private captureSessionId(response: Response): void {
		const id = response.headers.get(HEADER_SESSION_ID);
		if (id) {
			this.redactor.addSessionId(id);
			this.sessionId = id;
		}
	}

	private async requestWithSessionRecovery(
		method: string,
		params: unknown,
		options: { retryAfterRecovery?: boolean } = {},
	): Promise<unknown> {
		try {
			return await this.request(method, params);
		} catch (error) {
			if (!(error instanceof McpHttpSessionExpiredError) || this.closed) throw error;
			await this.recoverExpiredSession(error.expiredSessionId);
			if (options.retryAfterRecovery === false) {
				throw new Error(
					`MCP HTTP ${method} was not retried after session recovery because the operation may have side effects`,
				);
			}
			// Retry once with the new session. A second 404 is surfaced so a broken
			// endpoint cannot recurse forever.
			return this.request(method, params);
		}
	}

	private async recoverExpiredSession(expiredSessionId: string): Promise<void> {
		// Another concurrent request may already have replaced this exact session.
		// In that case connect() either awaits its in-flight handshake or observes
		// the newly initialized client without tearing the new session back down.
		if (this.sessionId === expiredSessionId) {
			this.initialized = false;
			this.sessionId = undefined;
			this.protocolVersion = undefined;
		}
		await this.connect();
	}

	private createActiveRequest(): McpHttpActiveRequest {
		const controller = new AbortController();
		const externalSignal = this.options.signal;
		if (!externalSignal) return { controller, detachExternalSignal: () => undefined };
		const abort = () => controller.abort(externalSignal.reason);
		if (externalSignal.aborted) {
			abort();
			return { controller, detachExternalSignal: () => undefined };
		}
		externalSignal.addEventListener("abort", abort, { once: true });
		return {
			controller,
			detachExternalSignal: () => externalSignal.removeEventListener("abort", abort),
		};
	}

	private async runWithTimeout<T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const active = this.createActiveRequest();
		this.activeOperations.add(active.controller);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			active.controller.abort(new Error(`MCP HTTP ${operation} timed out`));
		}, this.requestTimeoutMs);
		try {
			return await run(active.controller.signal);
		} catch (error) {
			if (timedOut) throw new Error(`MCP HTTP ${operation} timed out after ${this.requestTimeoutMs}ms`);
			throw this.safeError(error);
		} finally {
			clearTimeout(timer);
			active.detachExternalSignal();
			this.activeOperations.delete(active.controller);
		}
	}

	private responseError(method: string, status: number, body: string): Error {
		const safeBody = this.redactor.redact(body).slice(0, 512);
		return new Error(`MCP HTTP ${method} failed: HTTP ${status}${safeBody ? `: ${safeBody}` : ""}`);
	}

	private safeError(error: unknown): Error {
		// Session-expiry errors are consumed internally by request recovery. Their
		// public message intentionally contains neither the URL nor the session id.
		if (error instanceof McpHttpSessionExpiredError) return error;
		const original = error instanceof Error ? error : new Error(String(error));
		const message = this.redactor.redact(original.message);
		const safe = new Error(message);
		safe.name = original.name;
		return safe;
	}
}
