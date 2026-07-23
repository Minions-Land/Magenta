import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type Component, Container, type Focusable, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { AutocompleteProviderFactory } from "../src/core/extensions/types.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

function normalizeRenderedOutput(container: Container, width = 220): string {
	return renderAll(container, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode footer invalidation", () => {
	test("requests a render only when an extension status changes", () => {
		const setExtensionStatus = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const fakeThis: any = {
			footerDataProvider: { setExtensionStatus },
			ui: { requestRender: vi.fn() },
		};

		const updateStatus = (text: string | undefined) =>
			(InteractiveMode as any).prototype.setExtensionStatus.call(fakeThis, "background", text);
		updateStatus("1 running");
		updateStatus("1 running");
		updateStatus("2 running");
		updateStatus(undefined);
		updateStatus(undefined);

		expect(setExtensionStatus).toHaveBeenCalledTimes(5);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(3);
	});

	test("does not invalidate cumulative usage for a streaming message update", async () => {
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			streamingComponent: undefined,
			observeActiveSubmittedInputMessage: vi.fn(),
		};

		await (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "message_update",
			message: { role: "assistant" },
		});

		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	const RECENT_LIMIT = 3;

	function expandable() {
		const state = { expanded: false };
		return {
			state,
			setExpanded: vi.fn((value: boolean) => {
				state.expanded = value;
			}),
		};
	}

	function createFakeThis(chatChildren: unknown[]) {
		const header = { setExpanded: vi.fn() };
		const loadedResourcesChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			expandedChatOutputs: [],
			customHeader: undefined,
			builtInHeader: header,
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			chatContainer: { children: chatChildren, invalidateChild: vi.fn(), invalidateCache: vi.fn() },
			showLoadedResources: vi.fn(),
			ui: { requestRender: vi.fn() },
			applyRecentChatExpansion: (InteractiveMode as any).prototype.applyRecentChatExpansion,
		};
		fakeThis.applyRecentChatExpansion = fakeThis.applyRecentChatExpansion.bind(fakeThis);
		return { fakeThis, header, loadedResourcesChild };
	}

	test("expands header and loaded resources fully but only the newest three chat outputs", () => {
		const chatChildren = [expandable(), expandable(), expandable(), expandable(), expandable()];
		const { fakeThis, header, loadedResourcesChild } = createFakeThis(chatChildren);

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.showLoadedResources).toHaveBeenCalledWith({ showDiagnosticsWhenQuiet: true });
		expect(loadedResourcesChild.setExpanded).toHaveBeenCalledWith(true);

		// Only the last three chat children are expanded; older ones stay collapsed.
		expect(chatChildren[0].state.expanded).toBe(false);
		expect(chatChildren[1].state.expanded).toBe(false);
		expect(chatChildren[2].state.expanded).toBe(true);
		expect(chatChildren[3].state.expanded).toBe(true);
		expect(chatChildren[4].state.expanded).toBe(true);
		expect(fakeThis.expandedChatOutputs).toHaveLength(RECENT_LIMIT);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("collapse only affects the previously tracked outputs", () => {
		const chatChildren = [expandable(), expandable(), expandable(), expandable()];
		const { fakeThis } = createFakeThis(chatChildren);

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);
		const expandedIdentities = [...fakeThis.expandedChatOutputs];
		expect(expandedIdentities).toHaveLength(RECENT_LIMIT);

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, false);
		for (const child of chatChildren) {
			expect(child.state.expanded).toBe(false);
		}
		expect(fakeThis.expandedChatOutputs).toHaveLength(0);
	});

	test("re-expanding does not grow the expanded set beyond the limit", () => {
		const chatChildren = [expandable(), expandable(), expandable(), expandable(), expandable()];
		const { fakeThis } = createFakeThis(chatChildren);

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);
		// A newer output arrives while expanded; it must not auto-expand.
		chatChildren.push(expandable());
		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		const expandedCount = chatChildren.filter((c) => c.state.expanded).length;
		expect(expandedCount).toBe(RECENT_LIMIT);
		expect(fakeThis.expandedChatOutputs).toHaveLength(RECENT_LIMIT);
	});

	test("handles fewer expandable outputs than the limit", () => {
		const chatChildren = [expandable(), { notExpandable: true }];
		const { fakeThis } = createFakeThis(chatChildren);

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);
		expect((chatChildren[0] as { state?: { expanded: boolean } }).state?.expanded).toBe(true);
		expect(fakeThis.expandedChatOutputs).toHaveLength(1);
	});
});

describe("InteractiveMode harness menu", () => {
	test("describes extension event handlers without presenting them as HCP hooks", () => {
		const showStatus = vi.fn();
		const fakeThis: any = {
			session: {
				extensionRunner: {
					getExtensionPaths: () => ["/workspace/extensions/trust.ts"],
				},
			},
			getActiveExtensionEvents: () => ["project_trust", "tool_call"],
			showStatus,
		};

		(InteractiveMode as any).prototype.showExtensionEventsSummary.call(fakeThis);

		const summary = showStatus.mock.calls[0]?.[0] as string;
		expect(summary).toContain("Extension events");
		expect(summary).toContain("Registered events: project_trust, tool_call");
		expect(summary).not.toContain("Harness hooks");
		expect(summary).not.toContain("HCP hooks");
	});

	test("discovers packages from the resource loader's explicit root", async () => {
		const root = mkdtempSync(path.join(homedir(), "magenta-harness-packages-root-"));
		try {
			const repoRoot = path.join(root, "repo");
			const packagesRoot = path.join(root, "external-packages");
			mkdirSync(repoRoot, { recursive: true });
			mkdirSync(path.join(packagesRoot, "ExternalDomain"), { recursive: true });
			writeFileSync(
				path.join(packagesRoot, "ExternalDomain", "package.toml"),
				`schema_version = "magenta.package.v1"
id = "ExternalDomain"
name = "External Domain"
`,
			);
			const fakeThis = {
				sessionManager: { getCwd: () => repoRoot },
				session: {
					resourceLoader: { HcpClientgetharnesspackagesroot: () => packagesRoot },
				},
			};

			const view = await (InteractiveMode as any).prototype.HcpClientloadpackagesview.call(fakeThis);

			expect(view.packagesRoot).toBe(packagesRoot);
			expect(view.packages.map((pkg: { id: string }) => pkg.id)).toEqual(["ExternalDomain"]);
			expect(view.diagnostics).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("shows an active GitHub package that is absent from local discovery and preserves its exact selector", async () => {
		const selector = "github:Minions-Land/MagentaPackages/AutOmicScience@1.0.0:single-cell";
		const fakeThis: any = {
			HcpClientloadpackagesview: async () => ({
				packagesRoot: "/workspace/packages",
				packages: [],
				diagnostics: [],
			}),
		};

		const [root] = await (InteractiveMode as any).prototype.HcpClientpackagemenuitems.call(fakeThis, {
			harnessPackages: [selector],
		});
		const githubPackage = root.children.find((item: any) => item.label === "AutOmicScience (GitHub)");

		expect(root.description).toBe("1 selected · 0 local available");
		expect(githubPackage).toMatchObject({ active: true });
		expect(githubPackage.description).toContain(selector);
		expect(githubPackage.children.find((item: any) => item.label === "Profiles")).toMatchObject({
			disabled: true,
			description: "Active: single-cell",
		});

		const HcpClientsetpackageselectorenabled = vi.fn();
		const actionContext = { HcpClientsetpackageselectorenabled };
		const reload = githubPackage.children.find((item: any) => item.label === "Reload package");
		const unload = githubPackage.children.find((item: any) => item.label === "Unload selector");

		expect((InteractiveMode as any).prototype.handleHarnessMenuItem.call(actionContext, reload)).toBe(true);
		expect(HcpClientsetpackageselectorenabled).toHaveBeenLastCalledWith(selector, true);
		expect((InteractiveMode as any).prototype.handleHarnessMenuItem.call(actionContext, unload)).toBe(true);
		expect(HcpClientsetpackageselectorenabled).toHaveBeenLastCalledWith(selector, false);
	});

	test("offers an official Package release that downloads and loads through its exact selector", async () => {
		const selector = "github:Minions-Land/Magenta-CLI/ClaudeScience@0.1.0";
		const fakeThis: any = {
			HcpClientloadpackagesview: async () => ({
				packagesRoot: "/workspace/packages",
				packages: [],
				diagnostics: [],
			}),
			HcpClientloadpackagecatalogview: async () => ({
				packages: [
					{
						package: "ClaudeScience",
						version: "0.1.0",
						selector,
						owner: "Minions-Land",
						repo: "MagentaPackages",
					},
				],
				diagnostics: [],
			}),
		};

		const [root] = await (InteractiveMode as any).prototype.HcpClientpackagemenuitems.call(fakeThis, {
			harnessPackages: [],
		});
		const officialPackage = root.children.find((item: any) => item.label === "ClaudeScience (Official)");

		expect(root.description).toBe("0 selected · 0 local available · 1 official available");
		expect(officialPackage).toMatchObject({ active: false });
		const load = officialPackage.children.find((item: any) => item.label === "Download & load");
		expect(load.description).toContain("harness-packages");

		const HcpClientsetpackageselectorenabled = vi.fn();
		expect(
			(InteractiveMode as any).prototype.handleHarnessMenuItem.call({ HcpClientsetpackageselectorenabled }, load),
		).toBe(true);
		expect(HcpClientsetpackageselectorenabled).toHaveBeenCalledWith(selector, true);
	});

	test("keeps a same-id GitHub selector separate from local package profile controls", async () => {
		const selector = "github:owner/packages/SharedDomain@2.0.0";
		const fakeThis: any = {
			HcpClientloadpackagesview: async () => ({
				packagesRoot: "/workspace/packages",
				packages: [
					{
						id: "SharedDomain",
						dir: "/workspace/packages/SharedDomain",
						manifest: {
							components: [],
							profiles: [{ name: "local-profile", description: "Local-only profile" }],
						},
					},
				],
				diagnostics: [],
			}),
		};

		const [root] = await (InteractiveMode as any).prototype.HcpClientpackagemenuitems.call(fakeThis, {
			harnessPackages: [selector],
		});
		const localPackage = root.children.find((item: any) => item.value === "harness:package:SharedDomain");
		const githubPackage = root.children.find((item: any) => item.label === "SharedDomain (GitHub)");

		expect(localPackage).toMatchObject({ active: false });
		expect(localPackage.description).toContain("not selected");
		expect(localPackage.children.find((item: any) => item.label === "local-profile")).toMatchObject({
			active: false,
		});
		expect(githubPackage).toMatchObject({ active: true });
	});

	test("unloading a local package leaves a same-id GitHub selector active", async () => {
		const githubSelector = "github:owner/packages/SharedDomain@2.0.0";
		let nextSelectors: string[] | undefined;
		const fakeThis = {
			HcpClientenqueuepackagemutation: async (compute: (current: string[]) => string[]) => {
				nextSelectors = compute(["SharedDomain", "SharedDomain:local-profile", githubSelector, "OtherDomain"]);
			},
		};

		await (InteractiveMode as any).prototype.HcpClientclearpackageselectors.call(fakeThis, "SharedDomain");

		expect(nextSelectors).toEqual([githubSelector, "OtherDomain"]);
	});

	test("loading a new GitHub Package version replaces the active version but keeps a same-id local selector", async () => {
		const oldSelector = "github:Minions-Land/Magenta-CLI/ClaudeScience@0.1.0";
		const newSelector = "github:Minions-Land/Magenta-CLI/ClaudeScience@0.2.0";
		let nextSelectors: string[] | undefined;
		const fakeThis = {
			HcpClientenqueuepackagemutation: async (compute: (current: string[]) => string[]) => {
				nextSelectors = compute(["ClaudeScience", oldSelector, "OtherDomain"]);
			},
		};

		await (InteractiveMode as any).prototype.HcpClientsetpackageselectorenabled.call(fakeThis, newSelector, true);

		expect(nextSelectors).toEqual(["ClaudeScience", "OtherDomain", newSelector]);
	});

	test("restores the previous selection when a requested Package did not load", async () => {
		const requested = "github:Minions-Land/MagentaPackages/ClaudeScience@0.1.0";
		let selectors: string[] = [];
		const HcpClientsetharnesspackageselectors = vi.fn((next: string[]) => {
			selectors = [...next];
		});
		const handleReloadCommand = vi.fn(async () => true);
		const showError = vi.fn();
		const fakeThis: any = {
			session: {
				resourceLoader: {
					HcpClientsetharnesspackageselectors,
					getPackageOverlay: () => undefined,
					getPackageTools: () => ({
						tools: [],
						diagnostics: [{ type: "error", message: "GitHub returned 404 Not Found" }],
					}),
				},
			},
			canReloadRuntime: () => true,
			HcpClientgetharnesspackageselectors: () => [...selectors],
			handleReloadCommand,
			showError,
		};

		await (InteractiveMode as any).prototype.HcpClientapplypackageselectors.call(fakeThis, () => [requested]);

		expect(HcpClientsetharnesspackageselectors).toHaveBeenNthCalledWith(1, [requested]);
		expect(HcpClientsetharnesspackageselectors).toHaveBeenNthCalledWith(2, []);
		expect(handleReloadCommand).toHaveBeenCalledTimes(2);
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("Harness Package load failed"));
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("GitHub returned 404 Not Found"));
		expect(selectors).toEqual([]);
	});

	test("formats every loaded package in a multi-package overlay", () => {
		const formatted = (InteractiveMode as any).prototype.HcpClientformatpackageselection.call(
			{},
			["FirstDomain", "github:owner/packages/SecondDomain@2.0.0", "MissingDomain"],
			{
				packageId: "FirstDomain",
				packageRoot: "/cache/FirstDomain",
				packages: [
					{ id: "FirstDomain", dir: "/cache/FirstDomain" },
					{ id: "SecondDomain", dir: "/cache/SecondDomain" },
				],
			},
		);

		expect(formatted).toContain("- FirstDomain -> /cache/FirstDomain");
		expect(formatted).toContain("- github:owner/packages/SecondDomain@2.0.0 -> /cache/SecondDomain");
		expect(formatted).toContain("- MissingDomain -> not loaded");
	});

	test("shows Magenta and Pi Sources from generated HCP data", async () => {
		const root = mkdtempSync(path.join(homedir(), "magenta-harness-menu-"));
		try {
			const magentaPath = path.join(root, "harness", "tools", "bash", "magenta");
			const piPath = path.join(root, "harness", "tools", "bash", "pi");
			mkdirSync(magentaPath, { recursive: true });
			writeFileSync(
				path.join(magentaPath, "bash.toml"),
				'command = "../../../_magenta/process-tools/target/release/magenta-process-tools"\n',
			);
			mkdirSync(piPath, { recursive: true });

			const fakeThis: any = Object.create(InteractiveMode.prototype);
			fakeThis.createHarnessRuntimeSnapshot = async () => ({
				autoCompact: true,
				skillCommands: true,
				loadedSkills: 0,
				loadedExtensions: 0,
				tools: [{ name: "bash", active: true, source: "pi" }],
				harnessPackages: [],
				packageToolCount: 0,
				packageDiagnosticCount: 0,
				activeExtensionEvents: ["project_trust"],
				components: {
					components: [
						{
							id: "tool/bash",
							module: "tools/bash",
							kind: "tool",
							name: "bash",
							product: "tool",
							description: "Bash",
							descriptorPath: path.join(root, "harness", "tools", "bash", "bash.toml"),
							status: "active",
							sources: [
								{
									source: "magenta",
									status: "available",
									selected: false,
									active: false,
									descriptorPath: magentaPath,
								},
								{
									source: "pi",
									status: "active",
									selected: true,
									active: true,
									descriptorPath: piPath,
								},
							],
						},
					],
				},
			});
			fakeThis.HcpClientloadpackagesview = async () => ({
				packagesRoot: path.join(root, "packages"),
				packages: [],
				diagnostics: [],
			});
			fakeThis.HcpClientloadpackagecatalogview = async () => ({ packages: [], diagnostics: [] });

			const menu = await (InteractiveMode as any).prototype.harnessMenuItems.call(fakeThis);
			const tools = menu.children.find((item: any) => item.value === "harness:tools");
			const extensionEvents = menu.children.find((item: any) => item.value === "harness:hooks");
			const bash = tools.children.find((item: any) => item.value === "harness:tool:bash");
			const labels = bash.children.map((item: any) => item.label);
			const magenta = bash.children.find((item: any) => item.label === "Magenta");
			const pi = bash.children.find((item: any) => item.label === "Pi");

			expect(labels).toContain("Magenta");
			expect(labels).toContain("Pi");
			expect(extensionEvents.label).toBe("Extension events");
			expect(extensionEvents.description).toContain("1 registered event");
			expect(extensionEvents.children.map((item: any) => item.label)).toContain("Pi lifecycle handlers");
			expect(extensionEvents.children.map((item: any) => item.label)).not.toContain("Hooks");
			expect(bash.description).toContain("implementation: Pi");
			expect(magenta.description).toContain("available");
			expect(pi.description).toContain("active");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => {
					fakeThis.ui.requestRender();
					return { success: true };
				}),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("light");
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => ({ success: false, error: "Theme not found" })),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showExtensionCustom", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("overlay custom UI reclaims input after non-overlay custom UI closes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const editorContainer = new Container();
		const editor = new TestFocusableComponent("EDITOR");
		const palette = new TestFocusableComponent("PALETTE");
		const overlay = new TestFocusableComponent("OVERLAY");
		const replacement = new TestFocusableComponent("REPLACEMENT");
		let closeOverlay: (value: string) => void = () => {
			throw new Error("closeOverlay was not initialized");
		};
		let closeReplacement: (value: string) => void = () => {
			throw new Error("closeReplacement was not initialized");
		};
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
		};
		const showExtensionCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T> =>
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();
		try {
			const overlayPromise = showExtensionCustom<string>(
				(_tui, _theme, _keybindings, done) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			);
			await flushTui(ui, terminal);
			expect(overlay.focused).toBe(true);

			const replacementPromise = showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				closeReplacement = done;
				return replacement;
			});
			await flushTui(ui, terminal);
			expect(replacement.focused).toBe(true);

			closeReplacement("done");
			await replacementPromise;
			await flushTui(ui, terminal);
			terminal.sendInput("x");
			await flushTui(ui, terminal);

			expect(overlay.inputs).toEqual(["x"]);
			expect(editor.inputs).toEqual([]);
			expect(overlay.focused).toBe(true);

			closeOverlay("closed");
			await overlayPromise;
		} finally {
			ui.stop();
		}
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});

	test("merges triggerCharacters from wrapper factories", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const passThrough =
			(triggerCharacters: string[]): AutocompleteProviderFactory =>
			(current) => ({
				triggerCharacters,
				getSuggestions: (lines, cursorLine, cursorCol, options) =>
					current.getSuggestions(lines, cursorLine, cursorCol, options),
				applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
					current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [passThrough(["$"]), passThrough(["!"])],
		};

		(
			InteractiveMode as unknown as {
				prototype: { setupAutocompleteProvider: (this: typeof fakeThis) => void };
			}
		).prototype.setupAutocompleteProvider.call(fakeThis);

		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider.triggerCharacters).toEqual(["$", "!"]);
	});
});

describe("InteractiveMode.createBaseAutocompleteProvider", () => {
	test("matches model command arguments across provider/model order", async () => {
		type TestModel = { id: string; provider: string; name: string };
		type FakeInteractiveMode = {
			session: {
				scopedModels: Array<{ model: TestModel }>;
				modelRegistry: { getAvailable: () => TestModel[] };
				promptTemplates: [];
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			fdPath: null;
		};

		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: FakeInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const models = [
			{ id: "gpt-5.2-codex", provider: "github-copilot", name: "GPT-5.2 Codex" },
			{ id: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5" },
		];
		const fakeThis: FakeInteractiveMode = {
			session: {
				scopedModels: [],
				modelRegistry: { getAvailable: () => models },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
		};

		const provider = createBaseAutocompleteProvider.call(fakeThis);
		const line = "/model codexgpt";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"openai-codex/gpt-5.5",
			"github-copilot/gpt-5.2-codex",
		]);
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			loadedResourcesContainer: new Container(),
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.magenta/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.magenta/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.magenta/extensions",
				}),
			},
			{
				path: "/tmp/project/.magenta/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.magenta/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.magenta/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.magenta/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.magenta/npm/node_modules/pi-markdown-preview/extensions/index.ts",
					{
						source: "npm:pi-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.magenta/npm/node_modules/pi-markdown-preview",
					},
				),
			},
			{
				path: "/tmp/project/.magenta/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.magenta/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
					{
						source: "npm:@scope/pi-scoped",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.magenta/npm/node_modules/@scope/pi-scoped",
					},
				),
			},
			{
				path: "/tmp/project/.magenta/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.magenta/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.magenta/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.magenta/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.magenta/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.magenta/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("does not show a resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toBe("");
		expect(output).not.toContain("resource-list");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-subagents, HazAT/pi-interactive-subagents:subagents, local-index, pi-markdown-preview, user-index"`);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/one, beta/one, gamma/one"`);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode, webfetch.ts"`);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  bar, foo"`);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/tools, beta/tools"`);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  main.ts"`);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.magenta/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.magenta/npm/node_modules/pi-markdown-preview/extensions/index.ts",
					{
						source: "npm:pi-markdown-preview",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.magenta/npm/node_modules/pi-markdown-preview",
					},
				),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  pi-markdown-preview"`);
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  project
    /tmp/project/.magenta/extensions/answer.ts
    /tmp/project/.magenta/extensions/local-index
    git:github.com/HazAT/pi-interactive-subagents
      extensions
      extensions/subagents
    npm:@scope/pi-scoped
      extensions
    npm:pi-markdown-preview
      extensions
  user
    /tmp/agent/extensions/user-index
  path
    /tmp/temp/cli-extension.ts"`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [
				{ path: path.join(home, CONFIG_DIR_NAME, "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: true,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain(`~/${CONFIG_DIR_NAME}/agent/AGENTS.md, AGENTS.md`);
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [
				{ path: path.join(home, CONFIG_DIR_NAME, "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain(`~/${CONFIG_DIR_NAME}/agent/AGENTS.md`);
		expect(output).toContain("~/Development/pi-mono/AGENTS.md");
		expect(output).not.toContain(`~/${CONFIG_DIR_NAME}/agent/AGENTS.md, AGENTS.md`);
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
