import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import type { SshTarget } from "../../../_magenta/env/ssh.ts";
import { MessageStore, type PeerEndpoint } from "./message-store.ts";
import { peerEndpointId } from "./peer-endpoint.ts";
import { encodePeerRelayGenerationArgs, isPeerRelayLockActive, peerRelayGeneration } from "./peer-relay-lock.ts";

export type RemoteMailboxSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type AgentInvocationResolver = (args: string[]) => { command: string; args: string[] };

const DEFAULT_SUPERVISOR_INTERVAL_MS = 1_000;
const DEFAULT_SPAWN_RETRY_MS = 5_000;

export class RemoteMailboxController {
	private readonly dbPath: string;
	private readonly store: MessageStore;
	private readonly spawnRelay: RemoteMailboxSpawn;
	private readonly resolveInvocation: AgentInvocationResolver;
	private readonly spawnRetryMs: number;
	private readonly spawnRetryAt = new Map<string, number>();
	private readonly supervisorTimer: NodeJS.Timeout;
	private closed = false;

	constructor(
		dbPath: string,
		options: {
			sshTarget?: SshTarget;
			spawnRelay?: RemoteMailboxSpawn;
			resolveInvocation: AgentInvocationResolver;
			supervisorIntervalMs?: number;
			spawnRetryMs?: number;
		},
	) {
		this.dbPath = dbPath;
		this.store = new MessageStore(dbPath);
		this.spawnRelay = options.spawnRelay ?? spawn;
		this.resolveInvocation = options.resolveInvocation;
		this.spawnRetryMs = options.spawnRetryMs ?? DEFAULT_SPAWN_RETRY_MS;
		if (options.sshTarget) {
			const id = peerEndpointId(options.sshTarget.remote, options.sshTarget.port);
			this.store.upsertPeerEndpoint(id, options.sshTarget.remote, options.sshTarget.port);
		}
		this.ensureOpenLinks();
		this.supervisorTimer = setInterval(
			() => this.ensureOpenLinks(),
			options.supervisorIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS,
		);
		this.supervisorTimer.unref();
	}

	list(): PeerEndpoint[] {
		return this.store.listPeerEndpoints();
	}

	open(endpointId?: string): PeerEndpoint[] {
		this.assertOpen();
		const endpoints = endpointId ? [this.requireEndpoint(endpointId)] : this.store.listPeerEndpoints();
		for (const endpoint of endpoints) this.store.setPeerEndpointDesiredState(endpoint.id, "on");
		this.ensureOpenLinks();
		return endpoints.map((endpoint) => this.store.getPeerEndpoint(endpoint.id)!);
	}

	close(endpointId?: string): PeerEndpoint[] {
		this.assertOpen();
		const endpoints = endpointId ? [this.requireEndpoint(endpointId)] : this.store.listPeerEndpoints();
		for (const endpoint of endpoints) this.store.setPeerEndpointDesiredState(endpoint.id, "off");
		return endpoints.map((endpoint) => this.store.getPeerEndpoint(endpoint.id)!);
	}

	ensureOpenLinks(): void {
		if (this.closed) return;
		const now = Date.now();
		for (const endpoint of this.store.listPeerEndpoints()) {
			if (endpoint.desiredState !== "on") {
				this.spawnRetryAt.delete(endpoint.id);
				continue;
			}
			try {
				const relayArgs = [
					"_peer",
					"relay",
					"--db",
					this.dbPath,
					"--endpoint",
					endpoint.id,
					"--remote",
					endpoint.remote,
					"--stay-alive",
				];
				if (endpoint.port) relayArgs.push("--port", String(endpoint.port));
				const generationInvocation = this.resolveInvocation(relayArgs);
				const generation = peerRelayGeneration(generationInvocation);
				const lockActive = isPeerRelayLockActive(this.dbPath, endpoint.id);
				// While the lock is held, the persisted generation describes its owner.
				// Supervisors from another installed release may share this database; if
				// they rewrote that generation, each one-second poll would supersede the
				// other's healthy relay and churn the SSH link.
				if (lockActive) {
					this.spawnRetryAt.delete(endpoint.id);
					continue;
				}
				// A pid without the endpoint lock is never ownership proof. During a
				// pre-lock upgrade it may already belong to an unrelated reused process;
				// receiver-side deduplication makes a brief old/new overlap safer than an
				// indefinitely dead link.
				if ((this.spawnRetryAt.get(endpoint.id) ?? 0) > now) continue;
				this.spawnRetryAt.set(endpoint.id, now + this.spawnRetryMs);
				const invocation = this.resolveInvocation([
					...relayArgs,
					"--generation",
					generation,
					"--generation-command",
					generationInvocation.command,
					"--generation-args",
					encodePeerRelayGenerationArgs(generationInvocation.args),
				]);
				const child = this.spawnRelay(invocation.command, invocation.args, {
					detached: true,
					stdio: "ignore",
					env: process.env,
				});
				// spawn failures are asynchronous EventEmitter errors. Always consume
				// them so a missing executable cannot terminate the parent AgentSession.
				child.once("error", () => this.spawnRetryAt.set(endpoint.id, Date.now() + this.spawnRetryMs));
				child.unref();
			} catch {
				this.spawnRetryAt.set(endpoint.id, Date.now() + this.spawnRetryMs);
			}
		}
	}

	shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.supervisorTimer);
		this.spawnRetryAt.clear();
		this.store.close();
	}

	private requireEndpoint(endpointId: string): PeerEndpoint {
		const endpoint = this.store.getPeerEndpoint(endpointId);
		if (!endpoint) throw new Error(`Unknown remote mailbox endpoint: ${endpointId}`);
		return endpoint;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("remote mailbox controller is closed");
	}
}
