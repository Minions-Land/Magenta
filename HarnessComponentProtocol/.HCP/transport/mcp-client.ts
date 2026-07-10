/**
 * Minimal Model Context Protocol (MCP) client over a stdio transport.
 *
 * This is a deliberately small, dependency-free implementation of the subset of
 * the MCP protocol the harness needs to attract an external MCP server's tools
 * into the HCP tool address space: the `initialize` handshake, `tools/list`
 * discovery, and `tools/call` dispatch. It speaks newline-delimited JSON-RPC 2.0
 * over the managed process's stdin/stdout, matching the stdio transport every MCP
 * server ships.
 *
 * We intentionally do NOT depend on `@modelcontextprotocol/sdk`: the harness core
 * keeps a minimal dependency surface (pi-agent-core + pi-ai only), and these
 * three verbs are all a long-lived stdio server connection requires. SSE / HTTP
 * transports, OAuth, sampling, roots, and pagination are out of scope here; if a
 * future server needs them, add a transport rather than pulling the full SDK.
 */

/** JSON-RPC 2.0 protocol version advertised during initialization. */
const JSONRPC_VERSION = "2.0";
/** MCP protocol revision this client implements. */
const MCP_PROTOCOL_VERSION = "2024-11-05";

export type McpToolSchema = {
	name: string;
	description?: string;
	/** JSON Schema for the tool's arguments (MCP `inputSchema`). */
	inputSchema?: Record<string, unknown>;
};

export type McpToolContent = {
	type: string;
	text?: string;
	[key: string]: unknown;
};

export type McpToolCallResult = {
	content: McpToolContent[];
	isError?: boolean;
	[key: string]: unknown;
};

export type McpStdioManagedProcessExit = {
	status: number | null;
	signal: string | null;
	error?: Error;
};

export type McpStdioManagedProcess = {
	write(data: string): Promise<void>;
	onStdoutLine(listener: (line: string) => void): () => void;
	onStderr(listener: (chunk: string) => void): () => void;
	readonly exit: Promise<McpStdioManagedProcessExit>;
	close(): Promise<void>;
};

export type McpStdioManagedProcessInput = {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
};

export type McpStdioManagedSpawner = (
	input: McpStdioManagedProcessInput,
	signal?: AbortSignal,
) => Promise<McpStdioManagedProcess>;

export type McpStdioClientOptions = {
	command: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawnManaged: McpStdioManagedSpawner;
	signal?: AbortSignal;
	/** Client name reported to the server during `initialize`. */
	clientName?: string;
	clientVersion?: string;
	/** Per-request timeout in milliseconds. Default: 30000. */
	requestTimeoutMs?: number;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type JsonRpcResponse = {
	jsonrpc?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
	method?: string;
};

/**
 * A long-lived connection to a single MCP server process. Spawn once, run the
 * `initialize` handshake, then reuse the connection for many `listTools` /
 * `callTool` requests until {@link close} shuts the process down.
 */
export class McpStdioClient {
	private readonly options: McpStdioClientOptions;
	private process?: McpStdioManagedProcess;
	private removeStdoutListener?: () => void;
	private removeStderrListener?: () => void;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private initialized = false;
	private closed = false;
	private exitError?: Error;
	private stderrTail = "";

	constructor(options: McpStdioClientOptions) {
		this.options = options;
	}

	get isConnected(): boolean {
		return this.initialized && !this.closed;
	}

	/** Spawn the server process and complete the MCP initialize handshake. */
	async connect(): Promise<void> {
		if (this.initialized) return;
		if (this.closed) throw new Error("McpStdioClient has been closed and cannot reconnect");
		this.exitError = undefined;
		this.stderrTail = "";

		const managedProcess = await this.options.spawnManaged(
			{
				command: this.options.command,
				args: this.options.args,
				cwd: this.options.cwd,
				env: this.options.env,
			},
			this.options.signal,
		);
		this.process = managedProcess;
		this.removeStdoutListener = managedProcess.onStdoutLine((line) => this.handleLine(line));
		this.removeStderrListener = managedProcess.onStderr((chunk) => this.captureStderr(chunk));
		void managedProcess.exit.then((exit) => this.handleExit(exit));

		try {
			const result = (await this.request("initialize", {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: {
					name: this.options.clientName ?? "magenta-harness-mcp",
					version: this.options.clientVersion ?? "0.1.0",
				},
			})) as { protocolVersion?: string } | undefined;

			// Per the MCP lifecycle, the client sends `notifications/initialized`
			// after a successful `initialize` response.
			this.notify("notifications/initialized", {});
			this.initialized = true;
			void result;
		} catch (error) {
			await managedProcess.close();
			this.detachProcess();
			this.process = undefined;
			this.exitError = undefined;
			throw error;
		}
	}

	/** Discover the tools the server exposes via `tools/list`. */
	async listTools(): Promise<McpToolSchema[]> {
		this.ensureConnected();
		const result = (await this.request("tools/list", {})) as { tools?: McpToolSchema[] } | undefined;
		return result?.tools ?? [];
	}

	/** Invoke a remote tool via `tools/call`. */
	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
		this.ensureConnected();
		const result = (await this.request("tools/call", {
			name,
			arguments: args ?? {},
		})) as McpToolCallResult | undefined;
		return result ?? { content: [] };
	}

	/** Terminate the server process and reject any in-flight requests. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.initialized = false;
		this.failAll(new Error("MCP client closed"));
		await this.process?.close();
		this.detachProcess();
		this.process = undefined;
	}

	private ensureConnected(): void {
		if (!this.initialized || this.closed) {
			throw new Error("McpStdioClient is not connected; call connect() first");
		}
	}

	private request(method: string, params: unknown): Promise<unknown> {
		if (this.exitError) return Promise.reject(this.exitError);
		const managedProcess = this.process;
		if (!managedProcess) {
			return Promise.reject(new Error("MCP server process is not writable"));
		}
		const id = this.nextId++;
		const payload = `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params })}\n`;
		const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			void managedProcess.write(payload).catch((error: unknown) => {
				if (this.pending.delete(id)) {
					clearTimeout(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});
	}

	private notify(method: string, params: unknown): void {
		const managedProcess = this.process;
		if (!managedProcess) return;
		void managedProcess
			.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params })}\n`)
			.catch((error: unknown) => {
				this.failAll(error instanceof Error ? error : new Error(String(error)));
			});
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let message: JsonRpcResponse;
		try {
			message = JSON.parse(trimmed) as JsonRpcResponse;
		} catch {
			// Non-JSON output on stdout is not part of the protocol; ignore it.
			return;
		}
		// Server-initiated requests/notifications carry a `method`; this minimal
		// client does not implement server->client calls, so we ignore them.
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

	private failAll(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private captureStderr(chunk: string): void {
		this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_192);
	}

	private handleExit(exit: McpStdioManagedProcessExit): void {
		if (this.closed) return;
		this.initialized = false;
		const stderr = this.stderrTail.trim();
		const suffix = stderr === "" ? "" : `\nMCP stderr:\n${stderr}`;
		const reason =
			exit.error ??
			new Error(
				`MCP server process exited (code=${exit.status ?? "null"}, signal=${exit.signal ?? "null"})${suffix}`,
			);
		this.exitError = reason;
		this.failAll(reason);
	}

	private detachProcess(): void {
		this.removeStdoutListener?.();
		this.removeStderrListener?.();
		this.removeStdoutListener = undefined;
		this.removeStderrListener = undefined;
	}
}
