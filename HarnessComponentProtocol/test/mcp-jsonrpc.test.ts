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
		peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }));
		await expect(promise).resolves.toEqual({ tools: [] });
		expect(peer.hasPending).toBe(false);
	});

	it("rejects a pending request when the response carries an error", async () => {
		const peer = new JsonRpcPeer();
		const { id, promise } = peer.createRequest("tools/call", {});
		peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } }));
		await expect(promise).rejects.toThrow(/-32000.*boom/);
	});

	it("times out a request with no response", async () => {
		const peer = new JsonRpcPeer({ requestTimeoutMs: 20 });
		const { promise } = peer.createRequest("tools/list", {});
		await expect(promise).rejects.toThrow(/timed out after 20ms/);
	});

	it("ignores non-JSON text, unknown ids, and server-initiated messages", async () => {
		const peer = new JsonRpcPeer();
		const { id, promise } = peer.createRequest("tools/list", {});
		peer.handleMessage("not json");
		peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }));
		peer.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "server/ping" }));
		expect(peer.hasPending).toBe(true);
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
