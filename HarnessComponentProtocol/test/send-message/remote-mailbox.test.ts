import { type ChildProcess, execFileSync, type SpawnOptions, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageStore } from "../../tools/send-message/magenta/message-store.ts";
import {
	handlePeerCommand,
	monitorPeerExecutableGeneration,
	peerRelaySshArgs,
} from "../../tools/send-message/magenta/peer-command.ts";
import { peerEndpointId } from "../../tools/send-message/magenta/peer-endpoint.ts";
import {
	acquirePeerRelayLock,
	encodePeerRelayGenerationArgs,
	isPeerRelayLockActive,
	peerRelayGeneration,
	peerRelayGenerationMatches,
} from "../../tools/send-message/magenta/peer-relay-lock.ts";
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

	it("changes relay generation with executable artifacts but not fencing or mailbox writes", () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-generation-"));
		dirs.push(dir);
		const command = join(dir, "magenta");
		const dbPath = join(dir, "messages.db");
		writeFileSync(command, "first");
		writeFileSync(dbPath, "database-one");
		const invocation = { command, args: ["_peer", "relay", "--db", dbPath] };
		const first = peerRelayGeneration(invocation);
		expect(
			peerRelayGenerationMatches(first, {
				command,
				args: [...invocation.args, "--generation", first, "--generation-command", command],
			}),
		).toBe(true);
		writeFileSync(dbPath, "database-two-is-different");
		expect(peerRelayGeneration(invocation)).toBe(first);
		writeFileSync(command, "second-release-is-different");
		expect(peerRelayGenerationMatches(first, invocation)).toBe(false);

		const entrypoint = join(dir, "cli.js");
		writeFileSync(entrypoint, "first-cli");
		const cliInvocation = { command: process.execPath, args: [entrypoint, ...invocation.args] };
		const cliGeneration = peerRelayGeneration(cliInvocation);
		writeFileSync(entrypoint, "second-cli-is-different");
		expect(peerRelayGenerationMatches(cliGeneration, cliInvocation)).toBe(false);
	});

	it("uses the same canonical generation for a PATH fallback parent and relay child", () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-path-generation-"));
		dirs.push(dir);
		const executableName = process.platform === "win32" ? "magenta.CMD" : "magenta";
		const executable = join(dir, executableName);
		writeFileSync(executable, "first executable");
		chmodSync(executable, 0o755);
		const previousPath = process.env.PATH;
		const previousPathExt = process.env.PATHEXT;
		process.env.PATH = `${dir}${delimiter}${previousPath ?? ""}`;
		if (process.platform === "win32") process.env.PATHEXT = ".CMD;.EXE";
		try {
			const args = ["_peer", "relay", "--db", join(dir, "messages.db"), "--remote", "root@example"];
			const parentInvocation = { command: "magenta", args };
			const generation = peerRelayGeneration(parentInvocation);
			const childInvocation = {
				command: "magenta",
				args: [
					...args,
					"--generation",
					generation,
					"--generation-command",
					"magenta",
					"--generation-args",
					encodePeerRelayGenerationArgs(args),
				],
			};
			expect(peerRelayGenerationMatches(generation, childInvocation)).toBe(true);
			writeFileSync(executable, "replacement executable with different contents");
			expect(peerRelayGenerationMatches(generation, parentInvocation)).toBe(false);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousPathExt === undefined) delete process.env.PATHEXT;
			else process.env.PATHEXT = previousPathExt;
		}
	});

	it("executes an explicit remote binary and the default non-interactive SSH fallback", () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-remote-binary-"));
		dirs.push(dir);
		const stagedBinary = join(dir, "staged release", "magenta");
		mkdirSync(join(dir, "staged release"), { recursive: true });
		writeFileSync(stagedBinary, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
		chmodSync(stagedBinary, 0o755);
		const remoteDb = join(dir, "remote db's messages.db");
		const explicitCommand = peerRelaySshArgs("root@example", undefined, undefined, remoteDb, stagedBinary).at(-1)!;
		const explicitArgs = execFileSync("/bin/sh", ["-c", explicitCommand], {
			env: { HOME: dir, PATH: "" },
		})
			.toString("utf8")
			.trim()
			.split("\n");
		expect(explicitArgs).toEqual(["_peer", "link", "--db", remoteDb]);

		const defaultBinary = join(dir, ".local", "bin", "magenta");
		mkdirSync(join(dir, ".local", "bin"), { recursive: true });
		writeFileSync(defaultBinary, "#!/bin/sh\nprintf 'home\\n'\nprintf '%s\\n' \"$@\"\n");
		chmodSync(defaultBinary, 0o755);
		const fallbackCommand = peerRelaySshArgs("root@example", undefined, undefined, undefined).at(-1)!;
		const customBinDir = join(dir, "custom-bin");
		const customBinary = join(customBinDir, "magenta");
		mkdirSync(customBinDir);
		writeFileSync(customBinary, "#!/bin/sh\nprintf 'custom-path\\n'\nprintf '%s\\n' \"$@\"\n");
		chmodSync(customBinary, 0o755);
		const customPathArgs = execFileSync("/bin/sh", ["-c", fallbackCommand], {
			env: { HOME: dir, PATH: customBinDir },
		})
			.toString("utf8")
			.trim()
			.split("\n");
		expect(customPathArgs).toEqual(["custom-path", "_peer", "link"]);
		const fallbackArgs = execFileSync("/bin/sh", ["-c", fallbackCommand], {
			env: { HOME: dir, PATH: "" },
		})
			.toString("utf8")
			.trim()
			.split("\n");
		expect(fallbackArgs).toEqual(["home", "_peer", "link"]);
	});

	it("reports a bounded actionable error when the remote binary is unavailable", () => {
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-remote-missing-"));
		dirs.push(dir);
		const remoteCommand = peerRelaySshArgs("root@example", undefined, undefined, undefined).at(-1)!;
		const result = spawnSync("/bin/sh", ["-c", remoteCommand], {
			env: { HOME: dir, PATH: "" },
			encoding: "utf8",
		});
		expect(result.status).toBe(127);
		expect(result.stderr).toContain("could not find the remote binary");
		expect(result.stderr).toContain("--remote-binary");
	});

	it("persists bounded SSH stderr when the remote responder cannot start", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-ssh-diagnostic-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", undefined);
		let sshArgs: string[] | undefined;
		const spawnSsh: RemoteMailboxSpawn = (_command, args) => {
			sshArgs = args;
			const child = new EventEmitter() as ChildProcess;
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			Object.assign(child, {
				stdin,
				stdout,
				stderr,
				exitCode: null,
				signalCode: null,
				pid: 12345,
				kill: vi.fn(),
			});
			queueMicrotask(() => {
				stderr.end(`${"x".repeat(32 * 1024)}remote magenta startup failed`);
				stdout.end();
				Object.assign(child, { exitCode: 127 });
				const control = new MessageStore(dbPath);
				control.setPeerEndpointDesiredState(endpointId, "off");
				control.close();
				child.emit("close", 127, null);
			});
			return child;
		};
		await handlePeerCommand(
			[
				"_peer",
				"relay",
				"--db",
				dbPath,
				"--remote",
				"root@example",
				"--remote-binary",
				"/tmp/staged magenta",
				"--stay-alive",
			],
			{ defaultDbPath: dbPath, spawnSsh },
		);
		expect(sshArgs?.at(-1)).toContain("exec '/tmp/staged magenta' _peer link");
		const probe = new MessageStore(dbPath);
		try {
			const lastError = probe.getPeerEndpoint(endpointId)?.lastError ?? "";
			expect(lastError).toContain("remote magenta startup failed");
			expect(Buffer.byteLength(lastError, "utf8")).toBeLessThan(17 * 1024);
		} finally {
			probe.close();
		}
	});

	it("detects an in-place executable replacement for responder handoff", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-responder-generation-"));
		dirs.push(dir);
		const command = join(dir, "magenta");
		writeFileSync(command, "first responder generation");
		let changed = 0;
		const stop = monitorPeerExecutableGeneration(
			{ command, args: ["_peer", "link"] },
			() => {
				changed += 1;
			},
			5,
		);
		try {
			writeFileSync(command, "replacement responder generation with a different size");
			const deadline = Date.now() + 500;
			while (changed === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
			expect(changed).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 15));
			expect(changed).toBe(1);
		} finally {
			stop();
		}
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
				"--stay-alive",
				"--port",
				"23915",
			]),
		);
		const generationIndex = records[0]?.args.indexOf("--generation") ?? -1;
		expect(records[0]?.args[generationIndex + 1]).toMatch(/^[a-f0-9]{64}$/);
		expect(records[0]?.args).toEqual(expect.arrayContaining(["--generation-command", "/opt/magenta"]));
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
			expect(
				external.claimPeerEndpointRelay(endpointId, 2_147_483_646, "crashed-relay", {
					generation: controller.list()[0]?.relayGeneration,
				}),
			).toBe(true);
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

	it("uses an endpoint lock instead of trusting a potentially reused relay pid", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-lock-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", 23915);
		const seed = new MessageStore(dbPath);
		seed.upsertPeerEndpoint(endpointId, "root@example", 23915);
		seed.setPeerEndpointRelayGeneration(endpointId, "lock-owner-generation");
		seed.claimPeerEndpointRelay(endpointId, process.pid, "stale-owner", {
			generation: "lock-owner-generation",
		});
		seed.close();

		const release = await acquirePeerRelayLock(dbPath, endpointId, () => undefined);
		const records: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
		const controller = new RemoteMailboxController(dbPath, {
			spawnRelay: fakeSpawn(records),
			resolveInvocation: (args: string[]) => ({ command: "/opt/magenta", args }),
		});
		try {
			expect(isPeerRelayLockActive(dbPath, endpointId)).toBe(true);
			expect(records).toHaveLength(0);
			expect(controller.list()[0]?.relayGeneration).toBe("lock-owner-generation");
			await release();
			expect(isPeerRelayLockActive(dbPath, endpointId)).toBe(false);
			controller.ensureOpenLinks();
			expect(records).toHaveLength(1);
		} finally {
			controller.shutdown();
			if (isPeerRelayLockActive(dbPath, endpointId)) await release().catch(() => undefined);
		}
	});

	it("fails closed on endpoint-lock inspection errors without publishing a competing generation", () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-lock-error-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", 23915);
		const seed = new MessageStore(dbPath);
		seed.upsertPeerEndpoint(endpointId, "root@example", 23915);
		seed.setPeerEndpointRelayGeneration(endpointId, "active-generation");
		seed.close();
		const check = vi.spyOn(lockfile, "checkSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("lock path unavailable"), { code: "EACCES" });
		});
		const records: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
		const controller = new RemoteMailboxController(dbPath, {
			spawnRelay: fakeSpawn(records),
			resolveInvocation: (args: string[]) => ({ command: "/next/magenta", args }),
			supervisorIntervalMs: 60_000,
			spawnRetryMs: 0,
		});
		try {
			expect(records).toHaveLength(0);
			expect(controller.list()[0]?.relayGeneration).toBe("active-generation");
			check.mockRestore();
			controller.ensureOpenLinks();
			expect(records).toHaveLength(1);
			expect(controller.list()[0]?.relayGeneration).toBe("active-generation");
		} finally {
			check.mockRestore();
			controller.shutdown();
		}
	});

	it("does not let mixed executable generations oscillate an active relay", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-generation-lock-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", 23915);
		const seed = new MessageStore(dbPath);
		seed.upsertPeerEndpoint(endpointId, "root@example", 23915);
		seed.setPeerEndpointRelayGeneration(endpointId, "active-generation");
		seed.close();

		const release = await acquirePeerRelayLock(dbPath, endpointId, () => undefined);
		const records: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
		const first = new RemoteMailboxController(dbPath, {
			spawnRelay: fakeSpawn(records),
			resolveInvocation: (args: string[]) => ({ command: "/release/a/magenta", args }),
		});
		const second = new RemoteMailboxController(dbPath, {
			spawnRelay: fakeSpawn(records),
			resolveInvocation: (args: string[]) => ({ command: "/release/b/magenta", args }),
		});
		try {
			for (let poll = 0; poll < 5; poll++) {
				first.ensureOpenLinks();
				second.ensureOpenLinks();
			}
			expect(records).toHaveLength(0);
			expect(first.list()[0]?.relayGeneration).toBe("active-generation");
			expect(second.list()[0]?.relayGeneration).toBe("active-generation");
		} finally {
			first.shutdown();
			second.shutdown();
			await release();
		}
	});

	it("does not let a losing direct relay invocation rewrite an active generation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-direct-lock-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", 23915);
		const seed = new MessageStore(dbPath);
		seed.upsertPeerEndpoint(endpointId, "root@example", 23915);
		seed.setPeerEndpointRelayGeneration(endpointId, "active-generation");
		seed.close();
		const release = await acquirePeerRelayLock(dbPath, endpointId, () => undefined);
		try {
			expect(
				await handlePeerCommand(
					["_peer", "relay", "--db", dbPath, "--endpoint", endpointId, "--remote", "root@example"],
					{ defaultDbPath: dbPath },
				),
			).toBe(true);
			const probe = new MessageStore(dbPath);
			try {
				expect(probe.getPeerEndpoint(endpointId)?.relayGeneration).toBe("active-generation");
			} finally {
				probe.close();
			}
		} finally {
			await release();
		}
	});

	it("launches a successor after generation rollover without a live Session supervisor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-successor-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", 23915);
		const relayArgs = [
			"_peer",
			"relay",
			"--db",
			dbPath,
			"--endpoint",
			endpointId,
			"--remote",
			"root@example",
			"--port",
			"23915",
			"--stay-alive",
		];
		const records: Array<{ command: string; args: string[]; options: SpawnOptions; lockActive: boolean }> = [];
		let releaseSuccessorLock: (() => Promise<void>) | undefined;
		const spawnSuccessor: RemoteMailboxSpawn = (command, args, options) => {
			const child = new EventEmitter() as ChildProcess;
			Object.assign(child, { kill: vi.fn(), unref: vi.fn(), pid: 12345 });
			records.push({ command, args, options, lockActive: isPeerRelayLockActive(dbPath, endpointId) });
			if (records.length === 1) {
				queueMicrotask(() =>
					child.emit("error", Object.assign(new Error("successor binary missing"), { code: "ENOENT" })),
				);
			} else {
				queueMicrotask(() => {
					void acquirePeerRelayLock(dbPath, endpointId, () => undefined).then((release) => {
						releaseSuccessorLock = release;
					});
				});
			}
			return child;
		};

		try {
			expect(
				await handlePeerCommand(
					[
						...relayArgs,
						"--generation",
						"0".repeat(64),
						"--generation-command",
						"/next/magenta",
						"--generation-args",
						encodePeerRelayGenerationArgs(relayArgs),
					],
					{ defaultDbPath: dbPath, spawnRelaySuccessor: spawnSuccessor },
				),
			).toBe(true);
			expect(records).toHaveLength(2);
			expect(records).toEqual([
				expect.objectContaining({ command: "/next/magenta", args: relayArgs, lockActive: false }),
				expect.objectContaining({ command: "/next/magenta", args: relayArgs, lockActive: false }),
			]);
			const probe = new MessageStore(dbPath);
			try {
				expect(probe.getPeerEndpoint(endpointId)?.lastError).toContain("successor binary missing");
			} finally {
				probe.close();
			}
		} finally {
			await releaseSuccessorLock?.();
		}
	});

	it("backs off lock-inspection failures during handoff and preserves the diagnostic", async () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-handoff-lock-error-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", undefined);
		const relayArgs = [
			"_peer",
			"relay",
			"--db",
			dbPath,
			"--endpoint",
			endpointId,
			"--remote",
			"root@example",
			"--stay-alive",
		];
		const checkTimes: number[] = [];
		let closeEndpoint: NodeJS.Timeout | undefined;
		const check = vi.spyOn(lockfile, "checkSync").mockImplementation(() => {
			checkTimes.push(Date.now());
			if (checkTimes.length === 1) return false;
			closeEndpoint ??= setTimeout(() => {
				const control = new MessageStore(dbPath);
				control.setPeerEndpointDesiredState(endpointId, "off");
				control.close();
			}, 400);
			throw Object.assign(new Error("relay lock storage unavailable"), { code: "EIO" });
		});
		const spawned: string[] = [];
		const successorKill = vi.fn();
		try {
			await handlePeerCommand(
				[
					...relayArgs,
					"--generation",
					"0".repeat(64),
					"--generation-command",
					"/next/magenta",
					"--generation-args",
					encodePeerRelayGenerationArgs(relayArgs),
				],
				{
					defaultDbPath: dbPath,
					spawnRelaySuccessor: (command) => {
						spawned.push(command);
						const child = new EventEmitter() as ChildProcess;
						Object.assign(child, { kill: successorKill, unref: vi.fn(), pid: 12345 });
						return child;
					},
				},
			);
			expect(spawned).toHaveLength(1);
			expect(successorKill).toHaveBeenCalledWith("SIGTERM");
			expect(checkTimes.length).toBeGreaterThanOrEqual(4);
			expect(checkTimes[2]! - checkTimes[1]!).toBeGreaterThanOrEqual(75);
			expect(checkTimes[3]! - checkTimes[2]!).toBeGreaterThanOrEqual(200);
			const probe = new MessageStore(dbPath);
			try {
				expect(probe.getPeerEndpoint(endpointId)?.lastError).toContain("relay lock storage unavailable");
			} finally {
				probe.close();
			}
		} finally {
			if (closeEndpoint) clearTimeout(closeEndpoint);
			check.mockRestore();
		}
	});

	it("does not trust a live but potentially reused pre-lock relay pid", () => {
		const dir = mkdtempSync(join(tmpdir(), "remote-mailbox-legacy-relay-"));
		dirs.push(dir);
		const dbPath = join(dir, "messages.db");
		const endpointId = peerEndpointId("root@example", 23915);
		const seed = new MessageStore(dbPath);
		seed.upsertPeerEndpoint(endpointId, "root@example", 23915);
		expect(seed.claimPeerEndpointRelay(endpointId, process.pid, "legacy-owner")).toBe(true);
		seed.close();

		const records: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
		const controller = new RemoteMailboxController(dbPath, {
			spawnRelay: fakeSpawn(records),
			resolveInvocation: (args: string[]) => ({ command: "/opt/magenta", args }),
		});
		try {
			expect(records).toHaveLength(1);
			expect(controller.list()[0]?.relayGeneration).toBeUndefined();
		} finally {
			controller.shutdown();
		}
	});
});
