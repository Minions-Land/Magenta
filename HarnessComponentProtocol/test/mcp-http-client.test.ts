import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpHttpClient } from "../_magenta/mcp/http-client.ts";

/**
 * A configurable mock streamable-HTTP MCP server. Each test tunes how it answers
 * (`json` vs `sse`), whether it issues a session id, and can capture the headers
 * a client sent so assertions can inspect protocol behavior.
 */
type MockOptions = {
	mode?: "json" | "sse";
	sessionId?: string;
	toolsListResult?: unknown;
	onRequest?: (body: Record<string, unknown>, req: IncomingMessage) => void;
	/** When set, respond to this method with HTTP status + raw body. */
	failMethod?: { method: string; status: number; body: string; contentType?: string };
	/** Delay (ms) before answering — used to exercise client-side timeout. */
	delayMs?: number;
};

function rpcResult(method: string, params: Record<string, unknown>, opts: MockOptions): unknown {
	switch (method) {
		case "initialize":
			return { protocolVersion: "2025-03-26", capabilities: { tools: {} } };
		case "tools/list":
			return opts.toolsListResult ?? { tools: [{ name: "greet", inputSchema: { type: "object" } }] };
		case "tools/call":
			return { content: [{ type: "text", text: `hello ${(params.arguments as { name?: string })?.name ?? ""}` }] };
		default:
			return {};
	}
}

function startMockServer(opts: MockOptions): Promise<{ server: Server; url: string }> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "DELETE") {
			res.statusCode = 200;
			res.end();
			return;
		}
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const message = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, unknown> };
			opts.onRequest?.(message as Record<string, unknown>, req);

			// Notifications carry no id: acknowledge with 202 and no body.
			if (message.id === undefined) {
				res.statusCode = 202;
				res.end();
				return;
			}

			const respond = () => {
				if (opts.failMethod && opts.failMethod.method === message.method) {
					res.statusCode = opts.failMethod.status;
					res.setHeader("content-type", opts.failMethod.contentType ?? "application/json");
					if (opts.sessionId) res.setHeader("Mcp-Session-Id", opts.sessionId);
					res.end(opts.failMethod.body);
					return;
				}
				const result = rpcResult(message.method, message.params ?? {}, opts);
				const envelope = { jsonrpc: "2.0", id: message.id, result };
				if (message.method === "initialize" && opts.sessionId) {
					res.setHeader("Mcp-Session-Id", opts.sessionId);
				}
				if (opts.mode === "sse") {
					res.statusCode = 200;
					res.setHeader("content-type", "text/event-stream");
					res.write(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`);
					res.end();
				} else {
					res.statusCode = 200;
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify(envelope));
				}
			};
			if (opts.delayMs) setTimeout(respond, opts.delayMs);
			else respond();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
		});
	});
}

let active: Server | undefined;
afterEach(async () => {
	if (active) await new Promise<void>((resolve) => active?.close(() => resolve()));
	active = undefined;
});

describe("McpHttpClient (streamable-HTTP)", () => {
	it("connects, lists, and calls tools over JSON responses", async () => {
		const { server, url } = await startMockServer({ mode: "json" });
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		expect(client.isConnected).toBe(true);
		const tools = await client.listTools();
		expect(tools).toEqual([{ name: "greet", inputSchema: { type: "object" } }]);
		const result = await client.callTool("greet", { name: "world" });
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello world" });
		await client.close();
		expect(client.isConnected).toBe(false);
	});

	it("connects, lists, and calls tools over SSE responses", async () => {
		const { server, url } = await startMockServer({ mode: "sse" });
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		const tools = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["greet"]);
		const result = await client.callTool("greet", { name: "sse" });
		expect(result.content[0]).toMatchObject({ text: "hello sse" });
		await client.close();
	});

	it("captures the session id and echoes it on later requests", async () => {
		const seen: Array<string | undefined> = [];
		const { server, url } = await startMockServer({
			mode: "json",
			sessionId: "sess-123",
			onRequest: (_body, req) => seen.push(req.headers["mcp-session-id"] as string | undefined),
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		await client.listTools();
		// initialize + notifications/initialized + tools/list = 3 requests.
		// The initialize request carries no session; every request after the
		// server issued the id must echo it.
		expect(seen[0]).toBeUndefined();
		expect(seen.slice(1)).toEqual(["sess-123", "sess-123"]);
		await client.close();
	});

	it("sends the Accept header for both JSON and event-stream", async () => {
		let accept: string | undefined;
		const { server, url } = await startMockServer({
			mode: "json",
			onRequest: (_body, req) => {
				accept ??= req.headers.accept as string | undefined;
			},
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		expect(accept).toContain("text/event-stream");
		expect(accept).toContain("application/json");
		await client.close();
	});

	it("does not let user headers override reserved ones", async () => {
		const captured: Record<string, string | undefined> = {};
		const { server, url } = await startMockServer({
			mode: "json",
			onRequest: (_body, req) => {
				captured.accept = req.headers.accept as string;
				captured.custom = req.headers["x-team"] as string;
			},
		});
		active = server;
		const client = new McpHttpClient({
			transport: "http",
			url,
			headers: { Accept: "text/plain", "X-Team": "magenta" },
		});
		await client.connect();
		expect(captured.accept).toContain("application/json"); // reserved, not clobbered
		expect(captured.custom).toBe("magenta"); // custom header passes through
		await client.close();
	});

	it("surfaces a JSON-RPC error payload returned with a non-2xx status", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			failMethod: {
				method: "tools/list",
				status: 400,
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "bad request" } }),
			},
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		await expect(client.listTools()).rejects.toThrow(/-32000.*bad request/);
		await client.close();
	});

	it("times out when the server does not answer in time", async () => {
		const { server, url } = await startMockServer({ mode: "json", delayMs: 200 });
		active = server;
		const client = new McpHttpClient({ transport: "http", url, requestTimeoutMs: 40 });
		await expect(client.connect()).rejects.toThrow(/timed out after 40ms/);
		await client.close();
	});

	it("rejects calls before connect and after close", async () => {
		const { server, url } = await startMockServer({ mode: "json" });
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await expect(client.listTools()).rejects.toThrow(/not connected/);
		await client.connect();
		await client.close();
		await expect(client.listTools()).rejects.toThrow(/not connected/);
	});
});
