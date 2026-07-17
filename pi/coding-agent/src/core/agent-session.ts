/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai/compat";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import {
	type CompactionProvider,
	createSshToolOperations,
	formatSkillInvocation,
	type HcpClient,
	type PeerEndpoint,
	type PolicyProvider,
	type ProcessRuntimeProvider,
	type SandboxProvider,
	type SshTarget,
	type SshToolOperations,
	type SystemPromptProvider,
} from "@magenta/harness";
import { ENV_TEAMMATE_PARENT_SESSION_ID, getAgentDir, getPeerMessageDbPath } from "../config.ts";
import { createBuiltInMessageRenderersExtension } from "../modes/interactive/builtin-message-renderers.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { BackgroundEventManager, type BackgroundEventSnapshot } from "./background-events.ts";
import { BackgroundReminderCoordinator } from "./background-reminder-coordinator.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	CompactionError,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_NATIVE_ACTIVE_TOOLS } from "./defaults.ts";
import {
	type ExecutionProfile,
	getAvailableExecutionProfiles,
	type HarnessCapabilities,
	type HarnessCapabilitySettings,
	resolveExecutionProfile,
	resolveHarnessCapabilities,
} from "./execution-profile.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContext,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import {
	ExternalActivationCoordinator,
	type ExternalActivationEntry,
	type ExternalActivationMessage,
} from "./external-activation-coordinator.ts";
import { HcpClientpackageloadcontroller } from "./HcpClientpackageloadcontroller.ts";
import { HcpClientassembletools } from "./HcpClienttools.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { RemoteMailboxController } from "./remote-mailbox.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import {
	SIDE_CHAT_COMMAND_NAMES,
	type SideChatHandoffRequest,
	type SideChatHandoffResult,
	SideChatManager,
} from "./side-chat.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	getSystemPromptDocumentationPaths,
} from "./system-prompt.ts";
import { ToolProgressTracker } from "./tool-progress.ts";
import { type BashOperations, createLocalBashOperations, withBashAutoPromotion } from "./tools/bash.ts";
import { BackgroundShellController } from "./tools/bg-shell.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { formatPeerMessages, PEER_MESSAGE_CUSTOM_TYPE, SendMessageController } from "./tools/send-message.ts";
import { SubAgentController, type SubAgentWorkflowProvider } from "./tools/sub-agent.ts";
import { TeammateAgentController } from "./tools/teammate-agent.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_progress";
			reason: "manual" | "threshold" | "overflow";
			phase: "preparing" | "extensions" | "summarizing" | "persisting";
			processedBytes?: number;
			totalBytes?: number;
			completedChunks?: number;
	  }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "execution_profile_changed"; profile: ExecutionProfile; thinkingLevel: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			/** One claimed-host wake for a coalesced external activation batch. */
			type: "external_activation";
			activationId: number;
			sources: Array<"peer" | "bg_shell" | "sub_agent" | "reminder">;
			messages: AgentMessage[];
	  }
	| { type: "prompt_withdrawn"; input: SubmittedInput };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/**
	 * Agent config/state directory (e.g. ~/.magenta/agent). Used to locate the shared
	 * peer-message mailbox. Defaults to the machine-global mailbox when omitted.
	 */
	agentDir?: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ExecutionProfile }>;
	/** User-facing execution profile. Provider state remains a native ThinkingLevel. */
	executionProfile?: ExecutionProfile;
	/** Per-session Harness capability overrides. */
	harnessCapabilities?: HarnessCapabilitySettings;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Optional SSH remote workspace target for built-in read/write/edit/bash tools. */
	sshTarget?: SshTarget;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Auto-activate newly loaded Package and user MCP tools. */
	autoActivateLoadedTools?: boolean;
	/** Auto-activate newly loaded repository-default HCP tools. */
	autoActivateDefaultTools?: boolean;
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	/** Override UI availability when a protocol supplies an observable but non-interactive context. */
	hasUI?: boolean;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface SubmittedInput {
	text: string;
	images?: ImageContent[];
	/** Editor marker identity retained only for queue restoration. */
	imageMarkers?: string[];
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** Editor marker identity retained only while a prompt may enter a queue. */
	imageMarkers?: string[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/** Interactive-only draft to restore when this prompt is withdrawn before visible output. */
	withdrawable?: SubmittedInput;
}

interface PromptWithdrawalTransaction {
	input: SubmittedInput;
	userMessage: AgentMessage;
	assistantMessages: Set<AgentMessage>;
	assistantEntryIds: Set<string>;
	userEntryId?: string;
	previousErrorMessage?: string;
	outputCommitted: boolean;
	withdrawRequested: boolean;
	terminalSeen: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	executionProfile: ExecutionProfile;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	costUnknown?: boolean;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ExecutionProfile }>;
	private _executionProfile: ExecutionProfile;
	private _harnessCapabilityOverrides?: HarnessCapabilitySettings;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	// Settled-lifecycle state (D4): tracks whether an agent run (including retries,
	// auto-compaction, and queued/run-owned continuations) is still in progress.
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;
	private _activePromptWithdrawal?: PromptWithdrawalTransaction;

	/** Tracks pending steering messages and attachments. Removed when delivered. */
	private _steeringMessages: SubmittedInput[] = [];
	/** Tracks pending follow-up messages and attachments. Removed when delivered. */
	private _followUpMessages: SubmittedInput[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: Array<{ key?: string; message: CustomMessage }> = [];

	/**
	 * Magenta feature: when true, a host (e.g. the interactive TUI loop) has
	 * claimed the turn-runner, so coalesced external activations are delivered as
	 * one `external_activation` event for the host to run, instead of
	 * the session starting the turn itself. Defaults to false so headless and
	 * sub-agent sessions keep their self-running fallback.
	 */
	private _externalTurnRunnerClaimed = false;
	/** A host activation has been emitted for payload already appended to state. */
	private _externalActivationPending = false;
	private _externalActivationSequence = 0;
	private _externalActivationReceipts = new WeakMap<CustomMessage, ExternalActivationEntry>();

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	/**
	 * Estimated context size captured when a long tool loop is stopped between
	 * turns for threshold compaction. Presence also means the loop should resume
	 * from its retained tool result after compaction succeeds.
	 */
	private _pendingMidLoopCompactionTokens: number | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Phase 5: cached policy/sandbox/runtime providers resolved from session HCP.
	// Resolved at _buildRuntime (including reload) so they stay current. RESOLVED
	// but NOT enforced by default (policy defaults to yolo, sandbox to none) per
	// C5.2/C5.3 parity requirement. Actual enforcement is opt-in only.
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for the explicit policy opt-in integration stage.
	private _policyProvider?: PolicyProvider;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for the explicit sandbox opt-in integration stage.
	private _sandboxProvider?: SandboxProvider;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for the managed runtime integration stage.
	private _runtimeProvider?: ProcessRuntimeProvider;

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _autoActivateLoadedTools: boolean;
	private _autoActivateDefaultTools: boolean;
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionHasUI?: boolean;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _backgroundEvents: BackgroundEventManager;
	private _backgroundReminders: BackgroundReminderCoordinator;
	private _externalActivations: ExternalActivationCoordinator;
	private _backgroundShell: BackgroundShellController;
	private _HcpClientpackageloadcontroller: HcpClientpackageloadcontroller;
	private _subAgents: SubAgentController;
	/** Magenta feature: peer messaging between agent sessions. */
	private _peerMessages: SendMessageController;
	private _remoteMailbox: RemoteMailboxController;
	private _teammates: TeammateAgentController;
	private _toolProgressTracker: ToolProgressTracker;
	private _sideChat: SideChatManager;
	private _sshTarget?: SshTarget;
	private _sshOperations?: SshToolOperations;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._executionProfile = config.executionProfile ?? this.agent.state.thinkingLevel;
		this._harnessCapabilityOverrides = config.harnessCapabilities;
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._sshTarget = config.sshTarget;
		this._sshOperations = this._sshTarget ? createSshToolOperations(this._sshTarget, this._cwd) : undefined;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._autoActivateLoadedTools = config.autoActivateLoadedTools ?? config.initialActiveToolNames === undefined;
		this._autoActivateDefaultTools = config.autoActivateDefaultTools ?? this._autoActivateLoadedTools;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._backgroundEvents = new BackgroundEventManager();
		// One scheduling boundary for every model-visible payload produced outside
		// the AgentLoop. Single messages are one-element batches; sources never own
		// their own queue, wake, or turn path.
		this._externalActivations = new ExternalActivationCoordinator({
			injectBatch: (entries) => this._injectExternalActivationBatch(entries),
			cancelQueued: (entry) => this._cancelQueuedExternalActivation(entry),
		});
		this._backgroundReminders = new BackgroundReminderCoordinator(this._backgroundEvents, {
			upsertNextTurn: (key, content) => {
				const proactive = this._executionProfile === "ultra";
				this._externalActivations.register({
					key: `reminder:${key}`,
					source: { kind: "reminder", key },
					consumeIds: [`reminder:${key}`],
					message: {
						customType: "background-reminder",
						content,
						display: false,
						details: { key },
					},
					delivery: proactive ? "steer" : "nextTurn",
					idlePolicy: proactive ? "activate" : "passive",
				});
			},
			removeNextTurn: (key) => {
				this._externalActivations.cancel([`reminder:${key}`]);
			},
		});
		this._HcpClientpackageloadcontroller = new HcpClientpackageloadcontroller(this._backgroundEvents);
		this._toolProgressTracker = new ToolProgressTracker();
		this._backgroundShell = new BackgroundShellController(this._backgroundEvents, {
			registerReturn: (eventIds, message, delivery, receipt) =>
				this._externalActivations.register({
					key: `bg-shell:${eventIds[0]}`,
					source: { kind: "background", controller: "bg_shell", eventIds },
					consumeIds: eventIds,
					message,
					delivery,
					idlePolicy: delivery === "nextTurn" ? "passive" : "activate",
					onPersisted: receipt.onPersisted,
					onInjectionError: receipt.onDropped,
				}),
		});
		this._subAgents = new SubAgentController(this._backgroundEvents, {
			registerReturn: (eventIds, message, delivery, receipt) =>
				this._externalActivations.register({
					key: `sub-agent:${eventIds[0]}`,
					source: { kind: "background", controller: "sub_agent", eventIds },
					consumeIds: eventIds,
					message,
					delivery,
					idlePolicy: delivery === "nextTurn" ? "passive" : "activate",
					onPersisted: receipt.onPersisted,
					onInjectionError: receipt.onDropped,
				}),
			cancelReturn: (eventIds) => this._externalActivations.cancel(eventIds),
			getWorkflowProvider: () => this._resolveMultiAgentProvider(),
			isWorkflowEnabled: () => this.harnessCapabilities.workflows,
			getDefaultModel: () =>
				this.model
					? {
							provider: this.model.provider,
							model: this.model.id,
						}
					: undefined,
		});
		// Magenta feature: peer messaging. Sender identity is the live session id;
		// the mailbox is a single machine-global database so messages cross between
		// independent agent processes. A caller-provided agentDir (tests) overrides
		// the location.
		const configuredAgentDir = config.agentDir ? resolvePath(config.agentDir) : undefined;
		const defaultAgentDir = resolvePath(getAgentDir());
		const peerMessageDbPath =
			configuredAgentDir && configuredAgentDir !== defaultAgentDir
				? join(configuredAgentDir, "messages.db")
				: getPeerMessageDbPath();
		this._peerMessages = new SendMessageController({
			dbPath: peerMessageDbPath,
			managedParentSessionId: process.env[ENV_TEAMMATE_PARENT_SESSION_ID],
			getSessionId: () => this.sessionId,
			// Urgent peer notification only drains and submits. The shared coordinator
			// decides whether this joins an active boundary or wakes one idle loop.
			wakeForMessages: () => this._wakeForPeerMessages(),
		});
		this._remoteMailbox = new RemoteMailboxController(peerMessageDbPath, { sshTarget: this._sshTarget });
		this._teammates = new TeammateAgentController(this._backgroundEvents, {
			sendPeerMessage: (params) => this._peerMessages.send(params),
			getUnreadPeerMessageCount: (sessionId) => this._peerMessages.unreadCountFor(sessionId),
			getParentSessionId: () => this.sessionId,
			getParentSessionFile: () => this.sessionFile,
			getParentSessionDir: () => this.sessionManager.getSessionDir(),
			getAgentDirPath: () => configuredAgentDir ?? defaultAgentDir,
			getPeerMessageDbPath: () => peerMessageDbPath,
			isEnabled: () => this.harnessCapabilities.teammates,
			getDefaultModel: () =>
				this.model
					? {
							provider: this.model.provider,
							model: this.model.id,
						}
					: undefined,
		});
		this._sideChat = new SideChatManager({
			toolProgress: this._toolProgressTracker,
			appendEntry: (customType, data) => this.sessionManager.appendCustomEntry(customType, data),
			enqueueHumanHandoff: (request, ctx) => this._enqueueHumanSideHandoff(request, ctx),
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers, env: result.env };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getCompactionRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFn === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers, env: result.env } : {};
	}

	/**
	 * Resolve the compaction capability from the session HCP.
	 *
	 * INV-1: the compaction impl is obtained by resolving `capability:compaction`
	 * through the ONE session HcpClient rather than a static import. Returns
	 * undefined when the loader exposes no HCP (null loader / test double), in
	 * which case the compaction wrappers fall back to their static harness default
	 * — the same underlying function, so behavior is identical either way.
	 */
	private _resolveCompactionProvider(): CompactionProvider | undefined {
		const hcp: HcpClient | undefined = this._resourceLoader.HcpClientgetsession?.();
		return hcp?.resolveCapability?.<CompactionProvider>("compaction");
	}

	/**
	 * Resolve prompt composition through the session HCP. A loader with no HCP is
	 * a legacy/test-double boundary and may use the compatibility facade. Once an
	 * HCP exists, a missing required slot is an assembly error rather than a reason
	 * to silently bypass Source selection.
	 */
	private _resolveSystemPromptProvider(): SystemPromptProvider | undefined {
		const hcp: HcpClient | undefined = this._resourceLoader.HcpClientgetsession?.();
		if (!hcp) return undefined;
		const provider = hcp.resolveCapability<SystemPromptProvider>("system-prompt");
		if (!provider) {
			throw new Error('Session HCP is missing required capability slot "system-prompt"');
		}
		return provider;
	}

	private _resolveMultiAgentProvider(): SubAgentWorkflowProvider | undefined {
		const hcp: HcpClient | undefined = this._resourceLoader.HcpClientgetsession?.();
		return hcp?.resolveCapability?.<SubAgentWorkflowProvider>("multiagent");
	}

	/**
	 * Phase 5: Resolve the command-execution safety capabilities from the session
	 * HCP. These are RESOLVED (made consultable) but NOT consumed by default — pi's
	 * bash execution keeps its local spawn with full shell env. This satisfies C5.1
	 * (bash safety resolves through HCP) while preserving C5.2/C5.3 (default behavior
	 * unchanged: policy defaults to `yolo` = allow-all no-prompt; shell classification
	 * is advisory-only; sandbox enforcement is not-ported). Actual enforcement via
	 * these providers is opt-in only (future work / non-default modes).
	 *
	 * Returns undefined for each slot when the loader exposes no HCP (null loader /
	 * test double), in which case pi's current no-guard behavior applies — identical
	 * either way.
	 */
	private _resolvePolicyProvider(): PolicyProvider | undefined {
		const hcp: HcpClient | undefined = this._resourceLoader.HcpClientgetsession?.();
		return hcp?.resolveCapability?.<PolicyProvider>("policy");
	}

	private _resolveSandboxProvider(): SandboxProvider | undefined {
		const hcp: HcpClient | undefined = this._resourceLoader.HcpClientgetsession?.();
		return hcp?.resolveCapability?.<SandboxProvider>("sandbox");
	}

	private _resolveRuntimeProvider(): ProcessRuntimeProvider | undefined {
		const hcp: HcpClient | undefined = this._resourceLoader.HcpClientgetsession?.();
		// runtime is multi-slot; the process runtime lives at `runtime:process`.
		return hcp?.resolveCapability?.<ProcessRuntimeProvider>("runtime:process");
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		const existingShouldStopAfterTurn = this.agent.shouldStopAfterTurn;
		this.agent.shouldStopAfterTurn = async (context, signal) => {
			if (existingShouldStopAfterTurn && (await existingShouldStopAfterTurn(context, signal))) {
				return true;
			}

			// A normal final assistant response already ends the loop and is checked
			// by _handlePostAgentRun. Intervene only when the tool batch would issue
			// another provider request; this preserves explicit tool termination.
			if (!context.hasMoreToolCalls) return false;
			const settings = this.settingsManager.getCompactionSettings();
			if (!settings.enabled || context.message.stopReason === "error" || context.message.stopReason === "aborted") {
				return false;
			}
			const model = this.model;
			if (
				!model ||
				model.contextWindow <= 0 ||
				context.message.provider !== model.provider ||
				context.message.model !== model.id
			) {
				return false;
			}

			// Provider usage describes the completed assistant request. The estimate
			// adds tool results produced afterwards, which are part of the next input
			// and were the missing term in long tool-call loops.
			const contextTokens = estimateContextTokens(context.context.messages).tokens;
			if (!shouldCompact(contextTokens, model.contextWindow, settings)) return false;
			this._pendingMidLoopCompactionTokens = contextTokens;
			return true;
		};

		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: this._steeringMessages.map((input) => input.text),
			followUp: this._followUpMessages.map((input) => input.text),
		});
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	private _assistantHasRenderableOutput(message: AssistantMessage): boolean {
		return message.content.some((content) => {
			if (content.type === "toolCall") return true;
			if (content.type === "text") return content.text.trim().length > 0;
			if (content.type === "thinking") return content.thinking.trim().length > 0;
			return false;
		});
	}

	/** Capture output commitment before extension handlers introduce an await boundary. */
	private _capturePromptWithdrawalEvent(event: AgentEvent): PromptWithdrawalTransaction | undefined {
		const transaction = this._activePromptWithdrawal;
		if (!transaction) return undefined;

		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant"
		) {
			transaction.assistantMessages.add(event.message);
			if (this._assistantHasRenderableOutput(event.message) && !transaction.withdrawRequested) {
				transaction.outputCommitted = true;
			}
		} else if (event.type === "tool_execution_start") {
			if (!transaction.withdrawRequested) transaction.outputCommitted = true;
		} else if (event.type === "agent_end") {
			transaction.terminalSeen = true;
			for (const message of event.messages) {
				if (message.role !== "assistant") continue;
				transaction.assistantMessages.add(message);
				if (this._assistantHasRenderableOutput(message) && !transaction.withdrawRequested) {
					transaction.outputCommitted = true;
				}
			}
		}
		return transaction;
	}

	private _isWithdrawnPromptEvent(event: AgentEvent, transaction: PromptWithdrawalTransaction): boolean {
		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		) {
			return true;
		}
		if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") {
			return false;
		}
		return event.message === transaction.userMessage || transaction.assistantMessages.has(event.message);
	}

	private _cloneSubmittedInput(input: SubmittedInput): SubmittedInput {
		return {
			...input,
			...(input.images ? { images: [...input.images] } : {}),
			...(input.imageMarkers ? { imageMarkers: [...input.imageMarkers] } : {}),
		};
	}

	private _finalizePromptWithdrawal(transaction: PromptWithdrawalTransaction): void {
		const removedMessages = new Set<AgentMessage>([transaction.userMessage, ...transaction.assistantMessages]);
		this.agent.state.messages = this.agent.state.messages.filter((message) => !removedMessages.has(message));
		Object.assign(this.agent.state, { errorMessage: transaction.previousErrorMessage });
		if (this._lastAssistantMessage && transaction.assistantMessages.has(this._lastAssistantMessage)) {
			this._lastAssistantMessage = undefined;
		}
		if (transaction.userEntryId) {
			this.sessionManager.withdrawUserMessage(transaction.userEntryId, transaction.assistantEntryIds);
		}
		if (this._activePromptWithdrawal === transaction) this._activePromptWithdrawal = undefined;
		this._emit({ type: "prompt_withdrawn", input: this._cloneSubmittedInput(transaction.input) });
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		const promptWithdrawal = this._capturePromptWithdrawalEvent(event);
		if (event.type === "message_start" && event.message.role === "custom") {
			const entry = this._externalActivationReceipts.get(event.message);
			if (entry) this._externalActivations.markCommitted(entry.key);
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.findIndex((input) => input.text === messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.findIndex((input) => input.text === messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		if (
			promptWithdrawal?.withdrawRequested &&
			this._activePromptWithdrawal === promptWithdrawal &&
			this._isWithdrawnPromptEvent(event, promptWithdrawal)
		) {
			return;
		}

		if (
			event.type === "agent_end" &&
			promptWithdrawal?.withdrawRequested &&
			this._activePromptWithdrawal === promptWithdrawal
		) {
			const messages = event.messages.filter(
				(message) => message !== promptWithdrawal.userMessage && !promptWithdrawal.assistantMessages.has(message),
			);
			this._finalizePromptWithdrawal(promptWithdrawal);
			const sessionEvent: AgentSessionEvent = { ...event, messages, willRetry: false };
			this._toolProgressTracker.handleAgentEvent(sessionEvent);
			this._subAgents.handleAgentEvent(sessionEvent);
			this._emit(sessionEvent);
			return;
		}

		const sessionEvent =
			event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event;
		this._toolProgressTracker.handleAgentEvent(sessionEvent);
		this._subAgents.handleAgentEvent(sessionEvent);

		// Notify all listeners
		this._emit(sessionEvent);
		if (
			promptWithdrawal?.withdrawRequested &&
			this._activePromptWithdrawal === promptWithdrawal &&
			this._isWithdrawnPromptEvent(event, promptWithdrawal)
		) {
			return;
		}

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
				this._markExternalPayloadPersisted(event.message);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				const entryId = this.sessionManager.appendMessage(event.message);
				if (promptWithdrawal && event.message === promptWithdrawal.userMessage) {
					promptWithdrawal.userEntryId = entryId;
				} else if (
					promptWithdrawal &&
					event.message.role === "assistant" &&
					promptWithdrawal.assistantMessages.has(event.message)
				) {
					promptWithdrawal.assistantEntryIds.add(entryId);
				}
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			// Any agent run consumes all custom peer payloads already appended to
			// state. Clear a queued host activation so a user prompt that won the race
			// cannot be followed by a redundant continuation.
			this._externalActivationPending = false;
			this._turnIndex = 0;
			// Magenta feature: this session is now looping. Record presence so peers
			// see it as active and know a message will be picked up soon.
			this._peerMessages.recordPresence("active");
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			// Magenta feature: loop finished; the process is alive but not looping.
			this._peerMessages.recordPresence("idle");
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			// A turn boundary atomically drains mailbox claims and commits all external
			// submissions that are ready before the AgentLoop polls its batch queues.
			this._peerMessages.recordPresence("active");
			this._submitPeerMessages();
			await this._externalActivations.flushReady();
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			this._submitPeerMessages();
			await this._externalActivations.flushReady();
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Magenta feature: claim ownership of the turn-runner.
	 *
	 * A host with its own activation loop (the interactive TUI) calls this so
	 * coalesced external work is surfaced as one `external_activation` event for
	 * the host to run as one turn, instead of
	 * the session self-running the turn. Returns a release function that restores
	 * the self-running fallback. Headless / sub-agent sessions never claim it and
	 * keep running wake turns themselves.
	 */
	claimExternalTurnRunner(): () => void {
		this._externalTurnRunnerClaimed = true;
		return () => {
			this._externalTurnRunnerClaimed = false;
		};
	}

	/**
	 * Run one turn for an `external_activation` whose coalesced payload messages
	 * are already appended to session state by the shared coordinator.
	 * The host's activation loop calls this so the wake turn runs through the same
	 * single turn-runner as user prompts. No new message is appended — the
	 * continuation runs on the already-present payload. If another run wins the
	 * start race, wait for its real idle boundary before deciding whether it
	 * consumed the pending payload or this host still needs to continue it.
	 */
	async runExternalActivation(): Promise<void> {
		// An activation may have been handed to a claimed host immediately before
		// compaction latched the coordinator. Keep ownership of that wake, but do not
		// run its safe-boundary continuation until the barrier has released every
		// coalesced source against the post-compaction context.
		await this._externalActivations.waitForDeliveryReady();
		while (this.isStreaming && this._externalActivationPending) {
			await this.agent.waitForIdle();
			// The competing run may have crossed another compaction barrier. Recheck it
			// before retrying a payload that its agent_start did not consume.
			await this._externalActivations.waitForDeliveryReady();
		}
		if (!this._externalActivationPending) return;
		this._externalActivationPending = false;
		try {
			// The wake payload is already the last message in state, so a continuation
			// runs a turn on it without appending anything new.
			await this.agent.continue();
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._flushPendingBashMessages();
		}
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	async dispose(): Promise<void> {
		let resourceDisposal = Promise.resolve();
		try {
			// A host wake that has not started must not resume after disposal waits for
			// an active run to abort and become idle.
			this._externalActivationPending = false;
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this._backgroundReminders.dispose();
			// Stop source admission first, then settle/cancel their shared delivery
			// tickets before closing the mailbox used by peer rollback callbacks.
			this._backgroundShell.shutdown();
			this._subAgents.shutdown();
			await this._teammates.shutdown();
			this.agent.abort();
			await this.agent.waitForIdle();
			await this._externalActivations.shutdown();
			this._peerMessages.shutdown();
			this._remoteMailbox.shutdown();
			this._backgroundEvents.dispose();
			resourceDisposal = Promise.resolve(this._resourceLoader.dispose?.());
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
		try {
			await resourceDisposal;
		} catch {
			// Dispose must remain best-effort even when an external transport fails to close.
		}
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current provider-native thinking level. */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Current user-facing execution profile. */
	get executionProfile(): ExecutionProfile {
		return this._executionProfile;
	}

	get harnessCapabilities(): HarnessCapabilities {
		return resolveHarnessCapabilities(
			this._executionProfile,
			this.settingsManager.getHarnessCapabilities(),
			this._harnessCapabilityOverrides,
		);
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Serializable view of background shell, sub-agent, teammate, and package work. */
	getBackgroundEvents(): BackgroundEventSnapshot[] {
		return this._backgroundEvents.getEvents();
	}

	/** Host-only bounded settlement barrier for one-shot runners and shutdown. */
	waitForBackgroundIdle(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<boolean> {
		return this._backgroundEvents.waitForIdle(options);
	}

	/**
	 * Commit every external submission already waiting in the batch window or
	 * injection path. This is an explicit settlement barrier for one-shot hosts;
	 * normal turns should continue independent work instead of calling it.
	 */
	waitForExternalActivationQuiescence(options?: { timeoutMs?: number }): Promise<boolean> {
		return this._externalActivations.waitForQuiescence(options);
	}

	/** Cancel one background event through its owning source controller. */
	cancelBackgroundEvent(sourceId: string, eventId: string): boolean {
		return this._backgroundEvents.cancelEvent(sourceId, eventId);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ExecutionProfile }> {
		return this._scopedModels;
	}

	get sshTarget(): SshTarget | undefined {
		return this._sshTarget;
	}

	getRemoteMailboxEndpoints(): PeerEndpoint[] {
		return this._remoteMailbox.list();
	}

	openRemoteMailbox(endpointId?: string): PeerEndpoint[] {
		return this._remoteMailbox.open(endpointId);
	}

	closeRemoteMailbox(endpointId?: string): PeerEndpoint[] {
		return this._remoteMailbox.close(endpointId);
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ExecutionProfile }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._sshTarget ? `${this._sshTarget.remoteCwd} (via SSH: ${this._sshTarget.remote})` : this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			documentationPaths: getSystemPromptDocumentationPaths(),
			bundledPromptFeatures: this._resourceLoader.getBundledPromptFeatures?.(),
		};
		const provider = this._resolveSystemPromptProvider();
		return provider
			? provider.buildSystemPrompt(this._baseSystemPromptOptions)
			: buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._flushPendingBashMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		const midLoopCompactionTokens = this._pendingMidLoopCompactionTokens;
		this._pendingMidLoopCompactionTokens = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg, true, midLoopCompactionTokens)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via pi.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				const imageMarkers =
					options.imageMarkers?.length === currentImages?.length ? options.imageMarkers : undefined;
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages, imageMarkers);
				} else {
					await this._queueSteer(expandedText, currentImages, imageMarkers);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
				const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses)
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant && (await this._checkCompaction(lastAssistant, false))) {
				try {
					await this.agent.continue();
					while (await this._handlePostAgentRun()) {
						await this.agent.continue();
					}
				} finally {
					this._flushPendingBashMessages();
				}
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message.
			const pendingNextTurn = this._pendingNextTurnMessages;
			this._pendingNextTurnMessages = [];
			for (const { message } of pendingNextTurn) {
				const entry = this._externalActivationReceipts.get(message);
				if (entry) this._externalActivations.markCommitted(entry.key);
				messages.push(message);
			}
			this._backgroundReminders.markNextTurnDelivered();

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt) {
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		const userMessage = messages.find((message) => message.role === "user");
		const promptWithdrawal =
			options?.withdrawable && userMessage
				? {
						input: this._cloneSubmittedInput(options.withdrawable),
						userMessage,
						assistantMessages: new Set<AgentMessage>(),
						assistantEntryIds: new Set<string>(),
						previousErrorMessage: this.agent.state.errorMessage,
						outputCommitted: false,
						withdrawRequested: false,
						terminalSeen: false,
					}
				: undefined;
		if (promptWithdrawal) this._activePromptWithdrawal = promptWithdrawal;
		try {
			preflightResult?.(true);
			if (promptWithdrawal?.withdrawRequested) {
				this._finalizePromptWithdrawal(promptWithdrawal);
				return;
			}
			await this._runAgentPrompt(messages);
		} finally {
			if (this._activePromptWithdrawal === promptWithdrawal) this._activePromptWithdrawal = undefined;
		}
	}

	private async _enqueueHumanSideHandoff(
		request: SideChatHandoffRequest,
		ctx: ExtensionCommandContext,
	): Promise<SideChatHandoffResult> {
		if (this._harnessCapabilityOverrides?.teammates === false) {
			throw new Error("Managed teammates are explicitly disabled for this session");
		}
		if (this.settingsManager.getHarnessCapabilities()?.teammates === false) {
			throw new Error("Managed teammates are explicitly disabled in settings");
		}

		const previousOverrides = this._harnessCapabilityOverrides;
		const previousCapabilities = this.harnessCapabilities;
		const previousActiveToolNames = this.getActiveToolNames();
		let enabledForHandoff = false;
		if (!previousCapabilities.teammates) {
			this._harnessCapabilityOverrides = { ...previousOverrides, teammates: true };
			this._refreshNativeCapabilityTools(previousCapabilities);
			if (this.getToolDefinition("teammate_agent")) {
				this.setActiveToolsByName([...this.getActiveToolNames(), "teammate_agent"]);
			}
			enabledForHandoff = true;
		}
		if (!this.getActiveToolNames().includes("teammate_agent")) {
			this._harnessCapabilityOverrides = previousOverrides;
			if (enabledForHandoff) {
				this._refreshNativeCapabilityTools(this.harnessCapabilities);
				this.setActiveToolsByName(previousActiveToolNames);
			}
			throw new Error("teammate_agent is excluded by the current tool allowlist");
		}

		try {
			return await this._teammates.startHumanSideHandoff(request, ctx);
		} catch (error) {
			if (enabledForHandoff) {
				const enabledCapabilities = this.harnessCapabilities;
				this._harnessCapabilityOverrides = previousOverrides;
				this._refreshNativeCapabilityTools(enabledCapabilities);
				this.setActiveToolsByName(previousActiveToolNames);
			}
			throw error;
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		if (commandName === "events") {
			await this._backgroundEvents.handleCommand(args, this._extensionRunner.createCommandContext());
			return true;
		}
		if (SIDE_CHAT_COMMAND_NAMES.includes(commandName as (typeof SIDE_CHAT_COMMAND_NAMES)[number])) {
			await this._sideChat.handleCommand(commandName, args, this._extensionRunner.createCommandContext());
			return true;
		}

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		// Resolve by bare name or `<source>:<name>` qualified name (reaches collision-shadowed skills).
		// Fall back to a bare-name scan for loaders that don't implement resolveSkill.
		const skill =
			this.resourceLoader.resolveSkill?.(skillName) ??
			this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		// Use the already-loaded, frontmatter-stripped `skill.content` and the shared
		// `formatSkillInvocation` helper rather than re-reading the file and hand-rolling the block.
		// This keeps a single source of truth for the <skill> block and gives skills the same
		// argument-substitution grammar ($1, $@, $ARGUMENTS, ${N:-default}, ...) as prompt templates.
		return formatSkillInvocation(skill, args);
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[], imageMarkers?: string[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images, imageMarkers);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[], imageMarkers?: string[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images, imageMarkers);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[], imageMarkers?: string[]): Promise<void> {
		const markers = imageMarkers && imageMarkers.length === images?.length ? [...imageMarkers] : undefined;
		this._steeringMessages.push({
			text,
			...(images ? { images: [...images] } : {}),
			...(markers ? { imageMarkers: markers } : {}),
		});
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[], imageMarkers?: string[]): Promise<void> {
		const markers = imageMarkers && imageMarkers.length === images?.length ? [...imageMarkers] : undefined;
		this._followUpMessages.push({
			text,
			...(images ? { images: [...images] } : {}),
			...(markers ? { imageMarkers: markers } : {}),
		});
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	private _markExternalPayloadPersisted(message: CustomMessage): void {
		const entry = this._externalActivationReceipts.get(message);
		if (entry) {
			this._externalActivationReceipts.delete(message);
			this._externalActivations.markPersisted(entry.key);
		}
	}

	/** Drain a bounded mailbox claim into the unified external-activation hub. */
	private _submitPeerMessages(): void {
		let drained: ReturnType<typeof this._peerMessages.drainForInjection> = [];
		try {
			drained = this._peerMessages.drainForInjection();
			if (drained.length === 0) return;
			const groups = [
				{ messages: drained.filter((message) => message.priority === "urgent"), delivery: "steer" as const },
				{ messages: drained.filter((message) => message.priority !== "urgent"), delivery: "followUp" as const },
			];
			const entries: ExternalActivationEntry[] = [];
			for (const { messages, delivery } of groups) {
				if (messages.length === 0) continue;
				const ids = messages.map((message) => message.id);
				const requeue = (): void => {
					try {
						this._peerMessages.requeue(ids);
					} catch {
						// A stale pending claim is reclaimed by the mailbox on a later drain.
					}
				};
				entries.push({
					key: `peer:${delivery}:${ids.join(",")}`,
					source: { kind: "peer", messageIds: ids },
					consumeIds: ids,
					message: {
						customType: PEER_MESSAGE_CUSTOM_TYPE,
						content: formatPeerMessages(messages),
						display: true,
						details: { count: messages.length, ids, priority: messages[0]!.priority },
					},
					delivery,
					idlePolicy: delivery === "steer" ? "activate" : "passive",
					onPersisted: () => this._peerMessages.confirmDelivered(ids),
					onInjectionError: requeue,
				});
			}
			this._externalActivations.registerBatch(entries);
		} catch {
			if (drained.length === 0) return;
			try {
				this._peerMessages.requeue(drained.map((message) => message.id));
			} catch {
				// Best-effort; stale-claim recovery is the final fallback.
			}
		}
	}

	/** A signal is only notification; the coordinator owns all delivery and wake policy. */
	private _wakeForPeerMessages(): void {
		this._submitPeerMessages();
	}

	/**
	 * Commit one coalesced set of payloads produced outside the AgentLoop. Each
	 * delivery lane is atomic while streaming; when idle, all active lanes start
	 * one combined turn. nextTurn remains passive until a natural user prompt.
	 */
	private async _injectExternalActivationBatch(entries: ExternalActivationEntry[]): Promise<void> {
		if (entries.length === 0) return;
		const toPayload = (message: ExternalActivationMessage): CustomMessage => ({
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		});
		const payloadEntries = entries.map((entry) => {
			const payload = toPayload(entry.message);
			this._externalActivationReceipts.set(payload, entry);
			return { entry, payload };
		});

		for (const { entry, payload } of payloadEntries.filter(({ entry }) => entry.delivery === "nextTurn")) {
			try {
				this._queueNextTurnMessage(payload, `external:${entry.key}`);
				this._externalActivations.markQueued(entry.key);
			} catch (error) {
				this._externalActivations.markFailed(entry.key, error);
			}
		}
		const due = payloadEntries.filter(({ entry }) => entry.delivery !== "nextTurn");
		if (due.length === 0) return;

		const queueByLane = (queued: typeof due): void => {
			const queue = (laneEntries: typeof due, submit: (messages: CustomMessage[]) => void): void => {
				if (laneEntries.length === 0) return;
				try {
					submit(laneEntries.map(({ payload }) => payload));
					for (const { entry } of laneEntries) this._externalActivations.markQueued(entry.key);
				} catch (error) {
					for (const { entry } of laneEntries) this._externalActivations.markFailed(entry.key, error);
				}
			};
			queue(
				queued.filter(({ entry }) => entry.delivery === "steer"),
				(messages) => this.agent.steerBatch(messages),
			);
			queue(
				queued.filter(({ entry }) => entry.delivery === "followUp"),
				(messages) => this.agent.followUpBatch(messages),
			);
		};
		if (this.isStreaming) {
			queueByLane(due);
			return;
		}

		// Passive entries retain their lane until a natural or externally activated
		// loop reaches that boundary. Only entries with explicit idle activation
		// policy may wake a dormant session.
		const activating = due.filter(({ entry }) => entry.idlePolicy === "activate");
		queueByLane(due.filter(({ entry }) => entry.idlePolicy === "passive"));
		if (activating.length === 0) return;

		activating.sort(
			(left, right) => (left.entry.delivery === "steer" ? -1 : 1) - (right.entry.delivery === "steer" ? -1 : 1),
		);
		const payloads = activating.map(({ payload }) => payload);
		const sources = [
			...new Set(
				activating.map(({ entry }) =>
					entry.source.kind === "background" ? entry.source.controller : entry.source.kind,
				),
			),
		];
		const appendToState = (payload: CustomMessage): void => {
			this.agent.state.messages.push(payload);
			this.sessionManager.appendCustomMessageEntry(
				payload.customType,
				payload.content,
				payload.display,
				payload.details,
			);
			this._markExternalPayloadPersisted(payload);
			this._emit({ type: "message_start", message: payload });
			this._emit({ type: "message_end", message: payload });
		};

		if (this._externalTurnRunnerClaimed) {
			for (const payload of payloads) appendToState(payload);
			if (!this._externalActivationPending) {
				this._externalActivationPending = true;
				this._emit({
					type: "external_activation",
					activationId: ++this._externalActivationSequence,
					sources,
					messages: payloads,
				});
			}
			return;
		}

		const last = payloads[payloads.length - 1]!;
		for (const payload of payloads.slice(0, -1)) appendToState(payload);
		const lastEntry = this._externalActivationReceipts.get(last);
		if (lastEntry) this._externalActivations.markCommitted(lastEntry.key);
		// Starting an unclaimed headless turn is the commit boundary. Do not await
		// the run from inside the coordinator, because its turn listeners flush the
		// same coordinator and would otherwise form a re-entrant wait cycle.
		void this._runAgentPrompt(last).catch((error) => {
			if (lastEntry) this._externalActivations.markFailed(lastEntry.key, error);
		});
	}

	private _cancelQueuedExternalActivation(entry: ExternalActivationEntry): boolean {
		const removed = this.agent.removeQueuedMessages(
			(message) => message.role === "custom" && this._externalActivationReceipts.get(message)?.key === entry.key,
		);
		for (const message of removed) {
			if (message.role === "custom") this._externalActivationReceipts.delete(message);
		}
		const nextTurnKey = `external:${entry.key}`;
		const before = this._pendingNextTurnMessages.length;
		const retained: typeof this._pendingNextTurnMessages = [];
		for (const pending of this._pendingNextTurnMessages) {
			if (pending.key === nextTurnKey) this._externalActivationReceipts.delete(pending.message);
			else retained.push(pending);
		}
		this._pendingNextTurnMessages = retained;
		return removed.length > 0 || retained.length !== before;
	}

	private _queueNextTurnMessage(message: CustomMessage, key?: string): void {
		if (key) {
			const existing = this._pendingNextTurnMessages.findIndex((entry) => entry.key === key);
			if (existing !== -1) {
				this._pendingNextTurnMessages[existing] = { key, message };
				return;
			}
		}
		this._pendingNextTurnMessages.push({ key, message });
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (commandName === "events") {
			throw new Error(`Command "/${commandName}" cannot be queued. Execute it when not streaming.`);
		}
		if (SIDE_CHAT_COMMAND_NAMES.includes(commandName as (typeof SIDE_CHAT_COMMAND_NAMES)[number])) {
			throw new Error(`Command "/${commandName}" cannot be queued. Execute it when not streaming.`);
		}
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._queueNextTurnMessage(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/** Clear all queued messages with their attachments for an editor restore. */
	clearQueueWithContent(): { steering: SubmittedInput[]; followUp: SubmittedInput[] } {
		const steering = this._steeringMessages.map((input) => ({
			...input,
			...(input.images ? { images: [...input.images] } : {}),
			...(input.imageMarkers ? { imageMarkers: [...input.imageMarkers] } : {}),
		}));
		const followUp = this._followUpMessages.map((input) => ({
			...input,
			...(input.images ? { images: [...input.images] } : {}),
			...(input.imageMarkers ? { imageMarkers: [...input.imageMarkers] } : {}),
		}));
		this._steeringMessages = [];
		this._followUpMessages = [];
		const cleared = this.agent.clearAllQueues();
		for (const message of [...cleared.steering, ...cleared.followUp]) {
			if (message.role !== "custom") continue;
			const entry = this._externalActivationReceipts.get(message);
			if (!entry) continue;
			this._externalActivationReceipts.delete(message);
			this._externalActivations.markFailed(entry.key, new Error("Queued external activation was cleared"));
		}
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Clear queued messages while preserving the existing text-only public contract. */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.clearQueueWithContent();
		return {
			steering: steering.map((input) => input.text),
			followUp: followUp.map((input) => input.text),
		};
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages.map((input) => input.text);
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages.map((input) => input.text);
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	get toolProgressTracker(): ToolProgressTracker {
		return this._toolProgressTracker;
	}

	/**
	 * Withdraw the active interactive prompt before its first renderable assistant
	 * output. The latch and abort are synchronous so an output event cannot win in
	 * between the eligibility check and cancellation.
	 */
	requestPromptWithdrawal(): boolean {
		const transaction = this._activePromptWithdrawal;
		if (!transaction || transaction.outputCommitted || transaction.withdrawRequested || transaction.terminalSeen) {
			return false;
		}
		transaction.withdrawRequested = true;
		this.requestAbort();
		return true;
	}

	/** Request cancellation and return without waiting for terminal settlement. */
	requestAbort(): void {
		this.abortRetry();
		this.agent.abort();
	}

	/**
	 * Host-only settlement barrier. Agent loops, tools, and event listeners must
	 * use requestAbort() and observe agent_end instead.
	 */
	async abort(): Promise<void> {
		this.requestAbort();
		await this.waitForIdle();
	}

	/**
	 * Wait for the agent to become fully idle (no active run, including retries and continuations).
	 */
	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	/**
	 * Whether the agent is fully idle (no active run).
	 */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private async _emitAgentSettled(): Promise<void> {
		// Phase 1: the run has drained (agent_end handlers, retries, compaction, and
		// run-owned continuations already completed in _runAgentPrompt). Mark inactive.
		this._isAgentRunActive = false;
		// Phase 2: notify listeners. Extension settled callbacks are awaited before the
		// internal completion barrier (waitForIdle) resolves, so RPC promptAndWait only
		// completes once same-run settled work is done.
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			if (this._resolveIdleWait) {
				const resolve = this._resolveIdleWait;
				this._resolveIdleWait = undefined;
				this._idleWaitPromise = undefined;
				resolve();
			}
		}
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const executionProfile = this._getExecutionProfileForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-map the execution profile for the new model's native capabilities.
		this.setExecutionProfile(executionProfile);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = this._scopedModels.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const executionProfile = this._getExecutionProfileForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply execution profile.
		// - Explicit scoped model profile overrides current session profile
		// - Undefined scoped model profile inherits the current session preference
		this.setExecutionProfile(executionProfile);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return {
			model: next.model,
			thinkingLevel: this.thinkingLevel,
			executionProfile: this.executionProfile,
			isScoped: true,
		};
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const executionProfile = this._getExecutionProfileForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-map the execution profile for the new model's native capabilities.
		this.setExecutionProfile(executionProfile);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return {
			model: nextModel,
			thinkingLevel: this.thinkingLevel,
			executionProfile: this.executionProfile,
			isScoped: false,
		};
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set a provider-native thinking level. This compatibility API selects the
	 * corresponding standard execution profile.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		this.setExecutionProfile(level);
	}

	setExecutionProfile(profile: ExecutionProfile): void {
		const previousProfile = this._executionProfile;
		const previousLevel = this.agent.state.thinkingLevel;
		const previousCapabilities = this.harnessCapabilities;
		const effectiveLevel = resolveExecutionProfile(this.model, profile);
		const effectiveProfile = profile === "ultra" ? "ultra" : effectiveLevel;
		const profileChanging = effectiveProfile !== previousProfile;
		const levelChanging = effectiveLevel !== previousLevel;

		this._executionProfile = effectiveProfile;
		this.agent.state.thinkingLevel = effectiveLevel;

		if (!profileChanging && !levelChanging) return;

		this.sessionManager.appendThinkingLevelChange(effectiveProfile);
		if (this.supportsThinking() || effectiveProfile === "ultra" || effectiveLevel !== "off") {
			this.settingsManager.setDefaultThinkingLevel(effectiveProfile);
		}
		if (levelChanging) {
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
		this._emit({
			type: "execution_profile_changed",
			profile: effectiveProfile,
			thinkingLevel: effectiveLevel,
		});

		const capabilities = this.harnessCapabilities;
		if (
			profileChanging ||
			capabilities.workflows !== previousCapabilities.workflows ||
			capabilities.teammates !== previousCapabilities.teammates
		) {
			this._refreshNativeCapabilityTools(previousCapabilities);
		}
	}

	/** Cycle through native levels followed by Ultra. */
	cycleThinkingLevel(): ExecutionProfile | undefined {
		const profiles = this.getAvailableExecutionProfiles();
		if (profiles.length <= 1) return undefined;
		const currentIndex = profiles.indexOf(this.executionProfile);
		const nextIndex = (currentIndex + 1) % profiles.length;
		const nextProfile = profiles[nextIndex];

		this.setExecutionProfile(nextProfile);
		return nextProfile;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	getAvailableExecutionProfiles(): ExecutionProfile[] {
		return getAvailableExecutionProfiles(this.model);
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getExecutionProfileForModelSwitch(explicitProfile?: ExecutionProfile): ExecutionProfile {
		return explicitProfile ?? this.executionProfile;
	}

	private _refreshNativeCapabilityTools(previousCapabilities?: HarnessCapabilities): void {
		const activeToolNames = this.getActiveToolNames();
		const capabilities = this.harnessCapabilities;
		this._buildNativeToolDefinitions();
		const nextActiveToolNames = activeToolNames.filter((name) => name !== "teammate_agent" || capabilities.teammates);
		if (capabilities.teammates && !previousCapabilities?.teammates && this._autoActivateDefaultTools) {
			nextActiveToolNames.push("teammate_agent");
		}
		this._refreshToolRegistry({ activeToolNames: [...new Set(nextActiveToolNames)] });
		if (previousCapabilities?.teammates && !capabilities.teammates) {
			void this._teammates.stopAll();
		}
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		// Latch before aborting the current run. Returns/messages that arrived at the
		// preceding boundary are reclaimed into the same held coordinator batch, and
		// sources may continue durably registering while the summary is generated.
		const barrier = this._externalActivations.acquireDeliveryBarrier();
		let releaseBarrier: (() => Promise<void>) | undefined;
		this._disconnectFromAgent();

		try {
			await this.abort();
			releaseBarrier = await barrier;
			this._compactionAbortController = new AbortController();
			this._emit({ type: "compaction_start", reason: "manual" });
			this._emit({ type: "compaction_progress", reason: "manual", phase: "preparing" });
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers, env } = await this._getCompactionRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();
			const compactionProvider = this._resolveCompactionProvider();

			const preparation = prepareCompaction(pathEntries, settings, compactionProvider);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				this._emit({ type: "compaction_progress", reason: "manual", phase: "extensions" });
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				this._emit({ type: "compaction_progress", reason: "manual", phase: "summarizing" });
				const result = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
					env,
					compactionProvider,
					(progress) => this._emit({ type: "compaction_progress", reason: "manual", ...progress }),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this._emit({ type: "compaction_progress", reason: "manual", phase: "persisting" });
			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// User-cancel detection: pi's own post-compact guard throws "Compaction
			// cancelled"; an abort during the harness call surfaces as a
			// CompactionError with code "aborted" (also re-tagged name "AbortError"
			// by the compaction adapter). Match any of these so a cancel is not
			// reported as a failure.
			const aborted =
				message === "Compaction cancelled" ||
				(error instanceof Error && error.name === "AbortError") ||
				(error instanceof CompactionError && error.code === "aborted");
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
			// Release on success, provider/extension failure, and user cancellation.
			// Awaiting here makes the handoff atomic: waiters cannot run until every
			// source accumulated during compaction has entered the normal priority batch.
			releaseBarrier ??= await barrier;
			await releaseBarrier();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		midLoopContextTokens?: number,
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error, or reported usage exceeded
		// the configured window. A successful response over the configured window should compact
		// but must not retry: the assistant answer already completed and agent.continue() cannot
		// continue from an assistant message.
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = Math.max(directContextTokens, midLoopContextTokens ?? 0);
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", midLoopContextTokens !== undefined);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;
		let releaseBarrier: (() => Promise<void>) | undefined;

		try {
			if (!this.model) {
				return false;
			}

			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			let env: Record<string, string> | undefined;
			if (this.agent.streamFn === streamSimple) {
				const authResult = await this._modelRegistry.getApiKeyAndHeaders(this.model);
				if (!authResult.ok || !authResult.apiKey) {
					return false;
				}
				apiKey = authResult.apiKey;
				headers = authResult.headers;
				env = authResult.env;
			} else {
				({ apiKey, headers, env } = await this._getCompactionRequestAuth(this.model));
			}

			const pathEntries = this.sessionManager.getBranch();
			const compactionProvider = this._resolveCompactionProvider();

			const preparation = prepareCompaction(pathEntries, settings, compactionProvider);
			if (!preparation) {
				return false;
			}

			// All validation/preparation above is non-compacting work. Latch only once
			// compaction will actually start, reclaiming any external payload queued at
			// the just-completed AgentLoop boundary before the summary snapshot is used.
			releaseBarrier = await this._externalActivations.acquireDeliveryBarrier();
			this._autoCompactionAbortController = new AbortController();
			started = true;
			this._emit({ type: "compaction_start", reason });

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				this._emit({ type: "compaction_progress", reason, phase: "extensions" });
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				this._emit({ type: "compaction_progress", reason, phase: "summarizing" });
				const compactResult = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
					env,
					compactionProvider,
					(progress) => this._emit({ type: "compaction_progress", reason, ...progress }),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this._emit({ type: "compaction_progress", reason, phase: "persisting" });
			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			// An abort raised from inside the harness compaction call (rather than
			// caught by the post-compact signal check above) arrives here as a
			// CompactionError code "aborted" / name "AbortError". Treat it as a
			// cancel — emit aborted, not a failure — to match the signal-check path.
			const aborted =
				(error instanceof CompactionError && error.code === "aborted") ||
				(error instanceof Error && error.name === "AbortError");
			if (started) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage: aborted
						? undefined
						: reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
			// The release is deliberately after clearing compaction state. Its normal
			// priority batch may queue a safe-boundary continuation into the still-live
			// Agent run, but can never do so while compaction itself is active.
			await releaseBarrier?.();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.hasUI !== undefined) {
			this._extensionHasUI = bindings.hasUI;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		await this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode, this._extensionHasUI);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const builtinCommands: SlashCommandInfo[] = [
				{
					name: "events",
					description: "Show background work started by the main agent",
					source: "builtin",
					sourceInfo: createSyntheticSourceInfo("<builtin:events>", { source: "builtin" }),
				},
				...SIDE_CHAT_COMMAND_NAMES.map((name) => ({
					name,
					description: "Open Side/BTW history or start a no-tools side conversation",
					source: "builtin" as const,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
				})),
			];
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...builtinCommands, ...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, entry]) => [name, entry]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBaseTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values()).filter(({ definition }) => isAllowedTool(definition.name)),
			runner,
		);

		const toolRegistry = new Map(wrappedBaseTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		// Resolve repository and Package tools from the one session HCP
		// instead of local construction. Build tool magnets with per-runtime options
		// (SSH ops, shell path, auto-resize) and register into the session HCP, then
		// resolve back through the magnet chain. Satisfies INV-1 (all content via HCP)
		// while preserving pi's per-runtime option injection lifecycle. Falls back to
		// local construction when no session HCP is available (e.g. custom loaders).
		const sessionHcp = this._resourceLoader.HcpClientgetsession?.();
		const baseToolDefinitions: Record<string, ToolDefinitionEntry> = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						{
							definition: createToolDefinitionFromAgentTool(tool),
							sourceInfo: createSyntheticSourceInfo(`<sdk:${name}>`, { source: "sdk" }),
						},
					]),
				)
			: sessionHcp
				? this.HcpClientresolvetools(sessionHcp)
				: Object.fromEntries(
						Object.entries(
							createAllToolDefinitions(this._cwd, {
								read: {
									autoResizeImages: this.settingsManager.getImageAutoResize(),
									operations: this._sshOperations?.read,
								},
								bash: {
									commandPrefix: this.settingsManager.getShellCommandPrefix(),
									shellPath: this.settingsManager.getShellPath(),
									operations: this._sshOperations?.bash,
								},
								write: { operations: this._sshOperations?.write },
								edit: { operations: this._sshOperations?.edit },
							}),
						).map(([name, definition]) => [
							name,
							{
								definition,
								sourceInfo: createSyntheticSourceInfo(`<pi:${name}>`, { source: "pi" }),
							},
						]),
					);
		this._baseToolDefinitions = new Map(Object.entries(baseToolDefinitions));
		this._buildNativeToolDefinitions();

		const extensionsResult = this._resourceLoader.getExtensions();

		// Add built-in message renderers extension (for bg-shell-return, etc.)
		// Only in non-print modes where custom messages are displayed
		if (this._extensionMode !== "print") {
			extensionsResult.extensions.push(createBuiltInMessageRenderersExtension());
		}

		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		// Phase 4: inject the session HCP so ExtensionRunner can delegate lifecycle
		// hooks (pre-tool/post-tool/pre-llm/post-llm) to the HCP-resolved HookProvider.
		// Runs on every _buildRuntime (including reload) so the provider stays current.
		this._extensionRunner.HcpClientsetsession(sessionHcp);
		// Phase 5: resolve command-execution safety capabilities from the session HCP
		// so bash safety is HCP-routed (C5.1). These are cached for consultation but
		// NOT enforced by default (policy=yolo, sandbox=none) so behavior is identical
		// to pre-Phase-5 (C5.2/C5.3). undefined when no HCP — pi's local spawn applies.
		this._policyProvider = this._resolvePolicyProvider();
		this._sandboxProvider = this._resolveSandboxProvider();
		this._runtimeProvider = this._resolveRuntimeProvider();
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: [
					...DEFAULT_NATIVE_ACTIVE_TOOLS,
					...(this.harnessCapabilities.teammates ? ["teammate_agent"] : []),
					...(this._autoActivateDefaultTools ? (this._resourceLoader.getDefaultToolNames?.() ?? []) : []),
					...(this._autoActivateLoadedTools
						? [
								...this._resourceLoader.getPackageTools().tools.map((tool) => tool.name),
								...this._resourceLoader.getUserMcpTools().tools.map((tool) => tool.name),
							]
						: []),
				];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	private _buildNativeToolDefinitions(): void {
		if (this._baseToolsOverride) return;
		for (const name of ["bg_shell", "sub_agent", "send_message", "teammate_agent"]) {
			this._baseToolDefinitions.delete(name);
		}
		const definitions: Record<string, ToolDefinition> = {
			bg_shell: this._backgroundShell.createToolDefinition() as ToolDefinition,
			sub_agent: this._subAgents.createToolDefinition() as ToolDefinition,
			send_message: this._peerMessages.createToolDefinition() as ToolDefinition,
		};
		if (this.harnessCapabilities.teammates) {
			definitions.teammate_agent = this._teammates.createToolDefinition() as ToolDefinition;
		}
		for (const [name, definition] of Object.entries(definitions)) {
			this._baseToolDefinitions.set(name, {
				definition,
				sourceInfo: createSyntheticSourceInfo(`<pi:${name}>`, { source: "pi" }),
			});
		}

		// Wrap the resolved bash tool so long-running commands promote to a
		// background event (auto-returning their result) instead of blocking the
		// agent loop. The wrapper preserves the underlying execute (SSH ops, shell
		// path, safety routing) and only augments its lifecycle.
		const bashEntry = this._baseToolDefinitions.get("bash");
		if (bashEntry) {
			this._baseToolDefinitions.set("bash", {
				...bashEntry,
				definition: withBashAutoPromotion(
					bashEntry.definition as Parameters<typeof withBashAutoPromotion>[0],
					this._cwd,
					{ backgroundShell: this._backgroundShell },
				) as ToolDefinition,
			});
		}
	}

	private HcpClientresolvetools(sessionHcp: HcpClient): Record<string, ToolDefinitionEntry> {
		// Tools were built once by the session assembler. Runtime code only resolves
		// their addresses and adds pi-owned rendering metadata.
		const canonical = createAllToolDefinitions(this._cwd) as Record<string, ToolDefinition>;
		const descriptions = new Map(sessionHcp.describeAll().map((description) => [description.target, description]));
		const packageToolNames = new Set(this._resourceLoader.getPackageTools().tools.map((tool) => tool.name));
		const userMcpToolNames = new Set(this._resourceLoader.getUserMcpTools().tools.map((tool) => tool.name));
		const resolved: Record<string, ToolDefinitionEntry> = {};
		for (const address of sessionHcp.addresses().filter((candidate) => candidate.startsWith("tool:"))) {
			const tool = sessionHcp.resolveInstance<AgentTool>(address);
			if (tool) {
				const def = createToolDefinitionFromAgentTool(tool);
				// Merge pi-canonical prompt/render metadata (promptSnippet, promptGuidelines,
				// renderCall, renderResult) onto the HCP-resolved definition. HCP provides
				// execute+schema+description; pi's canonical provides prompt/render metadata.
				const canonicalDef = canonical[tool.name];
				if (canonicalDef) {
					def.promptSnippet = canonicalDef.promptSnippet;
					def.promptGuidelines = canonicalDef.promptGuidelines;
					def.prepareArguments = canonicalDef.prepareArguments;
					def.renderCall = canonicalDef.renderCall;
					def.renderResult = canonicalDef.renderResult;
				}
				const describedSource = descriptions.get(address)?.metadata?.source;
				const source = packageToolNames.has(tool.name)
					? "harness-package"
					: userMcpToolNames.has(tool.name)
						? "user-mcp"
						: typeof describedSource === "string"
							? describedSource
							: "hcp";
				resolved[tool.name] = {
					definition: def,
					sourceInfo: createSyntheticSourceInfo(
						source === "harness-package"
							? `<harness-package:${tool.name}>`
							: source === "user-mcp"
								? `<user-mcp:${tool.name}>`
								: `<hcp:${source}:${tool.name}>`,
						{
							source,
							origin: source === "harness-package" ? "package" : "top-level",
						},
					),
				};
			}
		}
		return resolved;
	}

	async reload(options?: {
		beforeSessionStart?: () => void | Promise<void>;
		HcpClienttrackpackageload?: boolean;
		HcpClientpreservepackageloadevent?: boolean;
	}): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		const previousToolNames = new Set(this.getAllTools().map((tool) => tool.name));
		const previousActiveToolNames = this.getActiveToolNames();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		// Refresh model registry to reload models.json and provider configurations
		this._modelRegistry.refresh();
		const HcpClientpreservepackageloadevent = options?.HcpClientpreservepackageloadevent === true;
		if (options?.HcpClienttrackpackageload && !HcpClientpreservepackageloadevent) {
			this._HcpClientpackageloadcontroller.begin(0);
		}
		try {
			await this._resourceLoader.reload({
				onPackageAssemblyProgress: HcpClientpreservepackageloadevent
					? undefined
					: this._HcpClientpackageloadcontroller.onProgress,
				HcpClientprepare: async (hcp) => {
					await HcpClientassembletools({
						hcp,
						cwd: this._cwd,
						settingsManager: this.settingsManager,
						sessionManager: this.sessionManager,
						sshOperations: this._sshOperations,
					});
				},
			});
			if (!HcpClientpreservepackageloadevent) {
				this._HcpClientpackageloadcontroller.finish();
			}
		} catch (error) {
			if (!HcpClientpreservepackageloadevent) {
				this._HcpClientpackageloadcontroller.fail(error);
			}
			throw error;
		}
		const loadedToolNames = [
			...(this._autoActivateDefaultTools ? (this._resourceLoader.getDefaultToolNames?.() ?? []) : []),
			...(this._autoActivateLoadedTools
				? [
						...this._resourceLoader.getPackageTools().tools.map((tool) => tool.name),
						...this._resourceLoader.getUserMcpTools().tools.map((tool) => tool.name),
					]
				: []),
		].filter((name) => !previousToolNames.has(name));
		this._buildRuntime({
			activeToolNames: [...previousActiveToolNames, ...loadedToolNames],
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable using the canonical pi-ai classifier.
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		// Delegate to the canonical retry classifier from @earendil-works/pi-ai,
		// which includes provider-specific transient errors, explicit retry guidance,
		// and quota/billing exclusions.
		return isRetryableAssistantError(message);
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? this._sshOperations?.bash ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers, env } = await this._getRequiredRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFn,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		let costUnknown = false;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				if (assistantMsg.usage.cost.unknown) {
					costUnknown = true;
				} else {
					totalCost += assistantMsg.usage.cost.total;
				}
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			...(costUnknown ? { costUnknown: true } : {}),
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
