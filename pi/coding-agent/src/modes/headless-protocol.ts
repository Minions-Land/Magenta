import { APP_NAME, INFRA_VERSION, VERSION } from "../config.ts";
import type { AgentSessionEvent, SessionStats } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { BackgroundEventSnapshot } from "../core/background-events.ts";
import type { SourceInfo } from "../core/source-info.ts";
import { hasTrustRequiringProjectResources } from "../core/trust-manager.ts";

export const HEADLESS_PROTOCOL_VERSION = 1;

export type HeadlessMode = "json" | "rpc";
export type HeadlessRunStatus = "success" | "error" | "aborted";
export type BackgroundPolicy = "cancel" | "wait" | "error";
export type NonInteractiveUiPolicy = "deny" | "error";

export interface HeadlessResourceDescriptor {
	name: string;
	sourceInfo: SourceInfo;
}

export interface HeadlessRuntimeManifest {
	type: "runtime_manifest";
	protocolVersion: typeof HEADLESS_PROTOCOL_VERSION;
	runId: string;
	sequence: number;
	mode: HeadlessMode;
	timestamp: string;
	product: {
		name: string;
		version: string;
		infrastructureVersion: string;
	};
	cwd: string;
	session: {
		id: string;
		file?: string;
		name?: string;
		persisted: boolean;
	};
	model?: {
		provider: string;
		id: string;
		api: string;
	};
	execution: {
		thinkingLevel: string;
		profile: string;
		harnessCapabilities: {
			workflows: boolean;
			teammates: boolean;
		};
	};
	tools: {
		active: string[];
		available: HeadlessResourceDescriptor[];
	};
	resources: {
		extensions: Array<{ path: string; resolvedPath: string; sourceInfo: SourceInfo }>;
		skills: HeadlessResourceDescriptor[];
		prompts: HeadlessResourceDescriptor[];
		contextFiles: string[];
		harnessPackages: string[];
		packageTools: string[];
		userMcpTools: string[];
		customSystemPrompt: boolean;
		appendSystemPromptCount: number;
	};
	projectTrust: {
		trusted: boolean;
		required: boolean;
	};
	policies: {
		autoCompaction: boolean;
		autoRetry: boolean;
		steeringMode: "all" | "one-at-a-time";
		followUpMode: "all" | "one-at-a-time";
		background?: { policy: BackgroundPolicy; waitTimeoutMs: number };
		nonInteractiveUi?: NonInteractiveUiPolicy;
		validationOnly?: boolean;
	};
	diagnostics: Array<{ type: "info" | "warning" | "error"; message: string }>;
}

export interface HeadlessUiEvent {
	type: "non_interactive_ui";
	protocolVersion: typeof HEADLESS_PROTOCOL_VERSION;
	mode: "print" | "json";
	method: string;
	disposition: "denied" | "error" | "reported" | "ignored";
	message: string;
}

export interface HeadlessRunEndEvent {
	type: "run_end";
	protocolVersion: typeof HEADLESS_PROTOCOL_VERSION;
	runId: string;
	status: HeadlessRunStatus;
	exitCode: number;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	stopReason?: string;
	error?: string;
	stats: SessionStats;
	background: {
		policy: BackgroundPolicy;
		settled: boolean;
		events: BackgroundEventSnapshot[];
	};
	nonInteractiveUi: {
		policy: NonInteractiveUiPolicy;
		requestCount: number;
	};
}

export type HeadlessProtocolEvent =
	| AgentSessionEvent
	| HeadlessRuntimeManifest
	| HeadlessUiEvent
	| HeadlessRunEndEvent;

export function createHeadlessRuntimeManifest(
	runtime: AgentSessionRuntime,
	options: {
		mode: HeadlessMode;
		runId: string;
		sequence: number;
		oneShot?: {
			backgroundPolicy: BackgroundPolicy;
			backgroundWaitTimeoutMs: number;
			nonInteractiveUiPolicy: NonInteractiveUiPolicy;
			validateOnly: boolean;
		};
	},
): HeadlessRuntimeManifest {
	const { session } = runtime;
	const { resourceLoader, settingsManager, sessionManager } = session;
	const model = session.model;
	const cwd = runtime.cwd || sessionManager.getCwd();

	return {
		type: "runtime_manifest",
		protocolVersion: HEADLESS_PROTOCOL_VERSION,
		runId: options.runId,
		sequence: options.sequence,
		mode: options.mode,
		timestamp: new Date().toISOString(),
		product: {
			name: APP_NAME,
			version: VERSION,
			infrastructureVersion: INFRA_VERSION,
		},
		cwd,
		session: {
			id: session.sessionId,
			file: session.sessionFile,
			name: session.sessionName,
			persisted: sessionManager.isPersisted(),
		},
		model: model ? { provider: model.provider, id: model.id, api: model.api } : undefined,
		execution: {
			thinkingLevel: session.thinkingLevel,
			profile: session.executionProfile,
			harnessCapabilities: session.harnessCapabilities,
		},
		tools: {
			active: session.getActiveToolNames(),
			available: session.getAllTools().map(({ name, sourceInfo }) => ({ name, sourceInfo })),
		},
		resources: {
			extensions: resourceLoader.getExtensions().extensions.map(({ path, resolvedPath, sourceInfo }) => ({
				path,
				resolvedPath,
				sourceInfo,
			})),
			skills: resourceLoader.getSkills().skills.map(({ name, sourceInfo }) => ({ name, sourceInfo })),
			prompts: resourceLoader.getPrompts().prompts.map(({ name, sourceInfo }) => ({ name, sourceInfo })),
			contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path),
			harnessPackages: resourceLoader.HcpClientgetharnesspackageselectors?.() ?? [],
			packageTools: resourceLoader.getPackageTools().tools.map(({ name }) => name),
			userMcpTools: resourceLoader.getUserMcpTools().tools.map(({ name }) => name),
			customSystemPrompt: resourceLoader.getSystemPrompt() !== undefined,
			appendSystemPromptCount: resourceLoader.getAppendSystemPrompt().length,
		},
		projectTrust: {
			trusted: settingsManager.isProjectTrusted(),
			required: hasTrustRequiringProjectResources(cwd),
		},
		policies: {
			autoCompaction: session.autoCompactionEnabled,
			autoRetry: settingsManager.getRetryEnabled(),
			steeringMode: session.steeringMode,
			followUpMode: session.followUpMode,
			...(options.oneShot
				? {
						background: {
							policy: options.oneShot.backgroundPolicy,
							waitTimeoutMs: options.oneShot.backgroundWaitTimeoutMs,
						},
						nonInteractiveUi: options.oneShot.nonInteractiveUiPolicy,
						validationOnly: options.oneShot.validateOnly,
					}
				: {}),
		},
		diagnostics: (runtime.diagnostics ?? []).map(({ type, message }) => ({ type, message })),
	};
}
