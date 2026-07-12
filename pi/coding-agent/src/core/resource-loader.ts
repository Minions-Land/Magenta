import type { FSWatcher } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { loadUserMcpTools } from "./mcp-config-loader.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Skill as HarnessSkill,
	type HcpClient,
	HcpClientbuildsession,
	HcpClientgetharnesspackagesroot,
	HcpClientloadpackageoverlay,
	type HcpClientpackageassemblyprogress,
	type HcpClientpackagediagnostic,
	HcpClientpackageinputfromoverlay,
	type HcpClientpackageoverlay,
	type HcpClientpackageprofileselection,
	type HcpMagnetResource,
	initProcessToolsBinary,
} from "@magenta/harness";
import { closeWatcher, watchWithErrorHandler } from "../utils/fs-watch.ts";
import { HcpClientacquiregithubpackage, HcpClientparsegithubpackageselector } from "../utils/package-acquisition.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import {
	clearExtensionCache,
	createExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensionsCached,
} from "./extensions/loader.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./extensions/types.ts";
import { loadSkills } from "./harness-skills-adapter.ts";
import { DefaultPackageManager, type PathMetadata, type ResolvedResource } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoaderReloadOptions {
	resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
	/** Prepare the candidate Client with host-owned settings before MCP discovery and publication. */
	HcpClientprepare?: (hcp: HcpClient) => void | Promise<void>;
	/**
	 * Optional progress sink for the package-assembly phase. Wired by the session
	 * to a {@link BackgroundEventManager} source so the TUI shows a live bar while
	 * package components (including MCP server spawns) are assembled.
	 */
	onPackageAssemblyProgress?: (progress: HcpClientpackageassemblyprogress) => void;
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	/**
	 * The session HcpClient holding TOML-selected tool magnets, default capability
	 * sources, package overlay tools, and capability overrides. Consumers resolve
	 * capabilities from this HCP instead of statically importing implementations. Returns undefined for loaders
	 * that do not assemble an HCP (null loader, test doubles).
	 */
	HcpClientgetsession?(): HcpClient | undefined;
	/**
	 * Resolve a skill by a `/skill:` handle: bare `name`, or `<source>:<name>` qualified name (which
	 * also reaches collision-shadowed skills excluded from {@link getSkills}). Optional so alternative
	 * loaders need not implement it; callers fall back to a bare-name scan over `getSkills()`.
	 */
	resolveSkill?(handle: string): Skill | undefined;
	/**
	 * Subscribe to skill hot-reload notifications; returns an unsubscribe function. Optional: loaders
	 * without hot-reload support may omit it, and callers should guard the call.
	 */
	onSkillsReloaded?(callback: () => void): () => void;
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getPackageOverlay(): HcpClientpackageoverlay | undefined;
	getPackageTools(): { tools: AgentTool[]; diagnostics: ResourceDiagnostic[] };
	getDefaultToolNames?(): string[];
	getUserMcpTools(): { tools: AgentTool[]; diagnostics: ResourceDiagnostic[] };
	getHarnessPackageSelectors?(): string[];
	setHarnessPackageSelectors?(selectors: string[]): void;
	HcpClientgetharnesspackagesroot?(): string | undefined;
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	extendResources(paths: ResourceExtensionPaths): Promise<void>;
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
	/** Release held resources (e.g. skill watchers and HCP Magnets). Optional and idempotent. */
	dispose?(): void | Promise<void>;
}

type HcpClientsessioncandidate = {
	hcp: HcpClient;
	overlay?: HcpClientpackageoverlay;
	packageToolAddresses: string[];
	defaultToolAddresses: string[];
	packageResources: HcpMagnetResource[];
	packageDiagnostics: ResourceDiagnostic[];
};

type HcpClientmcploadresult = {
	addresses: string[];
	diagnostics: ResourceDiagnostic[];
};

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		if (currentDir === root) break;

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

const BUILTIN_BACKGROUND_WORK_PROMPT = `# Background Work

Treat background shell events and sub-agents as built-in Magenta agent-loop infrastructure.

- Use bg_shell action=start for long-running non-interactive commands such as builds, tests, dev servers, migrations, downloads, or commands expected to take more than about 10 seconds.
- Use the regular bash tool for short one-off shell commands.
- After starting background shell work, either wait/check status before relying on the result, or set returnToMain=true so completed results return to the main agent automatically.
- Use sub_agent for independent parallel analysis, review, research, or planning subtasks; synthesize the results yourself before reporting to the user.
- User-visible event controls live under /events. Do not ask the user to manually manage event ids unless direct intervention is actually required.`;

function parseHarnessPackageEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	const value = env.MAGENTA_HARNESS_PACKAGES ?? env.PI_HARNESS_PACKAGES;
	return value ? normalizeHarnessPackageSelectors(value.split(",")) : [];
}

function normalizeHarnessPackageSelectors(selectors: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const selector of selectors) {
		const trimmed = selector.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}

function packageDiagnosticToResourceDiagnostic(
	diagnostic: Pick<HcpClientpackagediagnostic, "type" | "message" | "path">,
): ResourceDiagnostic {
	return {
		type: diagnostic.type,
		message: diagnostic.message,
		path: diagnostic.path,
	};
}

function packageResourceMetadata(resource: HcpMagnetResource): PathMetadata {
	const metadata = resource.metadata ?? {};
	const packageId = typeof metadata.packageId === "string" ? metadata.packageId : resource.source;
	const profile = typeof metadata.profile === "string" ? metadata.profile : undefined;
	const packageDir = typeof metadata.packageDir === "string" ? metadata.packageDir : resource.contentPath;
	const includeInContext = typeof metadata.includeInContext === "boolean" ? metadata.includeInContext : undefined;
	return {
		source: `harness:${packageId}${profile ? `:${profile}` : ""}`,
		scope: "temporary",
		origin: "package",
		baseDir: packageDir,
		...(includeInContext === undefined ? {} : { includeInContext }),
	};
}

function packagePathResources(resources: readonly HcpMagnetResource[], kind: string): ResolvedResource[] {
	return resources.flatMap((resource) =>
		resource.kind === kind && resource.contentPath
			? [{ path: resource.contentPath, enabled: true, metadata: packageResourceMetadata(resource) }]
			: [],
	);
}

function readResourceContent(
	resource: HcpMagnetResource,
	description: string,
): { content?: string; diagnostic?: ResourceDiagnostic } {
	if (resource.content !== undefined) return { content: resource.content };
	if (!resource.contentPath) {
		return {
			diagnostic: { type: "error", message: `${description} Resource has no content or contentPath` },
		};
	}
	try {
		return { content: readFileSync(resource.contentPath, "utf-8") };
	} catch (error) {
		return {
			diagnostic: {
				type: "error",
				message: `Failed to read ${description} Resource: ${error instanceof Error ? error.message : String(error)}`,
				path: resource.contentPath,
			},
		};
	}
}

/** Debounce window for skill hot-reload: coalesces editor save bursts (temp file + rename) into one reload. */
const SKILL_RELOAD_DEBOUNCE_MS = 150;
/** Event channel emitted after skills are hot-reloaded, so consumers (e.g. interactive mode) can refresh. */
export const SKILLS_RELOADED_EVENT = "skills-reloaded";

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	harnessPackages?: string[];
	/** Root containing Harness Package directories. Default: `<cwd>/packages`. */
	harnessPackagesRoot?: string;
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	includeBundledResources?: boolean;
	/**
	 * Watch skill directories and hot-reload skills mid-session when a `SKILL.md` (or root `.md`)
	 * changes. Off by default: headless/SDK/RPC callers that never re-read `getSkills()` gain nothing
	 * from it, and file watchers carry an OS handle + teardown cost. Interactive mode opts in.
	 */
	watchSkills?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: HarnessSkill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: HarnessSkill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private harnessPackages: string[];
	private harnessPackagesRoot: string;
	private extensionFactories: ExtensionFactory[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private includeBundledResources: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: HarnessSkill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: HarnessSkill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private packageOverlay?: HcpClientpackageoverlay;
	private packageToolAddresses: string[];
	/**
	 * The one session HCP with default sources and any selected package overlays.
	 * Rebuilt whenever package selection reloads.
	 */
	private sessionHcp?: HcpClient;
	private packageDiagnostics: ResourceDiagnostic[];
	/** HCP-selected tools available independently of a package selection. */
	private defaultToolAddresses: string[];
	/**
	 * MCP tools loaded from the user config (`~/.magenta/agent/mcp-servers.json`).
	 * This is the general MCP configuration path; unlike the Harness Package path
	 * it does not require shipping a Package.
	 */
	private userMcpToolAddresses: string[];
	private userMcpDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
	private lastSkillPaths: string[];
	private lastSkillMetadataByPath: Map<string, PathMetadata>;
	/**
	 * Skills that lost a name collision. Kept out of the model-visible {@link getSkills} listing but
	 * resolvable by their `<source>:<name>` qualified name for explicit `/skill:` invocation.
	 */
	private shadowedSkills: Skill[];
	/** Hot-reload state (only populated when `watchSkills` is enabled). */
	private watchSkills: boolean;
	private skillWatchers: Map<string, FSWatcher>;
	private skillReloadTimer: ReturnType<typeof setTimeout> | null;
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];
	private loaded: boolean;
	private reloadTail: Promise<void>;

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.harnessPackages = normalizeHarnessPackageSelectors(options.harnessPackages ?? parseHarnessPackageEnv());
		this.harnessPackagesRoot = resolvePath(
			options.harnessPackagesRoot ?? HcpClientgetharnesspackagesroot(this.cwd),
			this.cwd,
		);
		this.extensionFactories = options.extensionFactories ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.includeBundledResources = options.includeBundledResources ?? true;
		this.watchSkills = options.watchSkills ?? false;
		this.skillWatchers = new Map();
		this.skillReloadTimer = null;
		this.shadowedSkills = [];
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.packageToolAddresses = [];
		this.packageDiagnostics = [];
		this.defaultToolAddresses = [];
		this.userMcpToolAddresses = [];
		this.userMcpDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.lastSkillPaths = [];
		this.lastSkillMetadataByPath = new Map();
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
		this.loaded = false;
		this.reloadTail = Promise.resolve();
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getPackageOverlay(): HcpClientpackageoverlay | undefined {
		return this.packageOverlay;
	}

	getPackageTools(): { tools: AgentTool[]; diagnostics: ResourceDiagnostic[] } {
		const tools = this.sessionHcp
			? this.packageToolAddresses
					.map((address) => this.sessionHcp?.resolveInstance<AgentTool>(address))
					.filter((tool): tool is AgentTool => tool !== undefined)
			: [];
		return { tools, diagnostics: this.packageDiagnostics };
	}

	getDefaultToolNames(): string[] {
		const hcp = this.sessionHcp;
		if (!hcp) return [];
		return [
			...new Set(
				this.defaultToolAddresses
					.map((address) => hcp.resolveInstance<AgentTool>(address)?.name)
					.filter((name): name is string => name !== undefined),
			),
		];
	}

	getUserMcpTools(): { tools: AgentTool[]; diagnostics: ResourceDiagnostic[] } {
		const tools = this.sessionHcp
			? this.userMcpToolAddresses
					.map((address) => this.sessionHcp?.resolveInstance<AgentTool>(address))
					.filter((tool): tool is AgentTool => tool !== undefined)
			: [];
		return { tools, diagnostics: this.userMcpDiagnostics };
	}

	/**
	 * The session HCP: the package overlay HCP with default capability sources
	 * (compaction, ...) layered on. A loop consumer resolves capabilities by name
	 * through this one Client instead of importing a source. Built lazily so it
	 * is available even when no package was selected (default capabilities still
	 * apply).
	 */
	HcpClientgetsession(): HcpClient | undefined {
		return this.sessionHcp;
	}

	getHarnessPackageSelectors(): string[] {
		return [...this.harnessPackages];
	}

	setHarnessPackageSelectors(selectors: string[]): void {
		this.harnessPackages = normalizeHarnessPackageSelectors(selectors);
	}

	HcpClientgetharnesspackagesroot(): string {
		return this.harnessPackagesRoot;
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	async extendResources(paths: ResourceExtensionPaths): Promise<void> {
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
			this.lastSkillMetadataByPath.set(entry.path, entry.metadata);
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			await this.updateSkillsFromPaths(this.lastSkillPaths, this.lastSkillMetadataByPath);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			await this.updatePromptsFromPaths(this.lastPromptPaths);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths);
		}
	}

	async loadProjectTrustExtensions(): Promise<LoadExtensionsResult> {
		// Force untrusted project settings for the bootstrap pass. This keeps project-local
		// extensions/packages out while still loading user/global and temporary CLI extensions.
		this.settingsManager.setProjectTrusted(false);
		await this.settingsManager.reload();
		return this.loadCurrentExtensionSet({ includeInlineFactories: true });
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		const reload = this.reloadTail.then(() => this.HcpClientreloadnow(options));
		this.reloadTail = reload.catch(() => {});
		return reload;
	}

	private async HcpClientreloadnow(options?: ResourceLoaderReloadOptions): Promise<void> {
		if (this.loaded) {
			clearExtensionCache();
		}

		let preTrustExtensions: LoadExtensionsResult | undefined;
		if (options?.resolveProjectTrust) {
			preTrustExtensions = await this.loadProjectTrustExtensions();
			const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
			this.settingsManager.setProjectTrusted(projectTrusted);
		}

		// reload() preserves SettingsManager.projectTrusted and reloads settings for that trust state.
		await this.settingsManager.reload();
		initProcessToolsBinary();
		const resolvedPaths = await this.packageManager.resolve();
		const HcpClientcandidate = await this.HcpClientbuildcandidate(options?.onPackageAssemblyProgress);
		const previousResourceState = {
			extensionsResult: this.extensionsResult,
			skills: this.skills,
			skillDiagnostics: this.skillDiagnostics,
			shadowedSkills: this.shadowedSkills,
			prompts: this.prompts,
			promptDiagnostics: this.promptDiagnostics,
			themes: this.themes,
			themeDiagnostics: this.themeDiagnostics,
			agentsFiles: this.agentsFiles,
			systemPrompt: this.systemPrompt,
			appendSystemPrompt: this.appendSystemPrompt,
			lastSkillPaths: this.lastSkillPaths,
			lastSkillMetadataByPath: this.lastSkillMetadataByPath,
			lastPromptPaths: this.lastPromptPaths,
			lastThemePaths: this.lastThemePaths,
			extensionSkillSourceInfos: this.extensionSkillSourceInfos,
			extensionPromptSourceInfos: this.extensionPromptSourceInfos,
			extensionThemeSourceInfos: this.extensionThemeSourceInfos,
			loaded: this.loaded,
		};
		let HcpClientcandidatepublished = false;
		try {
			const packageResources = HcpClientcandidate.packageResources;
			await options?.HcpClientprepare?.(HcpClientcandidate.hcp);
			const HcpClientmcp = await this.HcpClientloadusermcp(HcpClientcandidate.hcp);
			const packageSystemPrompts = this.resolvePackageSystemPrompts(
				packageResources,
				HcpClientcandidate.packageDiagnostics,
			);
			const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
				temporary: true,
			});
			const metadataByPath = new Map<string, PathMetadata>();

			this.extensionSkillSourceInfos = new Map();
			this.extensionPromptSourceInfos = new Map();
			this.extensionThemeSourceInfos = new Map();

			// Helper to extract enabled paths and store metadata
			const getEnabledResources = (resources: ResolvedResource[]): ResolvedResource[] => {
				for (const r of resources) {
					if (!metadataByPath.has(r.path)) {
						metadataByPath.set(r.path, r.metadata);
					}
				}
				return resources.filter((r) => r.enabled);
			};

			const getEnabledPaths = (resources: ResolvedResource[]): string[] =>
				getEnabledResources(resources).map((r) => r.path);
			const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
			const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
			const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
			const enabledThemes = getEnabledPaths(resolvedPaths.themes);

			const enabledSkills = enabledSkillResources.map((resource) => this.mapSkillPath(resource, metadataByPath));
			const packageSkillResources = packagePathResources(packageResources, "skill");
			const packagePromptResources = packagePathResources(packageResources, "prompt-template");
			const packageThemeResources = packagePathResources(packageResources, "theme");

			// Add CLI paths metadata
			for (const r of cliExtensionPaths.extensions) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
				}
			}
			for (const r of cliExtensionPaths.skills) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
				}
			}
			for (const resource of [...packageSkillResources, ...packagePromptResources, ...packageThemeResources]) {
				if (!metadataByPath.has(resource.path)) {
					metadataByPath.set(resource.path, resource.metadata);
				}
			}

			const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
			const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
			const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
			const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);
			const bundledExtensionResources = this.noExtensions ? [] : this.getBundledExtensionResources();
			const harnessSkillResources = this.noSkills ? [] : this.HcpClientgetskillresources(HcpClientcandidate.hcp);
			for (const r of [...bundledExtensionResources, ...harnessSkillResources]) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, r.metadata);
				}
			}
			const bundledExtensions = bundledExtensionResources.map((r) => r.path);
			const harnessSkills = harnessSkillResources.map((r) => this.mapSkillPath(r, metadataByPath));

			const extensionPaths = this.noExtensions
				? cliEnabledExtensions
				: this.mergePaths([...cliEnabledExtensions, ...bundledExtensions], enabledExtensions);

			const extensionsResult = await this.loadFinalExtensionSet(extensionPaths, preTrustExtensions);
			for (const p of this.additionalExtensionPaths) {
				if (isLocalPath(p)) {
					const resolved = this.resolveResourcePath(p);
					if (!existsSync(resolved)) {
						extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
					}
				}
			}
			this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
			this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

			const skillPaths = this.noSkills
				? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
				: this.mergePaths(
						[
							...cliEnabledSkills,
							...packageSkillResources.map((resource) => this.mapSkillPath(resource, metadataByPath)),
							...harnessSkills,
							...enabledSkills,
						],
						this.additionalSkillPaths,
					);

			this.lastSkillPaths = skillPaths;
			this.lastSkillMetadataByPath = new Map(metadataByPath);
			await this.updateSkillsFromPaths(skillPaths, this.lastSkillMetadataByPath);
			for (const p of this.additionalSkillPaths) {
				if (isLocalPath(p)) {
					const resolved = this.resolveResourcePath(p);
					if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
						this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
					}
				}
			}

			const promptPaths = this.noPromptTemplates
				? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
				: this.mergePaths(
						[...cliEnabledPrompts, ...packagePromptResources.map((resource) => resource.path), ...enabledPrompts],
						this.additionalPromptTemplatePaths,
					);

			this.lastPromptPaths = promptPaths;
			await this.updatePromptsFromPaths(promptPaths, metadataByPath);
			for (const p of this.additionalPromptTemplatePaths) {
				if (isLocalPath(p)) {
					const resolved = this.resolveResourcePath(p);
					if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
						this.promptDiagnostics.push({
							type: "error",
							message: "Prompt template path does not exist",
							path: resolved,
						});
					}
				}
			}

			const themePaths = this.noThemes
				? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
				: this.mergePaths(
						[...cliEnabledThemes, ...packageThemeResources.map((resource) => resource.path), ...enabledThemes],
						this.additionalThemePaths,
					);

			this.lastThemePaths = themePaths;
			this.updateThemesFromPaths(themePaths, metadataByPath);
			for (const p of this.additionalThemePaths) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
					this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
				}
			}

			const agentsFiles = {
				agentsFiles: this.noContextFiles
					? []
					: loadProjectContextFiles({
							cwd: this.cwd,
							agentDir: this.agentDir,
						}),
			};
			const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
			this.agentsFiles = resolvedAgentsFiles.agentsFiles;

			const packageSystemPrompt = packageSystemPrompts.systemPrompts.at(-1);
			const baseSystemPrompt =
				this.systemPromptSource !== undefined
					? resolvePromptInput(this.systemPromptSource, "system prompt")
					: (packageSystemPrompt ?? resolvePromptInput(this.discoverSystemPromptFile(), "system prompt"));
			this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

			const discoveredAppendSystemPrompt = this.discoverAppendSystemPromptFile();
			const baseAppend = this.appendSystemPromptSource
				? this.appendSystemPromptSource
						.map((source) => resolvePromptInput(source, "append system prompt"))
						.filter((source): source is string => source !== undefined)
				: [
						...(discoveredAppendSystemPrompt
							? [resolvePromptInput(discoveredAppendSystemPrompt, "append system prompt")]
							: []),
						...packageSystemPrompts.appendSystemPrompts,
					].filter((source): source is string => source !== undefined);
			if (this.includeBundledResources) {
				baseAppend.unshift(BUILTIN_BACKGROUND_WORK_PROMPT);
			}
			this.appendSystemPrompt = this.appendSystemPromptOverride
				? this.appendSystemPromptOverride(baseAppend)
				: baseAppend;

			const previousSessionHcp = this.sessionHcp;
			this.sessionHcp = HcpClientcandidate.hcp;
			this.packageOverlay = HcpClientcandidate.overlay;
			this.packageToolAddresses = HcpClientcandidate.packageToolAddresses;
			this.defaultToolAddresses = HcpClientcandidate.defaultToolAddresses;
			this.packageDiagnostics = HcpClientcandidate.packageDiagnostics;
			this.userMcpToolAddresses = HcpClientmcp.addresses;
			this.userMcpDiagnostics = HcpClientmcp.diagnostics;
			this.loaded = true;
			HcpClientcandidatepublished = true;
			await previousSessionHcp?.dispose();
		} finally {
			if (!HcpClientcandidatepublished) {
				this.extensionsResult = previousResourceState.extensionsResult;
				this.skills = previousResourceState.skills;
				this.skillDiagnostics = previousResourceState.skillDiagnostics;
				this.shadowedSkills = previousResourceState.shadowedSkills;
				this.prompts = previousResourceState.prompts;
				this.promptDiagnostics = previousResourceState.promptDiagnostics;
				this.themes = previousResourceState.themes;
				this.themeDiagnostics = previousResourceState.themeDiagnostics;
				this.agentsFiles = previousResourceState.agentsFiles;
				this.systemPrompt = previousResourceState.systemPrompt;
				this.appendSystemPrompt = previousResourceState.appendSystemPrompt;
				this.lastSkillPaths = previousResourceState.lastSkillPaths;
				this.lastSkillMetadataByPath = previousResourceState.lastSkillMetadataByPath;
				this.lastPromptPaths = previousResourceState.lastPromptPaths;
				this.lastThemePaths = previousResourceState.lastThemePaths;
				this.extensionSkillSourceInfos = previousResourceState.extensionSkillSourceInfos;
				this.extensionPromptSourceInfos = previousResourceState.extensionPromptSourceInfos;
				this.extensionThemeSourceInfos = previousResourceState.extensionThemeSourceInfos;
				this.loaded = previousResourceState.loaded;
				if (this.watchSkills) this.syncSkillWatchers();
				await HcpClientcandidate.hcp.dispose();
			}
		}
	}

	private async loadCurrentExtensionSet(options: { includeInlineFactories: boolean }): Promise<LoadExtensionsResult> {
		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});
		const enabledExtensions = resolvedPaths.extensions.filter((r) => r.enabled).map((r) => r.path);
		const cliEnabledExtensions = cliExtensionPaths.extensions.filter((r) => r.enabled).map((r) => r.path);
		const bundledExtensions = this.noExtensions ? [] : this.getBundledExtensionResources().map((r) => r.path);
		const extensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths([...cliEnabledExtensions, ...bundledExtensions], enabledExtensions);
		const extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);
		if (!options.includeInlineFactories) {
			return extensionsResult;
		}

		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);
		return extensionsResult;
	}

	private resolveExtensionLoadPath(path: string): string {
		return resolvePath(path, this.cwd, { normalizeUnicodeSpaces: true });
	}

	private async loadFinalExtensionSet(
		extensionPaths: string[],
		preTrustExtensions: LoadExtensionsResult | undefined,
	): Promise<LoadExtensionsResult> {
		if (!preTrustExtensions) {
			const extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);
			const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
			extensionsResult.extensions.push(...inlineExtensions.extensions);
			extensionsResult.errors.push(...inlineExtensions.errors);
			this.addExtensionConflictDiagnostics(extensionsResult);
			return extensionsResult;
		}

		const preloadedByPath = new Map(
			preTrustExtensions.extensions
				.filter((extension) => !extension.path.startsWith("<inline:"))
				.map((extension) => [extension.resolvedPath, extension]),
		);
		const failedPreloadPaths = new Set(
			preTrustExtensions.errors.map((error) => this.resolveExtensionLoadPath(error.path)),
		);
		const remainingPaths = extensionPaths.filter((path) => {
			const resolvedPath = this.resolveExtensionLoadPath(path);
			return !preloadedByPath.has(resolvedPath) && !failedPreloadPaths.has(resolvedPath);
		});
		const remainingExtensions = await loadExtensionsCached(
			remainingPaths,
			this.cwd,
			this.eventBus,
			preTrustExtensions.runtime,
		);
		const loadedByPath = new Map(preloadedByPath);
		for (const extension of remainingExtensions.extensions) {
			loadedByPath.set(extension.resolvedPath, extension);
		}

		const inlineExtensions = preTrustExtensions.extensions.filter((extension) =>
			extension.path.startsWith("<inline:"),
		);
		const orderedExtensions = extensionPaths
			.map((path) => loadedByPath.get(this.resolveExtensionLoadPath(path)))
			.filter((extension): extension is Extension => extension !== undefined);
		orderedExtensions.push(...inlineExtensions);

		const extensionsResult: LoadExtensionsResult = {
			extensions: orderedExtensions,
			errors: [...preTrustExtensions.errors, ...remainingExtensions.errors],
			runtime: preTrustExtensions.runtime,
		};
		this.addExtensionConflictDiagnostics(extensionsResult);
		return extensionsResult;
	}

	private addExtensionConflictDiagnostics(extensionsResult: LoadExtensionsResult): void {
		// Detect extension conflicts (tools, commands, flags with same names from different extensions)
		// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}
	}

	private getBundledExtensionResources(): ResolvedResource[] {
		return [];
	}

	private HcpClientgetskillresources(hcp: HcpClient): ResolvedResource[] {
		if (!this.includeBundledResources) {
			return [];
		}

		return hcp
			.addresses()
			.filter((address) => address.startsWith("skill:"))
			.flatMap((address): ResolvedResource[] => {
				const resource = hcp.resolveInstance<HcpMagnetResource>(address);
				if (
					resource?.kind !== "skill" ||
					resource.metadata?.origin === "package" ||
					!resource.contentPath ||
					!existsSync(resource.contentPath)
				) {
					return [];
				}
				const path = statSync(resource.contentPath).isDirectory()
					? resource.contentPath
					: dirname(resource.contentPath);
				return [
					{
						path,
						enabled: true,
						metadata: {
							source: "harness",
							scope: "temporary",
							origin: "top-level",
							baseDir: resolve(path, "../.."),
						},
					},
				];
			})
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	private async HcpClientloadusermcp(hcp: HcpClient): Promise<HcpClientmcploadresult> {
		try {
			const result = await loadUserMcpTools({ hcp, cwd: this.cwd, agentDir: this.agentDir });
			return { addresses: result.addresses, diagnostics: result.diagnostics };
		} catch (error) {
			return {
				addresses: [],
				diagnostics: [
					{
						type: "error",
						message: `Failed to load user MCP servers: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			};
		}
	}

	/**
	 * Resolve raw harness-package selectors into overlay selections. Plain
	 * selectors (`Pkg` or `Pkg:profile`) pass through as strings and resolve
	 * under the packages root. `github:owner/repo/Pkg@ver` selectors are
	 * acquired from GitHub releases into the local cache, then handed to the
	 * overlay loader as explicit package roots.
	 */
	private async HcpClientresolvepackageselections(
		rawSelectors: readonly string[],
		packageDiagnostics: ResourceDiagnostic[],
	): Promise<Array<string | HcpClientpackageprofileselection>> {
		const selections: Array<string | HcpClientpackageprofileselection> = [];
		for (const raw of rawSelectors) {
			const github = HcpClientparsegithubpackageselector(raw);
			if (!github) {
				if (raw.startsWith("github:")) {
					packageDiagnostics.push({
						type: "error",
						message: `Invalid GitHub package selector: ${raw}`,
					});
					continue;
				}
				// Local selector: resolve under the packages root as before.
				selections.push(raw);
				continue;
			}
			const result = await HcpClientacquiregithubpackage(github);
			for (const diagnostic of result.diagnostics) {
				if (diagnostic.type === "error") {
					packageDiagnostics.push({ type: "error", message: diagnostic.message });
				} else if (diagnostic.type === "warning") {
					packageDiagnostics.push({ type: "warning", message: diagnostic.message });
				}
			}
			if (result.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
				// Acquisition failed; skip this package rather than loading a broken cache.
				continue;
			}
			selections.push({
				packageId: github.package,
				packageRoot: result.packageRoot,
				...(github.profiles?.length ? { profiles: github.profiles } : {}),
			});
		}
		return selections;
	}

	private async HcpClientbuildcandidate(
		onAssemblyProgress?: (progress: HcpClientpackageassemblyprogress) => void,
	): Promise<HcpClientsessioncandidate> {
		const packageDiagnostics: ResourceDiagnostic[] = [];
		let candidateHcp: HcpClient | undefined;
		try {
			const selections =
				this.harnessPackages.length === 0
					? []
					: await this.HcpClientresolvepackageselections(this.harnessPackages, packageDiagnostics);
			const overlay =
				selections.length === 0
					? undefined
					: await HcpClientloadpackageoverlay({
							repoRoot: this.cwd,
							packagesRoot: this.harnessPackagesRoot,
							selections,
						});
			const packageInput = overlay
				? await HcpClientpackageinputfromoverlay(overlay)
				: { components: [], diagnostics: [], toolDiagnostics: [] };
			packageDiagnostics.push(...packageInput.diagnostics.map(packageDiagnosticToResourceDiagnostic));
			if (overlay) {
				for (const [index, component] of overlay.components.entries()) {
					onAssemblyProgress?.({ phase: "start", index, total: overlay.components.length, component });
				}
			}

			const sessionAssembly = await HcpClientbuildsession({
				repoRoot: this.cwd,
				components: packageInput.components,
			});
			candidateHcp = sessionAssembly.hcp;
			packageDiagnostics.push(...packageInput.toolDiagnostics.map(packageDiagnosticToResourceDiagnostic));
			packageDiagnostics.push(...sessionAssembly.diagnostics.map(packageDiagnosticToResourceDiagnostic));
			const packageComponents = new Set(packageInput.components);
			const packageToolAddresses = sessionAssembly.builtComponents
				.filter(({ component }) => packageComponents.has(component) && component.product === "tool")
				.flatMap(({ addresses }) => addresses)
				.filter((address) => address.startsWith("tool:"));
			const packageResourceAddresses = sessionAssembly.builtComponents
				.filter(({ component }) => packageComponents.has(component) && component.product === "resource")
				.flatMap(({ addresses }) => addresses);
			if (overlay) {
				for (const [index, component] of overlay.components.entries()) {
					onAssemblyProgress?.({ phase: "assembled", index, total: overlay.components.length, component });
				}
			}
			const uniquePackageToolAddresses = [...new Set(packageToolAddresses)];
			const packageAddresses = new Set(uniquePackageToolAddresses);
			const packageResources = [...new Set(packageResourceAddresses)]
				.map((address) => sessionAssembly.hcp.resolveInstance<HcpMagnetResource>(address))
				.filter((resource): resource is HcpMagnetResource => resource !== undefined);
			candidateHcp = undefined;
			return {
				hcp: sessionAssembly.hcp,
				overlay,
				packageToolAddresses: uniquePackageToolAddresses,
				defaultToolAddresses: sessionAssembly.toolAddresses.filter((address) => !packageAddresses.has(address)),
				packageResources,
				packageDiagnostics,
			};
		} catch (error) {
			await candidateHcp?.dispose();
			packageDiagnostics.push({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
			const fallback = await HcpClientbuildsession({
				repoRoot: this.cwd,
			});
			packageDiagnostics.push(...fallback.diagnostics.map(packageDiagnosticToResourceDiagnostic));
			return {
				hcp: fallback.hcp,
				packageToolAddresses: [],
				defaultToolAddresses: fallback.toolAddresses,
				packageResources: [],
				packageDiagnostics,
			};
		}
	}

	private resolvePackageSystemPrompts(
		packageResources: HcpMagnetResource[],
		diagnostics: ResourceDiagnostic[],
	): {
		systemPrompts: string[];
		appendSystemPrompts: string[];
	} {
		const systemPrompts: string[] = [];
		const appendSystemPrompts: string[] = [];
		for (const resource of packageResources) {
			if (resource.kind !== "system-prompt") continue;
			const resolved = readResourceContent(resource, `${resource.name} system prompt`);
			if (resolved.diagnostic) diagnostics.push(resolved.diagnostic);
			if (resolved.content === undefined) continue;
			if (resource.mergeMode === "append") appendSystemPrompts.push(resolved.content);
			else systemPrompts.push(resolved.content);
		}
		return { systemPrompts, appendSystemPrompts };
	}

	private mapSkillPath(resource: ResolvedResource, metadataByPath: Map<string, PathMetadata>): string {
		if (
			resource.metadata.source !== "auto" &&
			resource.metadata.source !== "bundled" &&
			resource.metadata.source !== "harness" &&
			resource.metadata.origin !== "package"
		) {
			return resource.path;
		}
		try {
			const stats = statSync(resource.path);
			if (!stats.isDirectory()) {
				return resource.path;
			}
		} catch {
			return resource.path;
		}
		const skillFile = join(resource.path, "SKILL.md");
		if (existsSync(skillFile)) {
			if (!metadataByPath.has(skillFile)) {
				metadataByPath.set(skillFile, resource.metadata);
			}
			return skillFile;
		}
		return resource.path;
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? { ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	private async updateSkillsFromPaths(
		skillPaths: string[],
		metadataByPath?: Map<string, PathMetadata>,
	): Promise<void> {
		let skillsResult: { skills: HarnessSkill[]; shadowed: HarnessSkill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], shadowed: [], diagnostics: [] };
		} else {
			skillsResult = await loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		// skillsOverride only sees the model-visible set; shadowed collision-losers bypass it.
		const shadowed = skillsResult.shadowed;
		const resolvedSkills = this.skillsOverride
			? this.skillsOverride({ skills: skillsResult.skills, diagnostics: skillsResult.diagnostics })
			: skillsResult;
		this.skills = resolvedSkills.skills.map((skill) => this.enrichSkill(skill, metadataByPath, false));
		this.shadowedSkills = shadowed.map((skill) => this.enrichSkill(skill, metadataByPath, true));
		this.skillDiagnostics = resolvedSkills.diagnostics;
		if (this.watchSkills) this.syncSkillWatchers();
	}

	/** Attach pi-specific fields (baseDir, sourceInfo, qualifiedName) to a harness-loaded skill. */
	private enrichSkill(
		skill: HarnessSkill,
		metadataByPath: Map<string, PathMetadata> | undefined,
		shadowed: boolean,
	): Skill {
		const baseDir = skill.filePath.split("/").slice(0, -1).join("/") || "/";
		// Preserve a sourceInfo the skill already carries (e.g. injected by skillsOverride) before
		// falling back to extension/default resolution, which may stat the filePath.
		const existingSourceInfo = (skill as Partial<Skill>).sourceInfo;
		const sourceInfo =
			this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
			existingSourceInfo ??
			this.getDefaultSourceInfoForPath(skill.filePath);
		const qualifiedName = `${sourceInfo.source}:${skill.name}`;
		const metadata = this.findPathMetadata(skill.filePath, metadataByPath);
		return {
			...skill,
			baseDir,
			sourceInfo,
			qualifiedName,
			disableModelInvocation: skill.disableModelInvocation || metadata?.includeInContext === false,
			...(shadowed ? { shadowed: true } : {}),
		} as Skill;
	}

	/**
	 * Resolve a skill by the handle the user typed after `/skill:`. Tries, in order: exact bare-name
	 * match among visible skills, exact `<source>:<name>` qualified-name match among visible skills,
	 * then qualified-name match among shadowed collision-losers. Returns undefined if nothing matches.
	 */
	resolveSkill(handle: string): Skill | undefined {
		return (
			this.skills.find((s) => s.name === handle) ??
			this.skills.find((s) => s.qualifiedName === handle) ??
			this.shadowedSkills.find((s) => s.qualifiedName === handle)
		);
	}

	/**
	 * Subscribe to skill hot-reload notifications. The callback fires after a watched skill directory
	 * change is debounced and skills are re-read. Returns an unsubscribe function. No-op unless
	 * `watchSkills` is enabled (the event simply never fires otherwise).
	 */
	onSkillsReloaded(callback: () => void): () => void {
		return this.eventBus.on(SKILLS_RELOADED_EVENT, () => callback());
	}

	/**
	 * (Re)establish filesystem watchers over the directories that currently contribute skills.
	 *
	 * We watch the immediate parent directory of every loaded skill file (rather than the file
	 * itself — editors frequently replace a file via rename, which invalidates a per-file watch) plus
	 * any configured skill-path directories. Watchers are keyed by directory so re-syncing after a
	 * reload only opens/closes the delta.
	 */
	private syncSkillWatchers(): void {
		const wanted = new Set<string>();
		for (const skill of this.skills) wanted.add(dirname(skill.filePath));
		for (const dir of this.lastSkillPaths.map((p) => (p.endsWith(".md") ? dirname(p) : p))) wanted.add(dir);

		// Close watchers for directories that no longer contribute skills.
		for (const [dir, watcher] of this.skillWatchers) {
			if (!wanted.has(dir)) {
				closeWatcher(watcher);
				this.skillWatchers.delete(dir);
			}
		}
		// Open watchers for newly-contributing directories.
		for (const dir of wanted) {
			if (this.skillWatchers.has(dir) || !existsSync(dir)) continue;
			const watcher = watchWithErrorHandler(
				dir,
				(_event, filename) => {
					// Only react to markdown changes; ignore editor scratch files and unrelated churn.
					if (filename && !filename.endsWith(".md")) return;
					this.scheduleSkillReload();
				},
				() => {
					// On watcher error, drop it; the next reload() re-syncs watchers.
					const w = this.skillWatchers.get(dir);
					closeWatcher(w);
					this.skillWatchers.delete(dir);
				},
			);
			if (watcher) this.skillWatchers.set(dir, watcher);
		}
	}

	/** Debounced skill-only reload triggered by a watched-directory change. */
	private scheduleSkillReload(): void {
		if (this.skillReloadTimer) clearTimeout(this.skillReloadTimer);
		this.skillReloadTimer = setTimeout(() => {
			this.skillReloadTimer = null;
			void this.reloadSkillsFromWatch();
		}, SKILL_RELOAD_DEBOUNCE_MS);
	}

	/** Reload skills from the last-known paths and notify consumers. Errors are swallowed (best-effort). */
	private async reloadSkillsFromWatch(): Promise<void> {
		try {
			await this.updateSkillsFromPaths(this.lastSkillPaths, this.lastSkillMetadataByPath);
			this.eventBus.emit(SKILLS_RELOADED_EVENT, { skills: this.skills, diagnostics: this.skillDiagnostics });
		} catch {
			// Best-effort hot-reload: a transient read error should not crash the session.
		}
	}

	/** Stop all skill watchers and cancel any pending reload. Idempotent. */
	async dispose(): Promise<void> {
		await this.reloadTail;
		if (this.skillReloadTimer) {
			clearTimeout(this.skillReloadTimer);
			this.skillReloadTimer = null;
		}
		for (const watcher of this.skillWatchers.values()) closeWatcher(watcher);
		this.skillWatchers.clear();
		this.userMcpToolAddresses = [];
		const sessionHcp = this.sessionHcp;
		this.sessionHcp = undefined;
		await sessionHcp?.dispose();
	}

	private async updatePromptsFromPaths(
		promptPaths: string[],
		metadataByPath?: Map<string, PathMetadata>,
	): Promise<void> {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const allPrompts = await loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			const loaded = this.loadThemes(themePaths, false);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		for (const extension of extensions) {
			extension.sourceInfo =
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				this.getDefaultSourceInfoForPath(extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) {
			return undefined;
		}

		if (resourcePath.startsWith("<")) {
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);
		if (extraSourceInfos) {
			for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		const metadata = this.findPathMetadata(resourcePath, metadataByPath);
		if (metadata) return createSourceInfo(resourcePath, metadata);

		return undefined;
	}

	private findPathMetadata(
		resourcePath: string,
		metadataByPath?: Map<string, PathMetadata>,
	): PathMetadata | undefined {
		if (!resourcePath || resourcePath.startsWith("<") || !metadataByPath) return undefined;
		const normalizedResourcePath = resolve(resourcePath);
		const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
		if (exact) return exact;
		for (const [sourcePath, metadata] of metadataByPath.entries()) {
			const normalizedSourcePath = resolve(sourcePath);
			if (
				normalizedResourcePath === normalizedSourcePath ||
				normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
			) {
				return metadata;
			}
		}
		return undefined;
	}

	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		if (filePath.startsWith("<") && filePath.endsWith(">")) {
			return {
				path: filePath,
				source: filePath.slice(1, -1).split(":")[0] || "temporary",
				scope: "temporary",
				origin: "top-level",
			};
		}

		const normalizedPath = resolve(filePath);
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
		};
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		return resolvePath(p, this.cwd, { trim: true });
	}

	private loadThemes(
		paths: string[],
		includeDefaults: boolean = true,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics);
			}
		}

		for (const p of paths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	private loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		try {
			themes.push(loadThemeFromPath(filePath));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, factory] of this.extensionFactories.entries()) {
			const extensionPath = `<inline:${index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const t of themes) {
			const name = t.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: t.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, t);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private isUnderPath(target: string, root: string): boolean {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}

	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

		// Track which extension registered each tool and flag
		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		for (const ext of extensions) {
			// Check tools
			for (const toolName of ext.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, ext.path);
				}
			}

			// Check flags
			for (const flagName of ext.flags.keys()) {
				const existingOwner = flagOwners.get(flagName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					flagOwners.set(flagName, ext.path);
				}
			}
		}

		return conflicts;
	}
}
