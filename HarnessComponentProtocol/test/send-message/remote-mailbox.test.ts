import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageStore } from "../../tools/send-message/magenta/message-store.ts";
import { peerEndpointId } from "../../tools/send-message/magenta/peer-endpoint.ts";
import { RemoteMailboxController, type RemoteMailboxSpawn } from "../../tools/send-message/magenta/remote-mailbox.ts";

function fakeSpawn(records: Array<{ command: string; args: string[]; options: SpawnOptions }>): RemoteMailboxSpawn {
	return (command, args, options) => {
		const child = new EventEmitter() as ChildProcess;
		Object.assign(child, { unref: vi.fn(), pid: 12345 });
		records.push({ command, args, options });
		return child;
	};
}

describe("RemoteMailboxController", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("registers, opens, and persistently closes a host-wide endpoint", () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const records: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
		const options = {
			sshTarget: { remote: "root@example", remoteCwd: "/workspace", port: 23915 },
			spawnRelay: fakeSpawn(records),
			resolveInvocation: (args: string[]) => ({ command: "/opt/magenta", args }),
		};
		const endpointId = peerEndpointId("root@example", 23915);
		const first = new RemoteMailboxController(dbPath, options);
		expect(first.list()).toEqual([
			expect.objectContaining({ id: endpointId, desiredState: "on", observedState: "closed", port: 23915 }),
		]);
		expect(records).toHaveLength(1);
		expect(records[0]?.args).toEqual(
			expect.arrayContaining([
				"_peer",
				"relay",
				"--endpoint",
				endpointId,
				"--remote",
				"root@example",
				"--port",
				"23915",
			]),
		);
		first.close(endpointId);
		first.shutdown();

		const second = new RemoteMailboxController(dbPath, options);
		expect(second.list()[0]?.desiredState).toBe("off");
		expect(records).toHaveLength(1);
		second.open(endpointId);
		expect(records).toHaveLength(2);
		second.shutdown();
	});

	it("consumes async spawn errors and supervises crashed relay owners", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-supervisor-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", 23915);
		const records: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
		let injectError = true;
		const spawnWithFirstError: RemoteMailboxSpawn = (command, args, options) => {
			const child = new EventEmitter() as ChildProcess;
			Object.assign(child, { unref: vi.fn(), pid: 12345 });
			records.push({ command, args, options });
			if (injectError) {
				injectError = false;
				queueMicrotask(() => child.emit("error", Object.assign(new Error("missing binary"), { code: "ENOENT" })));
			}
			return child;
		};
		const controller = new RemoteMailboxController(dbPath, {
			sshTarget: { remote: "root@example", remoteCwd: "/workspace", port: 23915 },
			spawnRelay: spawnWithFirstError,
			resolveInvocation: (args: string[]) => ({ command: "/missing/magenta", args }),
			supervisorIntervalMs: 5,
			spawnRetryMs: 5,
		});
		const external = new MessageStore(dbPath);
		try {
			expect(external.claimPeerEndpointRelay(endpointId, 2_147_483_646, "crashed-relay")).toBe(true);
			const deadline = Date.now() + 500;
			while (records.length < 2 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(records.length).toBeGreaterThanOrEqual(2);
			controller.close(endpointId);
			const afterClose = records.length;
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(records).toHaveLength(afterClose);
			controller.open(endpointId);
			const reopenDeadline = Date.now() + 500;
			while (records.length === afterClose && Date.now() < reopenDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(records.length).toBeGreaterThan(afterClose);
		} finally {
			external.close();
			controller.shutdown();
		}
	});
});
