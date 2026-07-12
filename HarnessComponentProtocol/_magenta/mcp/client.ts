/**
 * Minimal Model Context Protocol (MCP) client transports.
 *
 * This is a deliberately small, dependency-free implementation of the subset of
 * the MCP protocol the harness needs to expose an external MCP server's tools
 * through an owning Harness tool Module: the `initialize` handshake, `tools/list`
 * discovery, and `tools/call` dispatch.
 *
 * `McpStdioClient` speaks newline-delimited JSON-RPC 2.0 over a managed
 * process's stdin/stdout (the stdio transport every MCP server ships). The
 * streamable-HTTP transport lives in `./http-client.ts`; both satisfy the
 * transport-agnostic {@link McpClient} shape so `McpConnection` never cares
 * which one it holds. Request/response correlation is shared through
 * {@link JsonRpcPeer} in `./jsonrpc.ts`.
 *
 * We intentionally do NOT depend on `@modelcontextprotocol/sdk`: the harness
 * core keeps a minimal dependency surface, and these three verbs are all a
 * long-lived server connection requires. OAuth, sampling, roots, and pagination
 * remain out of scope; a future need adds a transport rather than pulling the
 * full SDK.
 */

import { JsonRpcPeer, type JsonRpcResponse } from "./jsonrpc.ts";

/** MCP protocol revision this client implements. */
const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * Transport-agnostic MCP client surface. `McpConnection` only ever touches
 * these five members, so any transport (stdio, streamable-HTTP, ...) that
 * satisfies this shape is a drop-in. Selection happens in `./transport.ts`.
 */
export type McpClient = {
	readonly isConnected: boolean;
	connect(): Promise<void>;
	listTools(): Promise<McpToolSchema[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
	close(): Promise<void>;
};

export type McpToolSchema = {
	name: string;
	description?: string;
	/** JSON Schema for the tool's arguments (MCP `inputSchema`). */
	inputSchema?: Record<string, unknown>;
};

export function validateMcpToolSchemas(value: unknown): McpToolSchema[] {
	if (!Array.isArray(value)) throw new Error("MCP tools/list result must contain a tools array");
	return value.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error(`MCP tools/list tool[${index}] must be an object`);
		}
		const tool = candidate as Record<string, unknown>;
		if (typeof tool.name !== "string" || tool.name.length === 0) {
			throw new Error(`MCP tools/list tool[${index}] must have a non-empty name`);
		}
		if (tool.description !== undefined && typeof tool.description !== "string") {
			throw new Error(`MCP tools/list tool[${index}] description must be a string`);
		}
		if (
			tool.inputSchema !== undefined &&
			(!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema))
		) {
			throw new Error(`MCP tools/list tool[${index}] inputSchema must be an object`);
		}
		return candidate as McpToolSchema;
	});
}

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
	/** Transport discriminant. Absent or "stdio" selects the stdio transport. */
	transport?: "stdio";
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

/** Host-supplied settings for the streamable-HTTP transport (`./http-client.ts`). */
export type McpHttpClientOptions = {
	transport: "http";
	/** Absolute MCP endpoint URL, e.g. `https://host/mcp`. */
	url: string;
	/** Static request headers (e.g. `Authorization: Bearer ...`). */
	headers?: Record<string, string>;
	signal?: AbortSignal;
	clientName?: string;
	clientVersion?: string;
	/** Per-request timeout in milliseconds. Default: 30000. */
	requestTimeoutMs?: number;
};

/** Discriminated union of every MCP transport's construction settings. */
export type McpClientOptions = McpStdioClientOptions | McpHttpClientOptions;

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
	private readonly peer: JsonRpcPeer;
	private initialized = false;
	private closed = false;
	private exitError?: Error;
	private stderrTail = "";
	private connectPromise?: Promise<void>;
	private processClosePromise?: Promise<void>;

	constructor(options: McpStdioClientOptions) {
		this.options = options;
		this.peer = new JsonRpcPeer({ requestTimeoutMs: options.requestTimeoutMs });
	}

	get isConnected(): boolean {
		return this.initialized && !this.closed;
	}

	/** Spawn the server process and complete the MCP initialize handshake. */
	async connect(): Promise<void> {
		if (this.initialized) return;
		if (this.closed) throw new Error("McpStdioClient has been closed and cannot reconnect");
		if (!this.connectPromise) {
			this.connectPromise = this.connectOnce().finally(() => {
				this.connectPromise = undefined;
			});
		}
		await this.connectPromise;
	}

	private async connectOnce(): Promise<void> {
		this.exitError = undefined;
		this.stderrTail = "";
		this.processClosePromise = undefined;

		const managedProcess = await this.options.spawnManaged(
			{
				command: this.options.command,
				args: this.options.args,
				cwd: this.options.cwd,
				env: this.options.env,
			},
			this.options.signal,
		);
		if (this.closed) {
			await this.closeManagedProcess(managedProcess);
			throw new Error("McpStdioClient was closed while connecting");
		}
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
			await this.closeManagedProcess(managedProcess);
			this.detachProcess();
			this.process = undefined;
			this.processClosePromise = undefined;
			this.exitError = undefined;
			throw error;
		}
	}

	/** Discover the tools the server exposes via `tools/list`. */
	async listTools(): Promise<McpToolSchema[]> {
		this.ensureConnected();
		const result = await this.request("tools/list", {});
		if (!result || typeof result !== "object" || Array.isArray(result) || !("tools" in result)) {
			throw new Error("MCP tools/list result must be an object with a tools array");
		}
		return validateMcpToolSchemas((result as { tools: unknown }).tools);
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
		const connecting = this.connectPromise;
		if (this.closed) {
			await connecting?.catch(() => undefined);
			return;
		}
		this.closed = true;
		this.initialized = false;
		this.failAll(new Error("MCP client closed"));
		await this.closeManagedProcess(this.process);
		await connecting?.catch(() => undefined);
		this.detachProcess();
		this.process = undefined;
		this.processClosePromise = undefined;
	}

	private closeManagedProcess(managedProcess: McpStdioManagedProcess | undefined): Promise<void> {
		if (!managedProcess) return Promise.resolve();
		this.processClosePromise ??= managedProcess.close();
		return this.processClosePromise;
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
		const { id, payload, promise } = this.peer.createRequest(method, params);
		void managedProcess.write(`${payload}\n`).catch((error: unknown) => {
			this.peer.failRequest(id, error instanceof Error ? error : new Error(String(error)));
		});
		return promise;
	}

	private notify(method: string, params: unknown): void {
		const managedProcess = this.process;
		if (!managedProcess) return;
		void managedProcess.write(`${this.peer.createNotification(method, params)}\n`).catch((error: unknown) => {
			this.peer.failAll(error instanceof Error ? error : new Error(String(error)));
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
		// client does not implement server->client calls, so the peer ignores them.
		this.peer.handleParsed(message);
	}

	private failAll(error: Error): void {
		this.peer.failAll(error);
	}

	private captureStderr(chunk: string): void {
		this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_192);
	}

	private handleExit(exit: McpStdioManagedProcessExit): void {
		if (this.closed) return;
		this.initialized = false;
		this.detachProcess();
		this.process = undefined;
		this.processClosePromise = undefined;
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
