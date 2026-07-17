import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { FloatingMenuBody, type FloatingMenuItem } from "../src/modes/interactive/components/floating-menu.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmittedInput = { text: string; images?: unknown[]; imageMarkers?: string[] };

type SubmitContext = {
	defaultEditor: {
		onSubmit?: (text: string) => void;
		transformImageTokenInput: (text: string) => string;
		clearImageTokens: () => void;
	};
	pendingImageController: { takeForText: (text: string) => SubmittedInput };
	editor: {
		getText: () => string;
		getExpandedText?: () => string;
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
		clearPasteMarkers?: () => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
		resourceLoader: {
			getUserMcpTools: () => {
				tools: Array<{ name: string; provenance?: { kind: string; server?: string } }>;
				diagnostics: Array<{ type: "error" | "warning"; message: string }>;
			};
		};
	};
	flushPendingBashComponents: () => void;
	clipboardImagePastePending: number;
	settleClipboardImagePastes: () => Promise<void>;
	invalidateClipboardImagePastes: () => void;
	onInputCallback?: (input: SubmittedInput) => void;
	pendingUserInputs: SubmittedInput[];
	showFloatingMenu: (...args: unknown[]) => unknown;
	showMcpManager: () => void;
	mcpMenuView: () => { items: FloatingMenuItem[]; description: string };
};

type InputContext = {
	onInputCallback?: (input: SubmittedInput) => void;
	pendingUserInputs: SubmittedInput[];
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	mcpMenuView(this: SubmitContext): { items: FloatingMenuItem[]; description: string };
	showMcpManager(this: SubmitContext): void;
	mcpDockParentItem(this: SubmitContext): FloatingMenuItem;
	applyCommandDockFilter(this: { commandDockBody?: FloatingMenuBody }, filter: string): void;
	appendMissingBuiltinSlashDockItems(items: FloatingMenuItem[]): void;
	commandDockShouldSubmitExactBuiltin(this: {
		editor: { getText: () => string };
		commandDockBody?: FloatingMenuBody;
	}): boolean;
	skillDockParentItem(this: {
		settingsManager: { getEnableSkillCommands: () => boolean };
		skillMenuItems: () => FloatingMenuItem[];
	}): FloatingMenuItem[];
	handleCommandDockItem(
		this: {
			handleHarnessMenuItem: (item: FloatingMenuItem) => boolean;
			setEditorTextWithoutCommandDockSync: (value: string) => void;
			closeCommandDock: () => void;
			ui: { setFocus: (target: unknown) => void; requestRender: () => void };
			editor: unknown;
		},
		item: FloatingMenuItem,
	): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	const context: SubmitContext = {
		defaultEditor: {
			transformImageTokenInput: (text) => text,
			clearImageTokens: vi.fn(),
		},
		pendingImageController: {
			takeForText: (text) => ({ text }),
		},
		editor: {
			getText: () => "",
			addToHistory: vi.fn(),
			setText: vi.fn(),
			clearPasteMarkers: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
			resourceLoader: {
				getUserMcpTools: vi.fn(() => ({ tools: [], diagnostics: [] })),
			},
		},
		flushPendingBashComponents: vi.fn(),
		clipboardImagePastePending: 0,
		settleClipboardImagePastes: vi.fn(async () => {}),
		invalidateClipboardImagePastes: vi.fn(),
		pendingUserInputs: [],
		showFloatingMenu: vi.fn(),
		showMcpManager: vi.fn(),
		mcpMenuView: () => ({ items: [], description: "" }),
	};
	context.mcpMenuView = () => interactiveModePrototype.mcpMenuView.call(context);
	return context;
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt" }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("keeps submitted clipboard images with the queued input", async () => {
		const context = createSubmitContext();
		const attached = { type: "image", mimeType: "image/png", data: "abc" };
		context.pendingImageController.takeForText = (text) => ({ text, images: [attached] });
		const onInputCallback = vi.fn();
		context.onInputCallback = onInputCallback;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" [paste #1 Image] ");

		expect(onInputCallback).toHaveBeenCalledWith({ text: "[paste #1 Image]", images: [attached] });
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("waits for an in-flight image paste before finalizing the submitted draft", async () => {
		const context = createSubmitContext();
		const attached = { type: "image", mimeType: "image/png", data: "late" };
		context.clipboardImagePastePending = 1;
		context.editor.getExpandedText = () => "[paste #1 Image]";
		context.pendingImageController.takeForText = (text) => ({
			text,
			images: [attached],
			imageMarkers: ["[paste #1 Image]"],
		});
		const onInputCallback = vi.fn();
		context.onInputCallback = onInputCallback;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("describe this");

		expect(context.settleClipboardImagePastes).toHaveBeenCalledTimes(1);
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(onInputCallback).toHaveBeenCalledWith({
			text: "describe this [paste #1 Image]",
			images: [attached],
			imageMarkers: ["[paste #1 Image]"],
		});
	});

	it("opens the empty MCP manager without submitting the command as model input", async () => {
		const context = createSubmitContext();
		const onInputCallback = vi.fn();
		context.onInputCallback = onInputCallback;
		context.showMcpManager = () => interactiveModePrototype.showMcpManager.call(context);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" /mcp ");

		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(onInputCallback).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.showFloatingMenu).toHaveBeenCalledTimes(1);
		expect(vi.mocked(context.showFloatingMenu).mock.calls[0]?.[2]).toEqual([
			expect.objectContaining({ label: "No MCP servers configured", disabled: true }),
		]);
	});

	it("groups MCP tools by provenance instead of parsing local name prefixes", () => {
		const context = createSubmitContext();
		context.session.resourceLoader.getUserMcpTools = vi.fn(() => ({
			tools: [
				{ name: "my_team_alpha", provenance: { kind: "mcp", server: "managed" } },
				{ name: "my_team_beta", provenance: { kind: "mcp", server: "managed" } },
				{ name: "custom_name", provenance: { kind: "mcp", server: "second" } },
			],
			diagnostics: [],
		}));

		interactiveModePrototype.showMcpManager.call(context);

		expect(vi.mocked(context.showFloatingMenu).mock.calls[0]?.[2]).toEqual([
			expect.objectContaining({ label: "managed", description: "2 tools loaded" }),
			expect.objectContaining({ label: "second", description: "1 tool loaded" }),
		]);
	});

	it("shows loaded MCP servers in the command dock submenu", () => {
		const context = createSubmitContext();
		context.session.resourceLoader.getUserMcpTools = vi.fn(() => ({
			tools: [
				{ name: "alpha", provenance: { kind: "mcp", server: "remote" } },
				{ name: "beta", provenance: { kind: "mcp", server: "remote" } },
			],
			diagnostics: [],
		}));

		const item = interactiveModePrototype.mcpDockParentItem.call(context);

		expect(item).toMatchObject({
			value: "command:mcp",
			description: "1 server · 2 tools loaded",
			children: [expect.objectContaining({ label: "remote", description: "2 tools loaded" })],
		});
	});

	it("does not claim MCP is unconfigured when configured servers failed to load", () => {
		const context = createSubmitContext();
		context.session.resourceLoader.getUserMcpTools = vi.fn(() => ({
			tools: [],
			diagnostics: [{ type: "error" as const, message: "connection failed" }],
		}));

		const item = interactiveModePrototype.mcpDockParentItem.call(context);

		expect(item.description).toBe("No tools loaded · 1 diagnostic");
		expect(item.children).toEqual([
			expect.objectContaining({ label: "No MCP tools loaded", description: expect.stringContaining("diagnostics") }),
			expect.objectContaining({ label: "⚠ error", description: "connection failed" }),
		]);
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("builds the Skills dock only when skill commands are enabled", () => {
		const children = [{ value: "insert-skill:review", label: "skill:review" }];
		const enabled = interactiveModePrototype.skillDockParentItem.call({
			settingsManager: { getEnableSkillCommands: () => true },
			skillMenuItems: () => children,
		});
		expect(enabled).toEqual([expect.objectContaining({ value: "command:skill", label: "Skills", children })]);

		const disabled = interactiveModePrototype.skillDockParentItem.call({
			settingsManager: { getEnableSkillCommands: () => false },
			skillMenuItems: () => children,
		});
		expect(disabled).toEqual([]);
	});

	it("keeps the command dock in parity with the builtin slash registry", () => {
		const items: FloatingMenuItem[] = [
			{ value: "slash:new", label: "New Session", aliases: ["new", "clear"] },
			{ value: "slash:side", label: "Side Chat", aliases: ["side", "btw", "s"] },
			{ value: "slash:quit", label: "Quit", aliases: ["quit", "exit"] },
		];

		interactiveModePrototype.appendMissingBuiltinSlashDockItems.call({}, items);

		for (const command of BUILTIN_SLASH_COMMANDS) {
			expect(
				items.some((item) => item.aliases?.includes(command.name)),
				command.name,
			).toBe(true);
		}
		expect(items.filter((item) => item.aliases?.includes("new"))).toHaveLength(1);
		expect(items.filter((item) => item.aliases?.includes("btw"))).toHaveLength(1);
		expect(items.filter((item) => item.aliases?.includes("exit"))).toHaveLength(1);
	});

	it("submits exact session commands unless the user selects a different fuzzy match", () => {
		const requestedCommands = ["resume", "new", "session", "name", "tree", "fork", "clone", "export"];
		const items: FloatingMenuItem[] = [
			{ value: "slash:new", label: "New Session", aliases: ["new", "clear"] },
			{ value: "slash:tree", label: "Tree", aliases: ["tree"] },
			{ value: "slash:resume", label: "Resume", aliases: ["resume"] },
		];
		interactiveModePrototype.appendMissingBuiltinSlashDockItems.call({}, items);

		for (const command of requestedCommands) {
			const commandDockBody = new FloatingMenuBody({
				title: "command dock",
				items,
				onSelect: () => undefined,
				requestRender: () => undefined,
				navigationRepeatDelayMs: 0,
			});
			commandDockBody.setFilter(command);
			expect(
				interactiveModePrototype.commandDockShouldSubmitExactBuiltin.call({
					editor: { getText: () => `/${command}` },
					commandDockBody,
				}),
				command,
			).toBe(true);
		}

		const commandDockBody = new FloatingMenuBody({
			title: "command dock",
			items,
			onSelect: () => undefined,
			requestRender: () => undefined,
			navigationRepeatDelayMs: 0,
		});
		commandDockBody.setFilter("session");
		expect(commandDockBody.getSelectedItem()?.aliases).toContain("session");
		commandDockBody.handleInput("\x1b[B");
		expect(commandDockBody.getSelectedItem()?.aliases).toContain("new");
		expect(
			interactiveModePrototype.commandDockShouldSubmitExactBuiltin.call({
				editor: { getText: () => "/session" },
				commandDockBody,
			}),
		).toBe(false);
	});

	it("lets exact builtin Enter reach editor submit instead of a fuzzy dock action", () => {
		const selected: string[] = [];
		const items: FloatingMenuItem[] = [{ value: "slash:new", label: "New Session", aliases: ["new", "clear"] }];
		interactiveModePrototype.appendMissingBuiltinSlashDockItems.call({}, items);
		const commandDockBody = new FloatingMenuBody({
			title: "command dock",
			items,
			onSelect: (item) => {
				selected.push(item.value);
				return undefined;
			},
			requestRender: () => undefined,
			navigationRepeatDelayMs: 0,
		});
		commandDockBody.setFilter("session");
		const closeCommandDock = vi.fn();
		const context = {
			commandDockHandle: { isHidden: () => false },
			commandDockBody,
			editor: { getText: () => "/session" },
			closeCommandDock,
			ui: { requestRender: vi.fn() },
		};
		Object.assign(context, {
			commandDockShouldRouteInput: (data: string) =>
				(InteractiveMode.prototype as any).commandDockShouldRouteInput.call(context, data),
			commandDockShouldSubmitExactBuiltin: () =>
				interactiveModePrototype.commandDockShouldSubmitExactBuiltin.call(context),
		});

		const result = (InteractiveMode.prototype as any).handleCommandDockInput.call(context, "\r");

		expect(result).toBeUndefined();
		expect(closeCommandDock).toHaveBeenCalledTimes(1);
		expect(selected).toEqual([]);
	});

	it("routes /skill:<partial> into the filtered Skills submenu", () => {
		const selected: string[] = [];
		const commandDockBody = new FloatingMenuBody({
			title: "command dock",
			items: [
				{ value: "command:model", label: "Model", children: [] },
				{
					value: "command:skill",
					label: "Skills",
					children: [
						{ value: "insert-skill:analyze", label: "skill:analyze" },
						{ value: "insert-skill:review", label: "skill:review" },
					],
				},
			],
			onSelect: (item) => {
				selected.push(item.value);
				return undefined;
			},
			requestRender: () => undefined,
		});

		interactiveModePrototype.applyCommandDockFilter.call({ commandDockBody }, "skill:rev");
		expect(commandDockBody.submenuDepth).toBe(1);
		commandDockBody.handleInput("\r");
		expect(selected).toEqual(["insert-skill:review"]);
	});

	it("backfills a selected skill command with a trailing argument space", () => {
		const setEditorTextWithoutCommandDockSync = vi.fn();
		const closeCommandDock = vi.fn();
		const editor = {};
		const ui = { setFocus: vi.fn(), requestRender: vi.fn() };

		interactiveModePrototype.handleCommandDockItem.call(
			{
				handleHarnessMenuItem: () => false,
				setEditorTextWithoutCommandDockSync,
				closeCommandDock,
				ui,
				editor,
			},
			{ value: "insert-skill:review", label: "skill:review" },
		);

		expect(setEditorTextWithoutCommandDockSync).toHaveBeenCalledWith("/skill:review ");
		expect(closeCommandDock).toHaveBeenCalledTimes(1);
		expect(ui.setFocus).toHaveBeenCalledWith(editor);
		expect(ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
