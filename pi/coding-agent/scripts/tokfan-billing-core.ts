import { createHash } from "node:crypto";

export type CalibrationClientName = "claude-code" | "magenta";

export interface TokfanUsageBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TokfanConsumeLog {
	key: string;
	logId?: string;
	requestId?: string;
	upstreamRequestId?: string;
	createdAt: number;
	type: number;
	quota: number;
	model: string;
	upstreamModel?: string;
	channel?: number;
	tokenName?: string;
	usage: TokfanUsageBreakdown;
	usageSemantic?: string;
	requestPath?: string;
}

export interface CalibrationTurn {
	client: CalibrationClientName;
	model: string;
	cohort: number;
	turn: number;
	phase: "cold" | "warm";
	startedAt: string;
	endedAt: string;
	elapsedMs: number;
	chargedQuota: number;
	requestCount: number;
	requestFingerprints: string[];
	channels: number[];
	observedModels: string[];
	upstreamModels: string[];
	usage: TokfanUsageBreakdown;
	cacheableReuseRate: number | null;
}

export interface CalibrationClientSummary {
	client: CalibrationClientName;
	model: string;
	cohort: number;
	totalQuota: number;
	coldQuota: number;
	warmQuotaMedian: number;
	warmToColdRatio: number | null;
	warmCacheableReuseMedian: number | null;
	requestCount: number;
}

export interface CalibrationComparison {
	model: string;
	cohort: number;
	magentaWarmQuota: number;
	claudeCodeWarmQuota: number;
	magentaToClaudeWarmQuotaRatio: number | null;
	magentaWarmCacheableReuse: number | null;
	claudeCodeWarmCacheableReuse: number | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function nonNegative(value: unknown): number {
	return Math.max(0, finiteNumber(value) ?? 0);
}

function optionalInteger(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	return parsed === undefined ? undefined : Math.trunc(parsed);
}

function parseOther(value: unknown): JsonRecord {
	if (typeof value === "string") {
		try {
			return asRecord(JSON.parse(value)) ?? {};
		} catch {
			return {};
		}
	}
	return asRecord(value) ?? {};
}

function firstNumber(record: JsonRecord, keys: string[]): number {
	for (const key of keys) {
		const value = finiteNumber(record[key]);
		if (value !== undefined) return Math.max(0, value);
	}
	return 0;
}

function extractCacheWrite(other: JsonRecord): number {
	const normalized = finiteNumber(other.cache_write_tokens);
	if (normalized !== undefined) return Math.max(0, normalized);

	const fiveMinute = nonNegative(other.cache_creation_tokens_5m);
	const oneHour = nonNegative(other.cache_creation_tokens_1h);
	if (fiveMinute > 0 || oneHour > 0) return fiveMinute + oneHour;
	return nonNegative(other.cache_creation_tokens);
}

function extractRawLogs(payload: unknown): unknown[] {
	const root = asRecord(payload);
	if (!root) throw new Error("tok.fan log response is not a JSON object");
	if (root.success === false) throw new Error("tok.fan log endpoint returned success=false");

	const data = root.data;
	if (Array.isArray(data)) return data;
	const page = asRecord(data);
	if (page && Array.isArray(page.items)) return page.items;
	throw new Error("tok.fan log response has neither data[] nor data.items[]");
}

function fallbackLogKey(raw: JsonRecord, other: JsonRecord): string {
	return [
		raw.created_at,
		raw.model_name,
		raw.quota,
		raw.prompt_tokens,
		raw.completion_tokens,
		raw.channel,
		raw.use_time,
		other.frt,
	].join(":");
}

/** Parse both GET /api/log/token and GET /api/log/self response shapes. */
export function parseTokfanConsumeLogs(payload: unknown): TokfanConsumeLog[] {
	return extractRawLogs(payload).flatMap((entry): TokfanConsumeLog[] => {
		const raw = asRecord(entry);
		if (!raw) return [];
		const other = parseOther(raw.other);
		const logId =
			typeof raw.id === "string" && raw.id
				? raw.id
				: typeof raw.id === "number" && Number.isSafeInteger(raw.id)
					? String(raw.id)
					: undefined;
		const requestId = typeof raw.request_id === "string" && raw.request_id ? raw.request_id : undefined;
		const upstreamRequestId =
			typeof raw.upstream_request_id === "string" && raw.upstream_request_id ? raw.upstream_request_id : undefined;
		const upstreamModel =
			typeof other.upstream_model_name === "string" && other.upstream_model_name
				? other.upstream_model_name
				: undefined;
		const usageSemantic =
			typeof other.usage_semantic === "string" && other.usage_semantic ? other.usage_semantic : undefined;
		const requestPath = typeof other.request_path === "string" && other.request_path ? other.request_path : undefined;

		return [
			{
				key: logId ? `log:${logId}` : (requestId ?? upstreamRequestId ?? fallbackLogKey(raw, other)),
				logId,
				requestId,
				upstreamRequestId,
				createdAt: Math.trunc(nonNegative(raw.created_at)),
				type: Math.trunc(nonNegative(raw.type)),
				quota: nonNegative(raw.quota),
				model: typeof raw.model_name === "string" ? raw.model_name : "",
				upstreamModel,
				channel: optionalInteger(raw.channel),
				tokenName: typeof raw.token_name === "string" ? raw.token_name : undefined,
				usage: {
					input: nonNegative(raw.prompt_tokens),
					output: nonNegative(raw.completion_tokens),
					cacheRead: firstNumber(other, ["cache_tokens", "cached_tokens", "cache_read_input_tokens"]),
					cacheWrite: extractCacheWrite(other),
				},
				usageSemantic,
				requestPath,
			},
		];
	});
}

export function consumeLogKeys(logs: TokfanConsumeLog[]): Set<string> {
	return new Set(logs.filter((log) => log.type === 2).map((log) => log.key));
}

export function selectNewConsumeLogs(before: Set<string>, logs: TokfanConsumeLog[]): TokfanConsumeLog[] {
	return logs
		.filter((log) => log.type === 2 && !before.has(log.key))
		.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
}

export function sumUsage(logs: TokfanConsumeLog[]): TokfanUsageBreakdown {
	return logs.reduce<TokfanUsageBreakdown>(
		(total, log) => ({
			input: total.input + log.usage.input,
			output: total.output + log.usage.output,
			cacheRead: total.cacheRead + log.usage.cacheRead,
			cacheWrite: total.cacheWrite + log.usage.cacheWrite,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	);
}

export function cacheableReuseRate(usage: TokfanUsageBreakdown): number | null {
	const cacheable = usage.cacheRead + usage.cacheWrite;
	return cacheable > 0 ? usage.cacheRead / cacheable : null;
}

export function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildCalibrationTurn(options: {
	client: CalibrationClientName;
	model: string;
	cohort: number;
	turn: number;
	startedAt: Date;
	endedAt: Date;
	logs: TokfanConsumeLog[];
}): CalibrationTurn {
	if (options.logs.length === 0) throw new Error("no tok.fan consume log was correlated to the turn");
	const usage = sumUsage(options.logs);
	return {
		client: options.client,
		model: options.model,
		cohort: options.cohort,
		turn: options.turn,
		phase: options.turn === 1 ? "cold" : "warm",
		startedAt: options.startedAt.toISOString(),
		endedAt: options.endedAt.toISOString(),
		elapsedMs: Math.max(0, options.endedAt.getTime() - options.startedAt.getTime()),
		chargedQuota: options.logs.reduce((sum, log) => sum + log.quota, 0),
		requestCount: options.logs.length,
		requestFingerprints: options.logs.map((log) => fingerprint(log.key)),
		channels: Array.from(
			new Set(options.logs.map((log) => log.channel).filter((channel): channel is number => channel !== undefined)),
		).sort((a, b) => a - b),
		observedModels: Array.from(new Set(options.logs.map((log) => log.model).filter(Boolean))).sort(),
		upstreamModels: Array.from(
			new Set(options.logs.map((log) => log.upstreamModel).filter((model): model is string => !!model)),
		).sort(),
		usage,
		cacheableReuseRate: cacheableReuseRate(usage),
	};
}

export function median(values: number[]): number {
	if (values.length === 0) throw new Error("median requires at least one value");
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function summarizeClientTurns(turns: CalibrationTurn[]): CalibrationClientSummary {
	if (turns.length < 2) throw new Error("a calibration client needs one cold and at least one warm turn");
	const ordered = [...turns].sort((a, b) => a.turn - b.turn);
	const cold = ordered.find((turn) => turn.phase === "cold");
	const warm = ordered.filter((turn) => turn.phase === "warm");
	if (!cold || warm.length === 0) throw new Error("calibration turns are missing cold or warm samples");
	const reuseValues = warm
		.map((turn) => turn.cacheableReuseRate)
		.filter((value): value is number => value !== null);
	const warmQuotaMedian = median(warm.map((turn) => turn.chargedQuota));
	return {
		client: ordered[0]!.client,
		model: ordered[0]!.model,
		cohort: ordered[0]!.cohort,
		totalQuota: ordered.reduce((sum, turn) => sum + turn.chargedQuota, 0),
		coldQuota: cold.chargedQuota,
		warmQuotaMedian,
		warmToColdRatio: cold.chargedQuota > 0 ? warmQuotaMedian / cold.chargedQuota : null,
		warmCacheableReuseMedian: reuseValues.length > 0 ? median(reuseValues) : null,
		requestCount: ordered.reduce((sum, turn) => sum + turn.requestCount, 0),
	};
}

export function compareClientSummaries(
	magenta: CalibrationClientSummary,
	claudeCode: CalibrationClientSummary,
): CalibrationComparison {
	if (magenta.model !== claudeCode.model || magenta.cohort !== claudeCode.cohort) {
		throw new Error("client summaries must use the same model and cohort");
	}
	return {
		model: magenta.model,
		cohort: magenta.cohort,
		magentaWarmQuota: magenta.warmQuotaMedian,
		claudeCodeWarmQuota: claudeCode.warmQuotaMedian,
		magentaToClaudeWarmQuotaRatio:
			claudeCode.warmQuotaMedian > 0 ? magenta.warmQuotaMedian / claudeCode.warmQuotaMedian : null,
		magentaWarmCacheableReuse: magenta.warmCacheableReuseMedian,
		claudeCodeWarmCacheableReuse: claudeCode.warmCacheableReuseMedian,
	};
}

export function assertQuotaBudget(consumedQuota: number, maximumQuota: number): void {
	if (!Number.isFinite(maximumQuota) || maximumQuota <= 0) throw new Error("maximum quota must be a positive number");
	if (consumedQuota > maximumQuota) {
		throw new Error(`tok.fan quota budget exceeded: consumed ${consumedQuota}, maximum ${maximumQuota}`);
	}
}

export function deterministicOrder(seed: string, cohort: number): CalibrationClientName[] {
	const value = createHash("sha256").update(`${seed}:${cohort}`).digest()[0] ?? 0;
	return value % 2 === 0 ? ["claude-code", "magenta"] : ["magenta", "claude-code"];
}

export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
	let redacted = text;
	for (const secret of secrets) {
		if (secret) redacted = redacted.split(secret).join("[REDACTED]");
	}
	return redacted
		.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, "Bearer [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, "sk-[REDACTED]");
}
