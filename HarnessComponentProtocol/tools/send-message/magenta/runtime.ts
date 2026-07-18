import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SshTarget } from "../../../_magenta/env/ssh.ts";
import type { PeerEndpoint, PeerMessage } from "./message-store.ts";
import { type AgentInvocationResolver, RemoteMailboxController, type RemoteMailboxSpawn } from "./remote-mailbox.ts";
import {
	formatPeerMessages,
	type PeerMessageDetails,
	SendMessageController,
	type SendMessageControllerDeps,
	type SendMessageInput,
} from "./send-message.ts";

export type MailboxSupport = {
	send(params: SendMessageInput): {
		content: { type: "text"; text: string }[];
		details: PeerMessageDetails;
	};
	registerOfflineSession(sessionId: string): void;
	unreadCountFor(sessionId: string): number;
};

export type SendMessageRuntimeSettings = SendMessageControllerDeps & {
	sshTarget?: SshTarget;
	resolveAgentInvocation?: AgentInvocationResolver;
	spawnRelay?: RemoteMailboxSpawn;
	supervisorIntervalMs?: number;
	spawnRetryMs?: number;
	onRuntime?: (runtime: SendMessageRuntime) => void;
};

export class SendMessageRuntime {
	private readonly controller: SendMessageController;
	private readonly remote?: RemoteMailboxController;
	private disposed = false;

	constructor(settings: SendMessageRuntimeSettings) {
		this.controller = new SendMessageController(settings);
		if (settings.resolveAgentInvocation) {
			this.remote = new RemoteMailboxController(settings.dbPath, {
				sshTarget: settings.sshTarget,
				resolveInvocation: settings.resolveAgentInvocation,
				spawnRelay: settings.spawnRelay,
				supervisorIntervalMs: settings.supervisorIntervalMs,
				spawnRetryMs: settings.spawnRetryMs,
			});
		}
	}

	toTool(): AgentTool {
		return this.controller.createToolDefinition();
	}

	send(params: SendMessageInput) {
		return this.controller.send(params);
	}

	registerOfflineSession(sessionId: string): void {
		this.controller.registerOfflineSession(sessionId);
	}

	unreadCountFor(sessionId: string): number {
		return this.controller.unreadCountFor(sessionId);
	}

	drainForInjection(): PeerMessage[] {
		return this.controller.drainForInjection();
	}

	formatForInjection(messages: PeerMessage[]): string {
		return formatPeerMessages(messages);
	}

	confirmDelivered(ids: string[]): void {
		this.controller.confirmDelivered(ids);
	}

	requeue(ids: string[]): void {
		this.controller.requeue(ids);
	}

	recordPresence(state: "active" | "idle" | "offline"): void {
		this.controller.recordPresence(state);
	}

	listRemoteEndpoints(): PeerEndpoint[] {
		return this.remote?.list() ?? [];
	}

	openRemoteEndpoint(endpointId?: string): PeerEndpoint[] {
		if (!this.remote) throw new Error("Remote mailbox support is not configured");
		return this.remote.open(endpointId);
	}

	closeRemoteEndpoint(endpointId?: string): PeerEndpoint[] {
		if (!this.remote) throw new Error("Remote mailbox support is not configured");
		return this.remote.close(endpointId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.remote?.shutdown();
		this.controller.shutdown();
	}
}
