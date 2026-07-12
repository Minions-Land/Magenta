import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundEventManager } from "../src/core/background-events.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	BackgroundShellController,
	type BackgroundShellEventSnapshot,
	type BackgroundShellReturnMessage,
} from "../src/core/tools/bg-shell.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		signal: undefined,
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme: {} as ExtensionContext["ui"]["theme"],
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		},
	};
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("built-in bg_shell tool", () => {
	let tempDir: string;
	let manager: BackgroundEventManager;
	let controller: BackgroundShellController;
	let returned: BackgroundShellReturnMessage[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-bg-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		manager = new BackgroundEventManager();
		returned = [];
		controller = new BackgroundShellController(manager, {
			sendMessage: (message, options) => {
				returned.push({ message, options: options ?? {} });
			},
		});
	});

	afterEach(() => {
		controller.shutdown();
		manager.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("starts, waits for, and reports a completed command", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const start = await tool.execute(
			"call-start",
			{ action: "start", command: "printf bg-ok" },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		expect(eventId).toMatch(/^bg_/);
		expect(textOf(start)).toContain(`Started background event ${eventId}`);

		const waited = await tool.execute(
			"call-wait",
			{ action: "wait", eventId, waitTimeoutSeconds: 5 },
			undefined,
			undefined,
			ctx,
		);
		expect(textOf(waited)).toContain("Status: exited");
		expect(textOf(waited)).toContain("bg-ok");

		const status = await tool.execute("call-status", { action: "status" }, undefined, undefined, ctx);
		expect(textOf(status)).toContain(eventId);
		expect(textOf(status)).toContain("exited");
	});

	it("cancels a running command", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const start = await tool.execute(
			"call-start",
			{ action: "start", command: 'node -e "setTimeout(()=>{}, 30000)"' },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;

		const cancelled = await tool.execute("call-cancel", { action: "cancel", eventId }, undefined, undefined, ctx);
		expect(textOf(cancelled)).toContain(`Cancelled background event ${eventId}`);
		expect(cancelled.details?.status).toBe("cancelled");

		const status = await tool.execute("call-status", { action: "status", eventId }, undefined, undefined, ctx);
		expect(textOf(status)).toContain("Status: cancelled");
	});

	it("parses progress from output and reports it while running", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		// Emit a progress token, then stay alive so the event is still running.
		const start = await tool.execute(
			"call-start",
			{ action: "start", command: 'printf "working 42%%\\n"; node -e "setTimeout(()=>{}, 30000)"' },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;

		try {
			let statusText = "";
			await waitUntil(async () => {
				const status = await tool.execute("call-status", { action: "status", eventId }, undefined, undefined, ctx);
				statusText = textOf(status);
				return statusText.includes("Progress:");
			}, 5000);

			expect(statusText).toContain("Status: running");
			expect(statusText).toContain("Progress:");
			expect(statusText).toContain("42%");
		} finally {
			await tool.execute("call-cancel", { action: "cancel", eventId }, undefined, undefined, ctx);
		}
	});

	it("uses @@progress markers and hides them from output", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const start = await tool.execute(
			"call-start",
			{
				action: "start",
				command: 'printf "@@progress 0.8\\nreal-output-line\\n"; node -e "setTimeout(()=>{}, 30000)"',
			},
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;

		try {
			let statusText = "";
			await waitUntil(async () => {
				const status = await tool.execute("call-status", { action: "status", eventId }, undefined, undefined, ctx);
				statusText = textOf(status);
				return statusText.includes("Progress:");
			}, 5000);

			expect(statusText).toContain("80%");
			// Marker-backed progress carries no hint word (only time estimates do).
			expect(statusText).not.toContain("estimated");
			// Marker line is stripped from the output tail; real output survives.
			// (The `Command:` echo naturally still contains the literal command text,
			// so only inspect the Output section for leaked markers.)
			const outputSection = statusText.slice(statusText.indexOf("Output:"));
			expect(outputSection).toContain("real-output-line");
			expect(outputSection).not.toContain("@@progress");
		} finally {
			await tool.execute("call-cancel", { action: "cancel", eventId }, undefined, undefined, ctx);
		}
	});

	it("falls back to a time-based estimate hinted estimated when expectedSeconds is set", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		// No progress in output, so the estimate comes purely from expectedSeconds.
		const start = await tool.execute(
			"call-start",
			{ action: "start", command: 'node -e "setTimeout(()=>{}, 30000)"', expectedSeconds: 120 },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;

		try {
			let statusText = "";
			await waitUntil(async () => {
				const status = await tool.execute("call-status", { action: "status", eventId }, undefined, undefined, ctx);
				statusText = textOf(status);
				return statusText.includes("Progress:");
			}, 5000);

			expect(statusText).toContain("Status: running");
			expect(statusText).toContain("estimated");
		} finally {
			await tool.execute("call-cancel", { action: "cancel", eventId }, undefined, undefined, ctx);
		}
	});

	it("returns completed output to the main session when requested", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const start = await tool.execute(
			"call-start",
			{
				action: "start",
				command: "printf returned-bg",
				returnToMain: true,
				returnDelivery: "nextTurn",
			},
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;

		await tool.execute("call-wait", { action: "wait", eventId, waitTimeoutSeconds: 5 }, undefined, undefined, ctx);
		await waitUntil(() => returned.length === 1);

		expect(returned[0]?.message.customType).toBe("bg-shell-return");
		expect(returned[0]?.message.content).toContain("returned-bg");
		expect(returned[0]?.message.details).toMatchObject({ id: eventId, status: "exited", exitCode: 0 });
		expect(returned[0]?.options).toMatchObject({ deliverAs: "nextTurn", triggerTurn: false });

		// The delivered payload must be structured-cloneable — it is posted to the
		// main agent, and a live event (ChildProcess/WriteStream/Timer/waiter
		// callbacks) would throw "could not be cloned".
		expect(() => structuredClone(returned[0]?.message.details)).not.toThrow();

		// eventData is a plain-data snapshot: it carries the renderer fields but
		// none of the non-cloneable live-event handles.
		const eventData = (returned[0]?.message.details as { eventData: BackgroundShellEventSnapshot } | undefined)
			?.eventData;
		expect(eventData).toMatchObject({ id: eventId, status: "exited", exitCode: 0, command: "printf returned-bg" });
		expect(eventData).not.toHaveProperty("child");
		expect(eventData).not.toHaveProperty("log");
		expect(eventData).not.toHaveProperty("timeout");
		expect(eventData).not.toHaveProperty("waiters");
	});

	it("bounds model-visible return output while retaining the full expandable snapshot", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(20000) + 'TAIL-MARKER')"`;

		const start = await tool.execute(
			"call-start-large",
			{ action: "start", command, returnToMain: true, returnDelivery: "nextTurn" },
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		await tool.execute(
			"call-wait-large",
			{ action: "wait", eventId, waitTimeoutSeconds: 5 },
			undefined,
			undefined,
			ctx,
		);
		await waitUntil(() => returned.length === 1);

		const returnedMessage = returned[0]?.message;
		expect(Buffer.byteLength(returnedMessage?.content ?? "", "utf8")).toBeLessThan(12 * 1024);
		expect(returnedMessage?.content).toContain("TAIL-MARKER");
		expect(returnedMessage?.content).toContain("Output shortened");
		const eventData = (returnedMessage?.details as { eventData?: BackgroundShellEventSnapshot } | undefined)
			?.eventData;
		expect(Buffer.byteLength(eventData?.tail ?? "", "utf8")).toBeGreaterThan(20_000);
	});

	it("caps the complete return when instruction and metadata are huge", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);
		const label = `large-label-${"l".repeat(20_000)}`;

		const start = await tool.execute(
			"call-start-huge-metadata",
			{
				action: "start",
				command: "printf METADATA-TAIL",
				label,
				returnToMain: true,
				returnDelivery: "nextTurn",
				returnInstruction: `instruction-${"i".repeat(30_000)}`,
			},
			undefined,
			undefined,
			ctx,
		);
		const eventId = start.details?.id as string;
		await tool.execute(
			"call-wait-huge-metadata",
			{ action: "wait", eventId, waitTimeoutSeconds: 5 },
			undefined,
			undefined,
			ctx,
		);
		await waitUntil(() => returned.length === 1);

		const returnedMessage = returned[0]?.message;
		expect(Buffer.byteLength(returnedMessage?.content ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
		expect(returnedMessage?.content).toContain("Model-visible result shortened");
		expect(returnedMessage?.content).toContain("METADATA-TAIL");
		const details = returnedMessage?.details as
			| { instruction?: string; eventData?: BackgroundShellEventSnapshot }
			| undefined;
		expect(Buffer.byteLength(details?.instruction ?? "", "utf8")).toBeLessThanOrEqual(2 * 1024);
		expect(details?.eventData?.label).toBe(label);

		const status = await tool.execute("call-status-huge", { action: "status" }, undefined, undefined, ctx);
		expect(Buffer.byteLength(textOf(status), "utf8")).toBeLessThanOrEqual(8 * 1024);
	});

	it("updates session defaults with config action", async () => {
		const tool = controller.createToolDefinition();
		const ctx = createContext(tempDir);

		const result = await tool.execute(
			"call-config",
			{
				action: "config",
				defaultTimeoutSeconds: 1,
				defaultWaitTimeoutSeconds: 2,
				defaultReturnToMain: true,
				defaultReturnDelivery: "nextTurn",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(textOf(result)).toContain("defaultTimeoutSeconds: 1");
		expect(textOf(result)).toContain("defaultWaitTimeoutSeconds: 2");
		expect(textOf(result)).toContain("defaultReturnToMain: true");
		expect(textOf(result)).toContain("defaultReturnDelivery: nextTurn");
	});
});
