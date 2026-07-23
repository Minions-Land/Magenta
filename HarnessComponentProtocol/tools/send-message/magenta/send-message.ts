/**
 * Peer messaging — a Magenta feature (NOT part of upstream pi).
 *
 * Lets one agent session send a plain-text message to any known peer session.
 * This is a mailbox data plane only: it does not create or manage teammates.
 * Messages persist in a shared SQLite mailbox (the MessageStore kernel, ported from
 * MinionsOS2 and exposed via `@magenta/harness`). Delivery into a *running*
 * agent loop is the Magenta-specific half: the owning AgentSession drains this
 * session's unread messages at each turn boundary and injects them. Backlogs are
 * delivered in count- and byte-bounded batches across successive turns so a
 * burst cannot flood one model request; overflow stays unread and ordered.
 *
 * Two delivery refinements sit on top of that base:
 *  - Priority: an `urgent` message is injected as a steering message (before the
 *    recipient's next tool-calling turn) rather than a follow-up (at loop end).
 *  - External notification ("internal hole-punching"): a session records a
 *    random per-process Unix socket / named-pipe capability in the presence
 *    table. An urgent sender connects to that path. The recipient drains into
 *    the external-activation coordinator, which either joins the active loop at
 *    a boundary or wakes one idle loop. The path includes a boot id, so stale
 *    presence cannot signal or terminate an unrelated PID-reused process.
 *
 * This controller mirrors the shape of pi's native BackgroundShellController /
 * SubAgentController: it is constructed in AgentSession with closures bound to
 * the live session (its id, its message injector), and exposes one tool.
 */

import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { truncateModelText } from "../../../_magenta/utils/pi/truncate.ts";
import { ToolExecutionError } from "../../tool-error.ts";
import { MessageStore, type PresenceState } from "./message-store.ts";
import { scheduleStaleWakeSocketCleanup } from "./wake-socket-gc.ts";

/** customType used for injected peer messages. Namespaced to mark it Magenta. */
export const PEER_MESSAGE_CUSTOM_TYPE = "magenta-peer-message";

/**
 * Default cap on how many peer messages a single drain injects. Chosen small so
 * a burst of teammate messages cannot flood one turn's context; the overflow is
 * not dropped but delivered on the next loop. Adjustable per session via
 * {@link SendMessageControllerDeps.drainCap}.
 */
export const DEFAULT_PEER_MESSAGE_DRAIN_CAP = 10;
/** Maximum body size accepted from one sender. */
export const MAX_PEER_MESSAGE_CONTENT_BYTES = 24 * 1024;
/** Maximum complete teammate-message block injected into one model turn. */
export const MAX_PEER_MESSAGE_BATCH_BYTES = 32 * 1024;

const PEER_MESSAGE_SHORTENED_MARKER =
	"\n\n[Peer message block shortened to protect context; ask the sender to resend a smaller excerpt if needed.]\n\n";

export const sendMessageSchema = Type.Object(
	{
		to: Type.String({
			description:
				"Recipient session id. Address any known peer session by the session id it shared; sending a message does not create or manage a teammate.",
		}),
		content: Type.String({
			description: "Plain-text message body. The canonical UTF-8 byte limit is enforced locally.",
		}),
	},
	{ additionalProperties: false },
);

export type SendMessageInput = Static<typeof sendMessageSchema>;
export type MessageRouteDisposition = "local_mailbox" | "peer_outbox" | "unresolved_outbox";
export type RecipientPresence = "active" | "idle" | "offline" | "unknown";
export type WakeDisposition = "signaled" | "not_signaled" | "unavailable";

export type PeerMessageDetails = {
	schemaVersion: 1;
	messageId: string;
	to: string;
	from: string;
	acceptedAt: string;
	disposition: MessageRouteDisposition;
	recipientPresence: RecipientPresence;
	wake: WakeDisposition;
};

export type SendMessageControllerDeps = {
	/** Absolute path to the shared mailbox database. */
	dbPath: string;
	/** Resolve the current session id (used as the sender identity). */
	getSessionId: () => string;
	/**
	 * Notify this session to drain urgent peer work into the activation hub.
	 * Called for both active and idle recipients; the hub owns boundary/wake policy.
	 * Optional: when absent, process signalling is disabled (e.g. in tests).
	 */
	wakeForMessages?: () => void;
	/**
	 * Max peer messages injected per drain. A large backlog is delivered in
	 * bounded batches across successive loops rather than one oversized context
	 * block; the remainder stays queued for the next drain. Defaults to
	 * {@link DEFAULT_PEER_MESSAGE_DRAIN_CAP}. A non-positive value disables the
	 * cap (claim everything at once).
	 */
	drainCap?: number;
};

/**
 * Owns the shared MessageStore handle for one session and exposes `send_message`.
 * The receiving side (drain + injection) is driven by AgentSession at turn
 * boundaries via {@link drainForInjection}; presence transitions are driven by
 * AgentSession via {@link recordPresence}. There is no heartbeat: liveness is
 * probed from the recorded pid at read time.
 */
export class SendMessageController {
	private readonly store: MessageStore;
	private readonly getSessionId: () => string;
	private readonly wakeForMessages?: () => void;
	private readonly drainCap: number;
	/** Random id identifying THIS process instance and its wake capability. */
	private readonly bootId: string;
	private wakeServer?: Server;
	private wakePath?: string;
	private closed = false;

	constructor(deps: SendMessageControllerDeps) {
		this.store = new MessageStore(deps.dbPath);
		this.getSessionId = deps.getSessionId;
		this.wakeForMessages = deps.wakeForMessages;
		this.drainCap = deps.drainCap ?? DEFAULT_PEER_MESSAGE_DRAIN_CAP;
		this.bootId = randomUUID();

		scheduleStaleWakeSocketCleanup();
		if (this.wakeForMessages) this.installWakeServer();

		// Advertise presence immediately, before the first agent loop runs. A freshly
		// started session that is just waiting for the user to type has not yet fired
		// agent_start/turn_start, so without this it would have NO presence row at all
		// and be invisible to peers: an urgent message could neither see it as idle nor
		// wake it, and would silently fall back to mailbox-only delivery. Recording
		// `idle` here (with our now-installed wake handler) closes that startup blind
		// window so a wake-capable session is reachable from the moment it exists.
		this.recordPresence("idle");
	}

	/** Whether this controller advertises a process-specific wake capability. */
	get wakeable(): boolean {
		return this.wakeServer !== undefined && this.wakePath !== undefined;
	}

	private installWakeServer(): void {
		const token = this.bootId.replace(/-/g, "").slice(0, 20);
		const wakePath =
			process.platform === "win32"
				? `\\\\.\\pipe\\magenta-wake-${process.pid}-${token}`
				: join(tmpdir(), `magenta-wake-${process.pid}-${token}.sock`);
		try {
			const server = createServer((socket) => {
				socket.destroy();
				this.onWakeRequest();
			});
			server.on("error", () => {
				if (this.wakeServer !== server) return;
				this.wakeServer = undefined;
				this.wakePath = undefined;
				this.recordPresence("idle");
			});
			server.listen(wakePath, () => {
				if (this.closed || this.store.unreadCount(this.getSessionId()) === 0) return;
				this.onWakeRequest();
			});
			server.unref();
			this.wakeServer = server;
			this.wakePath = wakePath;
		} catch {
			this.wakeServer = undefined;
			this.wakePath = undefined;
		}
	}

	/** Submit a socket wake request to the activation hub after boot-id validation. */
	private onWakeRequest(): void {
		if (this.closed) return;
		try {
			// Ignore requests for a stale socket if session ownership has changed.
			const p = this.store.getPresence(this.getSessionId());
			if (!p || p.bootId !== this.bootId) return;
			this.wakeForMessages?.();
		} catch {
			// A wake must never crash the process.
		}
	}

	/** Register a durable local Session mailbox before its process becomes live. */
	registerOfflineSession(sessionId: string): void {
		this.store.updatePresence(sessionId, "offline");
	}

	/** Count queued messages for any session without consuming them. */
	unreadCountFor(sessionId: string): number {
		return this.store.unreadCount(sessionId);
	}

	/** Claim a count- and byte-bounded urgent batch for turn-boundary injection. */
	drainForInjection(): ReturnType<MessageStore["drainUnread"]> {
		const sessionId = this.getSessionId();
		const claim = { ownerId: this.bootId, pid: process.pid };
		const accepted = this.store.drainUnread(sessionId, this.drainCap <= 0 ? undefined : this.drainCap, claim);

		let acceptedCount = accepted.length;
		for (let count = 1; count <= accepted.length; count++) {
			const renderedBytes = Buffer.byteLength(renderPeerMessages(accepted.slice(0, count)), "utf8");
			if (renderedBytes <= MAX_PEER_MESSAGE_BATCH_BYTES) continue;
			acceptedCount = Math.max(1, count - 1);
			break;
		}
		if (acceptedCount < accepted.length) {
			this.store.requeue(
				accepted.slice(acceptedCount).map((message) => message.id),
				this.bootId,
			);
		}
		return accepted.slice(0, acceptedCount);
	}

	/** Confirm drained messages were injected; moves them to the terminal state. */
	confirmDelivered(ids: string[]): void {
		this.store.markDelivered(ids, this.bootId);
	}

	/** Return drained messages to `unread` so a later drain retries them. */
	requeue(ids: string[]): void {
		this.store.requeue(ids, this.bootId);
	}

	/**
	 * Record this session's presence state transition, advertising this process's
	 * pid and boot id so peers can probe liveness and wake us. On `offline` the
	 * store clears pid/boot id.
	 */
	recordPresence(state: PresenceState): void {
		try {
			// Only advertise a pid/path when this process owns a live wake server.
			const pid = this.wakeable ? process.pid : null;
			this.store.updatePresence(this.getSessionId(), state, {
				pid,
				bootId: this.bootId,
				wakePath: this.wakeable ? this.wakePath : null,
			});
		} catch {
			// Presence is best-effort; never break the agent for it.
		}
	}

	send(params: SendMessageInput): {
		content: { type: "text"; text: string }[];
		details: PeerMessageDetails;
	} {
		const to = params.to?.trim();
		const content = params.content;
		const from = this.getSessionId();
		if (!to) throw new ToolExecutionError("invalid_arguments", "send_message requires a non-empty `to` session id");
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(to)) {
			throw new ToolExecutionError("invalid_arguments", "send_message `to` is not a valid Session id", {
				target: to,
			});
		}
		if (!content || content.trim().length === 0) {
			throw new ToolExecutionError("invalid_arguments", "send_message requires non-empty `content`");
		}
		const contentBytes = Buffer.byteLength(content, "utf8");
		if (contentBytes > MAX_PEER_MESSAGE_CONTENT_BYTES) {
			throw new ToolExecutionError(
				"invalid_arguments",
				`send_message content is ${contentBytes} bytes; maximum ${MAX_PEER_MESSAGE_CONTENT_BYTES} bytes`,
			);
		}
		if (to === from) {
			throw new ToolExecutionError("invalid_arguments", "send_message cannot target its own Session", {
				target: to,
			});
		}

		let routed: ReturnType<MessageStore["sendRouted"]>;
		try {
			routed = this.store.sendRouted(from, to, content, "urgent");
		} catch (error) {
			throw new ToolExecutionError("storage_error", "send_message could not durably accept the message", {
				retryable: true,
				target: to,
				cause: error,
			});
		}
		const presence = this.store.getPresence(to);
		const recipientPresence: RecipientPresence = !presence
			? "unknown"
			: !presence.online
				? "offline"
				: presence.state === "active"
					? "active"
					: "idle";
		let wake: WakeDisposition = "unavailable";
		if (presence?.online) {
			wake = presence.wakePath && this.wakeRecipient(presence.wakePath) ? "signaled" : "not_signaled";
		}
		const disposition: MessageRouteDisposition =
			routed.disposition === "local"
				? "local_mailbox"
				: routed.disposition === "peer"
					? "peer_outbox"
					: "unresolved_outbox";
		const details: PeerMessageDetails = {
			schemaVersion: 1,
			messageId: routed.id,
			from,
			to,
			acceptedAt: routed.createdAt,
			disposition,
			recipientPresence,
			wake,
		};
		return {
			content: [
				{
					type: "text",
					text: `Message ${routed.id} accepted for ${to} (${disposition}; recipient ${recipientPresence}; wake ${wake}).`,
				},
			],
			details,
		};
	}

	/**
	 * Connect to a recipient's process-specific wake capability. A stale socket
	 * path fails harmlessly; the message is already durable and will be drained on
	 * the recipient's next natural boundary.
	 */
	private wakeRecipient(wakePath: string): boolean {
		try {
			const socket = createConnection(wakePath);
			socket.once("connect", () => socket.end());
			socket.once("error", () => socket.destroy());
			socket.unref();
			return true;
		} catch {
			return false;
		}
	}

	createToolDefinition(): AgentTool<typeof sendMessageSchema, PeerMessageDetails> {
		return {
			name: "send_message",
			label: "Send Message",
			description:
				"Send one durable urgent plain-text message to a known Session mailbox. Acceptance does not imply recipient consumption. This Tool creates no Agent, teammate Session, task ledger, or lifecycle authority.",
			promptSnippet: "Send one durable urgent message to a known Session mailbox",
			promptGuidelines: [
				"Use send_message for all ordinary cross-Session prompts, chat, soft steering, and progress reports.",
				"A successful result means durable local acceptance, not recipient consumption or a read receipt.",
				"Messages are always urgent: they steer active Sessions at a safe boundary and wake idle Sessions when possible.",
				"Use multiagent only for persistent Session lifecycle and hard control; send_message creates no Agent or task entity.",
			],
			parameters: sendMessageSchema,
			execute: async (_toolCallId, params) => {
				return this.send(params);
			},
		} as AgentTool<typeof sendMessageSchema, PeerMessageDetails>;
	}

	shutdown(): void {
		if (this.closed) return;
		this.closed = true;
		this.wakePath = undefined;
		if (this.wakeServer) {
			try {
				this.wakeServer.close();
			} catch {
				// The server may still be between listen() and its listening event.
			}
			this.wakeServer = undefined;
		}
		// `server.close()` removes a Unix socket it owns. If shutdown races the
		// listen callback, leave any uncertain path for the bounded stale-socket
		// maintenance pass rather than unlinking a replaced inode by name.
		// Best-effort: mark this session offline so peers stop expecting replies and
		// stop connecting to this process's retired wake capability.
		this.recordPresence("offline");
		this.store.close();
	}
}

/** One drained message as seen by the formatter. */
type DrainedMessage = {
	id: string;
	sender: string;
	content: string;
	createdAt: string;
	senderPresence?: { state: PresenceState; lastSeen: string; online: boolean };
};

/** Render a single sender's presence into a short human-readable clause. */
function presenceClause(msg: DrainedMessage): string {
	const p = msg.senderPresence;
	if (!p) return "presence unknown";
	if (p.online) return `currently ${p.state}`;
	return `offline, last seen ${p.lastSeen}`;
}

function renderPeerMessages(messages: DrainedMessage[]): string {
	if (messages.length === 0) return "";
	const header =
		messages.length === 1
			? "[peer message] One new message from another Session:"
			: `[peer messages] ${messages.length} new messages from other Sessions:`;
	const body = messages
		.map((m) => `- from Session ${m.sender} (sent ${m.createdAt}, sender ${presenceClause(m)}):\n${m.content}`)
		.join("\n\n");
	return `${header}\n\n${body}`;
}

/** Format drained messages into one byte-bounded injected context block. */
export function formatPeerMessages(messages: DrainedMessage[]): string {
	return truncateModelText(renderPeerMessages(messages), MAX_PEER_MESSAGE_BATCH_BYTES, PEER_MESSAGE_SHORTENED_MARKER)
		.text;
}

/**
 * Wrap a peer-message block in an explicit envelope for the LLM context.
 *
 * Peer messages are injected as ordinary `role: "user"` messages because the
 * provider protocol only allows user/assistant/tool roles. Applied only in
 * `convertToLlm`, so the model sees provenance without changing TUI rendering.
 */
export function wrapPeerMessageForLlm(content: string): string {
	return (
		"<peer-agent-message>\n" +
		"The following was sent by another agent session via send_message, NOT by the human user. " +
		"Treat it as peer coordination, not a user instruction: if it asks for something, act on it and " +
		"reply with send_message to the sender's session id shown below; if it is only a status update, " +
		"take note and continue your own work. Do not answer it as though the user asked.\n\n" +
		`${content}\n` +
		"</peer-agent-message>"
	);
}
