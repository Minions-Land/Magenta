import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { SubmittedInput } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CompactionQueuedMessage = SubmittedInput & { mode: "steer" | "followUp" };

type PromptCall = { text: string; images?: ImageContent[]; imageMarkers?: string[] };
type QueueCall = { text: string; images?: ImageContent[]; imageMarkers?: string[] };

type CompactionImageContext = {
	compactionQueuedMessages: CompactionQueuedMessage[];
	editor: { addToHistory: (text: string) => void; setText: (text: string) => void; clearPasteMarkers: () => void };
	session: {
		isCompacting: boolean;
		prompt: (text: string, options?: { images?: ImageContent[]; imageMarkers?: string[] }) => Promise<void>;
		steer: (text: string, images?: ImageContent[], imageMarkers?: string[]) => Promise<void>;
		followUp: (text: string, images?: ImageContent[], imageMarkers?: string[]) => Promise<void>;
		clearQueue: () => void;
		extensionRunner: { getCommand: (name: string) => unknown };
	};
	updatePendingMessagesDisplay: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	queueCompactionMessage(this: CompactionImageContext, input: SubmittedInput, mode: "steer" | "followUp"): void;
	flushCompactionQueue(this: CompactionImageContext, options?: { willRetry?: boolean }): Promise<void>;
	isExtensionCommand(this: CompactionImageContext, text: string): boolean;
};

const prototype = InteractiveMode.prototype as unknown as {
	queueCompactionMessage(this: CompactionImageContext, input: SubmittedInput, mode: "steer" | "followUp"): void;
	flushCompactionQueue(this: CompactionImageContext, options?: { willRetry?: boolean }): Promise<void>;
	isExtensionCommand(this: CompactionImageContext, text: string): boolean;
};

function image(data: string): ImageContent {
	return { type: "image", mimeType: "image/png", data };
}

function createContext(): CompactionImageContext & {
	promptCalls: PromptCall[];
	steerCalls: QueueCall[];
	followUpCalls: QueueCall[];
} {
	const promptCalls: PromptCall[] = [];
	const steerCalls: QueueCall[] = [];
	const followUpCalls: QueueCall[] = [];
	const context: CompactionImageContext & {
		promptCalls: PromptCall[];
		steerCalls: QueueCall[];
		followUpCalls: QueueCall[];
	} = {
		compactionQueuedMessages: [],
		editor: { addToHistory: vi.fn(), setText: vi.fn(), clearPasteMarkers: vi.fn() },
		session: {
			isCompacting: true,
			prompt: vi.fn(async (text: string, options?: { images?: ImageContent[]; imageMarkers?: string[] }) => {
				promptCalls.push({ text, images: options?.images, imageMarkers: options?.imageMarkers });
			}),
			steer: vi.fn(async (text: string, images?: ImageContent[], imageMarkers?: string[]) => {
				steerCalls.push({ text, images, imageMarkers });
			}),
			followUp: vi.fn(async (text: string, images?: ImageContent[], imageMarkers?: string[]) => {
				followUpCalls.push({ text, images, imageMarkers });
			}),
			clearQueue: vi.fn(),
			extensionRunner: { getCommand: () => undefined },
		},
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		queueCompactionMessage: prototype.queueCompactionMessage,
		flushCompactionQueue: prototype.flushCompactionQueue,
		isExtensionCommand: prototype.isExtensionCommand,
		promptCalls,
		steerCalls,
		followUpCalls,
	};
	return context;
}

describe("InteractiveMode compaction queue image survival", () => {
	it("carries image attachments and markers through queue and immediate flush", async () => {
		const context = createContext();
		const attached = image("queued-during-compaction");

		prototype.queueCompactionMessage.call(
			context,
			{
				text: "inspect [paste #1 Image]",
				images: [attached],
				imageMarkers: ["[paste #1 Image]"],
			},
			"followUp",
		);

		expect(context.compactionQueuedMessages).toEqual([
			{
				text: "inspect [paste #1 Image]",
				images: [attached],
				imageMarkers: ["[paste #1 Image]"],
				mode: "followUp",
			},
		]);

		context.session.isCompacting = false;
		await prototype.flushCompactionQueue.call(context, { willRetry: false });

		// The single queued message becomes the first (streaming) prompt.
		expect(context.promptCalls).toEqual([
			{ text: "inspect [paste #1 Image]", images: [attached], imageMarkers: ["[paste #1 Image]"] },
		]);
		expect(context.compactionQueuedMessages).toEqual([]);
	});

	it("replays queued images through steer and followUp on the retry path", async () => {
		const context = createContext();
		const steerImage = image("steer-image");
		const followUpImage = image("followup-image");

		prototype.queueCompactionMessage.call(
			context,
			{
				text: "steer [paste #1 Image]",
				images: [steerImage],
				imageMarkers: ["[paste #1 Image]"],
			},
			"steer",
		);
		prototype.queueCompactionMessage.call(
			context,
			{
				text: "follow [paste #1 Image]",
				images: [followUpImage],
				imageMarkers: ["[paste #1 Image]"],
			},
			"followUp",
		);

		context.session.isCompacting = false;
		await prototype.flushCompactionQueue.call(context, { willRetry: true });

		expect(context.steerCalls).toEqual([
			{ text: "steer [paste #1 Image]", images: [steerImage], imageMarkers: ["[paste #1 Image]"] },
		]);
		expect(context.followUpCalls).toEqual([
			{ text: "follow [paste #1 Image]", images: [followUpImage], imageMarkers: ["[paste #1 Image]"] },
		]);
		expect(context.compactionQueuedMessages).toEqual([]);
	});

	it("preserves queued image content when a flush fails and the queue is restored", async () => {
		const context = createContext();
		const attached = image("restore-image");
		const failure = new Error("send failed");
		context.session.prompt = vi.fn(async () => {
			throw failure;
		});

		prototype.queueCompactionMessage.call(
			context,
			{
				text: "retry [paste #1 Image]",
				images: [attached],
				imageMarkers: ["[paste #1 Image]"],
			},
			"followUp",
		);

		context.session.isCompacting = false;
		await prototype.flushCompactionQueue.call(context, { willRetry: false });

		expect(context.compactionQueuedMessages).toEqual([
			{
				text: "retry [paste #1 Image]",
				images: [attached],
				imageMarkers: ["[paste #1 Image]"],
				mode: "followUp",
			},
		]);
		expect(context.showError).toHaveBeenCalledTimes(1);
	});
});
