/**
 * Peer messaging — a Magenta feature (NOT part of upstream pi).
 *
 * Lets one agent session send a plain-text message to another session. Messages
 * persist in a shared SQLite mailbox (the MessageStore kernel, ported from
 * MinionsOS2 and exposed via `@magenta/harness`). Delivery into a *running*
 * agent loop is the Magenta-specific half: the owning AgentSession drains this
 * session's unread messages at each turn boundary and injects them. Because
 * messages accumulate as unread rows, everything that piled up while a session
 * was busy arrives together the moment it next enters its loop.
 *
 * Two delivery refinements sit on top of that base:
 *  - Priority: an `urgent` message is injected as a steering message (before the
 *    recipient's next tool-calling turn) rather than a follow-up (at loop end).
 *  - Idle wake ("internal hole-punching"): a session records its process pid and
 *    a per-process boot id in the presence table. When a sender targets an
 *    `idle` recipient (alive but not looping), it signals that process (SIGUSR1)
 *    so it wakes and drains immediately instead of waiting for the user to
 *    prompt it again. Liveness is probed straight from the pid (kill(pid, 0)),
 *    so there is no heartbeat; a dead pid simply reads as offline and the
 *    message waits in the mailbox for the session's next start.
 *
 * This controller mirrors the shape of pi's native BackgroundShellController /
 * SubAgentController: it is constructed in AgentSession with closures bound to
 * the live session (its id, its message injector), and exposes one tool.
 */

import { randomUUID } from "node:crypto";
import { type MessagePriority, MessageStore, type PresenceState } from "@magenta/harness";
import { type Static, Type } from "typebox";
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

const sendMessageSchema = Type.Object({
	to: Type.String({
		description:
			"Recipient session id (the identity of the agent to message). Use the session id shown for the teammate you want to reach.",
	}),
	content: Type.String({
		description: "Message content to send (the text body of the message).",
	}),
	urgent: Type.Optional(
		Type.Boolean({
			description:
				"When true, deliver with priority: the message is injected before the recipient's next tool-calling turn (steering), and if the recipient is idle its process is woken immediately. When false or omitted, the message arrives at the end of the recipient's current loop (normal follow-up).",
		}),
	),
});

export type SendMessageInput = Static<typeof sendMessageSchema>;

export interface PeerMessageDetails {
	id: string;
	to: string;
	from: string;
	urgent: boolean;
	/** Recipient liveness at send time: online+state, or offline. */
	recipientStatus: string;
	/** True when a wake signal was successfully delivered to an idle recipient. */
	woken: boolean;
}

export interface SendMessageControllerDeps {
	/** Absolute path to the shared mailbox database. */
	dbPath: string;
	/** Resolve the current session id (used as the sender identity). */
	getSessionId: () => string;
	/**
	 * Wake this session so it drains and injects pending peer messages. Called
	 * when another session sends this one an urgent message while it is idle.
	 * AgentSession wires this to a no-op-if-busy prompt that triggers a turn.
	 * Optional: when absent, idle wake is disabled (e.g. in tests).
	 */
	wakeForMessages?: () => void;
	/**
	 * Report whether this session is currently streaming (in an agent loop). Used
	 * to ignore self-directed wake signals that arrive while already active.
	 */
	isStreaming?: () => boolean;
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
	private readonly wakeForMessages?: () => void;
	private readonly isStreaming?: () => boolean;
	/** Random id identifying THIS process instance, to guard wake against PID reuse. */
	private readonly bootId: string;
	private wakeHandler?: () => void;

	constructor(deps: SendMessageControllerDeps) {
		this.store = new MessageStore(deps.dbPath);
		this.getSessionId = deps.getSessionId;
		this.wakeForMessages = deps.wakeForMessages;
		this.isStreaming = deps.isStreaming;
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
	}

	/** Whether this controller advertises a wake-capable pid (handler installed). */
	get wakeable(): boolean {
		return this.wakeHandler !== undefined;
	}

	/** Handle an incoming wake signal: drain now if we are idle and it's for us. */
	private onWakeSignal(): void {
		try {
			// Guard against PID reuse: only honor the wake if the presence row still
			// identifies this exact process instance.
			const p = this.store.getPresence(this.getSessionId());
			if (!p || p.bootId !== this.bootId) return;
			// If already looping, the next turn_start will drain anyway.
			if (this.isStreaming?.()) return;
			this.wakeForMessages?.();
		} catch {
			// A wake must never crash the process.
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

	private execute(params: SendMessageInput): {
		content: { type: "text"; text: string }[];
		details: PeerMessageDetails;
	} {
		const to = params.to?.trim();
		const content = params.content;
		const from = this.getSessionId();
		const urgent = params.urgent === true;

		if (!to) {
			throw new Error("send_message requires a non-empty `to` (recipient session id).");
		}
		if (!content || content.trim().length === 0) {
			throw new Error("send_message requires non-empty `content`.");
		}
		if (to === from) {
			throw new Error("send_message cannot target your own session.");
		}

		const priority: MessagePriority = urgent ? "urgent" : "normal";
		const id = this.store.send(from, to, content, priority);

		// Inspect the recipient's presence to report status and, for urgent messages
		// to an idle recipient, wake its process so it drains immediately.
		const presence = this.store.getPresence(to);
		let woken = false;
		let status: string;
		if (!presence) {
			status = "no presence record yet — message waits in the mailbox";
		} else if (!presence.online) {
			status = "offline — message waits in the mailbox until they next start";
		} else {
			status = `${presence.state}`;
			// Wake an idle recipient only for urgent messages. An active recipient
			// will drain on its next turn without a nudge.
			if (urgent && presence.state === "idle" && presence.pid != null) {
				woken = this.wakeRecipient(presence.pid);
			}
		}

		const urgentNote = urgent ? " [urgent]" : "";
		const wokenNote = woken ? " (woke recipient)" : "";
		return {
			content: [
				{ type: "text", text: `Message ${id} delivered to session ${to}${urgentNote} — ${status}${wokenNote}.` },
			],
			details: { id, to, from, urgent, recipientStatus: status, woken },
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
				"Send a plain-text message to another agent session. The message is stored in a shared mailbox and delivered to the recipient at the start of its next agent loop, without interrupting whatever it is currently doing. Your own session id is filled in automatically as the sender. Set `urgent: true` to deliver before the recipient's next tool-calling turn and to immediately wake the recipient if it is idle (alive but waiting). The result reports the recipient's presence (active, idle, or offline) so you know whether your message will be seen soon. Use this to coordinate with a teammate session — for example to ask for help on a hard change or to answer a question a teammate sent you.",
			promptSnippet: "Send a plain-text message to another agent session",
			promptGuidelines: [
				"Use send_message to coordinate with another agent session: ask for help, share findings, or reply to a message a teammate sent you.",
				"Messages you receive from teammates are injected automatically at the start of your next loop; you do not poll for them.",
				"Set urgent: true for time-sensitive messages: they are injected before the recipient's next tool-calling turn, and an idle recipient is woken immediately instead of waiting for its next prompt. Use it sparingly — normal messages already arrive promptly at the recipient's loop boundary.",
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
