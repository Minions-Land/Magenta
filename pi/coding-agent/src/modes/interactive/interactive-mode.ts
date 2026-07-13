/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	getProviders,
	type ImageContent,
	type Message,
	type Model,
	type OAuthProviderId,
	type OAuthSelectPrompt,
} from "@earendil-works/pi-ai/compat";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	PasteMarkerSnapshot,
	SlashCommand,
} from "@earendil-works/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Loader,
	type LoaderIndicatorOptions,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { HcpClientharnesspackage, HcpClientpackagediagnostic, HcpClientpackageoverlay } from "@magenta/harness";
import {
	createEmptyTodoPlanState,
	HcpClientdiscoverharnesspackages,
	HcpClientparsepackageselector,
} from "@magenta/harness";
import chalk from "chalk";
import { spawn, spawnSync } from "child_process";
import {
	APP_BINARY_NAME,
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getDocsPath,
	getShareViewerUrl,
	VERSION,
} from "../../config.ts";
import {
	type AgentSession,
	type AgentSessionEvent,
	parseSkillBlock,
	type SubmittedInput,
} from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import { applyCommandAlias } from "../../core/command-aliases.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	ProjectTrustContext,
} from "../../core/extensions/index.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { loadTodoPlanStateFromBranch } from "../../core/HcpClienttools.ts";
import {
	buildHarnessComponentsView,
	buildHarnessToolSwitches,
	formatHarnessComponentsSummary,
	formatHarnessRuntimeSummary,
	HARNESS_HOOK_EVENTS,
	type HarnessRuntimeSnapshot,
	hasHarnessComponent,
} from "../../core/harness-switches.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { ImageTokenController, readClipboardFilePaths } from "../../core/image-tokens.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { createCompactionSummaryMessage } from "../../core/messages.ts";
import { defaultModelPerProvider, findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.ts";
import { DefaultPackageManager } from "../../core/package-manager.ts";
import { PendingImageController } from "../../core/pending-images.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import { type SessionContext, SessionManager } from "../../core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	ProjectTrustStore,
} from "../../core/trust-manager.ts";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { readClipboardImage } from "../../utils/clipboard-image.ts";
import { parseGitUrl } from "../../utils/git.ts";
import type { UpdateCheckResult } from "../../utils/github-release-update.ts";
import { resizeImage } from "../../utils/image-resize.ts";
import { type checkForMagentaUpdate, recompileMagenta, runMagentaUpdate } from "../../utils/magenta-update.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import {
	HcpClientdiscoverofficialpackages,
	type HcpClientpackagecatalogresult,
	HcpClientparsegithubpackageselector,
} from "../../utils/package-acquisition.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { checkForAnyUpdate } from "../../utils/unified-update-check.ts";
// Pi's pi.dev version check is disabled for Magenta (see run()); the type is
// retained for the dormant showNewVersionNotification method.
// import { checkForNewPiVersion } from "../../utils/version-check.ts";
import type { LatestPiRelease } from "../../utils/version-check.ts";
import { ArminComponent } from "./components/armin.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import {
	buildOverlayOptions,
	type CentralOverlayConfig,
	createCentralOverlayAdapter,
	initializeFocus,
} from "./components/central-overlay.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CountdownTimer } from "./components/countdown-timer.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import {
	CENTER_FLOATING_MENU_OVERLAY,
	COMMAND_DOCK_OVERLAY,
	FloatingMenuBody,
	type FloatingMenuItem,
	type FloatingOverlayBody,
	FloatingOverlayContainer,
} from "./components/floating-menu.ts";
import { CENTER_FLOATING_OVERLAY } from "./components/floating-window.ts";
import { FooterComponent } from "./components/footer.ts";
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { TodoOverlay } from "./components/todo-overlay.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { ToolExecutionGroupComponent } from "./components/tool-execution-group.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import { getModelSearchText } from "./model-search.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

type HcpClientpackagesview = {
	packagesRoot?: string;
	packages: HcpClientharnesspackage[];
	diagnostics: HcpClientpackagediagnostic[];
	error?: string;
};

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type CompactionQueuedMessage = SubmittedInput & {
	mode: "steer" | "followUp";
};

/**
 * Magenta feature: an activation is anything that drives the main interactive
 * loop to advance. A `user_input` carries text to prompt; a `peer_wake` means
 * an idle peer-message wake already appended its payload to session state and
 * the loop should run one turn to consume it (via runExternalActivation).
 */
type Activation = { type: "user_input"; input: SubmittedInput } | { type: "peer_wake" };

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);
const ULTRA_BORDER_ANIMATION_INTERVAL_MS = 120;

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function encodeMenuValuePart(value: string): string {
	return encodeURIComponent(value);
}

function decodeMenuValuePart(value: string | undefined): string {
	if (!value) return "";
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function HcpClientpackageidfromselector(selector: string): string {
	const github = HcpClientparsegithubpackageselector(selector);
	if (github) return github.package;
	return HcpClientparsepackageselector(selector).packageId;
}

function formatHarnessSourceLabel(source: string): string {
	switch (source) {
		case "pi":
			return "Pi";
		case "magenta":
			return "Magenta";
		case "codex":
			return "Codex";
		case "jcode":
			return "JCode";
		case "claude-code":
			return "Claude Code";
		default:
			return source;
	}
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_BINARY_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

function hasDefaultModelProvider(providerId: string): providerId is keyof typeof defaultModelPerProvider {
	return providerId in defaultModelPerProvider;
}

const BEDROCK_PROVIDER_ID = "amazon-bedrock";

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .pi directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
}

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private ui: TUI;
	private loadedResourcesContainer: Container;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private readonly imageTokenController = new ImageTokenController();
	private readonly pendingImageController = new PendingImageController();
	private clipboardImagePasteQueue: Promise<void> = Promise.resolve();
	private clipboardImagePastePending = 0;
	private clipboardImageDraftGeneration = 0;
	private editor: EditorComponent;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private isTuiActive = false;
	private onInputCallback?: (input: SubmittedInput) => void;
	private pendingUserInputs: SubmittedInput[] = [];
	// Magenta feature: unified activation queue. The main loop consumes
	// Activations from a single source; producers are the keyboard (user_input)
	// and idle peer wake (peer_wake). This keeps one turn-runner and lets future
	// push-style triggers (timers, file watches, webhooks) add producers without
	// touching the loop.
	private activationQueue: Activation[] = [];
	private onActivationCallback?: (activation: Activation) => void;
	private releaseExternalTurnRunner?: () => void;
	private loadingAnimation: Loader | undefined = undefined;
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: LoaderIndicatorOptions | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;

	// Serializes harness package selection changes so overlapping toggles cannot
	// start concurrent reloads (each change awaits the previous one).
	private HcpClientpackagemutation: Promise<void> = Promise.resolve();
	private HcpClientpackagecatalogcache: { expiresAt: number; result: HcpClientpackagecatalogresult } | undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	private streamingToolGroup: ToolExecutionGroupComponent | undefined = undefined;
	private streamingAnimationTimer: NodeJS.Timeout | undefined = undefined;

	// Adaptive rendering: track message_update event rate to dynamically adjust render interval

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private pendingToolGroups = new Map<string, ToolExecutionGroupComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Center command dock, used for slash palette and nested model/harness menus.
	private commandDockHandle: OverlayHandle | undefined = undefined;
	private commandDockBody: FloatingMenuBody | undefined = undefined;
	private suppressCommandDockSync = false;
	private commandDockInputUnsubscribe: (() => void) | undefined = undefined;
	private commandDockRequestId = 0;

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	// Skill hot-reload subscription unsubscribe function
	private unsubscribeSkillsReloaded?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;
	private ultraBorderAnimationTimer: NodeJS.Timeout | undefined = undefined;
	private ultraBorderAnimationPhase = 0;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryCountdown: CountdownTimer | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;
	private autoTrustOnReloadCwd: string | undefined;
	private themeController: InteractiveThemeController;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.options = options;
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
		});
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			slashAutocomplete: false,
		});
		this.configureImageTokens();
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(
			this.ui,
			this.settingsManager,
			(message) => this.showError(message),
			() => this.updateEditorBorderColor(),
		);
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider in either order.
				const filtered = fuzzyFilter(items, prefix, getModelSearchText);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		// Add header container as first child. Populate it after applying theme settings.
		// Keep startup diagnostics before chat so restored session messages never precede them.
		this.ui.addChild(this.headerContainer);
		this.ui.addChild(this.loadedResourcesContainer);

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isTuiActive = true;
		this.isInitialized = true;

		await this.themeController.applyFromSettings();

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			// Brand the logo in Magenta's signature magenta (洋红色), independent of theme
			// accent and chalk's color-level detection. Uses a direct 24-bit ANSI escape,
			// the same truecolor form the theme renderer emits.
			const MAGENTA_FG = "\x1b[38;2;255;0;255m";
			const FG_RESET = "\x1b[39m";
			const logo = theme.bold(`${MAGENTA_FG}${APP_NAME}${FG_RESET}`);

			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.restart", "to restart"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			const compactInstructions = [
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "details"),
			].join(theme.fg("muted", " · "));
			const compactOnboarding = theme.fg("dim", `Press ${keyText("app.tools.expand")} to show startup details.`);
			this.builtInHeader = new ExpandableText(
				() => `${logo}\n${compactInstructions}\n${compactOnboarding}`,
				() => `${logo}\n${expandedInstructions}`,
				this.getStartupExpansionState(),
				1,
				0,
			);

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		this.ui.requestRender();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Render initial messages AFTER startup diagnostics are positioned.
		this.renderInitialMessages();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Pi's own pi.dev version check is disabled for Magenta — we ship from a
		// GitHub checkout and auto-update against origin/main instead (below).
		// checkForNewPiVersion(this.version).then((newRelease) => {
		// 	if (newRelease) {
		// 		this.showNewVersionNotification(newRelease);
		// 	}
		// });

		// Auto-update Magenta from its GitHub checkout (fast-forward + rebuild).
		void this.checkAndAutoUpdateMagenta();

		// Start package update check asynchronously
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) {
				this.showPackageUpdateNotification(updates);
			}
		});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop. Consumes a single activation queue fed by two
		// producers: keyboard input and idle peer wake. Running every activation
		// through one loop keeps a single turn-runner, so a wake turn never races
		// the input prompt.
		while (true) {
			const activation = await this.getNextActivation();
			let promptAccepted = false;
			try {
				if (activation.type === "user_input") {
					await this.session.prompt(activation.input.text, {
						images: activation.input.images,
						imageMarkers: activation.input.imageMarkers,
						preflightResult: (success) => {
							promptAccepted = success;
						},
					});
				} else {
					// peer_wake: the payload is already in session state; run one turn.
					await this.session.runExternalActivation();
				}
			} catch (error: unknown) {
				if (activation.type === "user_input" && !promptAccepted) {
					this.restoreSubmittedInputToEditor(activation.input);
				}
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.PI_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: this.sessionManager.getCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version, send telemetry, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		return undefined;
	}

	private reportInstallTelemetry(version: string): void {
		if (process.env.PI_OFFLINE) {
			return;
		}

		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			return;
		}

		void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
			headers: {
				"User-Agent": getPiUserAgent(version),
			},
			signal: AbortSignal.timeout(5000),
		})
			.then(() => undefined)
			.catch(() => undefined);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	private configureImageTokens(): void {
		if (!this.settingsManager.getCompressImageTokens()) {
			this.imageTokenController.clear();
			this.defaultEditor.setImageTokenController(undefined);
			return;
		}

		this.defaultEditor.setImageTokenController(this.imageTokenController, () => theme);
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		this.loadedResourcesContainer.clear();

		const showListing = options?.force || this.options.verbose || this.toolOutputExpanded;
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.loadedResourcesContainer.addChild(section);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
			if (contextFiles.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}

			// Show loaded themes (excluding built-in)
			const loadedThemes = themesResult.themes;
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("Themes", themeCompactList, themeList);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();
					try {
						return await this.runtimeHost.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();
		// Rebuild the skill autocomplete list whenever skills hot-reload on disk. Re-subscribe on each
		// bind so the callback closes over the current session's loader; drop any prior subscription.
		this.unsubscribeSkillsReloaded?.();
		this.unsubscribeSkillsReloaded = this.session.resourceLoader.onSkillsReloaded?.(() => {
			this.setupAutocompleteProvider();
		});
		const sshTarget = this.session.sshTarget;
		this.setExtensionStatus(
			"ssh",
			sshTarget ? theme.fg("accent", `SSH: ${sshTarget.remote}:${sshTarget.remoteCwd}`) : undefined,
		);

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private applyRuntimeSettings(): void {
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applyRuntimeSettings();
		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
			await this.bindCurrentSessionExtensions();
		} else {
			await this.bindCurrentSessionExtensions();
			this.subscribeToAgent();
		}
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private renderCurrentSessionState(): void {
		this.loadedResourcesContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.stopStreamingAnimation();
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.streamingToolGroup = undefined;
		this.pendingTools.clear();
		this.pendingToolGroups.clear();
		this.renderInitialMessages();
	}

	private startStreamingAnimation(): void {
		if (this.streamingAnimationTimer) return;
		this.streamingAnimationTimer = setInterval(() => {
			if (this.streamingComponent) {
				const hasMore = this.streamingComponent.advance();
				if (hasMore) {
					this.ui.requestRender();
				} else {
					// No more content to animate, stop timer
					this.stopStreamingAnimation();
				}
			}
		}, 16); // 60 FPS
	}

	private stopStreamingAnimation(): void {
		if (this.streamingAnimationTimer) {
			clearInterval(this.streamingAnimationTimer);
			this.streamingAnimationTimer = undefined;
		}
		// Ensure all content is displayed before stopping
		if (this.streamingComponent) {
			this.streamingComponent.finishAnimation();
			this.ui.requestRender();
		}
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.getToolDefinition(toolName);
	}

	private clearPendingToolDisplays(): void {
		this.pendingTools.clear();
		this.pendingToolGroups.clear();
		this.streamingToolGroup = undefined;
	}

	private createToolExecutionComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{
				showImages: this.settingsManager.getShowImages(),
				imageWidthCells: this.settingsManager.getImageWidthCells(),
			},
			this.getRegisteredToolDefinition(toolName),
			this.ui,
			this.sessionManager.getCwd(),
		);
		component.setExpanded(this.toolOutputExpanded);
		return component;
	}

	private ensureStreamingToolGroup(): ToolExecutionGroupComponent {
		if (!this.streamingToolGroup) {
			this.streamingToolGroup = new ToolExecutionGroupComponent({
				showImages: this.settingsManager.getShowImages(),
			});
			this.streamingToolGroup.setExpanded(this.toolOutputExpanded);
			this.chatContainer.addChild(this.streamingToolGroup);
		}
		return this.streamingToolGroup;
	}

	private registerToolInGroup(
		group: ToolExecutionGroupComponent,
		toolName: string,
		toolCallId: string,
		args: unknown,
	): ToolExecutionComponent {
		let component = this.pendingTools.get(toolCallId);
		if (!component) {
			component = this.createToolExecutionComponent(toolName, toolCallId, args);
			this.pendingTools.set(toolCallId, component);
		}
		group.addOrUpdateTool(toolCallId, toolName, args, component);
		this.pendingToolGroups.set(toolCallId, group);
		return component;
	}

	private ensureLiveToolDisplay(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
		const group = this.pendingToolGroups.get(toolCallId) ?? this.ensureStreamingToolGroup();
		return this.registerToolInGroup(group, toolName, toolCallId, args);
	}

	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private setMagentaUpdateStatus(text: string | undefined): void {
		this.setExtensionStatus("magenta-update", text);
	}

	private getWorkingLoaderMessage(): string {
		return this.workingMessage ?? this.defaultWorkingMessage;
	}

	private createWorkingLoader(): Loader {
		return new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			this.getWorkingLoaderMessage(),
			this.workingIndicatorOptions,
		);
	}

	private stopWorkingLoader(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.stopWorkingLoader();
			this.ui.requestRender();
			return;
		}
		if (this.session.isStreaming && !this.loadingAnimation) {
			this.statusContainer.clear();
			this.loadingAnimation = this.createWorkingLoader();
			this.statusContainer.addChild(this.loadingAnimation);
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.loadingAnimation?.setIndicator(options);
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.loadingAnimation) {
					this.loadingAnimation.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					return this.themeController.setThemeInstance(themeOrName);
				}
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save the complete draft surface before switching editor implementations.
		const currentText = this.editor.getText();
		const pasteMarkers: PasteMarkerSnapshot =
			this.editor.getPasteMarkerSnapshot?.() ?? this.defaultEditor.getPasteMarkerSnapshot();
		this.invalidateClipboardImagePastes();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text and registered atomic markers from the previous editor.
			newEditor.setText(currentText);
			newEditor.restorePasteMarkerSnapshot?.(pasteMarkers);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.) through onAction when available
				// so editor wrappers can forward them to the inner component that handles input.
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					const onAction = customEditor.onAction;
					if (typeof onAction === "function") {
						onAction.call(customEditor, action, handler);
					} else {
						(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
					}
				}
			}

			this.editor = newEditor;
		} else {
			// Restore the default editor with the custom editor's complete draft state.
			this.defaultEditor.setText(currentText);
			this.defaultEditor.restorePasteMarkerSnapshot(pasteMarkers);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		this.commandDockInputUnsubscribe?.();
		this.commandDockInputUnsubscribe = this.ui.addInputListener((data) => this.handleCommandDockInput(data));

		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.restart", () => this.handleRestart());
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());
		this.defaultEditor.onAction("app.mcp.manage", () => this.showMcpManager());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
			this.syncCommandDockFromEditorText(text);
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			const generation = this.clipboardImageDraftGeneration;
			const targetEditor = this.editor;
			this.clipboardImagePastePending++;
			const pasteTask = this.clipboardImagePasteQueue.then(() =>
				this.handleClipboardImagePaste(generation, targetEditor),
			);
			this.clipboardImagePasteQueue = pasteTask.finally(() => {
				this.clipboardImagePastePending--;
			});
			return this.clipboardImagePasteQueue;
		};
	}

	private invalidateClipboardImagePastes(): void {
		this.clipboardImageDraftGeneration++;
	}

	private async settleClipboardImagePastes(): Promise<void> {
		if (this.clipboardImagePastePending <= 0) return;
		const targetEditor = this.editor;
		this.ui.setFocus(null);
		try {
			await this.clipboardImagePasteQueue;
		} finally {
			if (!this.isShuttingDown && targetEditor === this.editor) {
				this.ui.setFocus(this.editor as Component);
			}
		}
	}

	private isClipboardImagePasteCurrent(generation: number, targetEditor: EditorComponent): boolean {
		return generation === this.clipboardImageDraftGeneration && targetEditor === this.editor && !this.isShuttingDown;
	}

	private async prepareClipboardImage(bytes: Uint8Array, mimeType: string): Promise<ImageContent | undefined> {
		if (!this.settingsManager.getImageAutoResize()) {
			return { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") };
		}
		const resized = await resizeImage(bytes, mimeType);
		if (!resized) return undefined;
		return { type: "image", mimeType: resized.mimeType, data: resized.data };
	}

	private insertPendingImage(
		image: ImageContent,
		targetEditor: EditorComponent = this.editor,
		generation = this.clipboardImageDraftGeneration,
	): boolean {
		if (!this.isClipboardImagePasteCurrent(generation, targetEditor)) return false;
		const paste = targetEditor.insertPasteMarker?.("Image");
		if (!paste) {
			this.showWarning("The active editor does not support clipboard image markers");
			return false;
		}
		this.pendingImageController.add(paste.marker, image);
		this.ui.requestRender();
		return true;
	}

	private async handleClipboardImagePaste(generation: number, targetEditor: EditorComponent): Promise<void> {
		try {
			if (!this.isClipboardImagePasteCurrent(generation, targetEditor)) return;
			const clipboardPaths = readClipboardFilePaths();
			let handledPath = false;
			for (const clipboardPath of clipboardPaths) {
				if (!this.isClipboardImagePasteCurrent(generation, targetEditor)) return;
				const mimeType = await detectSupportedImageMimeTypeFromFile(clipboardPath);
				if (!this.isClipboardImagePasteCurrent(generation, targetEditor)) return;
				if (!mimeType) {
					targetEditor.insertTextAtCursor?.(`${clipboardPath} `);
					handledPath = true;
					continue;
				}
				const bytes = await fs.promises.readFile(clipboardPath);
				const content = await this.prepareClipboardImage(bytes, mimeType);
				if (content && this.insertPendingImage(content, targetEditor, generation)) handledPath = true;
			}
			if (handledPath || !this.isClipboardImagePasteCurrent(generation, targetEditor)) return;

			const image = await readClipboardImage();
			if (!image || !this.isClipboardImagePasteCurrent(generation, targetEditor)) return;
			const content = await this.prepareClipboardImage(image.bytes, image.mimeType);
			if (content) this.insertPendingImage(content, targetEditor, generation);
		} catch {
			// Clipboard access is best-effort and can be denied by the OS or terminal.
		}
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			if (this.clipboardImagePastePending > 0) {
				await this.settleClipboardImagePastes();
				const latePasteText = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
				if (latePasteText) {
					text = [text, latePasteText].filter((value) => value.trim()).join(" ");
					this.editor.setText("");
					this.editor.clearPasteMarkers?.();
				}
			}
			this.invalidateClipboardImagePastes();
			text = this.defaultEditor.transformImageTokenInput(text);
			this.defaultEditor.clearImageTokens();
			const submittedInput = this.pendingImageController.takeForText(text.trim());
			text = submittedInput.text;
			if (!text) return;

			text = applyCommandAlias(text);
			submittedInput.text = text;

			// Handle commands
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/mcp") {
				this.showMcpManager();
				this.editor.setText("");
				return;
			}
			if (text === "/todo") {
				this.editor.setText("");
				this.showTodoOverlay();
				return;
			}
			if (text === "/harness" || text.startsWith("/harness ") || text === "/h" || text.startsWith("/h ")) {
				this.editor.setText("");
				await this.handleHarnessCommand(text);
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/clone") {
				this.editor.setText("");
				await this.handleCloneCommand();
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/trust") {
				this.showTrustSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login") {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/new") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/refresh") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleRecompileRestartCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/dementedelves") {
				this.handleDementedDelves();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit" || text === "/exit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text, {
						images: submittedInput.images,
						imageMarkers: submittedInput.imageMarkers,
					});
				} else {
					this.queueCompactionMessage(submittedInput, "steer");
				}
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text, {
					streamingBehavior: "steer",
					images: submittedInput.images,
					imageMarkers: submittedInput.imageMarkers,
				});
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(submittedInput);
			} else {
				this.pendingUserInputs.push(submittedInput);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
		// Magenta feature: claim the turn-runner so idle peer wakes are delivered as
		// external_activation events for our main loop to run, instead of the session
		// self-running the turn and racing the input prompt.
		this.releaseExternalTurnRunner = this.session.claimExternalTurnRunner();
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				this.clearPendingToolDisplays();
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				this.stopWorkingLoader();
				if (this.workingVisible) {
					this.loadingAnimation = this.createWorkingLoader();
					this.statusContainer.addChild(this.loadingAnimation);
				}
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
			case "execution_profile_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "external_activation":
				// Magenta feature: an idle peer wake appended its payload to session
				// state and handed the turn to us. Enqueue an activation so the main
				// loop runs exactly one turn through the single turn-runner.
				this.pushActivation({ type: "peer_wake" });
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage);
					this.startStreamingAnimation();
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage);
					this.startStreamingAnimation(); // Restart animation if stopped

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							this.registerToolInGroup(
								this.ensureStreamingToolGroup(),
								content.name,
								content.id,
								content.arguments,
							);
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage);
					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							this.registerToolInGroup(
								this.ensureStreamingToolGroup(),
								content.name,
								content.id,
								content.arguments,
							);
						}
					}

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [toolCallId, component] of this.pendingTools.entries()) {
							const result = {
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							};
							const group = this.pendingToolGroups.get(toolCallId);
							if (group) {
								group.updateResult(toolCallId, result, false);
							} else {
								component.updateResult(result);
							}
						}
						this.clearPendingToolDisplays();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.stopStreamingAnimation();
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.streamingToolGroup = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				const component = this.ensureLiveToolDisplay(event.toolName, event.toolCallId, event.args);
				component.markExecutionStarted();
				this.pendingToolGroups.get(event.toolCallId)?.markExecutionStarted(event.toolCallId);
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					const result = { ...event.partialResult, isError: false };
					const group = this.pendingToolGroups.get(event.toolCallId);
					if (group) {
						group.updateResult(event.toolCallId, result, true);
					} else {
						component.updateResult(result, true);
					}
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					const result = { ...event.result, isError: event.isError };
					const group = this.pendingToolGroups.get(event.toolCallId);
					if (group) {
						group.updateResult(event.toolCallId, result, false);
					} else {
						component.updateResult(result);
					}
					this.pendingTools.delete(event.toolCallId);
					this.pendingToolGroups.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.stopStreamingAnimation();
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.clearPendingToolDisplays();

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "compaction_start": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				this.statusContainer.clear();
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					event.reason === "manual"
						? `Compacting context... ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					label,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "compaction_progress": {
				if (!this.autoCompactionLoader) break;
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				let phaseLabel: string;
				switch (event.phase) {
					case "preparing":
						phaseLabel = "preparing";
						break;
					case "extensions":
						phaseLabel = "extensions";
						break;
					case "summarizing":
						if (event.totalBytes !== undefined && event.processedBytes !== undefined) {
							const fraction = event.totalBytes > 0 ? event.processedBytes / event.totalBytes : 0;
							const filled = Math.round(fraction * 10);
							const bar = "▓".repeat(filled) + "░".repeat(Math.max(0, 10 - filled));
							const pct = Math.round(fraction * 100);
							phaseLabel = `summarizing \u00b7 ${bar} ${pct}%`;
						} else {
							phaseLabel = "summarizing";
						}
						break;
					case "persisting":
						phaseLabel = "persisting";
						break;
					default:
						phaseLabel = "working";
				}
				const label =
					event.reason === "manual"
						? `Compacting context \u00b7 ${phaseLabel} ${cancelHint}`
						: `${event.reason === "overflow" ? "Context overflow, " : ""}compacting \u00b7 ${phaseLabel} ${cancelHint}`;
				this.autoCompactionLoader.setMessage(label);
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				// Show retry indicator
				this.statusContainer.clear();
				this.retryCountdown?.dispose();
				const retryMessage = (seconds: number) =>
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					retryMessage(Math.ceil(event.delayMs / 1000)),
				);
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.ui,
					(seconds) => {
						this.retryLoader?.setMessage(retryMessage(seconds));
					},
					() => {
						this.retryCountdown = undefined;
					},
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	private showSystemMessage(message: string): void {
		this.addMessageToChat({
			role: "custom",
			customType: "system",
			content: message,
			display: true,
			details: { source: "harness" },
			timestamp: Date.now(),
		});
		this.ui.requestRender();
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.clearPendingToolDisplays();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		const renderedPendingGroups = new Map<string, ToolExecutionGroupComponent>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				let group: ToolExecutionGroupComponent | undefined;
				for (const content of message.content) {
					if (content.type === "toolCall") {
						if (!group) {
							group = new ToolExecutionGroupComponent({
								showImages: this.settingsManager.getShowImages(),
							});
							group.setExpanded(this.toolOutputExpanded);
							this.chatContainer.addChild(group);
						}
						const component = this.createToolExecutionComponent(content.name, content.id, content.arguments);
						group.addOrUpdateTool(content.id, content.name, content.arguments, component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							group.updateResult(
								content.id,
								{ content: [{ type: "text", text: errorMessage }], isError: true },
								false,
							);
						} else {
							renderedPendingTools.set(content.id, component);
							renderedPendingGroups.set(content.id, group);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					const group = renderedPendingGroups.get(message.toolCallId);
					if (group) {
						group.updateResult(message.toolCallId, message, false);
					} else {
						component.updateResult(message);
					}
					renderedPendingTools.delete(message.toolCallId);
					renderedPendingGroups.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
			const group = renderedPendingGroups.get(toolCallId);
			if (group) this.pendingToolGroups.set(toolCallId, group);
		}
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart ${APP_NAME}.`,
				),
				1,
				0,
			),
		);
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput.text;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (input: SubmittedInput) => {
				this.onInputCallback = undefined;
				resolve(input.text);
			};
		});
	}

	/**
	 * Magenta feature: pull the next activation for the main loop. Drains any
	 * queued activation first (peer wakes queued while busy, or input queued
	 * before the loop was ready), otherwise blocks until either producer fires:
	 * keyboard submit (user_input) or an idle peer wake (peer_wake).
	 */
	async getNextActivation(): Promise<Activation> {
		// Drain queued activations first (FIFO). Keyboard input queued before the
		// loop was ready lives in pendingUserInputs; fold it in as a user_input.
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return { type: "user_input", input: queuedInput };
		}
		const queued = this.activationQueue.shift();
		if (queued !== undefined) {
			return queued;
		}

		return new Promise((resolve) => {
			// Keyboard producer: reuse the existing onInputCallback contract so the
			// submit handler and the startup-input test keep working unchanged.
			this.onInputCallback = (input: SubmittedInput) => {
				this.onInputCallback = undefined;
				this.onActivationCallback = undefined;
				resolve({ type: "user_input", input });
			};
			// Peer-wake producer: pushActivation resolves through this.
			this.onActivationCallback = (activation: Activation) => {
				this.onInputCallback = undefined;
				this.onActivationCallback = undefined;
				resolve(activation);
			};
		});
	}

	/**
	 * Magenta feature: enqueue an activation from a non-keyboard producer (idle
	 * peer wake). If the main loop is blocked waiting, resolve it immediately;
	 * otherwise queue it so the next getNextActivation() picks it up.
	 */
	private pushActivation(activation: Activation): void {
		if (this.onActivationCallback) {
			this.onActivationCallback(activation);
		} else {
			this.activationQueue.push(activation);
		}
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	private handleRestart(): void {
		void this.restartProcess();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.invalidateClipboardImagePastes();
		this.stopUltraBorderAnimation();
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			this.themeController.disableAutoSync();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.themeController.disableAutoSync();
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		process.exit(0);
	}

	private async restartProcess(): Promise<void> {
		// Same arguments and environment (skip the node executable path).
		await this.respawnAndExit(process.argv.slice(1));
	}

	/**
	 * Restart the process reconnecting to the current session. `/reload` uses this
	 * so the rebuilt code picks up exactly where the user left off. When the
	 * session is persisted we pass an explicit `--session <id>` (and matching
	 * `--session-dir` for a non-default dir); if `--session` is already present in
	 * argv we reuse the original args unchanged.
	 */
	private async restartProcessWithSession(): Promise<void> {
		const args = process.argv.slice(1);
		const alreadyHasSession = args.includes("--session") || args.includes("--session-id");
		if (!alreadyHasSession && this.sessionManager.isPersisted()) {
			if (!this.sessionManager.usesDefaultSessionDir()) {
				args.push("--session-dir", this.sessionManager.getSessionDir());
			}
			args.push("--session", this.sessionManager.getSessionId());
		}
		await this.respawnAndExit(args);
	}

	/**
	 * Tear down the TUI cleanly, spawn a replacement process attached to the same
	 * terminal, and exit. Never returns.
	 */
	private async respawnAndExit(args: string[]): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.invalidateClipboardImagePastes();
		this.stopUltraBorderAnimation();

		// Clean shutdown before restart
		this.themeController.disableAutoSync();
		await this.ui.terminal.drainInput(1000);
		this.stop();
		await this.runtimeHost.dispose();

		const { spawn } = await import("child_process");
		const child = spawn(process.argv[0], args, {
			detached: false,
			stdio: "inherit",
			env: process.env,
			cwd: process.cwd(),
		});

		child.on("exit", (code) => {
			process.exit(code ?? 0);
		});

		// Exit current process after spawning replacement
		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.invalidateClipboardImagePastes();
		this.stopUltraBorderAnimation();
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		this.invalidateClipboardImagePastes();
		this.stopUltraBorderAnimation();
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.isTuiActive = false;
			this.ui.stop();
		} catch {}
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in the app) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.isTuiActive = true;
			this.updateEditorBorderColor();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.stopUltraBorderAnimation();
			this.isTuiActive = false;
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		await this.settleClipboardImagePastes();
		this.invalidateClipboardImagePastes();
		let text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		text = this.defaultEditor.transformImageTokenInput(text);
		this.defaultEditor.clearImageTokens();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			const input = this.pendingImageController.takeForText(text);
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				this.editor.clearPasteMarkers?.();
				await this.session.prompt(text, { images: input.images, imageMarkers: input.imageMarkers });
			} else {
				this.queueCompactionMessage(input, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			const input = this.pendingImageController.takeForText(text);
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			this.editor.clearPasteMarkers?.();
			await this.session.prompt(text, {
				streamingBehavior: "followUp",
				images: input.images,
				imageMarkers: input.imageMarkers,
			});
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.clearPasteMarkers?.();
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private shouldAnimateUltraBorder(): boolean {
		return (
			this.isInitialized &&
			this.isTuiActive &&
			!this.isShuttingDown &&
			!this.isBashMode &&
			this.session.executionProfile === "ultra"
		);
	}

	private applyEditorBorderColor(): void {
		const borderColor = this.isBashMode
			? theme.getBashModeBorderColor()
			: this.session.executionProfile === "ultra"
				? theme.getUltraBorderColor(this.ultraBorderAnimationPhase)
				: theme.getThinkingBorderColor(this.session.thinkingLevel || "off");
		this.defaultEditor.borderColor = borderColor;
		if (this.editor !== this.defaultEditor) this.editor.borderColor = borderColor;
	}

	private startUltraBorderAnimation(): void {
		if (this.ultraBorderAnimationTimer || !this.shouldAnimateUltraBorder()) return;
		this.ultraBorderAnimationTimer = setInterval(() => {
			if (!this.shouldAnimateUltraBorder()) {
				this.stopUltraBorderAnimation();
				return;
			}
			this.ultraBorderAnimationPhase++;
			this.applyEditorBorderColor();
			this.ui.requestRender();
		}, ULTRA_BORDER_ANIMATION_INTERVAL_MS);
		this.ultraBorderAnimationTimer.unref();
	}

	private stopUltraBorderAnimation(): void {
		if (this.ultraBorderAnimationTimer) {
			clearInterval(this.ultraBorderAnimationTimer);
			this.ultraBorderAnimationTimer = undefined;
		}
		this.ultraBorderAnimationPhase = 0;
	}

	private updateEditorBorderColor(): void {
		if (this.shouldAnimateUltraBorder()) this.startUltraBorderAnimation();
		else this.stopUltraBorderAnimation();
		this.applyEditorBorderColor();
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Execution profile: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		this.showLoadedResources({ showDiagnosticsWhenQuiet: true });
		for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
			for (const child of container.children) {
				if (isExpandable(child)) {
					child.setExpanded(expanded);
				}
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.streamingMessage);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async openExternalEditor(): Promise<void> {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.invalidateClipboardImagePastes();
			this.stopUltraBorderAnimation();
			this.isTuiActive = false;
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after ui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			// On successful exit (status 0), replace editor content
			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			this.isTuiActive = true;
			this.updateEditorBorderColor();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.invalidateClipboardImagePastes();
		this.editor.setText("");
		this.editor.clearPasteMarkers?.();
		this.defaultEditor.clearImageTokens();
		this.pendingImageController.clear();
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(_release: LatestPiRelease): void {
		// Temporarily disabled update notification
		// const action = theme.fg("accent", `${APP_BINARY_NAME} update`);
		// const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
		// const changelogUrl = "https://pi.dev/changelog";
		// const changelogLink = getCapabilities().hyperlinks
		// 	? hyperlink(theme.fg("accent", changelogUrl), changelogUrl)
		// 	: theme.fg("accent", changelogUrl);
		// const changelogLine = theme.fg("muted", "Changelog: ") + changelogLink;
		// const note = release.note?.trim();
		// this.chatContainer.addChild(new Spacer(1));
		// this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		// this.chatContainer.addChild(
		// 	new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`, 1, 0),
		// );
		// if (note) {
		// 	this.chatContainer.addChild(new Spacer(1));
		// 	this.chatContainer.addChild(
		// 		new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
		// 			color: (text) => theme.fg("muted", text),
		// 		}),
		// 	);
		// 	this.chatContainer.addChild(new Spacer(1));
		// }
		// this.chatContainer.addChild(new Text(changelogLine, 1, 0));
		// this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		// this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_BINARY_NAME} update --extensions`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Check origin/main and auto-update the Magenta checkout when it is safe:
	 * only when the working tree is clean and can fast-forward. A dirty or
	 * diverged checkout (e.g. active development) is left untouched with a hint.
	 * Runs in the background; never throws.
	 */
	private async checkAndAutoUpdateMagenta(): Promise<void> {
		if (process.env.MAGENTA_SKIP_UPDATE) {
			this.setMagentaUpdateStatus("Auto-update: off");
			return;
		}
		if (process.env.PI_OFFLINE) {
			this.setMagentaUpdateStatus("Auto-update: offline");
			return;
		}

		this.setMagentaUpdateStatus("Auto-update: checking");
		try {
			const unified = await checkForAnyUpdate();

			if (unified.type === "unavailable") {
				this.setMagentaUpdateStatus("Auto-update: unavailable");
				return;
			}

			if (unified.type === "git") {
				await this.handleGitUpdateStatus(unified.status);
				return;
			}

			// unified.type === "release"
			this.handleReleaseUpdateStatus(unified.status);
		} catch {
			// Auto-update is best-effort; never disrupt the session on failure.
			this.setMagentaUpdateStatus("Auto-update: unavailable");
		}
	}

	/** Handle update status for Git checkout installations (developer mode). */
	private async handleGitUpdateStatus(status: Awaited<ReturnType<typeof checkForMagentaUpdate>>): Promise<void> {
		if (!status) {
			this.setMagentaUpdateStatus("Auto-update: unavailable");
			return;
		}
		if (status.behind === 0) {
			this.setMagentaUpdateStatus(`Auto-update: up to date (${status.localSha})`);
			return;
		}

		if (!status.clean || !status.fastForwardable) {
			this.setMagentaUpdateStatus(status.clean ? "Auto-update: skipped (diverged)" : "Auto-update: skipped (dirty)");
			this.showMagentaUpdateBanner(
				`${APP_NAME} is ${status.behind} commit(s) behind ${status.remoteSha}.`,
				status.clean
					? "Local branch has diverged — run git pull manually to update."
					: "Working tree has uncommitted changes — auto-update skipped.",
			);
			return;
		}

		this.setMagentaUpdateStatus(`Auto-update: updating ${status.localSha} -> ${status.remoteSha}`);
		this.showMagentaUpdateBanner(
			`Updating ${APP_NAME} (${status.behind} commit(s) behind)…`,
			`${status.localSha} → ${status.remoteSha}. This may take a minute.`,
		);
		const result = await runMagentaUpdate(status);
		if (result.ok) {
			const newSha = result.newSha ?? status.remoteSha;
			this.setMagentaUpdateStatus(`Auto-update: updated (${newSha})`);
			this.showMagentaUpdateBanner(
				`${APP_NAME} updated to ${newSha}.`,
				`Restart ${APP_NAME} to run the new version.`,
			);
		} else {
			this.setMagentaUpdateStatus("Auto-update: failed");
			this.showMagentaUpdateBanner(
				`${APP_NAME} auto-update failed.`,
				`${result.reason ?? "unknown error"} — update manually with git pull && npm install && npm run build.`,
			);
		}
	}

	/** Handle update status for binary installations (GitHub Releases). */
	private handleReleaseUpdateStatus(status: UpdateCheckResult): void {
		if (status.error) {
			this.setMagentaUpdateStatus("Auto-update: unavailable");
			return;
		}

		if (!status.updateAvailable) {
			this.setMagentaUpdateStatus(`Auto-update: up to date (v${status.currentVersion})`);
			return;
		}

		this.setMagentaUpdateStatus(`Auto-update: v${status.latestVersion} available`);
		const notes = status.releaseNotes ? this.summarizeReleaseNotes(status.releaseNotes) : undefined;
		this.showMagentaUpdateBanner(
			`${APP_NAME} v${status.latestVersion} is available (current: v${status.currentVersion}).`,
			`${notes ? `${notes}\n` : ""}Run '${APP_NAME.toLowerCase()} --update' to install, then restart.`,
		);
	}

	/** Truncate release notes to a few lines for banner display. */
	private summarizeReleaseNotes(notes: string): string {
		const lines = notes
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));
		const preview = lines.slice(0, 3).join("\n");
		return lines.length > 3 ? `${preview}\n…` : preview;
	}

	private showMagentaUpdateBanner(title: string, detail: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(`${theme.bold(theme.fg("warning", title))}\n${theme.fg("muted", detail)}`, 1, 0),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: SubmittedInput[]; followUp: SubmittedInput[] } {
		const { steering, followUp } = this.session.clearQueueWithContent();
		const compactionSteering = this.compactionQueuedMessages
			.filter((message) => message.mode === "steer")
			.map(({ mode: _mode, ...input }) => input);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((message) => message.mode === "followUp")
			.map(({ mode: _mode, ...input }) => input);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	private restoreQueuedInput(input: SubmittedInput): string {
		let text = input.text;
		const oldMarkers = input.imageMarkers ?? [];
		for (let index = 0; index < (input.images?.length ?? 0); index++) {
			const candidate = oldMarkers[index];
			const oldMarker = candidate && text.includes(candidate) ? candidate : undefined;
			const paste = this.editor.createPasteMarker?.("Image");
			const marker = paste?.marker ?? oldMarker;
			if (!marker) continue;
			if (oldMarker && marker !== oldMarker) text = text.replaceAll(oldMarker, marker);
			else if (!oldMarker) text = [text, marker].filter(Boolean).join(" ");
			this.pendingImageController.add(marker, input.images![index]!);
		}
		return text;
	}

	private restoreSubmittedInputToEditor(input: SubmittedInput): void {
		const restoredText = this.restoreQueuedInput(input);
		const currentText = this.editor.getText();
		this.editor.setText([restoredText, currentText].filter((value) => value.trim()).join("\n\n"));
		this.ui.requestRender();
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.map((input) => this.restoreQueuedInput(input)).join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((value) => value.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(input: SubmittedInput, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ ...input, mode });
		this.editor.addToHistory?.(input.text);
		this.editor.setText("");
		this.editor.clearPasteMarkers?.();
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (commandName === "events") return true;
		if (commandName === "mcp") return true;
		if (commandName === "side" || commandName === "btw" || commandName === "s") return true;
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text, {
							images: message.images,
							imageMarkers: message.imageMarkers,
						});
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text, message.images, message.imageMarkers);
					} else {
						await this.session.steer(message.text, message.images, message.imageMarkers);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text, {
						images: message.images,
						imageMarkers: message.imageMarkers,
					});
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text, {
					images: message.images,
					imageMarkers: message.imageMarkers,
				});
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.session
				.prompt(firstPrompt.text, {
					images: firstPrompt.images,
					imageMarkers: firstPrompt.imageMarkers,
				})
				.catch((error) => {
					restoreQueue(error);
				});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text, {
						images: message.images,
						imageMarkers: message.imageMarkers,
					});
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text, message.images, message.imageMarkers);
				} else {
					await this.session.steer(message.text, message.images, message.imageMarkers);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * 统一的中央浮动窗口入口 - 唯一的显示函数
	 * 通过配置和模板系统适配不同类型的内容
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 * @param config 中央浮动窗口配置
	 */
	private showCentralOverlay(
		create: (done: () => void) => { component: Component; focus: Component },
		config?: CentralOverlayConfig,
	): void {
		let handle: OverlayHandle | undefined;
		const done = () => {
			handle?.hide();
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);

		// 初始化焦点状态
		initializeFocus(focus);

		// 创建适配器，将组件包装为 FloatingOverlayBody
		const body = createCentralOverlayAdapter(component, focus, config ?? {});

		// 构建 overlay 配置
		const overlayOptions = buildOverlayOptions(config ?? {});

		// 创建并显示浮动窗口
		const overlay = new FloatingOverlayContainer(body, done);
		handle = this.ui.showOverlay(overlay, overlayOptions);
		handle.focus();
		this.ui.requestRender();
	}

	/**
	 * 显示选择器（保持向后兼容，内部调用 showCentralOverlay）
	 * @deprecated 使用 showCentralOverlay 替代
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		this.showCentralOverlay(create, {
			type: "selector",
			size: "large",
		});
	}

	private getHarnessComponentsView() {
		return buildHarnessComponentsView(this.session.resourceLoader.HcpClientgetsession?.());
	}

	private async HcpClientloadpackagesview(): Promise<HcpClientpackagesview> {
		try {
			const result = await HcpClientdiscoverharnesspackages({
				repoRoot: this.sessionManager.getCwd(),
				packagesRoot: this.session.resourceLoader.HcpClientgetharnesspackagesroot?.(),
			});
			return {
				packagesRoot: result.packagesRoot,
				packages: result.packages,
				diagnostics: result.diagnostics,
			};
		} catch (error) {
			return {
				packages: [],
				diagnostics: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async HcpClientloadpackagecatalogview(): Promise<HcpClientpackagecatalogresult> {
		const now = Date.now();
		if (this.HcpClientpackagecatalogcache && this.HcpClientpackagecatalogcache.expiresAt > now) {
			return this.HcpClientpackagecatalogcache.result;
		}
		const result = await HcpClientdiscoverofficialpackages();
		const successful =
			result.packages.length > 0 && !result.diagnostics.some((diagnostic) => diagnostic.type === "warning");
		this.HcpClientpackagecatalogcache = {
			expiresAt: now + (successful ? 5 * 60_000 : 30_000),
			result,
		};
		return result;
	}

	private getHarnessModule(snapshot: HarnessRuntimeSnapshot, id: string) {
		return snapshot.components.components.find((component) => component.id === id);
	}

	private beginHarnessMenuBuild(): void {
		// Kept as the menu-build boundary for callers; component state is already
		// derived from generated HCP rows and the current Client.
	}

	private formatHarnessImplementationDescription(input: {
		source: string;
		status: string;
		descriptorPath?: string;
		active: boolean;
	}): string {
		return [input.active ? "active" : undefined, input.status, input.descriptorPath].filter(Boolean).join(" · ");
	}

	private isHarnessToolImplementationActive(toolSource: string, implementationSource: string): boolean {
		return toolSource === implementationSource;
	}

	private HcpClientgetharnesspackageselectors(): string[] {
		const loader = this.session.resourceLoader;
		if (loader.HcpClientgetharnesspackageselectors) {
			return loader.HcpClientgetharnesspackageselectors();
		}
		// Fallback for loaders without the accessor: reconstruct one selector per
		// profile (id, id:profile, id:*) so the forms match what the menu emits and
		// compares against, rather than a single comma-joined "id:a,b" string.
		// Fallback for loaders without the accessor: a v2 overlay exposes its
		// primary package id and merged profiles rather than the original
		// selection list, so reconstruct one selector per profile (id, id:profile).
		const overlay = loader.getPackageOverlay();
		if (!overlay?.packageId) return [];
		const profiles = overlay.profiles ?? [];
		if (profiles.length === 0) return [overlay.packageId];
		return profiles.map((profile) => `${overlay.packageId}:${profile.name}`);
	}

	private getHarnessActiveHookEvents(): string[] {
		return HARNESS_HOOK_EVENTS.filter((event) => this.session.extensionRunner.hasHandlers(event));
	}

	private async createHarnessRuntimeSnapshot(): Promise<HarnessRuntimeSnapshot> {
		const packageTools = this.session.resourceLoader.getPackageTools();
		return {
			executionProfile: this.session.executionProfile,
			capabilities: this.session.harnessCapabilities,
			autoCompact: this.session.autoCompactionEnabled,
			skillCommands: this.settingsManager.getEnableSkillCommands(),
			loadedSkills: this.session.resourceLoader.getSkills().skills.length,
			loadedExtensions: this.session.extensionRunner.getExtensionPaths().length,
			tools: buildHarnessToolSwitches(this.session.getAllTools(), this.session.getActiveToolNames()),
			harnessPackages: this.HcpClientgetharnesspackageselectors(),
			packageToolCount: packageTools.tools.length,
			packageDiagnosticCount: packageTools.diagnostics.length,
			activeHookEvents: this.getHarnessActiveHookEvents(),
			components: this.getHarnessComponentsView(),
		};
	}

	private setHarnessAutoCompact(enabled: boolean): void {
		const previous = this.session.autoCompactionEnabled;
		this.session.setAutoCompactionEnabled(enabled);
		this.footer.setAutoCompactEnabled(enabled);
		this.showSystemMessage(
			`Harness auto-compact changed: ${previous ? "enabled" : "disabled"} -> ${enabled ? "enabled" : "disabled"}.`,
		);
		this.showStatus(`Harness auto-compact: ${enabled ? "enabled" : "disabled"}`);
	}

	private setHarnessSkillCommands(enabled: boolean): void {
		const previous = this.settingsManager.getEnableSkillCommands();
		this.settingsManager.setEnableSkillCommands(enabled);
		this.setupAutocompleteProvider();
		this.showSystemMessage(
			`Harness skill slash commands changed: ${previous ? "enabled" : "disabled"} -> ${enabled ? "enabled" : "disabled"}.`,
		);
		this.showStatus(`Harness skill commands: ${enabled ? "enabled" : "disabled"}`);
	}

	private setHarnessToolEnabled(name: string, enabled: boolean): void {
		const tools = this.session.getAllTools();
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) {
			this.showWarning(`Unknown tool: ${name}`);
			return;
		}

		const activeToolNames = new Set(this.session.getActiveToolNames());
		const previous = activeToolNames.has(name);
		if (enabled) {
			activeToolNames.add(name);
		} else {
			activeToolNames.delete(name);
		}
		const orderedToolNames = tools.map((tool) => tool.name).filter((toolName) => activeToolNames.has(toolName));
		this.session.setActiveToolsByName(orderedToolNames);
		this.showSystemMessage(
			`Harness tool exposure changed: ${name} ${previous ? "enabled" : "disabled"} -> ${enabled ? "enabled" : "disabled"}.\nSource: ${tool.sourceInfo.source}\nPath: ${tool.sourceInfo.path}`,
		);
		this.showStatus(`Harness tool ${name}: ${enabled ? "enabled" : "disabled"}`);
	}

	private setAllHarnessToolsEnabled(enabled: boolean): void {
		const tools = this.session.getAllTools();
		const previous = this.session.getActiveToolNames();
		this.session.setActiveToolsByName(enabled ? tools.map((tool) => tool.name) : []);
		const next = this.session.getActiveToolNames();
		this.showSystemMessage(
			`Harness tool exposure changed: ${enabled ? "enabled all tools" : "disabled all tools"}.\nBefore: ${previous.length ? previous.join(", ") : "none"}\nAfter: ${next.length ? next.join(", ") : "none"}`,
		);
		this.showStatus(`Harness tools: ${enabled ? "all enabled" : "all disabled"}`);
	}

	// Shared guard for runtime reloads (generic /reload and harness package
	// selection changes both refuse to reload mid-stream or mid-compaction).
	private canReloadRuntime(): boolean {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return false;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return false;
		}
		return true;
	}

	private async HcpClientsetharnesspackageselectors(selectors: string[]): Promise<void> {
		await this.HcpClientenqueuepackagemutation(() => selectors);
	}

	private async HcpClienttogglepackageselector(selector: string): Promise<void> {
		await this.HcpClientenqueuepackagemutation((current) =>
			current.includes(selector) ? current.filter((candidate) => candidate !== selector) : [...current, selector],
		);
	}

	private async HcpClientsetpackageselectorenabled(selector: string, enabled: boolean): Promise<void> {
		await this.HcpClientenqueuepackagemutation((current) => {
			const requestedGitHub = HcpClientparsegithubpackageselector(selector);
			const next = current.filter((candidate) => {
				if (candidate === selector) return false;
				const activeGitHub = HcpClientparsegithubpackageselector(candidate);
				return !(enabled && requestedGitHub && activeGitHub?.package === requestedGitHub.package);
			});
			if (enabled) next.push(selector);
			return next;
		});
	}

	private async HcpClientclearpackageselectors(packageId: string): Promise<void> {
		await this.HcpClientenqueuepackagemutation((current) =>
			current.filter(
				(candidate) =>
					HcpClientparsegithubpackageselector(candidate) !== undefined ||
					HcpClientpackageidfromselector(candidate) !== packageId,
			),
		);
	}

	// Serializes package selection changes: each mutation awaits the previous one
	// and computes its next selectors from the state left by that mutation, so
	// overlapping toggles cannot start concurrent reloads or clobber each other.
	private HcpClientenqueuepackagemutation(compute: (current: string[]) => string[]): Promise<void> {
		const run = this.HcpClientpackagemutation.then(() => this.HcpClientapplypackageselectors(compute));
		this.HcpClientpackagemutation = run.catch(() => undefined);
		return run;
	}

	private async HcpClientapplypackageselectors(compute: (current: string[]) => string[]): Promise<void> {
		const loader = this.session.resourceLoader;
		if (!loader.HcpClientsetharnesspackageselectors) {
			this.showWarning("Current resource loader does not support runtime harness package selection.");
			return;
		}
		if (!this.canReloadRuntime()) return;

		const previousSelectors = this.HcpClientgetharnesspackageselectors();
		const previousOverlay = loader.getPackageOverlay();
		const requestedSelectors = compute(previousSelectors);
		loader.HcpClientsetharnesspackageselectors(requestedSelectors);
		const newlySelectedGitHubPackages = requestedSelectors.filter(
			(selector) => !previousSelectors.includes(selector) && HcpClientparsegithubpackageselector(selector),
		);
		const reloaded = await this.handleReloadCommand(
			newlySelectedGitHubPackages.length > 0
				? `Downloading and loading ${newlySelectedGitHubPackages.map(HcpClientpackageidfromselector).join(", ")}...`
				: undefined,
			{ HcpClienttrackpackageload: true },
		);
		if (!reloaded) {
			// The reload failed after loadHarnessPackageResources already rebuilt the
			// overlay/tools for the new selection. Restoring the selector array alone
			// would leave runtime state on the failed selection, so reload again with
			// the previous selectors to bring loaded state back in sync.
			loader.HcpClientsetharnesspackageselectors(previousSelectors);
			const restored = await this.handleReloadCommand("Restoring the previous Harness Package selection...", {
				HcpClientpreservepackageloadevent: true,
			});
			if (!restored) {
				this.showError(
					"Harness package reload failed and the previous selection could not be restored; " +
						"runtime package state may be inconsistent until the next successful reload.",
				);
			}
			return;
		}
		const nextSelectors = this.HcpClientgetharnesspackageselectors();
		const nextOverlay = loader.getPackageOverlay();
		const packageTools = loader.getPackageTools();
		const packageErrors = packageTools.diagnostics
			.filter((diagnostic) => diagnostic.type === "error")
			.map((diagnostic) => diagnostic.message);
		const loadedPackageIds = new Set(nextOverlay?.packages.map((pkg) => pkg.id) ?? []);
		if (nextOverlay?.packageId) loadedPackageIds.add(nextOverlay.packageId);
		const missingSelectors = requestedSelectors.filter(
			(selector) => !loadedPackageIds.has(HcpClientpackageidfromselector(selector)),
		);
		if (missingSelectors.length > 0 || packageErrors.length > 0) {
			loader.HcpClientsetharnesspackageselectors(previousSelectors);
			const restored = await this.handleReloadCommand("Restoring the previous Harness Package selection...", {
				HcpClientpreservepackageloadevent: true,
			});
			this.showError(
				[
					missingSelectors.length > 0
						? `Harness Package load failed: ${missingSelectors.join(", ")}`
						: "Harness Package load reported errors.",
					...packageErrors.map((message) => `- ${message}`),
					...(restored
						? ["The previous Harness Package selection was restored."]
						: ["The previous Harness Package selection could not be restored; retry /refresh."]),
				].join("\n"),
			);
			return;
		}
		const bundleDiagnostics = packageTools.diagnostics.filter((diagnostic) => /\bbundle\b/i.test(diagnostic.message));
		this.showSystemMessage(
			[
				"Harness package selection changed.",
				"Before:",
				this.HcpClientformatpackageselection(previousSelectors, previousOverlay),
				"After:",
				this.HcpClientformatpackageselection(nextSelectors, nextOverlay),
				`Package tools: ${packageTools.tools.length ? packageTools.tools.map((tool) => tool.name).join(", ") : "none"}`,
				`Diagnostics: ${packageTools.diagnostics.length}`,
				...(bundleDiagnostics.length
					? ["Bundle effects:", ...bundleDiagnostics.map((diagnostic) => `- ${diagnostic.message}`)]
					: []),
				"Reload completed; package tools were assembled through HcpMagnet. No extra compile step was run.",
			].join("\n"),
		);
	}

	private HcpClientformatpackageselection(selectors: string[], overlay: HcpClientpackageoverlay | undefined): string {
		if (selectors.length === 0) return "- none";
		// Keep every successfully loaded package visible. The primary fields exist
		// for compatibility, while `packages` is the complete multi-package view.
		const packageDirs = new Map(overlay?.packages.map((pkg) => [pkg.id, pkg.dir]) ?? []);
		if (overlay?.packageId && overlay.packageRoot) {
			if (!packageDirs.has(overlay.packageId)) packageDirs.set(overlay.packageId, overlay.packageRoot);
		}
		return selectors
			.map((selector) => {
				const packageId = HcpClientpackageidfromselector(selector);
				return `- ${selector} -> ${packageDirs.get(packageId) ?? "not loaded"}`;
			})
			.join("\n");
	}

	private async setSelectedModel(model: Model<any>): Promise<void> {
		try {
			await this.session.setModel(model);
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Model: ${model.id}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
			this.checkDaxnutsEasterEgg(model);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showHarnessHooksSummary(): void {
		const extensionPaths = this.session.extensionRunner.getExtensionPaths();
		const activeEvents = this.getHarnessActiveHookEvents();
		const extensionList =
			extensionPaths.length > 0
				? extensionPaths
						.slice(0, 8)
						.map((extensionPath) => `  ${extensionPath}`)
						.join("\n") + (extensionPaths.length > 8 ? `\n  ... ${extensionPaths.length - 8} more` : "")
				: "  none";
		this.showStatus(
			[
				"Harness hooks",
				`Extensions loaded: ${extensionPaths.length}`,
				extensionList,
				`Active hook events: ${activeEvents.length > 0 ? activeEvents.join(", ") : "none"}`,
			].join("\n"),
		);
	}

	private async showHarnessMemorySummary(): Promise<void> {
		const components = this.getHarnessComponentsView();
		const available = hasHarnessComponent(components, "memory");
		const active = components.components.some(
			(component) => component.kind === "memory" && component.status === "active",
		);
		this.showStatus(
			[
				"Harness memory",
				`Component: ${available ? "declared" : "not declared"}`,
				`Session HCP: ${active ? "active" : "inactive"}`,
				"Runtime switch: not exposed in AgentSession yet",
			].join("\n"),
		);
	}

	/**
	 * Inspect the live session HcpClient via describeAll(). This reflects what is
	 * actually wired into the running session's one HCP:
	 * every `tool:*` and `capability:*` target that pi resolves at runtime
	 * (compaction, hooks, policy, sandbox, runtime, etc.). Inspect-only — no toggles.
	 */
	private HcpClientshowlivesummary(): void {
		const hcp = this.session.resourceLoader.HcpClientgetsession?.();
		if (!hcp) {
			this.showStatus(["Live HCP", "No session HcpClient is available (null loader / test double)."].join("\n"));
			return;
		}
		const descriptions = hcp.describeAll();
		const tools = descriptions.filter((d) => d.kind === "tool" || d.target.startsWith("tool:"));
		const capabilities = descriptions.filter((d) => d.target.startsWith("capability:"));
		const others = descriptions.filter(
			(d) => !d.target.startsWith("tool:") && !d.target.startsWith("capability:") && d.kind !== "tool",
		);
		const fmt = (d: { target: string; ops: string[]; description?: string }) =>
			`  ${d.target}${d.ops.length ? ` [${d.ops.join(",")}]` : ""}${d.description ? ` — ${d.description}` : ""}`;
		const section = (title: string, items: typeof descriptions) =>
			items.length > 0 ? `${title} (${items.length}):\n${items.map(fmt).join("\n")}` : `${title}: none`;
		this.showStatus(
			[
				"Live session HCP (describeAll)",
				`Total targets: ${descriptions.length}`,
				section("Tools", tools),
				section("Capabilities", capabilities),
				...(others.length > 0 ? [section("Other", others)] : []),
			].join("\n"),
		);
	}

	private parseHarnessToggle(value: string | undefined): boolean | undefined {
		switch (value?.toLowerCase()) {
			case "on":
			case "true":
			case "enable":
			case "enabled":
				return true;
			case "off":
			case "false":
			case "disable":
			case "disabled":
				return false;
			default:
				return undefined;
		}
	}

	private async handleHarnessCommand(text: string): Promise<void> {
		const [, ...args] = text.split(/\s+/);
		const action = args[0]?.toLowerCase();

		if (!action || action === "menu" || action === "switch") {
			await this.openHarnessMenu();
			return;
		}

		if (action === "status") {
			this.showStatus(formatHarnessRuntimeSummary(await this.createHarnessRuntimeSnapshot()));
			return;
		}

		if (action === "components") {
			this.showStatus(formatHarnessComponentsSummary(this.getHarnessComponentsView()));
			return;
		}

		if (action === "hooks") {
			this.showHarnessHooksSummary();
			return;
		}

		if (action === "memory") {
			await this.showHarnessMemorySummary();
			return;
		}

		if (action === "compact" || action === "compaction") {
			const enabled = this.parseHarnessToggle(args[1]);
			if (enabled === undefined) {
				this.showWarning("Usage: /harness compact <on|off>");
				return;
			}
			this.setHarnessAutoCompact(enabled);
			return;
		}

		if (action === "skills" || action === "skill-commands") {
			const enabled = this.parseHarnessToggle(args[1]);
			if (enabled === undefined) {
				this.showWarning("Usage: /harness skills <on|off>");
				return;
			}
			this.setHarnessSkillCommands(enabled);
			return;
		}

		if (action === "tool") {
			const name = args[1];
			const enabled = this.parseHarnessToggle(args[2]);
			if (!name || enabled === undefined) {
				this.showWarning("Usage: /harness tool <name> <on|off>");
				return;
			}
			this.setHarnessToolEnabled(name, enabled);
			return;
		}

		if (action === "tools") {
			const allEnabled = this.parseHarnessToggle(args[1]);
			if (allEnabled !== undefined && args[2] === undefined) {
				this.setAllHarnessToolsEnabled(allEnabled);
				return;
			}
			const name = args[1];
			const enabled = this.parseHarnessToggle(args[2]);
			if (!name || enabled === undefined) {
				await this.openHarnessMenu();
				return;
			}
			this.setHarnessToolEnabled(name, enabled);
			return;
		}

		if (action === "package" || action === "packages") {
			const selector = args[1];
			const enabled = this.parseHarnessToggle(args[2]);
			if (!selector) {
				await this.HcpClientopenpackagemenu();
				return;
			}
			if (enabled === undefined) {
				this.showWarning("Usage: /harness package <selector> <on|off>");
				return;
			}
			await this.HcpClientsetpackageselectorenabled(selector, enabled);
			return;
		}

		this.showWarning("Usage: /harness [status|components|hooks|memory|compact|skills|tool|package]");
	}

	private commandDockShouldRouteInput(data: string): boolean {
		return (
			matchesKey(data, "up") ||
			matchesKey(data, "down") ||
			matchesKey(data, "pageUp") ||
			matchesKey(data, "pageDown") ||
			matchesKey(data, "home") ||
			matchesKey(data, "end") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "right") ||
			matchesKey(data, "escape") ||
			matchesKey(data, "left")
		);
	}

	private handleCommandDockInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.commandDockHandle || this.commandDockHandle.isHidden() || !this.commandDockBody) {
			return undefined;
		}
		if (!this.commandDockShouldRouteInput(data)) {
			return undefined;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "left")) {
			if (!this.commandDockBody.handleInput(data)) {
				this.closeCommandDock();
				this.setEditorTextWithoutCommandDockSync("");
			}
			return { consume: true };
		}
		this.commandDockBody.handleInput(data);
		this.ui.requestRender();
		return { consume: true };
	}

	private syncCommandDockFromEditorText(text: string): void {
		if (this.suppressCommandDockSync) return;
		if (text.startsWith("/") && !text.includes("\n") && !text.includes(" ")) {
			void this.openCommandDock(text.slice(1));
			return;
		}
		this.closeCommandDock();
	}

	private setEditorTextWithoutCommandDockSync(value: string): void {
		this.suppressCommandDockSync = true;
		try {
			this.editor.setText(value);
		} finally {
			this.suppressCommandDockSync = false;
		}
	}

	private async openCommandDock(filter = ""): Promise<void> {
		const requestId = ++this.commandDockRequestId;
		if (this.commandDockHandle && !this.commandDockHandle.isHidden() && this.commandDockBody) {
			this.applyCommandDockFilter(filter);
			return;
		}

		const items = await this.commandDockItems();
		if (requestId !== this.commandDockRequestId) return;
		if (this.editor.getText() !== `/${filter}`) return;
		this.commandDockHandle = this.showFloatingMenu(
			"command dock",
			"keep typing to filter",
			items,
			(item) => {
				this.handleCommandDockItem(item);
				return undefined;
			},
			COMMAND_DOCK_OVERLAY,
		);
		this.applyCommandDockFilter(filter);
	}

	/**
	 * Apply the editor's slash-filter to the command dock. `/skill:` (and
	 * `/skill:<partial>`) auto-drills into the Skills submenu and filters within
	 * it, so typing the qualified prefix jumps straight to the skill list. Any
	 * other filter is applied at the root as before.
	 */
	private applyCommandDockFilter(filter: string): void {
		const body = this.commandDockBody;
		if (!body) return;
		const skillPrefix = "skill:";
		if (filter === "skill" || filter.startsWith(skillPrefix)) {
			const childFilter = filter.startsWith(skillPrefix) ? filter.slice(skillPrefix.length) : "";
			// Only drill in once; if already inside a submenu just refine the filter.
			if (body.submenuDepth === 0 && body.openChildByValue("command:skill", childFilter)) {
				return;
			}
			if (body.submenuDepth > 0) {
				body.setFilter(childFilter);
				return;
			}
		}
		// User backspaced out of `/skill:` (now at `/sk` or less) — pop back to root.
		if (body.submenuDepth > 0) {
			body.resetToRoot();
		}
		body.setFilter(filter);
	}

	private closeCommandDock(): void {
		this.commandDockRequestId++;
		const handle = this.commandDockHandle;
		this.commandDockHandle = undefined;
		this.commandDockBody = undefined;
		handle?.hide();
	}

	private async commandDockItems(): Promise<FloatingMenuItem[]> {
		const items: FloatingMenuItem[] = [
			{
				value: "command:model",
				label: "Model",
				aliases: ["m", "model"],
				description: this.session.model
					? `current: ${this.session.model.provider}/${this.session.model.id}`
					: "/model",
				children: this.modelMenuItems(),
			},
			{
				value: "command:harness",
				label: "Harness",
				aliases: ["h", "harness"],
				description: "Tools, compaction, skills, hooks, memory",
				children: (await this.harnessMenuItems()).children,
			},
			// Magenta feature: top-level Skills entry so `/skill:` drills straight
			// into the skill list. Selecting a skill backfills `/skill:<name> ` so
			// the user keeps typing their request; on submit `_expandSkillCommand`
			// inlines the skill markdown as the first turn payload.
			...this.skillDockParentItem(),
			{ value: "slash:settings", label: "Settings", aliases: ["settings"], description: "/settings" },
			this.mcpDockParentItem(),
			{ value: "slash:events", label: "Events", aliases: ["events"], description: "/events" },
			{ value: "slash:todo", label: "Todo", aliases: ["todo"], description: "/todo" },
			{ value: "slash:side", label: "Side Chat", aliases: ["side", "btw", "s"], description: "/side" },
			{
				value: "slash:scoped-models",
				label: "Scoped Models",
				aliases: ["scoped-models"],
				description: "/scoped-models",
			},
			{ value: "slash:compact", label: "Compact", aliases: ["compact"], description: "/compact" },
			{ value: "slash:refresh", label: "Refresh", aliases: ["refresh"], description: "/refresh" },
			{ value: "slash:reload", label: "Reload", aliases: ["reload"], description: "/reload" },
			{ value: "slash:tree", label: "Tree", aliases: ["tree"], description: "/tree" },
			{ value: "slash:resume", label: "Resume", aliases: ["resume"], description: "/resume" },
			{
				value: "command:trust",
				label: "Trust",
				aliases: ["trust"],
				description: (() => {
					const cwd = this.sessionManager.getCwd();
					const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
					const savedDecision = trustStore.getEntry(cwd);
					const savedLabel = savedDecision === null ? "none" : savedDecision.decision ? "trusted" : "untrusted";
					return `current: ${savedLabel}`;
				})(),
				children: this.trustMenuItems().items,
			},
			{
				value: "command:login",
				label: "Login",
				aliases: ["login"],
				description: "Authenticate with subscription or API key",
				children: this.loginMenuItems(),
			},
			{ value: "slash:new", label: "New Session", aliases: ["new", "clear"], description: "/new" },
			{ value: "slash:hotkeys", label: "Hotkeys", aliases: ["hotkeys"], description: "/hotkeys" },
			{ value: "slash:quit", label: "Quit", aliases: ["quit", "exit"], description: "/quit" },
		];

		for (const command of this.session.extensionRunner.getRegisteredCommands()) {
			if (items.some((item) => item.aliases?.includes(command.name) || item.label === command.name)) continue;
			items.push({
				value: `insert-command:${command.invocationName}`,
				label: command.invocationName,
				aliases: [command.name, command.invocationName],
				description: this.prefixAutocompleteDescription(command.description, command.sourceInfo),
			});
		}

		return items;
	}

	/**
	 * Magenta feature: the Skills parent entry for the command dock. Returns an
	 * empty array when skill slash commands are disabled or no skills are loaded,
	 * so the spread in commandDockItems() adds nothing. Reuses the same
	 * parent/children shape as the Model and Harness entries.
	 */
	private skillDockParentItem(): FloatingMenuItem[] {
		if (!this.settingsManager.getEnableSkillCommands()) return [];
		const children = this.skillMenuItems();
		if (children.length === 0) return [];
		return [
			{
				value: "command:skill",
				label: "Skills",
				aliases: ["skill", "skills"],
				description: `${children.length} loaded · /skill:<name>`,
				children,
			},
		];
	}

	/**
	 * Magenta feature: one dock leaf per loaded skill. Selecting a leaf backfills
	 * `/skill:<name> ` into the editor (via the `insert-skill:` value handled in
	 * handleCommandDockItem) so the user continues typing their request.
	 */
	private skillMenuItems(): FloatingMenuItem[] {
		return this.session.resourceLoader
			.getSkills()
			.skills.slice()
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((skill) => ({
				value: `insert-skill:${skill.name}`,
				label: `skill:${skill.name}`,
				aliases: [skill.name, `skill:${skill.name}`],
				description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
			}));
	}

	private handleCommandDockItem(item: FloatingMenuItem): void {
		if (item.value.startsWith("model:")) {
			const [, rawProvider, rawId] = item.value.split(":");
			const model = this.session.modelRegistry.find(decodeMenuValuePart(rawProvider), decodeMenuValuePart(rawId));
			if (model) void this.setSelectedModel(model);
			return;
		}
		if (item.value.startsWith("trust:")) {
			const index = Number.parseInt(item.value.slice("trust:".length), 10);
			if (!Number.isNaN(index)) this.applyTrustSelection(index);
			return;
		}
		if (item.value.startsWith("login:")) {
			if (item.value === "login:none") return;
			const [, rawAuthType, rawId] = item.value.split(":");
			const authType = decodeMenuValuePart(rawAuthType) as "oauth" | "api_key";
			const providerId = decodeMenuValuePart(rawId);
			const providerOption = this.getLoginProviderOptions(authType).find((p) => p.id === providerId);
			if (!providerOption) return;
			void (async () => {
				if (providerOption.authType === "oauth") {
					await this.showLoginDialog(providerOption.id, providerOption.name);
				} else if (providerOption.id === BEDROCK_PROVIDER_ID) {
					this.showBedrockSetupDialog(providerOption.id, providerOption.name);
				} else {
					await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
				}
			})();
			return;
		}
		if (item.value.startsWith("mcp:")) {
			// MCP is a placeholder; no action yet.
			return;
		}
		if (this.handleHarnessMenuItem(item)) {
			return;
		}
		if (item.value.startsWith("slash:")) {
			const command = item.value.slice("slash:".length);
			void this.handleDockSlashCommand(command);
			return;
		}
		if (item.value.startsWith("insert-command:")) {
			this.setEditorTextWithoutCommandDockSync(`/${item.value.slice("insert-command:".length)} `);
			this.closeCommandDock();
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
		if (item.value.startsWith("insert-skill:")) {
			// Backfill `/skill:<name> ` and leave the cursor after it so the user can
			// keep typing their request. The trailing space also drops us out of the
			// dock (syncCommandDockFromEditorText closes on whitespace).
			this.setEditorTextWithoutCommandDockSync(`/skill:${item.value.slice("insert-skill:".length)} `);
			this.closeCommandDock();
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	private async handleDockSlashCommand(command: string): Promise<void> {
		this.closeCommandDock();
		this.setEditorTextWithoutCommandDockSync("");
		switch (command) {
			case "settings":
				this.showSettingsSelector();
				return;
			case "mcp":
				this.showMcpManager();
				return;
			case "events":
				await this.session.prompt("/events");
				return;
			case "todo":
				this.showTodoOverlay();
				return;
			case "side":
				await this.session.prompt("/side");
				return;
			case "scoped-models":
				await this.showModelsSelector();
				return;
			case "compact":
				await this.handleCompactCommand();
				return;
			case "tree":
				this.showTreeSelector();
				return;
			case "resume":
				this.showSessionSelector();
				return;
			case "trust":
				this.showTrustSelector();
				return;
			case "login":
				this.showOAuthSelector("login");
				return;
			case "new":
				await this.handleClearCommand();
				return;
			case "hotkeys":
				this.handleHotkeysCommand();
				return;
			case "refresh":
				await this.handleReloadCommand();
				return;
			case "reload":
				await this.handleRecompileRestartCommand();
				return;
			case "quit":
				await this.shutdown();
				return;
		}
	}

	private modelMenuItems(): FloatingMenuItem[] {
		const models =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: this.session.modelRegistry.getAvailable();
		const byProvider = new Map<string, Model<any>[]>();
		for (const model of models) {
			const providerModels = byProvider.get(model.provider) ?? [];
			providerModels.push(model);
			byProvider.set(model.provider, providerModels);
		}
		return [...byProvider.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([provider, providerModels]) => ({
				value: `provider:${provider}`,
				label: provider,
				description: `${providerModels.length} models`,
				children: providerModels
					.sort((left, right) => left.id.localeCompare(right.id))
					.map((model) => ({
						value: `model:${encodeMenuValuePart(model.provider)}:${encodeMenuValuePart(model.id)}`,
						label: model.id,
						description: model.name ?? model.provider,
						active: this.session.model?.provider === model.provider && this.session.model?.id === model.id,
					})),
			}));
	}

	private async openModelMenu(): Promise<void> {
		this.session.modelRegistry.refresh();
		const items = this.modelMenuItems();
		if (items.length === 0) {
			this.showStatus("No models available");
			return;
		}
		this.showFloatingMenu("model", "provider / model", items, (item) => {
			this.handleCommandDockItem(item);
			return undefined;
		});
	}

	private async harnessMenuItems(): Promise<FloatingMenuItem> {
		this.beginHarnessMenuBuild();
		const snapshot = await this.createHarnessRuntimeSnapshot();
		const activeToolCount = snapshot.tools.filter((tool) => tool.active).length;
		const toolItems = snapshot.tools.map((tool) => {
			const module = this.getHarnessModule(snapshot, `tool/${tool.name}`);
			const implementationItems =
				module?.sources.map((implementation) => {
					const active = this.isHarnessToolImplementationActive(tool.source, implementation.source);
					return {
						value: `harness:tool:${encodeMenuValuePart(tool.name)}:impl:${encodeMenuValuePart(implementation.source)}`,
						label: formatHarnessSourceLabel(implementation.source),
						description: this.formatHarnessImplementationDescription({
							source: implementation.source,
							status: implementation.status,
							descriptorPath: implementation.descriptorPath,
							active,
						}),
						active,
					};
				}) ?? [];
			const activeImplementation =
				implementationItems.find((implementation) => implementation.active)?.label ??
				(tool.source === "harness-package" ? "package" : tool.source);
			return {
				value: `harness:tool:${encodeMenuValuePart(tool.name)}`,
				label: tool.name,
				description: `${tool.active ? "enabled" : "disabled"} · implementation: ${activeImplementation}`,
				children: [
					{
						value: `harness:tool:${encodeMenuValuePart(tool.name)}:on`,
						label: "Enabled",
						description: "Expose this tool to the agent",
						active: tool.active,
					},
					{
						value: `harness:tool:${encodeMenuValuePart(tool.name)}:off`,
						label: "Disabled",
						description: "Remove this tool from the active tool list",
						active: !tool.active,
					},
					...implementationItems,
				],
			};
		});
		const moduleItems = this.harnessModuleMenuItems(snapshot);
		const packageItems = await this.HcpClientpackagemenuitems(snapshot);

		return {
			value: "harness",
			label: "Harness",
			description: "Magenta3 runtime harness",
			children: [
				{
					value: "harness:tools",
					label: "Tools",
					description: `${activeToolCount}/${snapshot.tools.length} active`,
					children: [
						{
							value: "harness:tools:on",
							label: "Enable all tools",
							description: "Expose every current AgentSession tool",
							active: activeToolCount === snapshot.tools.length && snapshot.tools.length > 0,
						},
						{
							value: "harness:tools:off",
							label: "Disable all tools",
							description: "Remove every tool from the active tool list",
							active: activeToolCount === 0,
						},
						...toolItems,
					],
				},
				{
					value: "harness:compaction",
					label: "Compaction",
					description: snapshot.autoCompact ? "enabled · implementation: Pi" : "disabled · implementation: Pi",
					children: [
						{ value: "harness:compact:on", label: "Enabled", active: snapshot.autoCompact },
						{ value: "harness:compact:off", label: "Disabled", active: !snapshot.autoCompact },
						{
							value: "harness:compact:impl:pi",
							label: "Pi",
							description: "Harness compaction implementation",
							active: true,
						},
					],
				},
				{
					value: "harness:skills",
					label: "Skills",
					description: `${snapshot.loadedSkills} loaded · slash commands ${snapshot.skillCommands ? "enabled" : "disabled"}`,
					children: [
						{ value: "harness:skills:on", label: "Slash commands enabled", active: snapshot.skillCommands },
						{ value: "harness:skills:off", label: "Slash commands disabled", active: !snapshot.skillCommands },
						{
							value: "harness:skills:impl:pi",
							label: "Pi loader",
							description: "Harness skills loader",
							active: true,
						},
					],
				},
				{
					value: "harness:hooks",
					label: "Hooks",
					description: `${snapshot.loadedExtensions} extensions · ${snapshot.activeHookEvents.length} active events`,
					children: [
						{
							value: "harness:hooks:inspect",
							label: "Inspect active hooks",
							description: "Print extension event wiring",
						},
						{
							value: "harness:hooks:impl:pi",
							label: "Pi extension events",
							description: "Current hook substrate",
							active: true,
						},
					],
				},
				{
					value: "harness:memory",
					label: "Memory",
					description: "Declared component; no AgentSession switch yet",
					children: [
						{ value: "harness:memory:inspect", label: "Inspect memory status" },
						{
							value: "harness:memory:impl:magenta",
							label: "Magenta",
							description: "Selected HCP Source",
							active: true,
						},
					],
				},
				{
					value: "harness:components",
					label: "Components",
					description: `${snapshot.components.components.length} generated declarations`,
					children: [{ value: "harness:components:inspect", label: "Inspect components" }],
				},
				{
					value: "harness:livehcp",
					label: "Live HCP",
					description: "Inspect the running session's resolved HCP targets",
					children: [
						{
							value: "harness:livehcp:inspect",
							label: "Inspect live HCP (describeAll)",
							description: "List tool:* and capability:* targets wired into the active session",
						},
					],
				},
				...moduleItems,
				...packageItems,
			],
		};
	}

	private harnessModuleMenuItems(snapshot: HarnessRuntimeSnapshot): FloatingMenuItem[] {
		const modules = snapshot.components.components;
		if (modules.length === 0) return [];
		return [
			{
				value: "harness:modules",
				label: "Modules",
				description: `${modules.length} generated component declarations`,
				children: modules
					.slice()
					.sort((left, right) => left.id.localeCompare(right.id))
					.map((module) => {
						const encodedId = encodeMenuValuePart(module.id);
						const implementations = module.sources
							.map((implementation) => `${implementation.source}:${implementation.status}`)
							.join(", ");
						return {
							value: `harness:module:${encodedId}`,
							label: module.id,
							description: `${module.status} · ${implementations || "no implementations"}`,
							children: [
								{
									value: `harness:module:${encodedId}:inspect`,
									label: "Inspect",
									description: "Print module and implementation details",
								},
								...module.sources.map((implementation) => ({
									value: `harness:module:${encodedId}:impl:${encodeMenuValuePart(implementation.source)}`,
									label: formatHarnessSourceLabel(implementation.source),
									description: this.formatHarnessImplementationDescription({
										source: implementation.source,
										status: implementation.status,
										descriptorPath: implementation.descriptorPath,
										active: implementation.active,
									}),
								})),
							],
						};
					}),
			},
		];
	}

	private async HcpClientpackagemenuitems(snapshot: HarnessRuntimeSnapshot): Promise<FloatingMenuItem[]> {
		const [view, catalog] = await Promise.all([
			this.HcpClientloadpackagesview(),
			typeof this.HcpClientloadpackagecatalogview === "function"
				? this.HcpClientloadpackagecatalogview()
				: Promise.resolve({ packages: [], diagnostics: [] }),
		]);
		const activeSelectors = snapshot.harnessPackages;
		const activeByPackage = new Map<string, string[]>();
		const activeGitHubSelectors: Array<{
			selector: string;
			packageId: string;
			owner: string;
			repo: string;
			version: string;
			profiles?: string[];
		}> = [];
		for (const selector of activeSelectors) {
			const github = HcpClientparsegithubpackageselector(selector);
			if (github) {
				activeGitHubSelectors.push({
					selector,
					packageId: github.package,
					owner: github.owner,
					repo: github.repo,
					version: github.version,
					profiles: github.profiles,
				});
				continue;
			}
			const packageId = HcpClientpackageidfromselector(selector);
			const selectors = activeByPackage.get(packageId) ?? [];
			selectors.push(selector);
			activeByPackage.set(packageId, selectors);
		}

		const children: FloatingMenuItem[] = [];
		if (view.error) {
			children.push({
				value: "harness:packages:error",
				label: "Discovery error",
				description: view.error,
				disabled: true,
			});
		}
		if (view.diagnostics.length > 0) {
			children.push({
				value: "harness:packages:diagnostics",
				label: "Diagnostics",
				description: `${view.diagnostics.length} package discovery issue(s)`,
				children: view.diagnostics.slice(0, 20).map((diagnostic, index) => ({
					value: `harness:packages:diagnostic:${index}`,
					label: `${diagnostic.type}: ${diagnostic.code}`,
					description: diagnostic.message,
					disabled: true,
				})),
			});
		}
		if (catalog.diagnostics.length > 0) {
			children.push({
				value: "harness:package-catalog:diagnostics",
				label: "Official Package diagnostics",
				description: `${catalog.diagnostics.length} remote discovery issue(s)`,
				children: catalog.diagnostics.slice(0, 20).map((diagnostic, index) => ({
					value: `harness:package-catalog:diagnostic:${index}`,
					label: `${diagnostic.type}: ${diagnostic.code ?? "package_catalog"}`,
					description: diagnostic.message,
					disabled: true,
				})),
			});
		}

		for (const pkg of view.packages.slice().sort((left, right) => left.id.localeCompare(right.id))) {
			const packageSelectors = activeByPackage.get(pkg.id) ?? [];
			const rootSelector = pkg.id;
			const selected = packageSelectors.length > 0;
			const componentCount = pkg.manifest.components.length;
			const profileCount = pkg.manifest.profiles.length;
			const selectorLabel = selected ? `selected: ${packageSelectors.join(", ")}` : "not selected";
			const packageChildren: FloatingMenuItem[] = [
				{
					value: `harness:package:${encodeMenuValuePart(pkg.id)}:enable`,
					label: "Load package",
					description: "Load root package components and default profiles",
					active: packageSelectors.includes(rootSelector),
				},
				{
					value: `harness:package:${encodeMenuValuePart(pkg.id)}:disable`,
					label: "Unload package",
					description: "Remove this package from the current session selectors",
					active: !selected,
				},
			];
			if (pkg.manifest.profiles.length > 0) {
				packageChildren.push({
					value: `harness:package:${encodeMenuValuePart(pkg.id)}:all-profiles`,
					label: "Load all profiles",
					description: "Load every profile declared by this package",
					active: packageSelectors.includes(`${pkg.id}:*`),
				});
				packageChildren.push(
					...pkg.manifest.profiles.map((profile) => {
						const selector = `${pkg.id}:${profile.name}`;
						return {
							value: `harness:package:${encodeMenuValuePart(pkg.id)}:profile:${encodeMenuValuePart(profile.name)}`,
							label: profile.name,
							description: profile.description ?? "Load this package profile",
							active: packageSelectors.includes(selector),
						};
					}),
				);
			}
			children.push({
				value: `harness:package:${encodeMenuValuePart(pkg.id)}`,
				label: pkg.id,
				description: `${selectorLabel} · ${componentCount} root components · ${profileCount} profiles`,
				active: selected,
				children: packageChildren,
			});
		}

		const catalogSelectors = new Set(catalog.packages.map((pkg) => pkg.selector));
		for (const pkg of catalog.packages) {
			const selected = activeSelectors.includes(pkg.selector);
			const encodedSelector = encodeMenuValuePart(pkg.selector);
			children.push({
				value: `harness:official-package:${encodedSelector}`,
				label: `${pkg.package} (Official)`,
				description: `${selected ? "selected" : "available"} · v${pkg.version} · ${pkg.owner}/${pkg.repo}`,
				active: selected,
				children: [
					{
						value: `harness:package-selector:${encodedSelector}:reload`,
						label: selected ? "Reload package" : "Download & load",
						description: selected
							? "Reload this exact version through the verified Package cache"
							: "Download the verified release into ~/.magenta/harness-packages, then load it",
					},
					...(selected
						? [
								{
									value: `harness:package-selector:${encodedSelector}:disable`,
									label: "Unload package",
									description: "Unload this Package from the current session; keep the verified cache",
								},
							]
						: []),
				],
			});
		}

		// GitHub selectors are already versioned acquisition inputs, not local
		// discovery rows. Keep each exact selector manageable even when no matching
		// directory exists under packagesRoot (or a local package has the same id).
		for (const github of activeGitHubSelectors) {
			if (catalogSelectors.has(github.selector)) continue;
			const encodedSelector = encodeMenuValuePart(github.selector);
			children.push({
				value: `harness:package-selector:${encodedSelector}`,
				label: `${github.packageId} (GitHub)`,
				description: `selected: ${github.selector} · ${github.owner}/${github.repo}@${github.version}`,
				active: true,
				children: [
					{
						value: `harness:package-selector:${encodedSelector}:reload`,
						label: "Reload package",
						description: "Reload this exact versioned selector through the current acquisition/cache flow",
					},
					{
						value: `harness:package-selector:${encodedSelector}:disable`,
						label: "Unload selector",
						description: "Remove only this exact GitHub selector from the current session",
					},
					{
						value: `harness:package-selector:${encodedSelector}:profiles`,
						label: "Profiles",
						description: github.profiles?.length
							? `Active: ${github.profiles.join(", ")}`
							: "No explicit profiles; the package's declared defaults apply",
						disabled: true,
					},
				],
			});
		}

		if (children.length === 0) {
			children.push({
				value: "harness:packages:none",
				label: "No packages found",
				description: view.packagesRoot ? `Checked ${view.packagesRoot}` : "No packages root available",
				disabled: true,
			});
		}

		return [
			{
				value: "harness:packages",
				label: "Packages",
				description: [
					`${activeSelectors.length} selected`,
					`${view.packages.length} local available`,
					...(catalog.packages.length > 0 ? [`${catalog.packages.length} official available`] : []),
				].join(" · "),
				children,
			},
		];
	}

	private async openHarnessMenu(): Promise<void> {
		const root = await this.harnessMenuItems();
		this.showFloatingMenu("harness", "category / capability / implementation", root.children ?? [], (item) =>
			this.handleHarnessMenuItem(item),
		);
	}

	private async HcpClientopenpackagemenu(): Promise<void> {
		const snapshot = await this.createHarnessRuntimeSnapshot();
		const root = (await this.HcpClientpackagemenuitems(snapshot))[0];
		this.showFloatingMenu("harness packages", "package / selector", root?.children ?? [], (item) =>
			this.handleHarnessMenuItem(item),
		);
	}

	private handleHarnessMenuItem(item: FloatingMenuItem): boolean {
		const parts = item.value.split(":");
		if (parts[0] !== "harness") return false;
		if (parts[1] === "tools" && (parts[2] === "on" || parts[2] === "off")) {
			this.setAllHarnessToolsEnabled(parts[2] === "on");
			return true;
		}
		if (parts[1] === "tool" && parts[2] && (parts[3] === "on" || parts[3] === "off")) {
			this.setHarnessToolEnabled(decodeMenuValuePart(parts[2]), parts[3] === "on");
			return true;
		}
		if (parts[1] === "tool" && parts[2] && parts[3] === "impl" && parts[4]) {
			void this.showHarnessToolImplementationSelection(decodeMenuValuePart(parts[2]), decodeMenuValuePart(parts[4]));
			return true;
		}
		if (parts[1] === "compact" && (parts[2] === "on" || parts[2] === "off")) {
			this.setHarnessAutoCompact(parts[2] === "on");
			return true;
		}
		if (parts[1] === "skills" && (parts[2] === "on" || parts[2] === "off")) {
			this.setHarnessSkillCommands(parts[2] === "on");
			return true;
		}
		if (item.value === "harness:hooks:inspect") {
			this.showHarnessHooksSummary();
			return true;
		}
		if (item.value === "harness:memory:inspect") {
			void this.showHarnessMemorySummary();
			return true;
		}
		if (item.value === "harness:components:inspect") {
			this.showStatus(formatHarnessComponentsSummary(this.getHarnessComponentsView()));
			return true;
		}
		if (item.value === "harness:livehcp:inspect") {
			this.HcpClientshowlivesummary();
			return true;
		}
		if (parts[1] === "module" && parts[2]) {
			const moduleId = decodeMenuValuePart(parts[2]);
			const source = parts[4] ? decodeMenuValuePart(parts[4]) : undefined;
			if (source) {
				this.showSystemMessage(
					`Harness implementation inspected: ${moduleId} -> ${formatHarnessSourceLabel(source)}.\nNo runtime implementation switch was performed for this row.`,
				);
			}
			void this.showHarnessModuleItem(moduleId, source);
			return true;
		}
		if (parts[1] === "package-selector" && parts[2] && parts[3]) {
			const selector = decodeMenuValuePart(parts[2]);
			if (parts[3] === "reload") {
				void this.HcpClientsetpackageselectorenabled(selector, true);
				return true;
			}
			if (parts[3] === "disable") {
				void this.HcpClientsetpackageselectorenabled(selector, false);
				return true;
			}
		}
		if (parts[1] === "package" && parts[2] && parts[3]) {
			const packageId = decodeMenuValuePart(parts[2]);
			if (parts[3] === "enable") {
				void this.HcpClientsetpackageselectorenabled(packageId, true);
				return true;
			}
			if (parts[3] === "disable") {
				void this.HcpClientclearpackageselectors(packageId);
				return true;
			}
			if (parts[3] === "all-profiles") {
				void this.HcpClienttogglepackageselector(`${packageId}:*`);
				return true;
			}
			if (parts[3] === "profile" && parts[4]) {
				void this.HcpClienttogglepackageselector(`${packageId}:${decodeMenuValuePart(parts[4])}`);
				return true;
			}
		}
		if (item.value.includes(":impl:")) {
			this.showSystemMessage(
				`Harness implementation inspected: ${item.label}.\nNo runtime implementation switch was performed for this row.`,
			);
			this.showStatus(`${item.label} is the current implementation; alternate providers are not wired yet.`);
			return true;
		}
		return false;
	}

	private async showHarnessToolImplementationSelection(toolName: string, source: string): Promise<void> {
		const module = this.getHarnessComponentsView().components.find(
			(candidate) => candidate.id === `tool/${toolName}`,
		);
		const implementation = module?.sources.find((candidate) => candidate.source === source);
		const activeSource =
			this.session.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.source ?? "unknown";
		const requestedPath = implementation?.descriptorPath ?? "not declared";
		const activePath =
			module?.sources.find((candidate) => candidate.source === activeSource)?.descriptorPath ?? activeSource;

		this.showSystemMessage(
			[
				`Harness implementation inspected: tool/${toolName}`,
				`Requested source: ${formatHarnessSourceLabel(source)}`,
				`Requested path: ${requestedPath}`,
				`Requested status: ${implementation?.status ?? "not declared"}`,
				`Active source remains: ${formatHarnessSourceLabel(activeSource)}`,
				`Active path: ${activePath}`,
				"No runtime implementation switch was performed; this row is inspect-only until implementation hot-swap is wired.",
			].join("\n"),
		);
		await this.showHarnessModuleItem(`tool/${toolName}`, source);
	}

	private async showHarnessModuleItem(id: string, source?: string): Promise<void> {
		const module = this.getHarnessComponentsView().components.find((candidate) => candidate.id === id);
		if (!module) {
			this.showWarning(`Unknown harness module: ${id}`);
			return;
		}
		const implementations = source
			? module.sources.filter((implementation) => implementation.source === source)
			: module.sources;
		this.showStatus(
			[
				`Harness module: ${module.id}`,
				`Status: ${module.status}`,
				`Kind: ${module.kind}`,
				`Product: ${module.product}`,
				`Module: ${module.module}`,
				module.description ? `Description: ${module.description}` : undefined,
				`Descriptor: ${module.descriptorPath}`,
				implementations.length > 0
					? `Sources:\n${implementations
							.map(
								(implementation) =>
									`  - ${formatHarnessSourceLabel(implementation.source)}: ${implementation.status} (${implementation.descriptorPath})`,
							)
							.join("\n")}`
					: "Sources: none",
				source ? "Selection: implementation switching is planned; this row is inspect-only for now." : undefined,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n"),
		);
	}

	private showFloatingMenu(
		title: string,
		subtitle: string,
		items: FloatingMenuItem[],
		onSelect: (item: FloatingMenuItem) => undefined | boolean,
		overlayOptions: OverlayOptions = CENTER_FLOATING_MENU_OVERLAY,
	): OverlayHandle {
		let handle: OverlayHandle | undefined;
		const body = new FloatingMenuBody({
			title,
			subtitle,
			items,
			onSelect: (item) => {
				const result = onSelect(item);
				if (item.keepOpen || item.closeOnSelect === false || result === false) {
					this.ui.requestRender();
					return false;
				}
				if (handle === this.commandDockHandle) {
					this.commandDockHandle = undefined;
					this.commandDockBody = undefined;
					this.setEditorTextWithoutCommandDockSync("");
				}
				handle?.hide();
				this.ui.setFocus(this.editor);
				return true;
			},
			requestRender: () => this.ui.requestRender(),
		});
		if (overlayOptions.nonCapturing) {
			this.commandDockBody = body;
		}
		const overlay = new FloatingOverlayContainer(body, () => {
			handle?.hide();
			if (handle === this.commandDockHandle) {
				this.commandDockHandle = undefined;
				this.commandDockBody = undefined;
			}
			this.ui.setFocus(this.editor);
		});
		handle = this.ui.showOverlay(overlay, overlayOptions);
		if (!overlayOptions.nonCapturing) handle.focus();
		return handle;
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					showImages: this.settingsManager.getShowImages(),
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					thinkingLevel: this.session.executionProfile,
					availableThinkingLevels: this.session.getAvailableExecutionProfiles(),
					currentTheme: this.settingsManager.getThemeSetting() || "dark",
					terminalTheme: this.themeController.getTerminalTheme(),
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					warnings: this.settingsManager.getWarnings(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							} else if (child instanceof ToolExecutionGroupComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onImageWidthCellsChange: (width) => {
						this.settingsManager.setImageWidthCells(width);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setImageWidthCells(width);
							} else if (child instanceof ToolExecutionGroupComponent) {
								child.setImageWidthCells(width);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						configureHttpDispatcher(timeoutMs);
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					onThinkingLevelChange: (level) => {
						this.session.setExecutionProfile(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeSetting) => {
						this.settingsManager.setTheme(themeSetting);
						void this.themeController.applyFromSettings();
					},
					onThemePreview: (themeName) => this.themeController.preview(themeName),
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onEnableInstallTelemetryChange: (enabled) => {
						this.settingsManager.setEnableInstallTelemetry(enabled);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDefaultProjectTrustChange: (defaultProjectTrust) => {
						this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onWarningsChange: (warnings) => {
						this.settingsManager.setWarnings(warnings);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			await this.openModelMenu();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Model: ${model.id}`);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const models = await this.getModelCandidates();
		return findExactModelReferenceMatch(searchTerm, models);
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		const storedCredential = this.session.modelRegistry.authStorage.get("anthropic");
		if (storedCredential?.type === "oauth") {
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
			return;
		}

		try {
			const apiKey = await this.session.modelRegistry.getApiKeyForProvider(model.provider);
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(
				`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	// Builds the trust options as a flat menu (leaves). Reused by the /trust
	// command and the dock's Trust submenu so left/right navigation is uniform.
	private trustMenuItems(): { items: FloatingMenuItem[]; subtitle: string } {
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		const options = getProjectTrustOptions(cwd);
		const savedLabel = savedDecision === null ? "none" : savedDecision.decision ? "trusted" : "untrusted";
		const sessionLabel = this.settingsManager.isProjectTrusted() ? "trusted" : "untrusted";
		const isSaved = (option: ProjectTrustOption): boolean =>
			option.savedPath !== undefined &&
			savedDecision?.decision === option.trusted &&
			savedDecision.path === option.savedPath;
		const items: FloatingMenuItem[] = options.map((option, index) => ({
			value: `trust:${index}`,
			label: option.label,
			active: isSaved(option),
		}));
		return { items, subtitle: `${cwd} · saved: ${savedLabel} · session: ${sessionLabel}` };
	}

	private applyTrustSelection(index: number): void {
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const option = getProjectTrustOptions(cwd)[index];
		if (!option) return;
		trustStore.setMany(option.updates);
		this.showStatus(
			`Saved trust decision: ${option.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
		);
	}

	private showTrustSelector(): void {
		const { items, subtitle } = this.trustMenuItems();
		this.showFloatingMenu("trust", subtitle, items, (item) => {
			if (!item.value.startsWith("trust:")) return false;
			const index = Number.parseInt(item.value.slice("trust:".length), 10);
			if (Number.isNaN(index)) return false;
			this.applyTrustSelection(index);
			return undefined;
		});
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						done();
						this.showStatus(`Model: ${model.id}`);
						void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		let currentEnabledIds: string[] | null = null;

		if (hasSessionScope) {
			// Use current session's scoped models
			currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			}
		}

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: string[] | null) => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
				const newScopedModels = await resolveModelScope(enabledIds, this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
				},
				{
					onChange: async (enabledIds) => {
						await updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds === null || enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							done();
							this.ui.requestRender();
							return;
						}

						this.editor.setText(result.selectedText ?? "");
						done();
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTodoOverlay(): void {
		const state = loadTodoPlanStateFromBranch(this.sessionManager) ?? createEmptyTodoPlanState();
		void this.showExtensionCustom<void>(
			(tui, overlayTheme, _keybindings, done) =>
				new TodoOverlay(tui, overlayTheme, state, this.ui.terminal.rows, done),
			{
				overlay: true,
				overlayOptions: CENTER_FLOATING_OVERLAY,
				onHandle: (handle) => handle.focus(),
			},
		);
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private mcpMenuView(): { items: FloatingMenuItem[]; description: string } {
		const mcpConfigPath = `~/${CONFIG_DIR_NAME}/agent/mcp-servers.json`;
		const { tools, diagnostics } = this.session.resourceLoader.getUserMcpTools();
		const items: FloatingMenuItem[] = [];
		const byServer = new Map<string, number>();

		if (tools.length === 0) {
			items.push(
				diagnostics.length > 0
					? {
							value: "mcp:none",
							label: "No MCP tools loaded",
							description: `Review diagnostics or edit ${mcpConfigPath}`,
							disabled: true,
						}
					: {
							value: "mcp:none",
							label: "No MCP servers configured",
							description: `Add servers in ${mcpConfigPath}`,
							disabled: true,
						},
			);
		} else {
			for (const tool of tools) {
				const server = tool.provenance?.kind === "mcp" ? tool.provenance.server : undefined;
				const owner = server?.trim() || "unknown";
				byServer.set(owner, (byServer.get(owner) ?? 0) + 1);
			}
			for (const [server, count] of byServer) {
				items.push({
					value: `mcp:${server}`,
					label: server,
					description: `${count} tool${count === 1 ? "" : "s"} loaded`,
					disabled: true,
				});
			}
		}

		for (const diagnostic of diagnostics) {
			items.push({
				value: `mcp:diag:${diagnostic.message}`,
				label: diagnostic.type === "error" ? "⚠ error" : "⚠ warning",
				description: diagnostic.message,
				disabled: true,
			});
		}
		return {
			items,
			description:
				tools.length > 0
					? `${byServer.size} server${byServer.size === 1 ? "" : "s"} · ${tools.length} tool${tools.length === 1 ? "" : "s"} loaded`
					: diagnostics.length > 0
						? `No tools loaded · ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`
						: `View MCP servers loaded from ${mcpConfigPath}`,
		};
	}

	private mcpDockParentItem(): FloatingMenuItem {
		const view = this.mcpMenuView();
		return {
			value: "command:mcp",
			label: "MCP Servers",
			aliases: ["mcp"],
			description: view.description,
			children: view.items,
		};
	}

	private showMcpManager(): void {
		// Read-only view of the tools loaded from the user MCP config.
		// Surfaced through the shared dock menu so navigation matches every other
		// panel. Editing servers is still done by hand in the config file.
		const mcpConfigPath = `~/${CONFIG_DIR_NAME}/agent/mcp-servers.json`;
		const view = this.mcpMenuView();

		this.showFloatingMenu("mcp", `MCP servers (read-only; edit ${mcpConfigPath})`, view.items, () => false);
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				(onProgress) =>
					this.sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress)
						: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
		const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth",
		}));

		const modelProviders = new Set(this.session.modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.session.modelRegistry.authStorage;
		const options: AuthSelectorProvider[] = [];

		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.session.modelRegistry.getProviderDisplayName(providerId),
				authType: credential.type,
			});
		}

		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private showLoginAuthTypeSelector(): void {
		this.showLoginMenu();
	}

	// Builds the two-level login menu tree used by the stack-based dock menu:
	//   root = authentication methods (subscription / api key)
	//     children = providers for that method (leaves)
	// Selecting a provider leaf launches the matching OAuth / API-key dialog.
	// left/esc between levels is handled by FloatingMenuBody for free.
	private loginMenuItems(): FloatingMenuItem[] {
		const methods: Array<{ authType: "oauth" | "api_key"; label: string; empty: string }> = [
			{ authType: "oauth", label: "Use a subscription", empty: "No subscription providers available" },
			{ authType: "api_key", label: "Use an API key", empty: "No API key providers available" },
		];
		return methods.map((method) => {
			const providers = this.getLoginProviderOptions(method.authType);
			const children: FloatingMenuItem[] = providers.map((provider) => {
				const status = this.session.modelRegistry.getProviderAuthStatus(provider.id);
				return {
					value: `login:${encodeMenuValuePart(provider.authType)}:${encodeMenuValuePart(provider.id)}`,
					label: provider.name,
					description: status.configured
						? `configured${status.source ? ` (${status.source})` : ""}`
						: "not configured",
					active: status.configured,
				};
			});
			return {
				value: `login-method:${method.authType}`,
				label: method.label,
				description: children.length > 0 ? `${children.length} providers` : method.empty,
				children: children.length > 0 ? children : [{ value: "login:none", label: method.empty, disabled: true }],
			};
		});
	}

	private showLoginMenu(): void {
		const items = this.loginMenuItems();
		this.showFloatingMenu("login", "authentication method / provider", items, (item) => {
			if (!item.value.startsWith("login:") || item.value === "login:none") return false;
			const [, rawAuthType, rawId] = item.value.split(":");
			const authType = decodeMenuValuePart(rawAuthType) as "oauth" | "api_key";
			const providerId = decodeMenuValuePart(rawId);
			const providerOption = this.getLoginProviderOptions(authType).find((provider) => provider.id === providerId);
			if (!providerOption) return false;
			void (async () => {
				if (providerOption.authType === "oauth") {
					await this.showLoginDialog(providerOption.id, providerOption.name);
				} else if (providerOption.id === BEDROCK_PROVIDER_ID) {
					this.showBedrockSetupDialog(providerOption.id, providerOption.name);
				} else {
					await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
				}
			})();
			return undefined;
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "login") {
			this.showLoginAuthTypeSelector();
			return;
		}

		const providerOptions = this.getLogoutProviderOptions();
		if (providerOptions.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				providerOptions,
				async (providerId: string) => {
					done();

					const providerOption = providerOptions.find((provider) => provider.id === providerId);
					if (!providerOption) {
						return;
					}

					try {
						this.session.modelRegistry.authStorage.logout(providerOption.id);
						this.session.modelRegistry.refresh();
						await this.updateAvailableProviderCount();
						const message =
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.showStatus(message);
					} catch (error: unknown) {
						this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
	): Promise<void> {
		this.session.modelRegistry.refresh();

		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

		let selectedModel: Model<any> | undefined;
		let selectionError: string | undefined;
		if (isUnknownModel(previousModel)) {
			const availableModels = this.session.modelRegistry.getAvailable();
			const providerModels = availableModels.filter((model) => model.provider === providerId);
			if (!hasDefaultModelProvider(providerId)) {
				selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
			} else if (providerModels.length === 0) {
				selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
			} else {
				const defaultModelId = defaultModelPerProvider[providerId];
				selectedModel = providerModels.find((model) => model.id === defaultModelId);
				if (!selectedModel) {
					selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
				} else {
					try {
						await this.session.setModel(selectedModel);
					} catch (error: unknown) {
						selectedModel = undefined;
						const errorMessage = error instanceof Error ? error.message : String(error);
						selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
					}
				}
			}
		}

		await this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
		if (selectedModel) {
			this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
			void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
			this.checkDaxnutsEasterEgg(selectedModel);
		} else {
			this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
			if (selectionError) {
				this.showError(selectionError);
			} else {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			}
		}
	}

	private showBedrockSetupDialog(providerId: string, providerName: string): void {
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			() => restoreEditor(),
			providerName,
			"Amazon Bedrock setup",
		);
		dialog.showInfo([
			theme.fg("text", "Amazon Bedrock uses AWS credentials instead of a single API key."),
			theme.fg("text", "Configure an AWS profile, IAM keys, bearer token, or role-based credentials."),
			theme.fg("muted", "See:"),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();
	}

	private async showApiKeyLoginDialog(providerId: string, providerName: string): Promise<void> {
		const previousModel = this.session.model;

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });

			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
			}
		}
	}

	private showOAuthLoginSelect(dialog: LoginDialogComponent, prompt: OAuthSelectPrompt): Promise<string | undefined> {
		return new Promise((resolve) => {
			const restoreDialog = () => {
				this.editorContainer.clear();
				this.editorContainer.addChild(dialog);
				this.ui.setFocus(dialog);
				this.ui.requestRender();
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
				},
				() => {
					restoreDialog();
					resolve(undefined);
				},
			);
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.ui.requestRender();
		});
	}

	private async showLoginDialog(providerId: string, providerName: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage
			.getOAuthProviders()
			.find((provider) => provider.id === providerId);
		const previousModel = this.session.model;

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			(_success, _message) => {
				// Completion handled below
			},
			providerName,
		);

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onDeviceCode: (info) => {
					dialog.showDeviceCode(info);
					dialog.showWaiting("Waiting for authentication...");
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onSelect: (prompt: OAuthSelectPrompt) => this.showOAuthLoginSelect(dialog, prompt),

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(
		message = "Reloading Magenta runtime...",
		options?: {
			HcpClienttrackpackageload?: boolean;
			HcpClientpreservepackageloadevent?: boolean;
		},
	): Promise<boolean> {
		if (!this.canReloadRuntime()) {
			return false;
		}

		this.resetExtensionUI();

		// Create loading overlay
		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new Text(theme.fg("muted", message), 1, 0));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const body: FloatingOverlayBody = {
			closeOnQ: false,
			handleInput: () => undefined,
			render: (width: number) => {
				const rendered = reloadBox.render(width);
				return {
					title: "",
					body: rendered,
				};
			},
		};
		const uiWithOverlay = this.ui as typeof this.ui & {
			showOverlay?: (component: Component, options?: OverlayOptions) => OverlayHandle;
		};
		const handle =
			typeof uiWithOverlay.showOverlay === "function"
				? uiWithOverlay.showOverlay(new FloatingOverlayContainer(body, () => {}), {
						anchor: "center",
						width: "50%",
						minWidth: 40,
						margin: 1,
					})
				: undefined;
		if (!handle) {
			this.editorContainer.clear();
			this.editorContainer.addChild(reloadBox);
			this.ui.setFocus(reloadBox);
		}
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = () => {
			if (handle) {
				handle.hide();
			} else {
				this.editorContainer.clear();
				this.editorContainer.addChild(this.editor);
			}
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		let chatRestoredBeforeSessionStart = false;
		let reloadBoxDismissed = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestoredBeforeSessionStart) {
				return;
			}
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.rebuildChatFromMessages();
			chatRestoredBeforeSessionStart = true;
		};

		try {
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart, ...options });
			restoreChatBeforeSessionStart();
			configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			await this.themeController.applyFromSettings();
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus(
				savedImplicitProjectTrust ? "Reloaded Magenta runtime; saved project trust" : "Reloaded Magenta runtime",
			);
			dismissReloadBox();
			reloadBoxDismissed = true;
			return true;
		} catch (error) {
			if (!reloadBoxDismissed) {
				dismissReloadBox();
			}
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	/**
	 * `/reload`: recompile the local checkout and restart the TUI so the new code
	 * runs. Unlike `/refresh` (hot resync of resources in-process), this rebuilds
	 * dist and re-execs the process, reconnecting to the current session. Only
	 * available when running from a Magenta git checkout.
	 */
	private async handleRecompileRestartCommand(): Promise<void> {
		if (!this.canReloadRuntime()) return;

		this.showStatus("Recompiling Magenta… this may take a minute.");
		this.setExtensionStatus("magenta-reload", "Reload: recompiling");
		this.ui.requestRender();

		const result = await recompileMagenta();
		if (!result.ok) {
			this.setExtensionStatus("magenta-reload", "Reload: failed");
			this.showError(
				`Reload failed: ${result.reason ?? "unknown error"}. ` +
					"Fix the build, then try /reload again (or /refresh to hot-reload resources only).",
			);
			return;
		}

		this.setExtensionStatus("magenta-reload", "Reload: restarting");
		this.showStatus(result.installed ? "Recompiled (with npm install). Restarting…" : "Recompiled. Restarting…");
		this.ui.requestRender();
		// Give the status line a tick to paint before we tear the TUI down.
		await new Promise((resolve) => process.nextTick(resolve));
		await this.restartProcessWithSession();
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
			}
			this.statusContainer.clear();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.session.setSessionName(name);
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName !== name) {
			this.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${sessionName ?? name}`), 1, 0));
		this.ui.requestRender();
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.costUnknown) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} unknown (provider did not report a concrete price)`;
		} else if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => normalizeChangelogLinks(e.content, e))
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				const keyDisplay = formatKeyText(key, { capitalize: true });
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleClearCommand(): Promise<void> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = await extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(): void {
		this.invalidateClipboardImagePastes();
		this.stopUltraBorderAnimation();
		this.isTuiActive = false;
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		this.commandDockInputUnsubscribe?.();
		this.commandDockInputUnsubscribe = undefined;
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		this.releaseExternalTurnRunner?.();
		this.releaseExternalTurnRunner = undefined;
		this.unsubscribeSkillsReloaded?.();
		this.unsubscribeSkillsReloaded = undefined;
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
		this.unregisterSignalHandlers();
	}
}
