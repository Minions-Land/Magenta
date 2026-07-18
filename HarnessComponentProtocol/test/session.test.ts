import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../_magenta/env/pi/nodejs.ts";
import { JsonlSessionStorage } from "../_magenta/session/pi/jsonl-storage.ts";
import { InMemorySessionStorage } from "../_magenta/session/pi/memory-storage.ts";
import {
	buildContextEntries,
	buildSessionContext,
	defaultContextEntryTransform,
	Session,
	sessionEntryToContextMessages,
} from "../_magenta/session/pi/session.ts";
import type { CustomEntry, SessionContextBuildOptions, SessionStorage, SessionTreeEntry } from "../_magenta/types/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage, getLatestTempDir } from "./session-test-utils.ts";

async function runSessionSuite(
	name: string,
	createStorage: () => SessionStorage | Promise<SessionStorage>,
	inspect?: () => void,
) {
	describe(name, () => {
		it("appends messages and builds context in order", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		});

		it("tracks model and thinking level changes", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendModelChange("openai", "gpt-4.1");
			await session.appendThinkingLevelChange("high");
			const context = await session.buildContext();
			expect(context.thinkingLevel).toBe("high");
			expect(context.model).toEqual({ provider: "openai", modelId: "gpt-4.1" });
		});

		it("supports branching by moving the leaf and appending a new branch", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			const assistant1 = await session.appendMessage(createAssistantMessage("two"));
			await session.appendMessage(createUserMessage("three"));
			await session.moveTo(user1);
			await session.appendMessage(createAssistantMessage("branched"));
			const branch = await session.getBranch();
			expect(branch.map((entry) => entry.id)).toContain(user1);
			expect(branch.map((entry) => entry.id)).not.toContain(assistant1);
			const context = await session.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		});

		it("supports moving the leaf to root", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.moveTo(null);
			expect(await session.getLeafId()).toBeNull();
			expect((await session.buildContext()).messages).toEqual([]);
		});

		it("reconstructs compaction summaries in context", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			const user2 = await session.appendMessage(createUserMessage("three"));
			await session.appendMessage(createAssistantMessage("four"));
			await session.appendCompaction("summary", user2, 1234);
			await session.appendMessage(createUserMessage("five"));
			const context = await session.buildContext();
			expect(context.messages[0]?.role).toBe("compactionSummary");
			expect(context.messages).toHaveLength(4);
		});

		it("supports moving with branch summary entries in context", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			const summaryId = await session.moveTo(user1, { summary: "summary text" });
			expect(summaryId).toBeTruthy();
			const summaryEntry = await session.getEntry(summaryId!);
			expect(summaryEntry).toMatchObject({ type: "branch_summary", parentId: user1, fromId: user1 });
			const context = await session.buildContext();
			expect(context.messages[1]?.role).toBe("branchSummary");
		});

		it("supports custom message entries in context", async () => {
			const session = new Session(await createStorage());
			await session.appendMessage(createUserMessage("one"));
			await session.appendCustomMessageEntry("custom", "hello", true, { ok: true });
			const context = await session.buildContext();
			expect(context.messages[1]?.role).toBe("custom");
		});

		it("normalizes session names", async () => {
			const session = new Session(await createStorage());
			await session.appendSessionName(" hello\nworld\r\nagain ");
			expect(await session.getSessionName()).toBe("hello world again");
		});

		it("supports labels and session info entries without affecting context", async () => {
			const session = new Session(await createStorage());
			const user1 = await session.appendMessage(createUserMessage("one"));
			await session.appendLabel(user1, "checkpoint");
			await session.appendSessionName("name");
			const entries = await session.getEntries();
			expect(entries.some((entry) => entry.type === "label")).toBe(true);
			expect(entries.some((entry) => entry.type === "session_info")).toBe(true);
			expect(await session.getLabel(user1)).toBe("checkpoint");
			expect(await session.getSessionName()).toBe("name");
			expect((await session.buildContext()).messages).toHaveLength(1);
		});

		it("rejects labels for missing entries", async () => {
			const session = new Session(await createStorage());
			await expect(session.appendLabel("missing", "checkpoint")).rejects.toThrow("Entry missing not found");
		});

		it("persists leaf changes and appended entries via storage", async () => {
			const storage = await createStorage();
			const session = new Session(storage);
			const user1 = await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			await session.appendLabel(user1, "checkpoint");
			await session.appendSessionName("name");
			await session.moveTo(user1);
			await session.appendMessage(createAssistantMessage("branched"));
			const session2 = new Session(storage);
			const context = await session2.buildContext();
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(await session2.getLabel(user1)).toBe("checkpoint");
			expect(await session2.getSessionName()).toBe("name");
			inspect?.();
		});
	});
}

runSessionSuite("Session with in-memory storage", () => new InMemorySessionStorage());

runSessionSuite(
	"Session with JSONL storage",
	async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		return await JsonlSessionStorage.create(env, join(dir, "session.jsonl"), { cwd: dir, sessionId: "session-1" });
	},
	() => {
		const dir = getLatestTempDir();
		const filePath = join(dir, "session.jsonl");
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThan(1);
		const header = JSON.parse(lines[0]!);
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		const entries = lines.slice(1).map((line) => JSON.parse(line));
		expect(entries.some((entry) => entry.type === "leaf")).toBe(true);
		for (const entry of entries) {
			expect(entry.type).not.toBe("entry");
			expect(typeof entry.id).toBe("string");
		}
	},
);

describe("context entry transforms and custom projectors (AG-003)", () => {
	function customEntry(customType: string, id: string, data?: unknown): CustomEntry {
		return { type: "custom", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType, data };
	}

	function messageEntry(id: string, text: string): SessionTreeEntry {
		return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: createUserMessage(text) };
	}

	it("retains custom entries in the sequence but omits them from messages by default", async () => {
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendCustomEntry("note", { text: "remember" });
		await session.appendMessage(createAssistantMessage("two"));
		const entries = await session.buildContextEntries();
		expect(entries.some((entry) => entry.type === "custom")).toBe(true);
		const context = await session.buildContext();
		expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("projects custom entries via a keyed projector", async () => {
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendCustomEntry("note", { text: "projected" });
		const projector = (entry: CustomEntry): AgentMessage[] => [
			createUserMessage(String((entry.data as { text: string }).text)),
		];
		const context = await session.buildContext({ entryProjectors: { note: projector } });
		expect(context.messages.map((message) => message.role)).toEqual(["user", "user"]);
		const projected = context.messages[1];
		expect(projected?.role === "user" && projected.content).toEqual([{ type: "text", text: "projected" }]);
	});

	it("runs transforms after the default compaction selection", async () => {
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		await session.appendMessage(createAssistantMessage("four"));
		await session.appendCompaction("summary", user2, 1234);
		await session.appendMessage(createUserMessage("five"));
		// Transform sees post-compaction entries: compaction marker + kept + appended.
		const seen: string[] = [];
		const transform = (entries: SessionTreeEntry[]): SessionTreeEntry[] => {
			for (const entry of entries) seen.push(entry.type);
			return entries.filter((entry) => entry.type !== "compaction");
		};
		const context = await session.buildContext({ entryTransforms: [transform] });
		expect(seen[0]).toBe("compaction");
		expect(context.messages.some((message) => message.role === "compactionSummary")).toBe(false);
	});

	it("stacks constructor and per-call transforms in order", async () => {
		const order: string[] = [];
		const ctorTransform = (entries: SessionTreeEntry[]): SessionTreeEntry[] => {
			order.push("ctor");
			return entries;
		};
		const callTransform = (entries: SessionTreeEntry[]): SessionTreeEntry[] => {
			order.push("call");
			return entries;
		};
		const options: SessionContextBuildOptions = { entryTransforms: [ctorTransform] };
		const session = new Session(new InMemorySessionStorage(), options);
		await session.appendMessage(createUserMessage("one"));
		await session.buildContext({ entryTransforms: [callTransform] });
		expect(order).toEqual(["ctor", "call"]);
	});

	it("lets per-call projectors override same-name constructor projectors", async () => {
		const ctorProjector = (): AgentMessage[] => [createUserMessage("ctor")];
		const callProjector = (): AgentMessage[] => [createUserMessage("call")];
		const session = new Session(new InMemorySessionStorage(), { entryProjectors: { note: ctorProjector } });
		await session.appendCustomEntry("note", {});
		const context = await session.buildContext({ entryProjectors: { note: callProjector } });
		const message = context.messages[0];
		expect(message?.role === "user" && message.content).toEqual([{ type: "text", text: "call" }]);
	});

	it("defaultContextEntryTransform selects the latest compaction window", () => {
		const entries: SessionTreeEntry[] = [
			messageEntry("m1", "one"),
			messageEntry("m2", "two"),
			{
				type: "compaction",
				id: "c1",
				parentId: "m2",
				timestamp: "2026-01-01T00:00:00.000Z",
				summary: "summary",
				firstKeptEntryId: "m2",
				tokensBefore: 10,
			},
			messageEntry("m3", "three"),
		];
		const selected = defaultContextEntryTransform(entries);
		expect(selected.map((entry) => entry.id)).toEqual(["c1", "m2", "m3"]);
	});

	it("sessionEntryToContextMessages omits custom entries without a projector", () => {
		const entry = customEntry("note", "c1");
		expect(sessionEntryToContextMessages(entry, 0, [entry])).toEqual([]);
		const withData = customEntry("note", "c1", { text: "x" });
		const projected = sessionEntryToContextMessages(withData, 0, [withData], {
			entryProjectors: { note: () => [createUserMessage("projected")] },
		});
		expect(projected).toHaveLength(1);
	});

	it("passes index and entries to custom projectors and treats undefined as no messages", async () => {
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(createUserMessage("one"));
		await session.appendCustomEntry("note", { text: "projected" });
		let seenIndex = -1;
		let seenLength = -1;
		const projector = (entry: CustomEntry, index: number, entries: readonly SessionTreeEntry[]) => {
			seenIndex = index;
			seenLength = entries.length;
			return undefined;
		};
		const context = await session.buildContext({ entryProjectors: { note: projector } });
		// undefined projector result contributes no messages; only the user message remains.
		expect(context.messages.map((message) => message.role)).toEqual(["user"]);
		expect(seenIndex).toBe(1);
		expect(seenLength).toBe(2);
	});

	it("buildContextEntries applies stacked transforms on plain entry arrays", () => {
		const entries: SessionTreeEntry[] = [messageEntry("m1", "one"), customEntry("note", "c1")];
		const filtered = buildContextEntries(entries, {
			entryTransforms: [(input) => input.filter((entry) => entry_is_message(entry))],
		});
		expect(filtered.map((entry) => entry.type)).toEqual(["message"]);
		function entry_is_message(entry: SessionTreeEntry): boolean {
			return entry.type === "message";
		}
	});

	it("buildSessionContext derives runtime state from the full branch before compaction", () => {
		const entries: SessionTreeEntry[] = [
			{ type: "model_change", id: "mc", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "openai", modelId: "gpt-4.1" },
			messageEntry("m1", "one"),
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: "2026-01-01T00:00:00.000Z",
				summary: "summary",
				firstKeptEntryId: "m1",
				tokensBefore: 10,
			},
			messageEntry("m2", "two"),
		];
		const context = buildSessionContext(entries);
		// model_change precedes the compaction window but still informs runtime state.
		expect(context.model).toEqual({ provider: "openai", modelId: "gpt-4.1" });
		expect(context.messages[0]?.role).toBe("compactionSummary");
	});
});
