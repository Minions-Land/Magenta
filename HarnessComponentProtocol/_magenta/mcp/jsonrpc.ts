/**
 * Transport-agnostic JSON-RPC 2.0 request/response correlation for MCP clients.
 *
 * Both the stdio and streamable-HTTP MCP transports speak the same JSON-RPC 2.0
 * envelope; only the byte plumbing differs (a child process's stdin/stdout vs.
 * HTTP request/response bodies). This peer owns everything that is common:
 * allocating request ids, tracking in-flight requests, per-request timeouts,
 * matching incoming responses back to their promise, and failing all pending
 * requests when the connection drops. A transport calls {@link createRequest}
 * to obtain the wire payload plus a promise, ships the payload however it likes,
 * and feeds every received message string back through {@link handleMessage}.
 *
 * The peer never touches the network or a process; it is pure correlation logic
 * so it can be unit-tested in isolation and shared without duplication.
 */

/** JSON-RPC 2.0 protocol version advertised on every envelope. */
export const JSONRPC_VERSION = "2.0";

export type JsonRpcResponse = {
	jsonrpc?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
	method?: string;
};

type PendingRequest = {
	method: string;
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export type JsonRpcPeerOptions = {
	/** Per-request timeout in milliseconds. Default: 30000. */
	requestTimeoutMs?: number;
};

/**
 * A request created by {@link JsonRpcPeer.createRequest}: the numeric id, the
 * serialized JSON-RPC payload (no trailing newline — a transport adds framing),
 * and the promise that resolves with the response `result` or rejects on error,
 * timeout, or connection failure.
 */
export type JsonRpcOutgoing = {
	id: number;
	payload: string;
	promise: Promise<unknown>;
};

export class JsonRpcPeer {
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly requestTimeoutMs: number;

	constructor(options: JsonRpcPeerOptions = {}) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
	}

	/** Whether any request is still awaiting a response. */
	get hasPending(): boolean {
		return this.pending.size > 0;
	}

	/**
	 * Allocate an id, register a pending entry with a timeout, and return the
	 * serialized request payload plus a promise. The caller ships `payload` over
	 * its transport; a late/missing response rejects via the timeout.
	 */
	createRequest(method: string, params: unknown): JsonRpcOutgoing {
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params });
		const promise = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request "${method}" timed out after ${this.requestTimeoutMs}ms`));
			}, this.requestTimeoutMs);
			this.pending.set(id, { method, resolve, reject, timer });
		});
		return { id, payload, promise };
	}

	/** Serialize a JSON-RPC notification (no id, never awaits a response). */
	createNotification(method: string, params: unknown): string {
		return JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params });
	}

	/**
	 * Fail a specific in-flight request (e.g. a transport-level write error for
	 * its payload). No-op if the id already settled.
	 */
	failRequest(id: number, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	/**
	 * Match an incoming message string to a pending request and settle it.
	 * Non-JSON text, server-initiated requests/notifications (which carry a
	 * `method` and no numeric id we issued), and unmatched ids are ignored — a
	 * minimal client does not implement server->client calls.
	 */
	handleMessage(raw: string): void {
		const trimmed = raw.trim();
		if (trimmed === "") return;
		let message: JsonRpcResponse;
		try {
			message = JSON.parse(trimmed) as JsonRpcResponse;
		} catch {
			return;
		}
		this.handleParsed(message);
	}

	/** Match an already-parsed JSON-RPC message to a pending request. */
	handleParsed(message: JsonRpcResponse): void {
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) {
			const detail = message.error.message ?? "unknown error";
			pending.reject(new Error(`MCP error ${message.error.code ?? ""}: ${detail}`.trim()));
			return;
		}
		pending.resolve(message.result);
	}

	/** Reject every in-flight request; used when the connection closes or dies. */
	failAll(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
