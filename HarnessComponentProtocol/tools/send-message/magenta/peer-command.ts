import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { shellQuote } from "../../../_magenta/env/ssh.ts";
import { MessageStore, type PeerEndpointObservedState } from "./message-store.ts";
import { peerEndpointId } from "./peer-endpoint.ts";
import { PeerLinkSession } from "./peer-link-session.ts";
import { MessageStorePeerLinkAdapter } from "./peer-link-store-adapter.ts";

const CONTROL_POLL_MS = 250;
const NO_LIVE_SESSION_GRACE_MS = 3_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

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

async function runPeerLinkResponder(dbPath: string): Promise<void> {
	const store = new MessageStore(dbPath);
	let terminalResolve!: () => void;
	let terminalReject!: (error: Error) => void;
	const terminal = new Promise<void>((resolve, reject) => {
		terminalResolve = resolve;
		terminalReject = reject;
	});
	let ready = false;
	const session = new PeerLinkSession({
		role: "responder",
		input: process.stdin,
		output: process.stdout,
		storage: new MessageStorePeerLinkAdapter(store),
		flushIntervalMs: CONTROL_POLL_MS,
		onLocalRecipient: (sessionId) => wakeLocalRecipient(store, sessionId),
		onState: (state, error) => {
			if (state === "ready") ready = true;
			if (state === "closed") terminalResolve();
			if (state === "failed") {
				if (ready) terminalResolve();
				else terminalReject(new Error(error ?? "peer link failed"));
			}
		},
	});
	try {
		await session.start();
		await terminal;
	} finally {
		await session.close(false);
		store.close();
	}
}

function relaySshArgs(
	remote: string,
	port: number | undefined,
	identity: string | undefined,
	remoteDb: string | undefined,
): string[] {
	const remoteCommand = remoteDb ? `magenta _peer link --db ${shellQuote(remoteDb)}` : "magenta _peer link";
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
	shouldStop: () => boolean,
): Promise<"closed" | "reconnect"> {
	let noLiveSince: number | undefined;
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
	stayAlive: boolean;
	shouldStop: () => boolean;
}): Promise<"closed" | "reconnect"> {
	const { store, endpointId, bootId } = options;
	const child = spawn("ssh", relaySshArgs(options.remote, options.port, options.identity, options.remoteDb), {
		stdio: ["pipe", "pipe", "inherit"],
	});
	if (!child.stdin || !child.stdout) throw new Error("SSH peer link did not expose stdio pipes");
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
	child.once("close", terminalResolve);
	child.once("error", (error) => {
		failure = error.message;
		terminalResolve();
	});
	try {
		const control = controlConnection(store, endpointId, child, options.stayAlive, options.shouldStop);
		const starting = session.start();
		const startOutcome = await Promise.race([starting.then(() => "started" as const), control]);
		if (startOutcome !== "started") {
			void starting.catch(() => undefined);
			return startOutcome;
		}
		const outcome = await Promise.race([terminal.then(() => "reconnect" as const), control]);
		if (failure) throw new Error(failure);
		return outcome;
	} finally {
		await session.close(false);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
}

async function runPeerRelay(args: string[], defaultDbPath: string): Promise<void> {
	const dbPath = option(args, "--db") ?? defaultDbPath;
	const remote = requiredOption(args, "--remote");
	const port = parsePort(option(args, "--port"));
	const identity = option(args, "--identity");
	const remoteDb = option(args, "--remote-db");
	const endpointId = option(args, "--endpoint") ?? peerEndpointId(remote, port);
	const stayAlive = args.includes("--stay-alive");
	const store = new MessageStore(dbPath);
	const bootId = randomUUID();
	store.upsertPeerEndpoint(endpointId, remote, port);
	if (!store.claimPeerEndpointRelay(endpointId, process.pid, bootId)) {
		store.close();
		return;
	}
	let stopping = false;
	let resolveStop!: () => void;
	const stopped = new Promise<void>((resolve) => {
		resolveStop = resolve;
	});
	const requestStop = () => {
		stopping = true;
		resolveStop();
	};
	process.once("SIGTERM", requestStop);
	process.once("SIGINT", requestStop);
	let attempt = 0;
	try {
		while (!stopping) {
			const endpoint = store.getPeerEndpoint(endpointId);
			if (!endpoint || endpoint.desiredState === "off") break;
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
					stayAlive,
					shouldStop: () => stopping,
				});
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
		process.off("SIGTERM", requestStop);
		process.off("SIGINT", requestStop);
		store.releasePeerEndpointRelay(endpointId, bootId, "closed");
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

export type PeerCommandOptions = { defaultDbPath: string };

export async function handlePeerCommand(args: string[], options: PeerCommandOptions): Promise<boolean> {
	if (args[0] !== "_peer") return false;
	const command = args[1];
	if (!command) throw new Error("_peer requires a command");
	if (command === "link") {
		await runPeerLinkResponder(option(args, "--db") ?? options.defaultDbPath);
		return true;
	}
	if (command === "relay") {
		await runPeerRelay(args.slice(2), options.defaultDbPath);
		return true;
	}
	await runDemoCommand(command, args.slice(2), options.defaultDbPath);
	return true;
}
