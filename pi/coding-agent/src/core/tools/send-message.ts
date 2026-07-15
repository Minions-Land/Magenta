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
 *  - External notification ("internal hole-punching"): a session records its
 *    process pid and per-process boot id in the presence table. An urgent sender
 *    signals any online recipient (SIGUSR1). The recipient drains into the
 *    external-activation coordinator, which either joins the active loop at a
 *    boundary or wakes one idle loop. Liveness is probed from the pid (kill(pid, 0)),
 *    so there is no heartbeat; a dead pid simply reads as offline and the
 *    message waits in the mailbox for the session's next start.
 *
 * This controller mirrors the shape of pi's native BackgroundShellController /
 * SubAgentController: it is constructed in AgentSession with closures bound to
 * the live session (its id, its message injector), and exposes one tool.
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { type MessagePriority, MessageStore, type PresenceState } from "@magenta/harness";
import { type Static, Type } from "typebox";
import { truncateModelText } from "../background-shell-utils.ts";
import type { ToolDefinition } from "../extensions/types.ts";

/** customType used for injected peer messages. Namespaced to mark it Magenta. */
export const PEER_MESSAGE_CUSTOM_TYPE = "magenta-peer-message";

/**
 * Signal used to wake an idle recipient's process. SIGUSR1 is a user-defined
 * signal with no default meaning for our process once a handler is installed.
 * (Node's default action for an unhandled SIGUSR1 is to start the debugger, not
 * to terminate — but we always install a handler before advertising a pid.)
 */
export const WAKE_SIGNAL: NodeJS.Signals = "SIGUSR1";

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

const sendMessageSchema = Type.Object({
	to: Type.String({
		description:
			"Recipient session id. Address any known peer session by the session id it shared; sending a message does not create or manage a teammate.",
	}),
	content: Type.String({
		description: `Message content to send (the text body of the message; maximum ${MAX_PEER_MESSAGE_CONTENT_BYTES / 1024} KiB).`,
	}),
	assignmentId: Type.Optional(
		Type.String({
			description:
				"Managed teammate only: assignment id supplied by the parent. Pair with terminalStatus when reporting a terminal result.",
		}),
	),
	terminalStatus: Type.Optional(
		StringEnum(["completed", "failed", "blocked", "cancelled"] as const, {
			description:
				"Managed teammate only: structured terminal status for assignmentId. Ordinary peer messages must omit it.",
		}),
	),
	// The `urgent` parameter has been removed: every peer message is always urgent
	// (injected before the recipient's next tool-calling turn and waking an idle
	// recipient immediately). Teammate coordination is time-sensitive by nature, so a
	// low-priority/follow-up mode is intentionally not offered.
});

export type SendMessageInput = Static<typeof sendMessageSchema>;

/**
 * Internal input to {@link SendMessageController.send}. The public `send_message`
 * tool schema deliberately omits `urgent` so an agent-issued message is ALWAYS
 * urgent (steer + idle wake) — peer coordination is time-sensitive by nature.
 * The optional `urgent` here exists only for internal callers such as the
 * teammate_agent controller, which may enqueue a lower-priority assignment.
 */
export type PeerSendInput = SendMessageInput & { urgent?: boolean };

export interface PeerMessageDetails {
	id: string;
	to: string;
	from: string;
	urgent: boolean;
	/** Recipient liveness at send time: online+state, or offline. */
	recipientStatus: string;
	/** True when a wake signal was successfully delivered to an idle recipient. */
	woken: boolean;
	assignmentId?: string;
	terminalStatus?: "completed" | "failed" | "blocked" | "cancelled";
}

export interface SendMessageControllerDeps {
	/** Absolute path to the shared mailbox database. */
	dbPath: string;
	/** Managed teammate parent; when set, inbound/outbound peer traffic is parent-only. */
	managedParentSessionId?: string;
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
}

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
	private readonly managedParentSessionId?: string;
	private readonly wakeForMessages?: () => void;
	private readonly drainCap: number;
	/** Random id identifying THIS process instance, to guard wake against PID reuse. */
	private readonly bootId: string;
	private wakeHandler?: () => void;

	constructor(deps: SendMessageControllerDeps) {
		this.store = new MessageStore(deps.dbPath);
		this.getSessionId = deps.getSessionId;
		this.managedParentSessionId = deps.managedParentSessionId;
		this.wakeForMessages = deps.wakeForMessages;
		this.drainCap = deps.drainCap ?? DEFAULT_PEER_MESSAGE_DRAIN_CAP;
		this.bootId = randomUUID();

		// Install the wake-signal handler BEFORE any presence row advertises our pid,
		// so a sender can never signal us before we can handle it. The handler is
		// idempotent and self-verifying: it only acts if the presence row still names
		// this exact process (pid + bootId), guarding against a signal aimed at a
		// prior process whose pid the OS reused for us.
		if (this.wakeForMessages) {
			this.wakeHandler = () => this.onWakeSignal();
			try {
				process.on(WAKE_SIGNAL, this.wakeHandler);
			} catch {
				// Some platforms/sandboxes disallow custom signal handlers; wake is then
				// simply unavailable and messages wait for the next natural loop.
				this.wakeHandler = undefined;
			}
		}

		// Advertise presence immediately, before the first agent loop runs. A freshly
		// started session that is just waiting for the user to type has not yet fired
		// agent_start/turn_start, so without this it would have NO presence row at all
		// and be invisible to peers: an urgent message could neither see it as idle nor
		// wake it, and would silently fall back to mailbox-only delivery. Recording
		// `idle` here (with our now-installed wake handler) closes that startup blind
		// window so a wake-capable session is reachable from the moment it exists.
		this.recordPresence("idle");
	}

	/** Whether this controller advertises a wake-capable pid (handler installed). */
	get wakeable(): boolean {
		return this.wakeHandler !== undefined;
	}

	/** Handle an incoming signal by submitting mailbox work to the activation hub. */
	private onWakeSignal(): void {
		try {
			// Guard against PID reuse: only honor the wake if the presence row still
			// identifies this exact process instance.
			const p = this.store.getPresence(this.getSessionId());
			if (!p || p.bootId !== this.bootId) return;
			this.wakeForMessages?.();
		} catch {
			// A wake must never crash the process.
		}
	}

	/** Count queued messages for any session without consuming them. */
	unreadCountFor(sessionId: string): number {
		return this.store.unreadCount(sessionId);
	}

	/**
	 * Drain this session's unread messages, claiming them as `pending`. Managed
	 * teammates accept only their parent's messages without allowing rejected
	 * senders to starve the queue. The count cap is followed by a byte cap over
	 * the rendered block; overflow is requeued in original order.
	 */
	drainForInjection(): ReturnType<MessageStore["drainUnread"]> {
		const sessionId = this.getSessionId();
		const accepted: ReturnType<MessageStore["drainUnread"]> = [];
		const unlimited = this.drainCap <= 0;
		const claim = { ownerId: this.bootId, pid: process.pid };

		while (unlimited || accepted.length < this.drainCap) {
			const remaining = unlimited ? undefined : this.drainCap - accepted.length;
			const drained = this.store.drainUnread(sessionId, remaining, claim);
			if (drained.length === 0) break;

			if (!this.managedParentSessionId) {
				accepted.push(...drained);
				break;
			}

			const parentMessages = drained.filter((message) => message.sender === this.managedParentSessionId);
			const rejected = drained.filter((message) => message.sender !== this.managedParentSessionId);
			accepted.push(...parentMessages);
			this.store.markDelivered(
				rejected.map((message) => message.id),
				this.bootId,
			);
			if (rejected.length === 0) break;
		}

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
			// Only advertise a pid when we can actually be woken via the signal path.
			const pid = this.wakeable ? process.pid : null;
			this.store.updatePresence(this.getSessionId(), state, { pid, bootId: this.bootId });
		} catch {
			// Presence is best-effort; never break the agent for it.
		}
	}

	send(params: PeerSendInput): {
		content: { type: "text"; text: string }[];
		details: PeerMessageDetails;
	} {
		const to = params.to?.trim();
		const content = params.content;
		const from = this.getSessionId();
		// Urgent by default. The public tool schema has no `urgent` field, so a message
		// sent via the send_message tool is always urgent; only internal callers (e.g.
		// teammate_agent) can pass `urgent: false` for a low-priority assignment.
		const urgent = params.urgent !== false;

		if (!to) {
			throw new Error("send_message requires a non-empty `to` (recipient session id).");
		}
		if (!content || content.trim().length === 0) {
			throw new Error("send_message requires non-empty `content`.");
		}
		const contentBytes = Buffer.byteLength(content, "utf8");
		if (contentBytes > MAX_PEER_MESSAGE_CONTENT_BYTES) {
			throw new Error(
				`send_message content is ${contentBytes} bytes; the maximum is ${MAX_PEER_MESSAGE_CONTENT_BYTES} bytes. Send a smaller excerpt or split it into multiple messages.`,
			);
		}
		if (to === from) {
			throw new Error("send_message cannot target your own session.");
		}
		if (this.managedParentSessionId && to !== this.managedParentSessionId) {
			throw new Error(
				`Managed teammate send_message may only target parent session ${this.managedParentSessionId}.`,
			);
		}
		const hasTerminalReceipt = params.assignmentId !== undefined || params.terminalStatus !== undefined;
		if (hasTerminalReceipt && !this.managedParentSessionId) {
			throw new Error("assignmentId and terminalStatus are reserved for managed teammate result receipts.");
		}
		if (hasTerminalReceipt && (!params.assignmentId?.trim() || !params.terminalStatus)) {
			throw new Error("Managed teammate terminal receipts require both assignmentId and terminalStatus.");
		}

		const priority: MessagePriority = urgent ? "urgent" : "normal";
		const id = this.store.send(from, to, content, priority);

		// Inspect recipient presence and notify any online process for urgent work.
		// Active notification closes the final-turn race; the recipient coordinator
		// decides whether to queue at a boundary or wake an idle loop.
		const presence = this.store.getPresence(to);
		let woken = false;
		let status: string;
		if (!presence) {
			status = "no presence record yet — message waits in the mailbox";
		} else if (!presence.online) {
			status = "offline — message waits in the mailbox until they next start";
		} else {
			status = `${presence.state}`;
			if (urgent && presence.pid != null) woken = this.wakeRecipient(presence.pid);
		}

		const urgentNote = urgent ? " [urgent]" : "";
		const wokenNote = woken ? " (woke recipient)" : "";
		return {
			content: [
				{ type: "text", text: `Message ${id} delivered to session ${to}${urgentNote} — ${status}${wokenNote}.` },
			],
			details: {
				id,
				to,
				from,
				urgent,
				recipientStatus: status,
				woken,
				...(params.assignmentId ? { assignmentId: params.assignmentId } : {}),
				...(params.terminalStatus ? { terminalStatus: params.terminalStatus } : {}),
			},
		};
	}

	/**
	 * Send the wake signal to a recipient process. Best-effort: a failure (the
	 * process died between the presence read and the signal, or we lack
	 * permission) is not an error — the message is already persisted and will be
	 * drained when the recipient next loops. Returns whether the signal was sent.
	 */
	private wakeRecipient(pid: number): boolean {
		try {
			process.kill(pid, WAKE_SIGNAL);
			return true;
		} catch {
			return false;
		}
	}

	createToolDefinition(): ToolDefinition<typeof sendMessageSchema, PeerMessageDetails> {
		return {
			name: "send_message",
			label: "Send Message",
			description:
				"Send a plain-text message to any known peer agent session. This is an urgent shared-mailbox data plane only: it does not create, register, or manage a teammate. Every message is injected before the recipient's next tool-calling turn and immediately wakes an idle recipient. Your own session id is filled in automatically as the sender. The result reports the recipient's presence (active, idle, or offline). Use teammate_agent separately when the parent must create or control a managed child session.",
			promptSnippet: "Send an urgent mailbox message to a known peer agent session",
			promptGuidelines: [
				"Use send_message to coordinate with any known peer session: ask for help, share findings, or reply to a peer message.",
				"send_message never creates or manages a teammate. Use teammate_agent when you need the parent-managed child-session control plane.",
				"Messages you receive from peers are injected automatically at the start of your next loop; you do not poll for them.",
				"All messages are urgent: they are injected before the recipient's next tool-calling turn, and an idle recipient is woken immediately. This is the only public delivery mode.",
				"Each injected message shows the sender's presence (active/idle/offline). If a sender is offline, a reply will wait until they come back, so decide accordingly.",
				"Address the recipient by its known session id in `to`. Your own session id is attached as the sender automatically.",
			],
			parameters: sendMessageSchema,
			execute: async (_toolCallId, params) => {
				return this.send(params);
			},
		};
	}

	shutdown(): void {
		// Deregister the wake-signal handler so a stray signal after shutdown cannot
		// hit a torn-down controller.
		if (this.wakeHandler) {
			try {
				process.off(WAKE_SIGNAL, this.wakeHandler);
			} catch {
				// ignore
			}
			this.wakeHandler = undefined;
		}
		// Best-effort: mark this session offline so peers stop expecting replies and
		// stop trying to signal our (soon-to-be-freed) pid.
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

function renderPeerMessages(messages: DrainedMessage[]): string {
	if (messages.length === 0) return "";
	const header =
		messages.length === 1
			? "📨 You have a new message from a peer agent:"
			: `📨 You have ${messages.length} new messages from peer agents:`;
	const body = messages
		.map((m) => `— from session ${m.sender} (sent ${m.createdAt}, sender ${presenceClause(m)}):\n${m.content}`)
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
