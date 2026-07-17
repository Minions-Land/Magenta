import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const undiciState = vi.hoisted(() => ({
	globalDispatcher: undefined as unknown,
	clients: [] as unknown[],
	pools: [] as unknown[],
	agents: [] as unknown[],
}));

vi.mock("undici", async () => {
	const { EventEmitter: NodeEventEmitter } = await import("node:events");
	class MockDispatcher extends NodeEventEmitter {
		options: Record<string, unknown>;

		constructor(options: Record<string, unknown> = {}) {
			super();
			this.options = options;
		}
		request = vi.fn(async () => {
			throw new Error("request failed");
		});
	}
	class Client extends MockDispatcher {
		origin: string | URL;

		constructor(origin: string | URL, options: Record<string, unknown>) {
			super(options);
			this.origin = origin;
			undiciState.clients.push(this);
		}
	}
	class Pool extends MockDispatcher {
		origin: string | URL;

		constructor(origin: string | URL, options: Record<string, unknown>) {
			super(options);
			this.origin = origin;
			undiciState.pools.push(this);
		}
	}
	class EnvHttpProxyAgent extends MockDispatcher {
		constructor(options: Record<string, unknown>) {
			super(options);
			undiciState.agents.push(this);
		}
	}
	return {
		Client,
		Pool,
		EnvHttpProxyAgent,
		setGlobalDispatcher: (dispatcher: unknown) => {
			undiciState.globalDispatcher = dispatcher;
		},
		install: vi.fn(),
	};
});

import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";

type MockDispatcher = EventEmitter & {
	options: Record<string, unknown>;
	request: () => Promise<unknown>;
};

describe("undici dispatcher client error guard", () => {
	beforeEach(() => {
		undiciState.globalDispatcher = undefined;
		undiciState.clients.length = 0;
		undiciState.pools.length = 0;
		undiciState.agents.length = 0;
	});

	it("guards agents, pools, and clients once without swallowing request rejections", async () => {
		configureHttpDispatcher(30_000);
		const agent = undiciState.globalDispatcher as MockDispatcher;
		expect(agent.listenerCount("error")).toBe(1);
		expect(() => agent.emit("error", new Error("agent internal error"))).not.toThrow();

		const originFactory = agent.options.factory as (origin: string, options: object) => MockDispatcher;
		const pool = originFactory("https://example.test", { connections: 2 });
		expect(pool.listenerCount("error")).toBe(1);
		const clientFactory = pool.options.factory as (origin: string, options: object) => MockDispatcher;
		const pooledClient = clientFactory("https://example.test", {});
		expect(pooledClient.listenerCount("error")).toBe(1);
		expect(() => pooledClient.emit("error", new Error("mid-stream"))).not.toThrow();
		await expect(pooledClient.request()).rejects.toThrow("request failed");

		const directClient = originFactory("https://example.test", { connections: 1 });
		expect(directClient.listenerCount("error")).toBe(1);
		expect(undiciState.clients).toHaveLength(2);
	});
});
