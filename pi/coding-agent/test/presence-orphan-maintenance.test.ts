import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MessageStore } from "@magenta/harness";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_PEER_MESSAGE_DB } from "../src/config.ts";
import {
	runEmptyRegistryOrphanMaintenance,
	runPresenceOrphanMaintenance,
	runStartupOrphanMaintenance,
} from "../src/migrations.ts";

const DEAD_PID = 2_147_483_646;

describe("startup presence orphan maintenance", () => {
	const roots: string[] = [];
	const previous = new Map<string, string | undefined>();

	afterEach(() => {
		for (const key of [ENV_AGENT_DIR, ENV_PEER_MESSAGE_DB]) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		previous.clear();
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	function setup(): { root: string; agentDir: string; dbPath: string; sessionsDir: string } {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "magenta-presence-startup-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const dbPath = path.join(root, "messages.db");
		const sessionsDir = path.join(agentDir, "sessions", "project");
		fs.mkdirSync(sessionsDir, { recursive: true });
		for (const key of [ENV_AGENT_DIR, ENV_PEER_MESSAGE_DB]) previous.set(key, process.env[key]);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env[ENV_PEER_MESSAGE_DB] = dbPath;
		return { root, agentDir, dbPath, sessionsDir };
	}

	it("protects valid Session and registry ids while deleting a proven orphan", async () => {
		const { agentDir, dbPath, sessionsDir } = setup();
		const sessionFile = path.join(sessionsDir, "2026-01-01_session-on-disk.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "session-on-disk", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" })}\n${"x".repeat(100_000)}\n`,
		);
		fs.mkdirSync(path.join(agentDir, "multiagent"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "multiagent", "main.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				parentSessionId: "main",
				updatedAt: Date.now(),
				records: [{ schemaVersion: 1, parentSessionId: "main", sessionId: "session-in-registry" }],
			})}\n`,
		);

		const store = new MessageStore(dbPath, { presenceRetentionMs: 0 });
		try {
			for (const id of ["session-on-disk", "session-in-registry", "orphan"]) {
				store.updatePresence(id, "active", {
					pid: DEAD_PID,
					bootId: `boot-${id}`,
					processStartId: `start-${id}`,
				});
			}
			store.upsertPeerEndpoint("relay", "relay@example.test");
		} finally {
			store.close();
		}

		expect(await runStartupOrphanMaintenance({ sessionDir: sessionsDir, retentionMs: 0, nowMs: Date.now() })).toEqual(
			{
				deletedPresence: 1,
				deletedRegistries: 0,
			},
		);
		const check = new MessageStore(dbPath);
		try {
			expect(check.getPresence("orphan")).toBeUndefined();
			expect(check.getPresence("session-on-disk")).toBeDefined();
			expect(check.getPresence("session-in-registry")).toBeDefined();
			expect(check.getPeerEndpoint("relay")).toMatchObject({ remote: "relay@example.test", desiredState: "on" });
		} finally {
			check.close();
		}
	});

	it("skips the entire pass when a Session scan is malformed", () => {
		const { dbPath, sessionsDir } = setup();
		fs.writeFileSync(path.join(sessionsDir, "bad.jsonl"), "not-json\n");
		const store = new MessageStore(dbPath, { presenceRetentionMs: 0 });
		try {
			store.updatePresence("would-be-orphan", "active", {
				pid: DEAD_PID,
				bootId: "boot-orphan",
				processStartId: "start-orphan",
			});
		} finally {
			store.close();
		}
		expect(runPresenceOrphanMaintenance({ sessionDir: sessionsDir, retentionMs: 0, nowMs: Date.now() })).toBe(0);
		const check = new MessageStore(dbPath);
		try {
			expect(check.getPresence("would-be-orphan")).toBeDefined();
		} finally {
			check.close();
		}
	});

	it("deletes only old empty registries whose parent Session is absent", async () => {
		const { agentDir, sessionsDir } = setup();
		fs.writeFileSync(
			path.join(sessionsDir, "live.jsonl"),
			`${JSON.stringify({ type: "session", id: "live", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" })}\n`,
		);
		const registryDir = path.join(agentDir, "multiagent");
		fs.mkdirSync(registryDir, { recursive: true });
		const writeEmptyRegistry = (id: string): string => {
			const registryPath = path.join(registryDir, `${id}.json`);
			fs.writeFileSync(
				registryPath,
				`${JSON.stringify({ schemaVersion: 1, parentSessionId: id, updatedAt: 1, records: [] })}\n`,
				{ mode: 0o600 },
			);
			fs.utimesSync(registryPath, new Date(1), new Date(1));
			return registryPath;
		};
		const liveRegistry = writeEmptyRegistry("live");
		const orphanRegistry = writeEmptyRegistry("orphan");

		expect(
			await runEmptyRegistryOrphanMaintenance({ sessionDir: sessionsDir, retentionMs: 0, nowMs: Date.now() }),
		).toBe(1);
		expect(fs.existsSync(liveRegistry)).toBe(true);
		expect(fs.existsSync(orphanRegistry)).toBe(false);
	});

	it("preserves empty registries when the Session scan is incomplete", async () => {
		const { agentDir, sessionsDir } = setup();
		fs.writeFileSync(path.join(sessionsDir, "bad.jsonl"), "not-json\n");
		const registryDir = path.join(agentDir, "multiagent");
		fs.mkdirSync(registryDir, { recursive: true });
		const registryPath = path.join(registryDir, "orphan.json");
		fs.writeFileSync(
			registryPath,
			`${JSON.stringify({ schemaVersion: 1, parentSessionId: "orphan", updatedAt: 1, records: [] })}\n`,
		);

		expect(
			await runEmptyRegistryOrphanMaintenance({ sessionDir: sessionsDir, retentionMs: 0, nowMs: Date.now() }),
		).toBe(0);
		expect(fs.existsSync(registryPath)).toBe(true);
	});
});
