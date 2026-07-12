import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHttpClient } from "../_magenta/mcp/http-client.ts";

/**
 * A configurable mock streamable-HTTP MCP server. Each test tunes how it answers
 * (`json` vs `sse`), whether it issues a session id, and can capture the headers
 * a client sent so assertions can inspect protocol behavior.
 */
type MockOptions = {
	mode?: "json" | "sse";
	sessionId?: string;
	sessionIdFactory?: (initializeCount: number) => string;
	protocolVersion?: string;
	toolsListResult?: unknown;
	onRequest?: (body: Record<string, unknown>, req: IncomingMessage) => void;
	/** When set, respond to this method with HTTP status + raw body. */
	failMethod?: { method: string; status: number; body: string; contentType?: string };
	/** Delay (ms) before answering — used to exercise client-side timeout. */
	delayMs?: number;
	/** Keep this method's HTTP exchange open until the client aborts it. */
	neverRespondMethod?: string;
	/** Send successful headers/body prefix, then keep the response body open. */
	hangBodyMethod?: string;
	/** Keep DELETE open until the client's close timeout aborts it. */
	hangDelete?: boolean;
	/** Return one session-expired 404 for this method, then resume normally. */
	expireOnceMethod?: string;
	/** Redirect this method; the client must not follow with credential headers. */
	redirectMethod?: { method: string; url: string; status?: number };
	onResponseClose?: (method: string) => void;
};

function rpcResult(method: string, params: Record<string, unknown>, opts: MockOptions): unknown {
	switch (method) {
		case "initialize":
			return { protocolVersion: opts.protocolVersion ?? "2025-03-26", capabilities: { tools: {} } };
		case "tools/list":
			return opts.toolsListResult ?? { tools: [{ name: "greet", inputSchema: { type: "object" } }] };
		case "tools/call":
			return { content: [{ type: "text", text: `hello ${(params.arguments as { name?: string })?.name ?? ""}` }] };
		default:
			return {};
	}
}

function startMockServer(opts: MockOptions): Promise<{ server: Server; url: string }> {
	let initializeCount = 0;
	let expiredOnce = false;
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "DELETE") {
			if (opts.hangDelete) return;
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
			if (message.method === "initialize") initializeCount += 1;
			opts.onRequest?.(message as Record<string, unknown>, req);
			res.on("close", () => opts.onResponseClose?.(message.method));
			if (opts.neverRespondMethod === message.method) return;

			const respond = () => {
				if (opts.expireOnceMethod === message.method && !expiredOnce) {
					expiredOnce = true;
					res.statusCode = 404;
					res.end("session expired");
					return;
				}
				if (opts.redirectMethod?.method === message.method) {
					res.statusCode = opts.redirectMethod.status ?? 307;
					res.setHeader("location", opts.redirectMethod.url);
					res.end();
					return;
				}
				if (opts.hangBodyMethod === message.method) {
					res.statusCode = 200;
					res.setHeader("content-type", "text/plain");
					res.write("partial body");
					return;
				}
				if (opts.failMethod && opts.failMethod.method === message.method) {
					res.statusCode = opts.failMethod.status;
					res.setHeader("content-type", opts.failMethod.contentType ?? "application/json");
					if (opts.sessionId) res.setHeader("Mcp-Session-Id", opts.sessionId);
					res.end(opts.failMethod.body);
					return;
				}
				// Notifications carry no id: acknowledge with 202 and no body.
				if (message.id === undefined) {
					res.statusCode = 202;
					res.end();
					return;
				}
				const result = rpcResult(message.method, message.params ?? {}, opts);
				const envelope = { jsonrpc: "2.0", id: message.id, result };
				if (message.method === "initialize") {
					const sessionId = opts.sessionIdFactory?.(initializeCount) ?? opts.sessionId;
					if (sessionId) res.setHeader("Mcp-Session-Id", sessionId);
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

	it("closes each SSE response after its own request settles during concurrent calls", async () => {
		let callIndex = 0;
		let firstStreamClosed = false;
		const server = createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				const message = JSON.parse(raw) as { id?: number; method: string };
				if (message.id === undefined) {
					res.statusCode = 202;
					res.end();
					return;
				}
				if (message.method === "initialize") {
					res.setHeader("content-type", "application/json");
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
						}),
					);
					return;
				}
				callIndex += 1;
				const envelope = JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: { content: [{ type: "text", text: `call-${callIndex}` }] },
				});
				if (callIndex === 1) {
					res.statusCode = 200;
					res.setHeader("content-type", "text/event-stream");
					res.on("close", () => {
						firstStreamClosed = true;
					});
					res.write(`data: ${envelope}\n\n`);
					return;
				}
				setTimeout(() => {
					res.statusCode = 200;
					res.setHeader("content-type", "application/json");
					res.end(envelope);
				}, 150);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		active = server;
		const { port } = server.address() as AddressInfo;
		const client = new McpHttpClient({ transport: "http", url: `http://127.0.0.1:${port}/mcp` });
		await client.connect();
		let secondSettled = false;
		const first = client.callTool("first", {});
		const second = client.callTool("second", {}).finally(() => {
			secondSettled = true;
		});
		await expect(first).resolves.toMatchObject({ content: [{ text: "call-1" }] });
		await vi.waitFor(() => expect(firstStreamClosed).toBe(true), { timeout: 100 });
		expect(secondSettled).toBe(false);
		await expect(second).resolves.toMatchObject({ content: [{ text: "call-2" }] });
		await client.close();
	});

	it("does not let a mismatched JSON response settle another concurrent request", async () => {
		const calls: Array<{ id: number; res: ServerResponse }> = [];
		const server = createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				const message = JSON.parse(raw) as { id?: number; method: string };
				if (message.id === undefined) {
					res.statusCode = 202;
					res.end();
					return;
				}
				if (message.method === "initialize") {
					res.setHeader("content-type", "application/json");
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
						}),
					);
					return;
				}
				calls.push({ id: message.id, res });
				if (calls.length !== 2) return;
				const [first, second] = calls;
				first.res.setHeader("content-type", "application/json");
				first.res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: second.id,
						result: { content: [{ type: "text", text: "wrong response" }] },
					}),
				);
				setTimeout(() => {
					second.res.setHeader("content-type", "application/json");
					second.res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: second.id,
							result: { content: [{ type: "text", text: "second response" }] },
						}),
					);
				}, 20);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		active = server;
		const { port } = server.address() as AddressInfo;
		const client = new McpHttpClient({
			transport: "http",
			url: `http://127.0.0.1:${port}/mcp`,
			requestTimeoutMs: 300,
		});
		await client.connect();
		const first = client.callTool("first", {});
		const second = client.callTool("second", {});
		await expect(first).rejects.toThrow(/did not match request id/);
		await expect(second).resolves.toMatchObject({ content: [{ text: "second response" }] });
		await client.close();
	});

	it("ignores unrelated SSE response ids without cross-settling concurrent calls", async () => {
		const calls: Array<{ id: number; res: ServerResponse }> = [];
		const server = createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				const message = JSON.parse(raw) as { id?: number; method: string };
				if (message.id === undefined) {
					res.statusCode = 202;
					res.end();
					return;
				}
				if (message.method === "initialize") {
					res.setHeader("content-type", "application/json");
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
						}),
					);
					return;
				}
				calls.push({ id: message.id, res });
				if (calls.length !== 2) return;
				const [first, second] = calls;
				first.res.setHeader("content-type", "text/event-stream");
				first.res.write(
					`data: ${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { content: [{ type: "text", text: "wrong response" }] } })}\n\n`,
				);
				first.res.end(
					`data: ${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { content: [{ type: "text", text: "first response" }] } })}\n\n`,
				);
				setTimeout(() => {
					second.res.setHeader("content-type", "application/json");
					second.res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: second.id,
							result: { content: [{ type: "text", text: "second response" }] },
						}),
					);
				}, 20);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		active = server;
		const { port } = server.address() as AddressInfo;
		const client = new McpHttpClient({ transport: "http", url: `http://127.0.0.1:${port}/mcp` });
		await client.connect();
		const first = client.callTool("first", {});
		const second = client.callTool("second", {});
		await expect(first).resolves.toMatchObject({ content: [{ text: "first response" }] });
		await expect(second).resolves.toMatchObject({ content: [{ text: "second response" }] });
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

	it("sends the negotiated protocol version after initialize", async () => {
		const seen: Array<string | undefined> = [];
		const { server, url } = await startMockServer({
			mode: "json",
			onRequest: (_body, req) => seen.push(req.headers["mcp-protocol-version"] as string | undefined),
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		await client.listTools();
		expect(seen[0]).toBeUndefined();
		expect(seen.slice(1)).toEqual(["2025-03-26", "2025-03-26"]);
		await client.close();
	});

	it("rejects an unsupported negotiated protocol version", async () => {
		const { server, url } = await startMockServer({ mode: "json", protocolVersion: "2025-06-18" });
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await expect(client.connect()).rejects.toThrow(/unsupported protocol version.*2025-06-18/);
		expect(client.isConnected).toBe(false);
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

	it("surfaces non-JSON-RPC error JSON immediately instead of timing out", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			failMethod: {
				method: "tools/list",
				status: 401,
				body: JSON.stringify({ error: "unauthorized" }),
			},
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url, requestTimeoutMs: 1_000 });
		await client.connect();
		await expect(client.listTools()).rejects.toThrow(/HTTP 401.*unauthorized/);
		await client.close();
	});

	it("does not accept a JSON-RPC success result carried by HTTP 401", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			failMethod: {
				method: "tools/list",
				status: 401,
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
			},
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url, requestTimeoutMs: 1_000 });
		await client.connect();
		await expect(client.listTools()).rejects.toThrow(/HTTP 401/);
		await client.close();
	});

	it("redacts credential-shaped values from HTTP error diagnostics", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			failMethod: {
				method: "tools/list",
				status: 401,
				body: JSON.stringify({ authorization: "Bearer super-secret-token", apiKey: "key-value" }),
			},
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		const error = await client.listTools().catch((caught: unknown) => caught);
		expect(String(error)).toContain("[REDACTED]");
		expect(String(error)).not.toContain("super-secret-token");
		expect(String(error)).not.toContain("key-value");
		await client.close();
	});

	it("redacts a bare credential echoed without its Authorization scheme", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			failMethod: {
				method: "tools/list",
				status: 401,
				contentType: "text/plain",
				body: "credential rejected: super-secret-token",
			},
		});
		active = server;
		const client = new McpHttpClient({
			transport: "http",
			url,
			headers: { Authorization: "Bearer super-secret-token" },
		});
		await client.connect();
		const error = await client.listTools().catch((caught: unknown) => caught);
		expect(String(error)).toContain("[REDACTED]");
		expect(String(error)).not.toContain("super-secret-token");
		await client.close();
	});

	it("redacts credential-shaped values from unsupported response bodies", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			failMethod: {
				method: "tools/list",
				status: 200,
				contentType: "text/plain",
				body: '{"authorization":"Bearer unsupported-secret"}',
			},
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		const error = await client.listTools().catch((caught: unknown) => caught);
		expect(String(error)).toContain("[REDACTED]");
		expect(String(error)).not.toContain("unsupported-secret");
		await client.close();
	});

	it.each([
		["a successful HTTP response", 200],
		["a failed HTTP response", 401],
	])("redacts configured headers and session ids from JSON-RPC errors in %s", async (_label, status) => {
		const { server, url } = await startMockServer({
			mode: "json",
			sessionId: "session-secret",
			failMethod: {
				method: "tools/list",
				status,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					error: {
						code: -32001,
						message: "X-API-Key: header-secret; session=session-secret",
					},
				}),
			},
		});
		active = server;
		const client = new McpHttpClient({
			transport: "http",
			url,
			headers: { "X-API-Key": "header-secret" },
		});
		await client.connect();
		const error = await client.listTools().catch((caught: unknown) => caught);
		expect(String(error)).toContain("[REDACTED]");
		expect(String(error)).not.toContain("header-secret");
		expect(String(error)).not.toContain("session-secret");
		await client.close();
	});

	it("redacts URL userinfo and secret query values from HTTP errors", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			failMethod: {
				method: "tools/list",
				status: 500,
				contentType: "text/plain",
				body: "upstream https://url-user:url-password@example.test/mcp?api_key=query-secret&safe=visible",
			},
		});
		active = server;
		const endpoint = new URL(url);
		endpoint.searchParams.set("api_key", "query-secret");
		endpoint.searchParams.set("safe", "visible");
		const client = new McpHttpClient({ transport: "http", url: endpoint.href });
		await client.connect();
		const error = await client.listTools().catch((caught: unknown) => caught);
		const text = String(error);
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain("url-password");
		expect(text).not.toContain("query-secret");
		expect(text).toContain("safe=visible");
		await client.close();
	});

	it("does not become connected when initialized notification fails", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			failMethod: { method: "notifications/initialized", status: 500, body: "notification failed" },
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await expect(client.connect()).rejects.toThrow(/notifications\/initialized.*HTTP 500/);
		expect(client.isConnected).toBe(false);
		await client.close();
	});

	it("reinitializes once when a server expires the current session with 404", async () => {
		const seen: Array<{ method: string; session?: string }> = [];
		const { server, url } = await startMockServer({
			mode: "json",
			sessionIdFactory: (count) => `session-${count}`,
			expireOnceMethod: "tools/list",
			onRequest: (body, req) =>
				seen.push({ method: String(body.method), session: req.headers["mcp-session-id"] as string | undefined }),
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		await expect(client.listTools()).resolves.toEqual([{ name: "greet", inputSchema: { type: "object" } }]);
		expect(seen.filter((entry) => entry.method === "initialize")).toHaveLength(2);
		expect(seen.filter((entry) => entry.method === "tools/list").map((entry) => entry.session)).toEqual([
			"session-1",
			"session-2",
		]);
		expect(client.isConnected).toBe(true);
		await client.close();
	});

	it("recovers an expired session without replaying a side-effecting tool call", async () => {
		const seen: string[] = [];
		const { server, url } = await startMockServer({
			mode: "json",
			sessionIdFactory: (count) => `session-${count}`,
			expireOnceMethod: "tools/call",
			onRequest: (body) => seen.push(String(body.method)),
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url });
		await client.connect();
		await expect(client.callTool("write_once", {})).rejects.toThrow(/not retried.*side effects/);
		expect(seen.filter((method) => method === "initialize")).toHaveLength(2);
		expect(seen.filter((method) => method === "tools/call")).toHaveLength(1);
		await expect(client.callTool("after_recovery", {})).resolves.toMatchObject({ content: [{ type: "text" }] });
		expect(seen.filter((method) => method === "tools/call")).toHaveLength(2);
		await client.close();
	});

	it("does not let an old in-flight response restore an expired session id", async () => {
		let initializeCount = 0;
		let expired = false;
		const seenListSessions: Array<string | undefined> = [];
		const server = createServer((req, res) => {
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
				const message = JSON.parse(raw) as { id?: number; method: string };
				const requestSession = req.headers["mcp-session-id"] as string | undefined;
				if (message.id === undefined) {
					res.statusCode = 202;
					res.end();
					return;
				}
				if (message.method === "initialize") {
					initializeCount += 1;
					res.setHeader("content-type", "application/json");
					res.setHeader("Mcp-Session-Id", `session-${initializeCount}`);
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
						}),
					);
					return;
				}
				if (message.method === "tools/call") {
					setTimeout(() => {
						res.setHeader("content-type", "application/json");
						res.setHeader("Mcp-Session-Id", "session-1");
						res.end(
							JSON.stringify({
								jsonrpc: "2.0",
								id: message.id,
								result: { content: [{ type: "text", text: "slow response" }] },
							}),
						);
					}, 80);
					return;
				}
				seenListSessions.push(requestSession);
				if (!expired && requestSession === "session-1") {
					expired = true;
					res.statusCode = 404;
					res.end("expired");
					return;
				}
				res.setHeader("content-type", "application/json");
				res.setHeader("Mcp-Session-Id", requestSession ?? "");
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		active = server;
		const { port } = server.address() as AddressInfo;
		const client = new McpHttpClient({ transport: "http", url: `http://127.0.0.1:${port}/mcp` });
		await client.connect();
		const slowCall = client.callTool("slow", {});
		await expect(client.listTools()).resolves.toEqual([]);
		await expect(slowCall).resolves.toMatchObject({ content: [{ text: "slow response" }] });
		await expect(client.listTools()).resolves.toEqual([]);
		expect(initializeCount).toBe(2);
		expect(seenListSessions).toEqual(["session-1", "session-2", "session-2"]);
		await client.close();
	});

	it("times out when the server does not answer in time", async () => {
		const { server, url } = await startMockServer({ mode: "json", delayMs: 200 });
		active = server;
		const client = new McpHttpClient({ transport: "http", url, requestTimeoutMs: 40 });
		await expect(client.connect()).rejects.toThrow(/timed out after 40ms/);
		await client.close();
	});

	it("aborts an in-flight response stream when request correlation times out", async () => {
		let listResponseClosed = false;
		const { server, url } = await startMockServer({
			mode: "json",
			neverRespondMethod: "tools/list",
			onResponseClose: (method) => {
				if (method === "tools/list") listResponseClosed = true;
			},
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url, requestTimeoutMs: 40 });
		await client.connect();
		await expect(client.listTools()).rejects.toThrow(/timed out after 40ms/);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(listResponseClosed).toBe(true);
		await client.close();
	});

	it("times out a notification body and leaves the client disconnected", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			neverRespondMethod: "notifications/initialized",
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url, requestTimeoutMs: 40 });
		await expect(client.connect()).rejects.toThrow(/notifications\/initialized timed out after 40ms/);
		expect(client.isConnected).toBe(false);
		await client.close();
	});

	it("times out when notification headers arrive but the response body stalls", async () => {
		const { server, url } = await startMockServer({
			mode: "json",
			hangBodyMethod: "notifications/initialized",
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url, requestTimeoutMs: 40 });
		await expect(client.connect()).rejects.toThrow(/notifications\/initialized timed out after 40ms/);
		expect(client.isConnected).toBe(false);
		await client.close();
	});

	it("does not follow a cross-origin redirect with static credentials", async () => {
		let redirectedRequests = 0;
		let leakedApiKey: string | undefined;
		const redirectTarget = createServer((req, res) => {
			redirectedRequests += 1;
			leakedApiKey = req.headers["x-api-key"] as string | undefined;
			res.statusCode = 200;
			res.end();
		});
		await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
		const targetPort = (redirectTarget.address() as AddressInfo).port;
		const { server, url } = await startMockServer({
			mode: "json",
			redirectMethod: { method: "tools/list", url: `http://127.0.0.1:${targetPort}/capture` },
		});
		active = server;
		const client = new McpHttpClient({ transport: "http", url, headers: { "X-API-Key": "secret" } });
		try {
			await client.connect();
			await expect(client.listTools()).rejects.toThrow(/HTTP 307/);
			expect(redirectedRequests).toBe(0);
			expect(leakedApiKey).toBeUndefined();
		} finally {
			await client.close();
			await new Promise<void>((resolve) => redirectTarget.close(() => resolve()));
		}
	});

	it("bounds best-effort session DELETE during close", async () => {
		const { server, url } = await startMockServer({ mode: "json", sessionId: "close-session", hangDelete: true });
		active = server;
		const client = new McpHttpClient({ transport: "http", url, requestTimeoutMs: 40 });
		await client.connect();
		const startedAt = Date.now();
		await client.close();
		expect(Date.now() - startedAt).toBeLessThan(500);
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
