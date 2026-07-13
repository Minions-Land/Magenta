/**
 * CLI argument parsing and help display
 */

import chalk from "chalk";
import { APP_BINARY_NAME, APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import { EXECUTION_PROFILES, type ExecutionProfile, isExecutionProfile } from "../core/execution-profile.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import type { BackgroundPolicy, NonInteractiveUiPolicy } from "../modes/headless-protocol.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ExecutionProfile;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	update?: boolean;
	mode?: Mode;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	harnessWorkflows?: boolean;
	harnessTeammates?: boolean;
	backgroundPolicy?: BackgroundPolicy;
	backgroundWaitTimeoutMs?: number;
	nonInteractiveUiPolicy?: NonInteractiveUiPolicy;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	harnessList?: boolean;
	harnessPackages?: string[];
	harnessPackagesRoot?: string;
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	validateConfig?: boolean;
	offline?: boolean;
	verbose?: boolean;
	projectTrustOverride?: boolean;
	ssh?: string;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

export function isValidThinkingLevel(level: string): level is ExecutionProfile {
	return isExecutionProfile(level);
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--update") {
			result.update = true;
		} else if (arg === "--mode") {
			const mode = args[i + 1];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
				i++;
			} else {
				result.diagnostics.push({
					type: "error",
					message: `--mode requires one of: text, json, rpc${mode !== undefined && !mode.startsWith("-") ? ` (got "${mode}")` : ""}`,
				});
				if (mode !== undefined && !mode.startsWith("-")) i++;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--name" || arg === "-n") {
			if (i + 1 < args.length) {
				result.name = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--name requires a value" });
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--session-id" && i + 1 < args.length) {
			result.sessionId = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if (arg === "--harness-workflows") {
			result.harnessWorkflows = true;
		} else if (arg === "--no-harness-workflows") {
			result.harnessWorkflows = false;
		} else if (arg === "--harness-teammates") {
			result.harnessTeammates = true;
		} else if (arg === "--no-harness-teammates") {
			result.harnessTeammates = false;
		} else if (arg === "--background-policy") {
			const policy = args[++i];
			if (policy === "cancel" || policy === "wait" || policy === "error") {
				result.backgroundPolicy = policy;
			} else {
				result.diagnostics.push({
					type: "error",
					message: "--background-policy requires one of: cancel, wait, error",
				});
			}
		} else if (arg === "--background-wait-timeout") {
			const value = args[++i];
			const seconds = Number(value);
			if (value !== undefined && Number.isFinite(seconds) && seconds >= 0) {
				result.backgroundWaitTimeoutMs = seconds * 1000;
			} else {
				result.diagnostics.push({
					type: "error",
					message: "--background-wait-timeout requires a non-negative number of seconds",
				});
			}
		} else if (arg === "--non-interactive-ui") {
			const policy = args[++i];
			if (policy === "deny" || policy === "error") {
				result.nonInteractiveUiPolicy = policy;
			} else {
				result.diagnostics.push({
					type: "error",
					message: "--non-interactive-ui requires one of: deny, error",
				});
			}
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			result.excludeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${EXECUTION_PROFILES.join(", ")}`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--harness-list") {
			result.harnessList = true;
		} else if (arg === "--harness-package" && i + 1 < args.length) {
			result.harnessPackages = result.harnessPackages ?? [];
			result.harnessPackages.push(args[++i]);
		} else if (arg === "--harness-packages-root" && i + 1 < args.length) {
			result.harnessPackagesRoot = args[++i];
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--validate-config") {
			result.validateConfig = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg === "--ssh") {
			if (i + 1 < args.length) {
				result.ssh = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--ssh requires a value" });
			}
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	const commandName = APP_BINARY_NAME;
	console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with file, shell, and background work tools

${chalk.bold("Usage:")}
  ${commandName} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${commandName} install <source> [-l]     Install extension source and add to settings
  ${commandName} remove <source> [-l]      Remove extension source from settings
  ${commandName} uninstall <source> [-l]   Alias for remove
  ${commandName} update [source|self|${commandName}]   Update ${APP_NAME} (use --all for ${APP_NAME} and extensions)
  ${commandName} list                      List installed extensions from settings
  ${commandName} config                    Open TUI to enable/disable package resources
  ${commandName} <command> --help          Show help for install/remove/uninstall/update/list

${chalk.bold("Options:")}
  --provider <name>              Provider name (default: google)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path|id>            Use specific session file or partial UUID
  --session-id <id>              Use exact project session ID, creating it if missing
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --name, -n <name>              Set session display name
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default
  --no-builtin-tools, -nbt       Disable app/HCP defaults; keep explicit Package, MCP, and extension tools
  --harness-workflows            Enable sub_agent workflow templates independently of thinking level
  --no-harness-workflows         Disable sub_agent workflow templates independently of thinking level
  --harness-teammates            Enable teammate_agent independently of thinking level
  --no-harness-teammates         Disable teammate_agent independently of thinking level
  --background-policy <policy>   Headless leftover work policy: cancel (default), wait, or error
  --background-wait-timeout <s>  Total wait deadline for --background-policy wait (default: 60)
  --non-interactive-ui <policy>  Blocking extension UI policy: deny (default) or error
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to every configured tool source
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names to disable
                                 Applies to every configured tool source
  --thinking <level>             Set execution profile: off, minimal, low, medium, high, xhigh, max, ultra
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --harness-list                 List generated Harness components and Source selections
  --harness-package <selector>   Load local Pkg[:profile] or github:owner/repo/Pkg@version[:profile]
  --harness-packages-root <dir>  Read Harness Packages from this explicit root
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --validate-config              Load and validate headless model/auth/resources without calling the model
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --approve, -a                  Trust project-local files for this run
  --no-approve, -na              Ignore project-local files for this run
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  --ssh <user@host[:path]>       Run read/write/edit/bash against a remote workspace over SSH
  --help, -h                     Show this help
  --version, -v                  Show version number
  --update                       Check and install updates from GitHub Releases

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Examples:")}
  # Interactive mode
  ${commandName}

  # Interactive mode with initial prompt
  ${commandName} "List all .ts files in src/"

  # Include files in initial message
  ${commandName} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${commandName} -p "List all .ts files in src/"

  # Multiple messages (interactive)
  ${commandName} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${commandName} --continue "What did we discuss?"

  # Start a named session
  ${commandName} --name "Refactor auth module"

  # Use different model
  ${commandName} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${commandName} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${commandName} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${commandName} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${commandName} --models "github-copilot/*"

  # Cycle models with fixed thinking levels
  ${commandName} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${commandName} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${commandName} --tools read,grep,find,ls -p "Review the code in src/"

  # Work against a remote checkout over SSH
  ${commandName} --ssh user@host:/remote/project

  # Disable one tool while keeping the rest available
  ${commandName} --exclude-tools ask_question

  # Export a session file to HTML
  ${commandName} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${commandName} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  ANT_LING_API_KEY                 - Ant Ling API key
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  NVIDIA_API_KEY                   - NVIDIA NIM API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  TOGETHER_API_KEY                 - Together AI API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI Coding Plan API key (Global)
  ZAI_CODING_CN_API_KEY            - ZAI Coding Plan API key (China)
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  MAGENTA_HARNESS_PACKAGES       - Comma-separated harness package selectors
  MAGENTA_PEER_MESSAGE_DB        - Override shared peer-message mailbox path
  PI_HARNESS_PACKAGES            - Comma-separated harness package selectors
  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PI_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no
  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)

${chalk.bold("Native Application Tool Names:")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  bg_shell  - Run long-running shell commands in the background
  sub_agent - Run parallel no-TUI agent subtasks
  send_message - Send messages to other agent sessions
  teammate_agent - Manage persistent hidden teammate sessions
  show   - Display local files or remote URLs
  grep   - Search file contents (read-only)
  find   - Find files by glob pattern (read-only)
  ls     - List directory contents (read-only)

Repository HCP, Package, user MCP, and extension tools may add more names.
Use --harness-list to inspect repository HCP components.
`);
}
