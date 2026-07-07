/**
 * Peer messaging — a Magenta feature (NOT part of upstream pi).
 *
 * Lets one agent session send a plain-text message to another session. Messages
 * persist in a shared SQLite mailbox (the MessageStore kernel, ported from
 * MinionsOS2 and exposed via `@magenta/harness`). Delivery into a *running*
 * agent loop is the Magenta-specific half: the owning AgentSession drains this
 * session's unread messages at each turn boundary and injects them as follow-up
 * context, so a teammate's message reaches the model on its next loop without
 * interrupting the tool in flight. Because messages accumulate as unread rows,
 * everything that piled up while a session was busy arrives together the moment
 * it next enters its loop.
 *
 * The store also tracks presence: each session records whether it is `active`
 * (in a loop), `idle` (alive, waiting), or `offline` (shut down), with a
 * heartbeat. Drained messages carry the sender's presence so the recipient can
 * judge whether replying is worthwhile.
 *
 * This controller mirrors the shape of pi's native BackgroundShellController /
 * SubAgentController: it is constructed in AgentSession with closures bound to
 * the live session (its id, its message injector), and exposes one tool.
 */

import { MessageStore, type PresenceState } from "@magenta/harness";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

/** customType used for injected peer messages. Namespaced to mark it Magenta. */
export const PEER_MESSAGE_CUSTOM_TYPE = "magenta-peer-message";

const sendMessageSchema = Type.Object({
	to: Type.String({
		description:
			"Recipient session id (the identity of the agent to message). Use the session id shown for the teammate you want to reach.",
	}),
	content: Type.String({
		description: "The message body to deliver to the recipient agent.",
	}),
});

export type SendMessageInput = Static<typeof sendMessageSchema>;

export interface PeerMessageDetails {
	id: string;
	to: string;
	from: string;
}

export interface SendMessageControllerDeps {
	/** Absolute path to the shared mailbox database. */
	dbPath: string;
	/** Resolve the current session id (used as the sender identity). */
	getSessionId: () => string;
	/**
	 * Heartbeat interval in ms. The controller re-stamps its current presence on
	 * this cadence so an alive-but-idle session does not decay to offline via the
	 * store's staleness window. Must be comfortably smaller than that window.
	 * Default 10s (store staleness is 30s). Set 0 to disable (tests).
	 */
	heartbeatMs?: number;
}

/**
 * Owns the shared MessageStore handle for one session and exposes `send_message`.
 * The receiving side (drain + injection) is driven by AgentSession at turn
 * boundaries via {@link drainForInjection}; presence is driven by AgentSession
 * via {@link recordPresence}, kept fresh by an internal heartbeat.
 */
export class SendMessageController {
	private readonly store: MessageStore;
	private readonly getSessionId: () => string;
	private lastState: PresenceState = "idle";
	private heartbeat?: ReturnType<typeof setInterval>;

	constructor(deps: SendMessageControllerDeps) {
		this.store = new MessageStore(deps.dbPath);
		this.getSessionId = deps.getSessionId;
		const heartbeatMs = deps.heartbeatMs ?? 10_000;
		if (heartbeatMs > 0) {
			this.heartbeat = setInterval(() => this.recordPresence(this.lastState), heartbeatMs);
			// Do not keep the process alive just for heartbeats.
			this.heartbeat.unref?.();
		}
	}

	/** Drain this session's unread messages, claiming them as `pending`. */
	drainForInjection(): ReturnType<MessageStore["drainUnread"]> {
		return this.store.drainUnread(this.getSessionId());
	}

	/** Confirm drained messages were injected; moves them to the terminal state. */
	confirmDelivered(ids: string[]): void {
		this.store.markDelivered(ids);
	}

	/** Return drained messages to `unread` so a later drain retries them. */
	requeue(ids: string[]): void {
		this.store.requeue(ids);
	}

	/** Record this session's presence (state transition or heartbeat). */
	recordPresence(state: PresenceState): void {
		this.lastState = state;
		try {
			this.store.updatePresence(this.getSessionId(), state);
		} catch {
			// Presence is best-effort; never break the agent for it.
		}
	}

	private execute(params: SendMessageInput): {
		content: { type: "text"; text: string }[];
		details: PeerMessageDetails;
	} {
		const to = params.to?.trim();
		const content = params.content;
		const from = this.getSessionId();

		if (!to) {
			throw new Error("send_message requires a non-empty `to` (recipient session id).");
		}
		if (!content || content.trim().length === 0) {
			throw new Error("send_message requires non-empty `content`.");
		}
		if (to === from) {
			throw new Error("send_message cannot target your own session.");
		}

		const id = this.store.send(from, to, content);
		// Report the recipient's current presence so the sender knows whether the
		// message will be seen soon or is waiting for an offline teammate.
		const presence = this.store.getPresence(to);
		const status = !presence
			? "recipient has no presence record yet"
			: presence.online
				? `recipient is ${presence.state}`
				: `recipient is offline (last seen ${presence.lastSeen})`;
		return {
			content: [{ type: "text", text: `Message ${id} delivered to session ${to} — ${status}.` }],
			details: { id, to, from },
		};
	}

	createToolDefinition(): ToolDefinition<typeof sendMessageSchema, PeerMessageDetails> {
		return {
			name: "send_message",
			label: "Send Message",
			description:
				"Send a plain-text message to another agent session. The message is stored in a shared mailbox and delivered to the recipient at the start of its next agent loop, without interrupting whatever it is currently doing. Your own session id is filled in automatically as the sender. The result reports the recipient's presence (active, idle, or offline) so you know whether your message will be seen soon. Use this to coordinate with a teammate session — for example to ask for help on a hard change or to answer a question a teammate sent you.",
			promptSnippet: "Send a plain-text message to another agent session",
			promptGuidelines: [
				"Use send_message to coordinate with another agent session: ask for help, share findings, or reply to a message a teammate sent you.",
				"Messages you receive from teammates are injected automatically at the start of your next loop; you do not poll for them.",
				"Each injected message shows the sender's presence (active/idle/offline). If a sender is offline, a reply will wait until they come back, so decide accordingly.",
				"Address the recipient by its session id in `to`. Your own session id is attached as the sender automatically.",
			],
			parameters: sendMessageSchema,
			execute: async (_toolCallId, params) => {
				return this.execute(params);
			},
		};
	}

	shutdown(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		// Best-effort: mark this session offline so peers stop expecting replies.
		this.recordPresence("offline");
		this.store.close();
	}
}

/** One drained message as seen by the formatter. */
interface DrainedMessage {
	id: string;
	sender: string;
	content: string;
	createdAt: string;
	senderPresence?: { state: PresenceState; lastSeen: string; online: boolean };
}

/** Render a single sender's presence into a short human-readable clause. */
function presenceClause(msg: DrainedMessage): string {
	const p = msg.senderPresence;
	if (!p) return "presence unknown";
	if (p.online) return `currently ${p.state}`;
	return `offline, last seen ${p.lastSeen}`;
}

/** Format drained messages into a single injected context block. */
export function formatPeerMessages(messages: DrainedMessage[]): string {
	if (messages.length === 0) return "";
	const header =
		messages.length === 1
			? "📨 You have a new message from a teammate agent:"
			: `📨 You have ${messages.length} new messages from teammate agents:`;
	const body = messages
		.map((m) => `— from session ${m.sender} (sent ${m.createdAt}, sender ${presenceClause(m)}):\n${m.content}`)
		.join("\n\n");
	return `${header}\n\n${body}`;
}
