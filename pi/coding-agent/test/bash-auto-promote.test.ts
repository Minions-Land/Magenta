import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundEventManager } from "../src/core/background-events.ts";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { withBashAutoPromotion } from "../src/core/tools/bash.ts";
import { BackgroundShellController, type BackgroundShellReturnMessage } from "../src/core/tools/bg-shell.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function createContext(): ExtensionContext {
	return { cwd: "/tmp", hasUI: false, mode: "print" } as unknown as ExtensionContext;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A fake bash tool definition whose execute resolves on demand. */
function createControllableBash(): {
	definition: ToolDefinition<any, any, any>;
	resolveExec: (text: string, isError?: boolean) => void;
	emit: (text: string) => void;
	started: () => boolean;
	abortCount: () => number;
} {
	type FakeResult = {
		content: Array<{ type: "text"; text: string }>;
		details: unknown;
		isError?: boolean;
	};
	let resolveExec!: (result: FakeResult) => void;
	let onUpdateRef: ((u: unknown) => void) | undefined;
	let didStart = false;
	let abortCount = 0;
	const definition: ToolDefinition<any, any, any> = {
		name: "bash",
		label: "bash",
		description: "fake bash",
		parameters: {} as any,
		renderKind: "shell-output",
		execute: (_id, _params, signal, onUpdate) => {
			didStart = true;
			onUpdateRef = onUpdate as (u: unknown) => void;
			return new Promise<FakeResult>((resolve, reject) => {
				let settled = false;
				const detachAbort = () => signal?.removeEventListener("abort", onAbort);
				const onAbort = () => {
					if (settled) return;
					settled = true;
					abortCount++;
					detachAbort();
					reject(new Error("aborted"));
				};
				resolveExec = (result) => {
					if (settled) return;
					settled = true;
					detachAbort();
					resolve(result);
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	};
	return {
		definition,
		resolveExec: (text: string, isError = false) =>
			resolveExec({ content: [{ type: "text", text }], details: undefined, isError }),
		emit: (text: string) => onUpdateRef?.({ content: [{ type: "text" as const, text }] }),
		started: () => didStart,
		abortCount: () => abortCount,
	};
}

describe("bash auto-promotion", () => {
	let manager: BackgroundEventManager;
	let controller: BackgroundShellController;
	let returned: BackgroundShellReturnMessage[];

	beforeEach(() => {
		manager = new BackgroundEventManager();
		returned = [];
		controller = new BackgroundShellController(manager, {
			registerReturn: (_eventIds, message, delivery) => {
				returned.push({
					message,
					options: { deliverAs: delivery, triggerTurn: delivery !== "nextTurn" },
				});
			},
		});
	});

	afterEach(() => {
		controller.shutdown();
		manager.dispose();
	});

	it("returns inline without promotion when the command finishes before the deadline", async () => {
		const fake = createControllableBash();
		const tool = withBashAutoPromotion(fake.definition, "/tmp", {
			backgroundShell: controller,
			promoteAfterMs: 50,
		});

		const exec = tool.execute("call", { command: "echo quick" }, undefined, undefined, createContext());
		fake.resolveExec("quick-output");
		const result = await exec;

		expect(textOf(result)).toContain("quick-output");
		expect(textOf(result)).not.toContain("promoted to background");
		expect(returned).toHaveLength(0);
		expect(manager.getEvents()).toHaveLength(0);
	});

	it("promotes a slow command to a background event and auto-returns its completion", async () => {
		const fake = createControllableBash();
		const tool = withBashAutoPromotion(fake.definition, "/tmp", {
			backgroundShell: controller,
			promoteAfterMs: 20,
		});

		const exec = tool.execute("call", { command: "sleep 999" }, undefined, undefined, createContext());
		const result = await exec;

		// The inline result reports promotion; the loop is not blocked.
		expect(textOf(result)).toContain("promoted to background event");
		const events = manager.getEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.status).toBe("running");

		// The underlying command finishes later; its result auto-returns to main.
		fake.resolveExec("final-output");
		await waitUntil(() => returned.length === 1);
		expect(returned[0]?.message.customType).toBe("bg-shell-return");
		expect(returned[0]?.message.content).toContain("final-output");
		expect(manager.getEvents()[0]?.status).toBe("exited");
	});

	it("aborts the underlying execution when a promoted event is cancelled and returns once", async () => {
		const fake = createControllableBash();
		const tool = withBashAutoPromotion(fake.definition, "/tmp", {
			backgroundShell: controller,
			promoteAfterMs: 20,
		});

		await tool.execute("call", { command: "cancel-me" }, undefined, undefined, createContext());
		const event = manager.getEvents()[0];
		expect(event?.status).toBe("running");

		expect(manager.cancelEvent("shell", event!.id)).toBe(true);
		expect(fake.abortCount()).toBe(1);
		await waitUntil(() => returned.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(returned).toHaveLength(1);
		expect(returned[0]?.message.details).toMatchObject({ status: "cancelled" });
		expect(manager.getEvents()[0]?.status).toBe("cancelled");
	});

	it("aborts the underlying promoted execution on controller shutdown without returning it", async () => {
		const fake = createControllableBash();
		const tool = withBashAutoPromotion(fake.definition, "/tmp", {
			backgroundShell: controller,
			promoteAfterMs: 20,
		});

		await tool.execute("call", { command: "shutdown-me" }, undefined, undefined, createContext());
		controller.shutdown();

		expect(fake.abortCount()).toBe(1);
		expect(manager.getEvents()[0]).toMatchObject({ status: "running", activityPhase: "terminating" });
		await waitUntil(() => manager.getEvents()[0]?.status === "cancelled");
		expect(returned).toHaveLength(0);
	});

	it("relays parent cancellation before promotion", async () => {
		const fake = createControllableBash();
		const tool = withBashAutoPromotion(fake.definition, "/tmp", {
			backgroundShell: controller,
			promoteAfterMs: 100,
		});
		const parentController = new AbortController();

		const exec = tool.execute(
			"call",
			{ command: "cancel-inline" },
			parentController.signal,
			undefined,
			createContext(),
		);
		expect(fake.started()).toBe(true);
		parentController.abort();

		await expect(exec).rejects.toThrow("aborted");
		expect(fake.abortCount()).toBe(1);
		expect(manager.getEvents()).toHaveLength(0);
		expect(returned).toHaveLength(0);
	});

	it("detaches parent cancellation after promotion", async () => {
		const fake = createControllableBash();
		const tool = withBashAutoPromotion(fake.definition, "/tmp", {
			backgroundShell: controller,
			promoteAfterMs: 20,
		});
		const parentController = new AbortController();

		await tool.execute("call", { command: "keep-running" }, parentController.signal, undefined, createContext());
		parentController.abort();

		expect(fake.abortCount()).toBe(0);
		expect(manager.getEvents()[0]?.status).toBe("running");
		fake.resolveExec("completed independently");
		await waitUntil(() => returned.length === 1);
		expect(manager.getEvents()[0]?.status).toBe("exited");
	});

	it("streams output produced after promotion into the background event tail", async () => {
		const fake = createControllableBash();
		const tool = withBashAutoPromotion(fake.definition, "/tmp", {
			backgroundShell: controller,
			promoteAfterMs: 20,
		});

		const exec = tool.execute("call", { command: "long-task" }, undefined, undefined, createContext());
		await exec;
		fake.emit("progress line after promotion");
		fake.resolveExec("progress line after promotion\ndone");
		await waitUntil(() => returned.length === 1);
		expect(returned[0]?.message.content).toContain("done");
	});

	it("marks a failed promoted command as failed", async () => {
		const fake = createControllableBash();
		const tool = withBashAutoPromotion(fake.definition, "/tmp", {
			backgroundShell: controller,
			promoteAfterMs: 20,
		});

		const exec = tool.execute("call", { command: "will-fail" }, undefined, undefined, createContext());
		await exec;
		fake.resolveExec("error output", true);
		await waitUntil(() => manager.getEvents()[0]?.status === "failed");
		expect(manager.getEvents()[0]?.status).toBe("failed");
	});
});
