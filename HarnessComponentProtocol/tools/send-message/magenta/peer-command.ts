import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { shellQuote } from "../../../_magenta/env/ssh.ts";
import { MessageStore, type PeerEndpointObservedState } from "./message-store.ts";
import { peerEndpointId } from "./peer-endpoint.ts";
import { PeerLinkSession } from "./peer-link-session.ts";
import { MessageStorePeerLinkAdapter } from "./peer-link-store-adapter.ts";
import {
	acquirePeerRelayLock,
	decodePeerRelayGenerationArgs,
	isPeerRelayLockActive,
	peerRelayGeneration,
	peerRelayGenerationMatches,
	peerRelayProcessArgs,
} from "./peer-relay-lock.ts";

const CONTROL_POLL_MS = 250;
const GENERATION_POLL_MS = 1_000;
const MAX_SSH_DIAGNOSTIC_BYTES = 16 * 1024;
const NO_LIVE_SESSION_GRACE_MS = 3_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SUCCESSOR_LOCK_POLL_MS = 100;
const SUCCESSOR_LOCK_TIMEOUT_MS = 5_000;
const SUCCESSOR_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];
type RelayConnectionOutcome = "closed" | "reconnect" | "superseded" | "generation_changed";

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
	const value = option(args, name);
	if (!value) throw new Error(`${name} requires a value`);
	return value;
}

function parsePort(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const port = Number(value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535)
		throw new Error("--port must be an integer from 1 to 65535");
	return port;
}

function wakeLocalRecipient(store: MessageStore, sessionId: string): void {
	const presence = store.getPresence(sessionId);
	if (!presence?.online || !presence.wakePath) return;
	try {
		const socket = createConnection(presence.wakePath);
		socket.once("connect", () => socket.end());
		socket.once("error", () => socket.destroy());
		socket.unref();
	} catch {
		// The message is already durable; wake is best-effort.
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function monitorPeerExecutableGeneration(
	invocation: { command: string; args: readonly string[] },
	onChanged: () => void,
	pollMs = GENERATION_POLL_MS,
): () => void {
	const expected = peerRelayGeneration(invocation);
	let stopped = false;
	const timer = setInterval(() => {
		if (stopped || peerRelayGenerationMatches(expected, invocation)) return;
		stopped = true;
		clearInterval(timer);
		onChanged();
	}, pollMs);
	timer.unref();
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	};
}

async function runPeerLinkResponder(dbPath: string): Promise<void> {
	const store = new MessageStore(dbPath);
	let terminalResolve!: () => void;
	const terminal = new Promise<void>((resolve) => {
		terminalResolve = resolve;
	});
	let generationChanged = false;
	let generationChangedResolve!: () => void;
	const generationChangedSignal = new Promise<void>((resolve) => {
		generationChangedResolve = resolve;
	});
	let ready = false;
	const session = new PeerLinkSession({
		role: "responder",
		input: process.stdin,
		output: process.stdout,
		storage: new MessageStorePeerLinkAdapter(store),
		flushIntervalMs: CONTROL_POLL_MS,
		onLocalRecipient: (sessionId) => wakeLocalRecipient(store, sessionId),
		onState: (state) => {
			if (state === "ready") ready = true;
			if (state === "closed") terminalResolve();
			if (state === "failed" && ready) terminalResolve();
		},
	});
	const stopGenerationMonitor = monitorPeerExecutableGeneration(
		{ command: process.execPath, args: process.argv.slice(1) },
		() => {
			generationChanged = true;
			generationChangedResolve();
		},
	);
	try {
		const starting = session.start();
		const startOutcome = await Promise.race([
			starting.then(() => "started" as const),
			generationChangedSignal.then(() => "generation_changed" as const),
		]);
		if (startOutcome === "generation_changed") {
			void starting.catch(() => undefined);
			return;
		}
		await Promise.race([terminal, generationChangedSignal]);
	} finally {
		stopGenerationMonitor();
		await session.close(false);
		store.close();
		if (generationChanged) {
			process.stdin.destroy();
			process.stdout.end();
		}
	}
}

function remotePeerLinkCommand(remoteDb: string | undefined, remoteBinary: string | undefined): string {
	const peerArgs = `_peer link${remoteDb ? ` --db ${shellQuote(remoteDb)}` : ""}`;
	if (remoteBinary) return `exec ${shellQuote(remoteBinary)} ${peerArgs}`;
	const missingMessage =
		"Magenta peer relay could not find the remote binary; install it at $HOME/.local/bin/magenta or pass --remote-binary";
	return [
		'MAGENTA_BIN=""',
		"MAGENTA_BIN=$(command -v magenta 2>/dev/null || true)",
		'if [ -z "$MAGENTA_BIN" ] && [ -x "$HOME/.local/bin/magenta" ]; then MAGENTA_BIN="$HOME/.local/bin/magenta"; fi',
		`if [ -z "$MAGENTA_BIN" ]; then printf '%s\\n' ${shellQuote(missingMessage)} >&2; exit 127; fi`,
		`exec "$MAGENTA_BIN" ${peerArgs}`,
	].join("; ");
}

export function peerRelaySshArgs(
	remote: string,
	port: number | undefined,
	identity: string | undefined,
	remoteDb: string | undefined,
	remoteBinary?: string,
): string[] {
	const remoteCommand = remotePeerLinkCommand(remoteDb, remoteBinary);
	return [
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ServerAliveInterval=30",
		"-o",
		"ServerAliveCountMax=3",
		...(port ? ["-p", String(port)] : []),
		...(identity ? ["-i", identity] : []),
		"--",
		remote,
		remoteCommand,
	];
}

async function controlConnection(
	store: MessageStore,
	endpointId: string,
	child: ChildProcess,
	stayAlive: boolean,
	relayGeneration: string,
	isGenerationCurrent: () => boolean,
	shouldStop: () => boolean,
): Promise<RelayConnectionOutcome> {
	let noLiveSince: number | undefined;
	let nextGenerationPollAt = 0;
	while (child.exitCode === null && child.signalCode === null) {
		if (shouldStop()) {
			child.kill("SIGTERM");
			return "closed";
		}
		const endpoint = store.getPeerEndpoint(endpointId);
		if (!endpoint || endpoint.desiredState === "off") {
			child.kill("SIGTERM");
			return "closed";
		}
		if (endpoint.relayGeneration && endpoint.relayGeneration !== relayGeneration) {
			child.kill("SIGTERM");
			return "superseded";
		}
		const now = Date.now();
		if (now >= nextGenerationPollAt) {
			nextGenerationPollAt = now + GENERATION_POLL_MS;
			if (!isGenerationCurrent()) {
				child.kill("SIGTERM");
				return "generation_changed";
			}
		}
		if (!stayAlive && store.listLiveSessionPids().length === 0) {
			noLiveSince ??= Date.now();
			if (Date.now() - noLiveSince >= NO_LIVE_SESSION_GRACE_MS) {
				child.kill("SIGTERM");
				return "closed";
			}
		} else {
			noLiveSince = undefined;
		}
		await wait(CONTROL_POLL_MS);
	}
	return "reconnect";
}

async function runRelayConnection(options: {
	store: MessageStore;
	endpointId: string;
	bootId: string;
	remote: string;
	port?: number;
	identity?: string;
	remoteDb?: string;
	remoteBinary?: string;
	stayAlive: boolean;
	relayGeneration: string;
	isGenerationCurrent: () => boolean;
	shouldStop: () => boolean;
	spawnSsh: PeerRelaySuccessorSpawn;
}): Promise<RelayConnectionOutcome> {
	const { store, endpointId, bootId } = options;
	const child = options.spawnSsh(
		"ssh",
		peerRelaySshArgs(options.remote, options.port, options.identity, options.remoteDb, options.remoteBinary),
		{
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	if (!child.stdin || !child.stdout || !child.stderr) throw new Error("SSH peer link did not expose stdio pipes");
	let stderrTail = Buffer.alloc(0);
	child.stderr.on("data", (chunk: Buffer | string) => {
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const combined = Buffer.concat([stderrTail, incoming]);
		stderrTail =
			combined.length <= MAX_SSH_DIAGNOSTIC_BYTES
				? combined
				: combined.subarray(combined.length - MAX_SSH_DIAGNOSTIC_BYTES);
	});
	let terminalResolve!: () => void;
	const terminal = new Promise<void>((resolve) => {
		terminalResolve = resolve;
	});
	let failure: string | undefined;
	const session = new PeerLinkSession({
		role: "initiator",
		input: child.stdout,
		output: child.stdin,
		storage: new MessageStorePeerLinkAdapter(store),
		includeUnresolvedOutbound: true,
		flushIntervalMs: CONTROL_POLL_MS,
		onLocalRecipient: (sessionId) => wakeLocalRecipient(store, sessionId),
		onState: (state, error) => {
			if (state === "ready") {
				store.updatePeerEndpointRelay(endpointId, bootId, "connected", {
					remoteStoreId: session.remoteStoreId,
				});
			}
			if (state === "failed") {
				failure = error;
				terminalResolve();
			}
			if (state === "closed") terminalResolve();
		},
	});
	child.once("close", (code, signal) => {
		if (code !== 0)
			failure = `SSH peer link exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`}`;
		terminalResolve();
	});
	child.once("error", (error) => {
		failure = error.message;
		terminalResolve();
	});
	try {
		const control = controlConnection(
			store,
			endpointId,
			child,
			options.stayAlive,
			options.relayGeneration,
			options.isGenerationCurrent,
			options.shouldStop,
		);
		const starting = session.start();
		const startOutcome = await Promise.race([starting.then(() => "started" as const), control]);
		if (startOutcome !== "started") {
			void starting.catch(() => undefined);
			return startOutcome;
		}
		const outcome = await Promise.race([terminal.then(() => "reconnect" as const), control]);
		if (failure) throw new Error(failure);
		return outcome;
	} catch (error) {
		const reason = failure ?? (error instanceof Error ? error.message : String(error));
		const diagnostic = stderrTail.toString("utf8").trim();
		throw new Error(diagnostic && !reason.includes(diagnostic) ? `${reason}: ${diagnostic}` : reason);
	} finally {
		await session.close(false);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
}

export type PeerRelaySuccessorSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

async function launchRelaySuccessor(options: {
	dbPath: string;
	endpointId: string;
	previousBootId: string;
	invocation: { command: string; args: string[] };
	spawnSuccessor: PeerRelaySuccessorSpawn;
	store: MessageStore;
	shouldStop: () => boolean;
	stopped: Promise<void>;
}): Promise<void> {
	let attempt = 0;
	let lockInspectionAttempt = 0;
	let lastDiagnostic: string | undefined;
	const publishDiagnostic = (error: unknown) => {
		const message = `Relay handoff failed: ${error instanceof Error ? error.message : String(error)}`;
		if (message === lastDiagnostic) return;
		lastDiagnostic = message;
		try {
			options.store.updatePeerEndpointRelay(options.endpointId, options.previousBootId, "error", {
				lastError: message,
			});
		} catch {
			// The endpoint lock remains authoritative if SQLite diagnostics are unavailable.
		}
	};
	const pause = (ms: number) => Promise.race([wait(ms), options.stopped]);
	const lockInspectionDelay = () => {
		const delay = SUCCESSOR_RETRY_DELAYS_MS[Math.min(lockInspectionAttempt, SUCCESSOR_RETRY_DELAYS_MS.length - 1)]!;
		lockInspectionAttempt += 1;
		return delay;
	};

	while (!options.shouldStop() && options.store.getPeerEndpoint(options.endpointId)?.desiredState === "on") {
		try {
			if (isPeerRelayLockActive(options.dbPath, options.endpointId)) return;
			lockInspectionAttempt = 0;
		} catch (error) {
			publishDiagnostic(error);
			await pause(lockInspectionDelay());
			continue;
		}

		let child: ChildProcess | undefined;
		let childFailure: Error | undefined;
		try {
			child = options.spawnSuccessor(options.invocation.command, options.invocation.args, {
				detached: true,
				stdio: "ignore",
				env: process.env,
			});
			child.once("error", (error) => {
				childFailure = error;
			});
			child.once("exit", (code, signal) => {
				if (code === 0) childFailure = new Error("successor exited before acquiring the endpoint lock");
				else {
					childFailure = new Error(
						`successor exited before acquiring the endpoint lock (${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`})`,
					);
				}
			});
			child.unref();
		} catch (error) {
			childFailure = error instanceof Error ? error : new Error(String(error));
		}

		const lockDeadline = Date.now() + SUCCESSOR_LOCK_TIMEOUT_MS;
		while (!options.shouldStop() && options.store.getPeerEndpoint(options.endpointId)?.desiredState === "on") {
			try {
				if (isPeerRelayLockActive(options.dbPath, options.endpointId)) return;
				lockInspectionAttempt = 0;
			} catch (error) {
				publishDiagnostic(error);
				await pause(lockInspectionDelay());
				continue;
			}
			if (childFailure) break;
			if (Date.now() >= lockDeadline) {
				childFailure = new Error("successor did not acquire the endpoint lock before the handoff deadline");
				try {
					child?.kill("SIGTERM");
				} catch {
					// The process may have exited between the timeout check and signal.
				}
				break;
			}
			await pause(SUCCESSOR_LOCK_POLL_MS);
		}
		if (options.shouldStop() || options.store.getPeerEndpoint(options.endpointId)?.desiredState !== "on") {
			try {
				child?.kill("SIGTERM");
			} catch {
				// The process may already have exited while the endpoint was closing.
			}
			return;
		}
		publishDiagnostic(childFailure ?? new Error("successor stopped before acquiring the endpoint lock"));
		const delay = SUCCESSOR_RETRY_DELAYS_MS[Math.min(attempt, SUCCESSOR_RETRY_DELAYS_MS.length - 1)]!;
		attempt += 1;
		await pause(delay);
	}
}

async function runPeerRelay(
	args: string[],
	defaultDbPath: string,
	spawnSuccessor: PeerRelaySuccessorSpawn,
	spawnSsh: PeerRelaySuccessorSpawn,
): Promise<void> {
	const dbPath = option(args, "--db") ?? defaultDbPath;
	const remote = requiredOption(args, "--remote");
	const port = parsePort(option(args, "--port"));
	const identity = option(args, "--identity");
	const remoteDb = option(args, "--remote-db");
	const remoteBinary = option(args, "--remote-binary");
	if (args.includes("--remote-binary") && !remoteBinary) throw new Error("--remote-binary requires a value");
	const endpointId = option(args, "--endpoint") ?? peerEndpointId(remote, port);
	const stayAlive = args.includes("--stay-alive");
	const suppliedGeneration = option(args, "--generation");
	const generationCommand = option(args, "--generation-command") ?? process.execPath;
	const suppliedGenerationArgs = option(args, "--generation-args");
	const generationInvocation = {
		command: generationCommand,
		args: suppliedGenerationArgs ? decodePeerRelayGenerationArgs(suppliedGenerationArgs) : peerRelayProcessArgs(),
	};
	const relayGeneration = suppliedGeneration ?? peerRelayGeneration(generationInvocation);
	const isGenerationCurrent = () => peerRelayGenerationMatches(relayGeneration, generationInvocation);
	const store = new MessageStore(dbPath);
	const bootId = randomUUID();
	store.upsertPeerEndpoint(endpointId, remote, port);
	let stopping = false;
	let resolveStop!: () => void;
	const stopped = new Promise<void>((resolve) => {
		resolveStop = resolve;
	});
	let lockFailure: Error | undefined;
	const requestStop = () => {
		stopping = true;
		resolveStop();
	};
	let releaseRelayLock: () => Promise<void>;
	try {
		releaseRelayLock = await acquirePeerRelayLock(dbPath, endpointId, (error) => {
			lockFailure = error;
			requestStop();
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		store.close();
		if (code === "ELOCKED") return;
		throw error;
	}
	// Only the endpoint-lock owner may publish a generation. Supervisors and
	// losing relay children never rewrite the active owner's fencing token.
	store.setPeerEndpointRelayGeneration(endpointId, relayGeneration);
	if (
		!store.claimPeerEndpointRelay(endpointId, process.pid, bootId, {
			exclusiveLockHeld: true,
			generation: relayGeneration,
		})
	) {
		await releaseRelayLock();
		store.close();
		return;
	}
	process.once("SIGTERM", requestStop);
	process.once("SIGINT", requestStop);
	let attempt = 0;
	let restartForGeneration = false;
	try {
		while (!stopping) {
			const endpoint = store.getPeerEndpoint(endpointId);
			if (!endpoint || endpoint.desiredState === "off") break;
			if (endpoint.relayGeneration && endpoint.relayGeneration !== relayGeneration) break;
			if (!isGenerationCurrent()) {
				restartForGeneration = true;
				break;
			}
			if (!stayAlive && store.listLiveSessionPids().length === 0) break;
			const observed: PeerEndpointObservedState = attempt === 0 ? "connecting" : "reconnecting";
			store.updatePeerEndpointRelay(endpointId, bootId, observed);
			try {
				const outcome = await runRelayConnection({
					store,
					endpointId,
					bootId,
					remote,
					...(port ? { port } : {}),
					...(identity ? { identity } : {}),
					...(remoteDb ? { remoteDb } : {}),
					...(remoteBinary ? { remoteBinary } : {}),
					stayAlive,
					relayGeneration,
					isGenerationCurrent,
					shouldStop: () => stopping,
					spawnSsh,
				});
				if (outcome === "superseded") break;
				if (outcome === "generation_changed") {
					restartForGeneration = true;
					break;
				}
				if (outcome === "closed") {
					if (stopping) break;
					if (store.getPeerEndpoint(endpointId)?.desiredState === "on") continue;
					break;
				}
			} catch (error) {
				store.updatePeerEndpointRelay(endpointId, bootId, "error", {
					lastError: error instanceof Error ? error.message : String(error),
				});
			}
			const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
			attempt += 1;
			await Promise.race([wait(delay + Math.floor(Math.random() * Math.min(500, delay / 4))), stopped]);
		}
	} finally {
		const shouldHandoff = restartForGeneration && !stopping;
		if (!shouldHandoff) store.releasePeerEndpointRelay(endpointId, bootId, lockFailure ? "error" : "closed");
		await releaseRelayLock().catch(() => undefined);
		if (shouldHandoff) {
			await launchRelaySuccessor({
				dbPath,
				endpointId,
				previousBootId: bootId,
				invocation: generationInvocation,
				spawnSuccessor,
				store,
				shouldStop: () => stopping,
				stopped,
			});
			const endpointClosed = store.getPeerEndpoint(endpointId)?.desiredState !== "on";
			store.releasePeerEndpointRelay(endpointId, bootId, stopping || endpointClosed ? "closed" : "error");
		}
		process.off("SIGTERM", requestStop);
		process.off("SIGINT", requestStop);
		store.close();
	}
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runDemoCommand(command: string, args: string[], defaultDbPath: string): Promise<void> {
	const dbPath = option(args, "--db") ?? defaultDbPath;
	const store = new MessageStore(dbPath);
	try {
		switch (command) {
			case "register": {
				const sessionId = requiredOption(args, "--session");
				store.updatePresence(sessionId, "offline");
				writeJson({ storeId: store.getStoreId(), sessionId });
				return;
			}
			case "send": {
				const result = store.sendRouted(
					requiredOption(args, "--from"),
					requiredOption(args, "--to"),
					requiredOption(args, "--content"),
					args.includes("--normal") ? "normal" : "urgent",
				);
				writeJson(result);
				return;
			}
			case "drain": {
				const sessionId = requiredOption(args, "--session");
				const messages = store.drainUnread(sessionId);
				store.markDelivered(messages.map((message) => message.id));
				writeJson({ storeId: store.getStoreId(), sessionId, messages });
				return;
			}
			case "status":
				writeJson({
					storeId: store.getStoreId(),
					sessions: store.listRegisteredSessionIds(),
					routes: store.listPeerRoutes(),
					outbox: store.getPeerOutboxCounts(),
					endpoints: store.listPeerEndpoints(),
				});
				return;
			default:
				throw new Error(`unknown _peer command: ${command}`);
		}
	} finally {
		store.close();
	}
}

export type PeerCommandOptions = {
	defaultDbPath: string;
	spawnRelaySuccessor?: PeerRelaySuccessorSpawn;
	spawnSsh?: PeerRelaySuccessorSpawn;
};

export async function handlePeerCommand(args: string[], options: PeerCommandOptions): Promise<boolean> {
	if (args[0] !== "_peer") return false;
	const command = args[1];
	if (!command) throw new Error("_peer requires a command");
	if (command === "link") {
		await runPeerLinkResponder(option(args, "--db") ?? options.defaultDbPath);
		return true;
	}
	if (command === "relay") {
		await runPeerRelay(
			args.slice(2),
			options.defaultDbPath,
			options.spawnRelaySuccessor ?? spawn,
			options.spawnSsh ?? spawn,
		);
		return true;
	}
	await runDemoCommand(command, args.slice(2), options.defaultDbPath);
	return true;
}
