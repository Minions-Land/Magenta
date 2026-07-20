import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import {
	assertQuotaBudget,
	buildCalibrationTurn,
	compareClientSummaries,
	consumeLogKeys,
	deterministicOrder,
	fingerprint,
	parseTokfanConsumeLogs,
	redactSecrets,
	selectNewConsumeLogs,
	summarizeClientTurns,
	type CalibrationClientName,
	type CalibrationClientSummary,
	type CalibrationTurn,
	type TokfanConsumeLog,
} from "./tokfan-billing-core.ts";

const DEFAULT_BASE_URL = "https://tok.fan";
const LIVE_CONFIRMATION = "I_UNDERSTAND_THIS_SPENDS_REAL_BALANCE";
const DEFAULT_TURNS = 4;
const DEFAULT_MAX_REQUESTS_PER_TURN = 4;
const DEFAULT_LOG_TIMEOUT_MS = 45_000;
const DEFAULT_LOG_POLL_MS = 800;
const DEFAULT_LOG_END_TOLERANCE_MS = 10_000;
const CALIBRATION_PROMPTS = [
	"For this billing calibration, reply with exactly OK. Do not call tools.",
	"For this billing calibration, reply with exactly OK. Do not call tools.",
	"For this billing calibration, reply with exactly OK. Do not call tools.",
	"For this billing calibration, reply with exactly OK. Do not call tools.",
	"For this billing calibration, reply with exactly OK. Do not call tools.",
	"For this billing calibration, reply with exactly OK. Do not call tools.",
];

type Profile = "core" | "minimal";

export interface CalibrationConfig {
	baseUrl: string;
	apiKey: string | undefined;
	userAccessToken: string | undefined;
	userId: string | undefined;
	tokenName: string | undefined;
	models: string[];
	turns: number;
	cohorts: number;
	seed: string;
	profile: Profile;
	maxQuota: number | undefined;
	maxMagentaWarmRatio: number | undefined;
	maxRequestsPerTurn: number;
	logTimeoutMs: number;
	logPollMs: number;
	logEndToleranceMs: number;
	claudeBin: string;
	magentaCli: string;
	live: boolean;
	outputPath: string | undefined;
}

interface StatusInfo {
	version?: string;
	quotaPerUnit?: number;
	batchUpdate?: boolean;
}

export interface TokenUsageInfo {
	tokenName: string;
	totalAvailable: number;
	totalUsed: number;
	unlimitedQuota: boolean;
}

interface SafeReport {
	schemaVersion: 1;
	createdAt: string;
	baseHost: string;
	ledgerMode: "token" | "user";
	status: StatusInfo;
	profile: Profile;
	orderSeedFingerprint: string;
	models: string[];
	turns: number;
	cohorts: number;
	maxQuota?: number;
	budget: {
		enforcement: "finite-token-quota";
		initialAvailable: number;
	};
	runs: CalibrationTurn[];
	summaries: CalibrationClientSummary[];
	comparisons: ReturnType<typeof compareClientSummaries>[];
	validity: {
		requestCountExceeded: boolean;
		modelMismatch: boolean;
		emptyCacheUsage: boolean;
	};
	acceptance?: {
		maxMagentaToClaudeWarmQuotaRatio: number;
		passed: boolean;
	};
}

function usageNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function assertFiniteTokenBudget(usage: TokenUsageInfo, maxQuota: number): void {
	if (usage.unlimitedQuota) throw new Error("live calibration requires a finite-quota dedicated tok.fan token");
	if (usage.totalAvailable > maxQuota) {
		throw new Error(
			`dedicated token has ${usage.totalAvailable} quota available, above TOKFAN_MAX_QUOTA=${maxQuota}; lower the token quota before running`,
		);
	}
	if (usage.totalAvailable <= 0) throw new Error("dedicated tok.fan token has no quota available");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parsePositiveInt(value: string | undefined, name: string, fallback?: number): number {
	if (value === undefined || value === "") {
		if (fallback !== undefined) return fallback;
		throw new Error(`${name} is required`);
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function parseArgs(argv: string[]): CalibrationConfig {
	let live = false;
	let model: string | undefined;
	let models: string[] | undefined;
	let turns: number | undefined;
	let cohorts: number | undefined;
	let seed = process.env.TOKFAN_CALIBRATION_SEED || randomUUID();
	let profile: Profile = "core";
	let maxQuota: number | undefined;
	let maxMagentaWarmRatio: number | undefined;
	let maxRequestsPerTurn: number | undefined;
	let outputPath: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--live") live = true;
		else if (arg === "--model") model = argv[++index];
		else if (arg === "--models") models = argv[++index]?.split(",").map((value) => value.trim()).filter(Boolean);
		else if (arg === "--turns") turns = parsePositiveInt(argv[++index], "--turns");
		else if (arg === "--cohorts") cohorts = parsePositiveInt(argv[++index], "--cohorts");
		else if (arg === "--seed") seed = argv[++index] ?? seed;
		else if (arg === "--profile") {
			const value = argv[++index];
			if (value !== "core" && value !== "minimal") throw new Error("--profile must be core or minimal");
			profile = value;
		} else if (arg === "--max-quota") {
			const value = Number(argv[++index]);
			if (!Number.isFinite(value) || value <= 0) throw new Error("--max-quota must be positive");
			maxQuota = value;
		} else if (arg === "--max-magenta-warm-ratio") {
			const value = Number(argv[++index]);
			if (!Number.isFinite(value) || value <= 0) throw new Error("--max-magenta-warm-ratio must be positive");
			maxMagentaWarmRatio = value;
		} else if (arg === "--max-requests-per-turn") {
			maxRequestsPerTurn = parsePositiveInt(argv[++index], "--max-requests-per-turn");
		} else if (arg === "--output") outputPath = argv[++index];
		else if (arg === "--dry-run") live = false;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else throw new Error(`unknown argument: ${arg}`);
	}

	const configuredModels = models ?? (model ? [model] : process.env.TOKFAN_CALIBRATION_MODELS?.split(",").filter(Boolean));
	const resolvedModels = configuredModels?.length ? configuredModels : ["claude-sonnet-5"];
	for (const modelId of resolvedModels) {
		if (!/^claude-(?:sonnet|haiku)/iu.test(modelId)) {
			throw new Error(`model must be a Claude Sonnet or Haiku alias: ${modelId}`);
		}
	}

	const resolvedTurns = turns ?? parsePositiveInt(process.env.TOKFAN_CALIBRATION_TURNS, "TOKFAN_CALIBRATION_TURNS", DEFAULT_TURNS);
	if (resolvedTurns < 2 || resolvedTurns > CALIBRATION_PROMPTS.length) throw new Error(`turns must be between 2 and ${CALIBRATION_PROMPTS.length}`);
	const resolvedCohorts = cohorts ?? parsePositiveInt(process.env.TOKFAN_CALIBRATION_COHORTS, "TOKFAN_CALIBRATION_COHORTS", 1);
	if (resolvedCohorts > 8) throw new Error("cohorts must be <= 8");

	const envMaxQuota = usageNumber(process.env.TOKFAN_MAX_QUOTA);
	const resolvedMaxQuota = maxQuota ?? envMaxQuota;
	const envMaxRatio = usageNumber(process.env.TOKFAN_MAX_MAGENTA_WARM_RATIO);
	const resolvedMaxRatio = maxMagentaWarmRatio ?? envMaxRatio;
	if (live && (!resolvedMaxQuota || resolvedMaxQuota <= 0)) {
		throw new Error("live mode requires --max-quota or TOKFAN_MAX_QUOTA in raw tok.fan quota units");
	}

	return {
		baseUrl: (process.env.TOKFAN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/u, ""),
		apiKey: process.env.TOKFAN_API_KEY,
		userAccessToken: process.env.TOKFAN_USER_ACCESS_TOKEN,
		userId: process.env.TOKFAN_USER_ID,
		tokenName: process.env.TOKFAN_TOKEN_NAME,
		models: resolvedModels,
		turns: resolvedTurns,
		cohorts: resolvedCohorts,
		seed,
		profile,
		maxQuota: resolvedMaxQuota,
		maxMagentaWarmRatio: resolvedMaxRatio,
		maxRequestsPerTurn:
			maxRequestsPerTurn ??
			parsePositiveInt(
				process.env.TOKFAN_MAX_REQUESTS_PER_TURN,
				"TOKFAN_MAX_REQUESTS_PER_TURN",
				DEFAULT_MAX_REQUESTS_PER_TURN,
			),
		logTimeoutMs: parsePositiveInt(process.env.TOKFAN_LOG_TIMEOUT_MS, "TOKFAN_LOG_TIMEOUT_MS", DEFAULT_LOG_TIMEOUT_MS),
		logPollMs: parsePositiveInt(process.env.TOKFAN_LOG_POLL_MS, "TOKFAN_LOG_POLL_MS", DEFAULT_LOG_POLL_MS),
		logEndToleranceMs: parsePositiveInt(
			process.env.TOKFAN_LOG_END_TOLERANCE_MS,
			"TOKFAN_LOG_END_TOLERANCE_MS",
			DEFAULT_LOG_END_TOLERANCE_MS,
		),
		claudeBin: process.env.CLAUDE_CODE_BIN || "claude",
		magentaCli: resolve(process.env.MAGENTA_CLI_PATH || join(repoRoot(), "dist", "cli.js")),
		live,
		outputPath,
	};
}

function repoRoot(): string {
	return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

function printHelp(): void {
	console.log(`Tok.fan real billing calibration (dry-run by default)

Usage:
  npx tsx pi/coding-agent/scripts/tokfan-billing-calibration.ts --dry-run
  npx tsx pi/coding-agent/scripts/tokfan-billing-calibration.ts --live --model claude-sonnet-5 --max-quota 100000

Required live environment:
  TOKFAN_API_KEY              Dedicated API token used by both clients
  TOKFAN_TOKEN_NAME           Token name, used to detect cross-request contamination
  TOKFAN_MAX_QUOTA            Hard limit in raw tok.fan quota units
  TOKFAN_BILLING_CONFIRM      Must equal ${LIVE_CONFIRMATION}

Optional user-log fallback:
  TOKFAN_USER_ACCESS_TOKEN    User access token (never printed or persisted)
  TOKFAN_USER_ID              Matching New-Api user id

Options:
  --model <id>                One Sonnet/Haiku model (default claude-sonnet-5)
  --models <a,b>              Run multiple models sequentially
  --turns <n>                 Cold turn plus warm turns (default 4, max 6)
  --cohorts <n>               Independent paired cohorts (default 1)
  --profile <core|minimal>    Core tools or no-tools transport control (default core)
  --max-quota <n>             Hard raw quota budget
  --max-magenta-warm-ratio <n>  Optional regression threshold against Claude Code
  --output <path>             Write the redacted JSON report with mode 0600
`);
}

function apiUrl(baseUrl: string, path: string): string {
	return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function headerSafeError(status: number, body: string, secrets: Array<string | undefined>): Error {
	const compact = redactSecrets(body.replace(/\s+/gu, " ").slice(0, 400), secrets);
	return new Error(`tok.fan HTTP ${status}: ${compact || "empty response"}`);
}

class TokfanLedger {
	private mode: "token" | "user" | undefined;
	private readonly secrets: Array<string | undefined>;
	private readonly config: CalibrationConfig;

	constructor(config: CalibrationConfig) {
		this.config = config;
		this.secrets = [config.apiKey, config.userAccessToken];
	}

	async status(): Promise<StatusInfo> {
		const response = await fetch(apiUrl(this.config.baseUrl, "/api/status"), { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return {};
		const body = (await response.json()) as unknown;
		const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
		const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
		return {
			version: typeof data.version === "string" ? data.version : undefined,
			quotaPerUnit: usageNumber(data.quota_per_unit),
			batchUpdate: typeof data.enable_batch_update === "boolean" ? data.enable_batch_update : undefined,
		};
	}

	async tokenUsage(): Promise<TokenUsageInfo> {
		if (!this.config.apiKey) throw new Error("TOKFAN_API_KEY is required for token usage mode");
		const payload = await this.get("/api/usage/token", { Authorization: `Bearer ${this.config.apiKey}` });
		const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
		const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : undefined;
		const tokenName = typeof data?.name === "string" ? data.name : "";
		const totalAvailable = usageNumber(data?.total_available);
		const totalUsed = usageNumber(data?.total_used);
		const unlimitedQuota = data?.unlimited_quota;
		if (
			!tokenName ||
			totalAvailable === undefined ||
			totalAvailable < 0 ||
			totalUsed === undefined ||
			totalUsed < 0 ||
			typeof unlimitedQuota !== "boolean"
		) {
			throw new Error("tok.fan token usage response is missing finite quota fields");
		}
		if (tokenName !== this.config.tokenName) {
			throw new Error("tok.fan token usage returned a different token name; refusing ambiguous budget");
		}
		return { tokenName, totalAvailable, totalUsed, unlimitedQuota };
	}

	private async get(path: string, headers: Record<string, string>): Promise<unknown> {
		const response = await fetch(apiUrl(this.config.baseUrl, path), {
			headers: { accept: "application/json", ...headers },
			signal: AbortSignal.timeout(15_000),
		});
		const text = await response.text();
		if (!response.ok) throw headerSafeError(response.status, text, this.secrets);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new Error("tok.fan returned a non-JSON log response");
		}
	}

	private async readTokenLogs(): Promise<TokfanConsumeLog[]> {
		if (!this.config.apiKey) throw new Error("TOKFAN_API_KEY is required for token log mode");
		const payload = await this.get("/api/log/token", { Authorization: `Bearer ${this.config.apiKey}` });
		const logs = parseTokfanConsumeLogs(payload);
		this.validateTokenAttribution(logs);
		return logs;
	}

	private validateTokenAttribution(logs: TokfanConsumeLog[]): void {
		if (!this.config.tokenName) throw new Error("TOKFAN_TOKEN_NAME is required for consume-log attribution");
		if (logs.some((log) => log.tokenName !== this.config.tokenName)) {
			throw new Error("tok.fan consume log token_name is missing or different; refusing ambiguous attribution");
		}
	}

	private async readUserLogs(): Promise<TokfanConsumeLog[]> {
		if (!this.config.userAccessToken || !this.config.userId) {
			throw new Error("user log mode requires TOKFAN_USER_ACCESS_TOKEN and TOKFAN_USER_ID");
		}
		const params = new URLSearchParams({ p: "1", page_size: "100", type: "2" });
		if (this.config.tokenName) params.set("token_name", this.config.tokenName);
		const payload = await this.get(`/api/log/self?${params.toString()}`, {
			Authorization: `Bearer ${this.config.userAccessToken}`,
			"New-Api-User": this.config.userId,
		});
		const logs = parseTokfanConsumeLogs(payload);
		this.validateTokenAttribution(logs);
		return logs;
	}

	async discover(): Promise<"token" | "user"> {
		if (this.mode) return this.mode;
		if (this.config.apiKey) {
			try {
				await this.readTokenLogs();
				this.mode = "token";
				return this.mode;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/HTTP (?:401|403|404)|success=false|token.*invalid/iu.test(message)) throw error;
			}
		}
		if (this.config.userAccessToken && this.config.userId) {
			await this.readUserLogs();
			this.mode = "user";
			return this.mode;
		}
		throw new Error("no usable tok.fan consume-log endpoint; token mode failed and user fallback is not configured");
	}

	async logs(): Promise<TokfanConsumeLog[]> {
		const mode = await this.discover();
		return mode === "token" ? this.readTokenLogs() : this.readUserLogs();
	}

	async waitForNewLogs(before: Set<string>, startedAt: Date, endedAt: Date): Promise<TokfanConsumeLog[]> {
		const deadline = Date.now() + this.config.logTimeoutMs;
		const lowerBound = startedAt.getTime() - 2_000;
		const upperBound = endedAt.getTime() + this.config.logEndToleranceMs;
		let previousSignature = "";
		let stablePolls = 0;
		while (Date.now() < deadline) {
			const logs = await this.logs();
			const candidates = selectNewConsumeLogs(before, logs);
			const lateLogs = candidates.filter((log) => {
				const timestampMs = log.createdAt > 1_000_000_000_000 ? log.createdAt : log.createdAt * 1000;
				return timestampMs > upperBound;
			});
			if (lateLogs.length > 0) {
				throw new Error("tok.fan consume log appeared after the turn attribution window; refusing ambiguous charge");
			}
			const newLogs = candidates.filter((log) => {
				const timestampMs = log.createdAt > 1_000_000_000_000 ? log.createdAt : log.createdAt * 1000;
				return timestampMs >= lowerBound && timestampMs <= upperBound;
			});
			const signature = newLogs
				.map((log) =>
					JSON.stringify({
						key: log.key,
						quota: log.quota,
						usage: log.usage,
						model: log.model,
						upstreamModel: log.upstreamModel,
						channel: log.channel,
					}),
				)
				.join("|");
			if (newLogs.length > 0 && signature === previousSignature) stablePolls++;
			else stablePolls = 0;
			previousSignature = signature;
			if (newLogs.length > 0 && stablePolls >= 2) return newLogs;
			await sleep(this.config.logPollMs);
		}
		throw new Error(`timed out waiting for tok.fan consume log after ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`);
	}
}

function runProcess(options: {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	secrets: Array<string | undefined>;
	timeoutMs?: number;
}): Promise<string> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
		}, options.timeoutMs ?? 180_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = `${stdout}${chunk.toString()}`.slice(-1_000_000);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-100_000);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			rejectPromise(new Error(redactSecrets(error.message, options.secrets)));
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise(stdout);
			else {
				const detail = redactSecrets(`${stderr}\n${stdout}`, options.secrets).replace(/\s+/gu, " ").trim().slice(0, 800);
				rejectPromise(new Error(`child ${options.command} exited ${code ?? `by ${signal}`}: ${detail}`));
			}
		});
	});
}

const SAFE_CHILD_ENV_KEYS = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"SHELL",
	"USER",
	"LOGNAME",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

function safeBaseChildEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of SAFE_CHILD_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function childEnv(config: CalibrationConfig, extra: Record<string, string>): NodeJS.ProcessEnv {
	return {
		...safeBaseChildEnv(),
		ANTHROPIC_API_KEY: config.apiKey,
		ANTHROPIC_OAUTH_TOKEN: "",
		ANTHROPIC_BASE_URL: config.baseUrl,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		...extra,
	};
}

interface CalibrationRunner {
	runTurn(turn: number): Promise<void>;
	close(): Promise<void>;
}

async function createClaudeCodeRunner(config: CalibrationConfig, model: string, root: string): Promise<CalibrationRunner> {
	const sessionId = randomUUID();
	let nextTurn = 0;
	return {
		async runTurn(turn: number): Promise<void> {
			if (turn !== nextTurn + 1) throw new Error(`Claude Code turns must be sequential (expected ${nextTurn + 1}, got ${turn})`);
			nextTurn = turn;
			const args = [
				"--print",
				"--output-format",
				"json",
				"--model",
				model,
				"--effort",
				"low",
				"--max-turns",
				"1",
				"--permission-mode",
				"dontAsk",
				"--disable-slash-commands",
				"--prompt-suggestions",
				"false",
			];
			if (config.profile === "minimal") args.push("--bare", "--tools", "");
			else args.push("--safe-mode", "--tools", "default");
			if (turn === 1) args.push("--session-id", sessionId);
			else args.push("--resume", sessionId);
			args.push(CALIBRATION_PROMPTS[turn - 1]!);
			await runProcess({
				command: config.claudeBin,
				args,
				cwd: root,
				env: childEnv(config, { CLAUDE_CONFIG_DIR: join(root, "claude-config") }),
				secrets: [config.apiKey, config.userAccessToken],
			});
		},
		async close(): Promise<void> {},
	};
}

async function createMagentaRunner(config: CalibrationConfig, model: string, root: string): Promise<CalibrationRunner> {
	const agentDir = join(root, "magenta-agent");
	const sessionDir = join(root, "magenta-sessions");
	const peerDir = join(root, "magenta-peer");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	mkdirSync(peerDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { anthropic: { baseUrl: config.baseUrl, api: "anthropic-messages", apiKey: "$ANTHROPIC_API_KEY" } } }),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "anthropic", defaultModel: model, defaultThinkingLevel: "low" }),
		{ mode: 0o600 },
	);

	const client = new RpcClient({
		cliPath: config.magentaCli,
		cwd: root,
		provider: "anthropic",
		model,
		inheritEnv: false,
		forwardStderr: false,
		env: {
			...safeBaseChildEnv(),
			MAGENTA_CODING_AGENT_DIR: agentDir,
			MAGENTA_CODING_AGENT_SESSION_DIR: sessionDir,
			MAGENTA_PEER_MESSAGE_DB: join(peerDir, "messages.db"),
			ANTHROPIC_API_KEY: config.apiKey ?? "",
			ANTHROPIC_BASE_URL: config.baseUrl,
			ANTHROPIC_OAUTH_TOKEN: "",
			PI_CACHE_TELEMETRY: "0",
		},
		args: [
			"--thinking",
			"low",
			"--no-context-files",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			...(config.profile === "minimal" ? ["--no-tools"] : []),
		],
		readyTimeoutMs: 30_000,
	});
	try {
		await client.start();
	} catch (error) {
		await client.stop().catch(() => undefined);
		throw error;
	}
	let nextTurn = 0;
	return {
		async runTurn(turn: number): Promise<void> {
			if (turn !== nextTurn + 1) throw new Error(`Magenta turns must be sequential (expected ${nextTurn + 1}, got ${turn})`);
			nextTurn = turn;
			await client.promptAndWait(CALIBRATION_PROMPTS[turn - 1]!, undefined, 180_000);
		},
		async close(): Promise<void> {
			await client.stop();
		},
	};
}

export function hasPairedModelMismatch(turns: CalibrationTurn[]): boolean {
	const pairs = new Map<string, Map<CalibrationClientName, { observed: Set<string>; upstream: Set<string> }>>();
	for (const turn of turns) {
		const key = `${turn.model}:${turn.cohort}`;
		const clients = pairs.get(key) ?? new Map();
		const models = clients.get(turn.client) ?? { observed: new Set<string>(), upstream: new Set<string>() };
		for (const model of turn.observedModels) models.observed.add(model);
		for (const model of turn.upstreamModels) models.upstream.add(model);
		clients.set(turn.client, models);
		pairs.set(key, clients);
	}
	for (const [key, clients] of pairs.entries()) {
		const requestedModel = key.split(":", 1)[0];
		const claude = clients.get("claude-code");
		const magenta = clients.get("magenta");
		if (!claude || !magenta) return true;
		if ([...claude.observed, ...claude.upstream, ...magenta.observed, ...magenta.upstream].some((model) => model !== requestedModel)) return true;
		if (JSON.stringify([...claude.observed].sort()) !== JSON.stringify([...magenta.observed].sort())) return true;
		if (JSON.stringify([...claude.upstream].sort()) !== JSON.stringify([...magenta.upstream].sort())) return true;
	}
	return false;
}

function createSafeReport(
	config: CalibrationConfig,
	ledgerMode: "token" | "user",
	status: StatusInfo,
	initialTokenAvailable: number,
	turns: CalibrationTurn[],
	summaries: CalibrationClientSummary[],
	comparisons: ReturnType<typeof compareClientSummaries>[],
): SafeReport {
	const requestCountExceeded = turns.some((turn) => turn.requestCount > config.maxRequestsPerTurn);
	const modelMismatch = hasPairedModelMismatch(turns);
	const emptyCacheUsage = turns.every((turn) => turn.cacheableReuseRate === null);
	const acceptance =
		config.maxMagentaWarmRatio === undefined
			? undefined
			: {
					maxMagentaToClaudeWarmQuotaRatio: config.maxMagentaWarmRatio,
					passed:
						!requestCountExceeded &&
						!modelMismatch &&
						!emptyCacheUsage &&
						comparisons.every(
							(comparison) =>
								comparison.magentaToClaudeWarmQuotaRatio !== null &&
								comparison.magentaToClaudeWarmQuotaRatio <= config.maxMagentaWarmRatio!,
						),
				};
	return {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		baseHost: new URL(config.baseUrl).host,
		ledgerMode,
		status,
		profile: config.profile,
		orderSeedFingerprint: fingerprint(config.seed),
		models: config.models,
		turns: config.turns,
		cohorts: config.cohorts,
		...(config.maxQuota !== undefined ? { maxQuota: config.maxQuota } : {}),
		budget: { enforcement: "finite-token-quota", initialAvailable: initialTokenAvailable },
		runs: turns,
		summaries,
		comparisons,
		validity: { requestCountExceeded, modelMismatch, emptyCacheUsage },
		...(acceptance ? { acceptance } : {}),
	};
}

async function runLive(config: CalibrationConfig): Promise<void> {
	if (process.env.TOKFAN_BILLING_CONFIRM !== LIVE_CONFIRMATION) {
		throw new Error(`live mode requires TOKFAN_BILLING_CONFIRM=${LIVE_CONFIRMATION}`);
	}
	if (!config.apiKey) throw new Error("live mode requires TOKFAN_API_KEY");
	if (!config.tokenName) throw new Error("live mode requires TOKFAN_TOKEN_NAME for contamination detection");
	if (!config.maxQuota) throw new Error("live mode requires a positive quota budget");

	const ledger = new TokfanLedger(config);
	const status = await ledger.status();
	const ledgerMode = await ledger.discover();
	const initialTokenUsage = await ledger.tokenUsage();
	assertFiniteTokenBudget(initialTokenUsage, config.maxQuota);
	const allTurns: CalibrationTurn[] = [];
	let consumedQuota = 0;

	for (const model of config.models) {
		for (let cohort = 1; cohort <= config.cohorts; cohort++) {
			for (const clientName of deterministicOrder(`${config.seed}:${model}`, cohort)) {
				const root = mkdtempSync(join(process.env.TMPDIR || "/tmp", `tokfan-billing-${clientName}-`), { encoding: "utf8" });
				let runner: CalibrationRunner | undefined;
				try {
					const beforeLogs = await ledger.logs();
					const beforeKeys = consumeLogKeys(beforeLogs);
					runner =
						clientName === "claude-code"
							? await createClaudeCodeRunner(config, model, root)
							: await createMagentaRunner(config, model, root);
					for (let turn = 1; turn <= config.turns; turn++) {
						const availableBeforeTurn = await ledger.tokenUsage();
						assertFiniteTokenBudget(availableBeforeTurn, config.maxQuota);
						const providerEnforcedSpend = initialTokenUsage.totalAvailable - availableBeforeTurn.totalAvailable;
						assertQuotaBudget(providerEnforcedSpend, config.maxQuota);
						const startedAt = new Date();
						await runner.runTurn(turn);
						const endedAt = new Date();
						const logs = await ledger.waitForNewLogs(beforeKeys, startedAt, endedAt);
						if (logs.length > config.maxRequestsPerTurn) {
							throw new Error(
								`${clientName} ${model} turn ${turn} generated ${logs.length} requests; maximum is ${config.maxRequestsPerTurn}`,
							);
						}
						const turnResult = buildCalibrationTurn({ client: clientName, model, cohort, turn, startedAt, endedAt, logs });
						allTurns.push(turnResult);
						consumedQuota += turnResult.chargedQuota;
						assertQuotaBudget(consumedQuota, config.maxQuota);
						for (const log of logs) beforeKeys.add(log.key);
					}
				} finally {
					await runner?.close();
					rmSync(root, { recursive: true, force: true });
				}
			}
		}
	}

	const summaries = config.models.flatMap((model) =>
		Array.from({ length: config.cohorts }, (_, index) => index + 1).flatMap((cohort) =>
			(["claude-code", "magenta"] as const).map((client) => {
				const clientTurns = allTurns.filter((turn) => turn.model === model && turn.cohort === cohort && turn.client === client);
				return summarizeClientTurns(clientTurns);
			}),
		),
	);
	const comparisons = config.models.flatMap((model) =>
		Array.from({ length: config.cohorts }, (_, index) => index + 1).map((cohort) => {
			const magenta = summaries.find((summary) => summary.model === model && summary.cohort === cohort && summary.client === "magenta");
			const claudeCode = summaries.find((summary) => summary.model === model && summary.cohort === cohort && summary.client === "claude-code");
			if (!magenta || !claudeCode) throw new Error(`missing paired summary for ${model} cohort ${cohort}`);
			return compareClientSummaries(magenta, claudeCode);
		}),
	);
	const report = createSafeReport(
		config,
		ledgerMode,
		status,
		initialTokenUsage.totalAvailable,
		allTurns,
		summaries,
		comparisons,
	);
	const output = JSON.stringify(report, null, 2);
	console.log(output);
	if (config.outputPath) {
		writeFileSync(config.outputPath, `${output}\n`, { mode: 0o600 });
		chmodSync(config.outputPath, 0o600);
	}
	if (report.acceptance && !report.acceptance.passed) {
		throw new Error(
			`Magenta warm quota exceeded the configured Claude Code ratio ${report.acceptance.maxMagentaToClaudeWarmQuotaRatio}`,
		);
	}
}

function dryRun(config: CalibrationConfig): void {
	console.log(
		JSON.stringify(
			{
				mode: "dry-run",
				baseHost: new URL(config.baseUrl).host,
				models: config.models,
				turns: config.turns,
				cohorts: config.cohorts,
				profile: config.profile,
				orderSeedFingerprint: fingerprint(config.seed),
				maxQuota: config.maxQuota ?? null,
				maxMagentaWarmRatio: config.maxMagentaWarmRatio ?? null,
				claudeBin: config.claudeBin,
				magentaCli: config.magentaCli,
				liveRequires: [
					"TOKFAN_API_KEY",
					"TOKFAN_TOKEN_NAME",
					"TOKFAN_MAX_QUOTA",
					"finite dedicated token with remaining quota <= TOKFAN_MAX_QUOTA",
					`TOKFAN_BILLING_CONFIRM=${LIVE_CONFIRMATION}`,
				],
			},
			null,
			2,
		),
	);
}

async function main(): Promise<void> {
	const config = parseArgs(process.argv.slice(2));
	if (!config.live) {
		dryRun(config);
		return;
	}
	await runLive(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(redactSecrets(message, [process.env.TOKFAN_API_KEY, process.env.TOKFAN_USER_ACCESS_TOKEN]));
		process.exitCode = 1;
	});
}

export { TokfanLedger, parseArgs, runLive };
