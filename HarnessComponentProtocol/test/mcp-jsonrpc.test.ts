import { describe, expect, it } from "vitest";
import { JsonRpcPeer } from "../_magenta/mcp/jsonrpc.ts";

describe("JsonRpcPeer", () => {
	it("allocates incrementing ids and serializes a valid request envelope", () => {
		const peer = new JsonRpcPeer();
		const a = peer.createRequest("tools/list", {});
		const b = peer.createRequest("tools/call", { name: "x" });
		expect(a.id).toBe(1);
		expect(b.id).toBe(2);
		const parsed = JSON.parse(a.payload) as Record<string, unknown>;
		expect(parsed).toMatchObject({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		// Silence unhandled rejections when the peer is dropped without settling.
		peer.failAll(new Error("done"));
		return Promise.allSettled([a.promise, b.promise]);
	});

	it("resolves a pending request when a matching response arrives", async () => {
		const peer = new JsonRpcPeer();
		const { id, promise } = peer.createRequest("tools/list", {});
		expect(peer.hasPendingRequest(id)).toBe(true);
		expect(peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }))).toBe(true);
		await expect(promise).resolves.toEqual({ tools: [] });
		expect(peer.hasPending).toBe(false);
		expect(peer.hasPendingRequest(id)).toBe(false);
	});

	it("rejects a pending request when the response carries an error", async () => {
		const peer = new JsonRpcPeer();
		const { id, promise } = peer.createRequest("tools/call", {});
		peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } }));
		await expect(promise).rejects.toThrow(/-32000.*boom/);
	});

	it("times out a request with no response", async () => {
		const peer = new JsonRpcPeer({ requestTimeoutMs: 20 });
		let transportAborted = false;
		const { promise } = peer.createRequest(
			"tools/list",
			{},
			{
				onTimeout: () => {
					transportAborted = true;
				},
			},
		);
		await expect(promise).rejects.toThrow(/timed out after 20ms/);
		expect(transportAborted).toBe(true);
	});

	it("ignores non-JSON text, unknown ids, and server-initiated messages", async () => {
		const peer = new JsonRpcPeer();
		const { id, promise } = peer.createRequest("tools/list", {});
		expect(peer.handleMessage("not json")).toBe(false);
		expect(peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }))).toBe(false);
		expect(peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "server/ping" }))).toBe(false);
		expect(peer.hasPending).toBe(true);
		peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, result: "ok" }));
		await expect(promise).resolves.toBe("ok");
	});

	it("does not settle requests from malformed response envelopes", async () => {
		const peer = new JsonRpcPeer();
		const { id, promise } = peer.createRequest("tools/list", {});
		for (const message of [
			{ id, result: {} },
			{ jsonrpc: "1.0", id, result: {} },
			{ jsonrpc: "2.0", id, method: "server/request", result: {} },
			{ jsonrpc: "2.0", id, result: {}, error: { code: -1, message: "both" } },
			{ jsonrpc: "2.0", id },
		]) {
			expect(peer.handleMessage(JSON.stringify(message))).toBe(false);
			expect(peer.hasPendingRequest(id)).toBe(true);
		}
		peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, result: "ok" }));
		await expect(promise).resolves.toBe("ok");
	});

	it("createNotification produces an id-less envelope", () => {
		const peer = new JsonRpcPeer();
		const parsed = JSON.parse(peer.createNotification("notifications/initialized", {})) as Record<string, unknown>;
		expect(parsed).toEqual({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
		expect(parsed).not.toHaveProperty("id");
	});

	it("failAll rejects every in-flight request", async () => {
		const peer = new JsonRpcPeer();
		const a = peer.createRequest("tools/list", {});
		const b = peer.createRequest("tools/call", {});
		peer.failAll(new Error("connection dropped"));
		await expect(a.promise).rejects.toThrow(/connection dropped/);
		await expect(b.promise).rejects.toThrow(/connection dropped/);
		expect(peer.hasPending).toBe(false);
	});

	it("failRequest rejects only the targeted id", async () => {
		const peer = new JsonRpcPeer();
		const a = peer.createRequest("tools/list", {});
		const b = peer.createRequest("tools/call", {});
		peer.failRequest(a.id, new Error("write failed"));
		await expect(a.promise).rejects.toThrow(/write failed/);
		expect(peer.hasPending).toBe(true);
		peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: 1 }));
		await expect(b.promise).resolves.toBe(1);
	});
});
