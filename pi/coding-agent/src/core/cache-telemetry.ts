import { createHmac, randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const TELEMETRY_VERSION = 2;
const MAX_BREAKPOINTS_RECORDED = 16;
const MAX_PREVIOUS_REQUESTS = 64;
const CACHE_ELIGIBILITY_MIN_TOKENS = 1024;
export const CACHE_TELEMETRY_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const CACHE_TELEMETRY_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const CACHE_TELEMETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TELEMETRY_ARCHIVE_PATTERN = /^events\.(\d+)\.\d+\.[a-f0-9]+\.jsonl$/;
const CACHE_TELEMETRY_ACTIVE_PATTERN = /^events\.active\.(\d+)\.(\d+)\.[a-f0-9]+\.jsonl$/;
const CACHE_TELEMETRY_LEGACY_LOG = "events.jsonl";
const LIVE_CACHE_TELEMETRY_LOGS = new Set<string>();
const VOLATILE_CONFIG_FIELDS = new Set(["diagnostics", "previous_response_id"]);
const SAFE_BREAKPOINT_PATH_KEYS = new Set([
	"system",
	"tools",
	"messages",
	"input",
	"content",
	"output",
	"cache_control",
	"prompt_cache_breakpoint",
	"prompt_cache_options",
]);
const SAFE_CACHE_TTLS = new Set(["5m", "30m", "1h", "24h"]);
const SAFE_CACHE_MODES = new Set(["ephemeral", "implicit", "explicit"]);
const ANTHROPIC_CACHE_MISS_REASONS = new Set([
	"messages_changed",
	"model_changed",
	"previous_message_not_found",
	"system_changed",
	"tools_changed",
	"unavailable",
]);

export type CacheEligibility = "eligible" | "ineligible" | "unknown";
export type CacheOutcome = "hit" | "write" | "hit_write" | "miss" | "ineligible" | "unknown";
export type CachePayloadObservation = "wire" | "provider_payload" | "logical_fallback";

export interface CacheBreakpointFingerprint {
	kind: "cache_control" | "prompt_cache_breakpoint" | "prompt_cache_options";
	path: string;
	ttl?: string;
	mode?: string;
}

export interface CacheSegmentFingerprint {
	hash: string;
	bytes: number;
	items: number;
}

export interface ProviderPayloadFingerprint {
	payloadHash: string;
	promptBytes: number;
	configHash?: string;
	cacheKeyHash?: string;
	cacheConfigured: boolean;
	continuation: boolean;
	breakpoints: CacheBreakpointFingerprint[];
	segments: {
		system?: CacheSegmentFingerprint;
		tools?: CacheSegmentFingerprint;
		messages?: CacheSegmentFingerprint;
	};
}

export interface CacheEpochDiff {
	previousObserved: boolean;
	epochReason:
		| "first_observed"
		| "unclassified_payload"
		| "model_changed"
		| "config_changed"
		| "system_changed"
		| "tools_changed"
		| "messages_rewritten"
		| "continuation"
		| "append_only"
		| "unchanged";
	appendOnly?: boolean;
	commonMessagePrefixItems?: number;
	previousMessageItems?: number;
	changed?: {
		model: boolean;
		config: boolean;
		system: boolean;
		tools: boolean;
		messages: boolean;
	};
}

export interface CacheRequestRecord {
	type: "cache_request";
	v: typeof TELEMETRY_VERSION;
	requestId: string;
	attempt: number;
	observation: CachePayloadObservation;
	timestamp: number;
	sessionHash?: string;
	provider: string;
	api: Api;
	model: string;
	fingerprint: ProviderPayloadFingerprint;
	epoch: CacheEpochDiff;
}

export interface CacheResultRecord {
	type: "cache_result";
	v: typeof TELEMETRY_VERSION;
	requestId: string;
	attempts: number;
	observation: CachePayloadObservation;
	timestamp: number;
	provider: string;
	api: Api;
	model: string;
	stopReason: AssistantMessage["stopReason"];
	diagnostics?: Array<{
		type: "anthropic_cache_miss";
		reason: string;
		cacheMissedInputTokens?: number;
	}>;
	timing: {
		payloadReadyMs?: number;
		responseHeadersMs?: number;
		firstSemanticEventMs?: number;
		totalMs: number;
	};
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: Usage["cost"];
	};
	metrics: {
		promptTokens: number;
		requestHit: boolean;
		tokenHitRate: number;
		writeShare: number;
		writeAmplification: number | null;
		eligibility: CacheEligibility;
		cacheOutcome: CacheOutcome;
		priorObserved: boolean;
		cacheReuseExpected: boolean;
		eligibleMiss: boolean;
	};
}

type JsonRecord = Record<string, unknown>;

type InternalPayloadFingerprint = {
	public: ProviderPayloadFingerprint;
	configHash?: string;
	cachePolicyHash: string;
	continuation: boolean;
	systemHash?: string;
	toolsHash?: string;
	messageItemHashes: string[];
	segmentsClassified: boolean;
};

type PreviousRequestFingerprint = InternalPayloadFingerprint & {
	model: string;
	cacheNamespace: string;
};

type RecordedRequest = {
	fingerprint: ProviderPayloadFingerprint;
	epoch: CacheEpochDiff;
};

export type CacheTelemetryRetentionOptions = {
	maxFileBytes?: number;
	maxTotalBytes?: number;
	maxAgeMs?: number;
	now?: () => number;
};

type CacheTelemetryLogFile = {
	path: string;
	size: number;
	startedAt: number;
	protected: boolean;
};

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function retentionLimit(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
	return Math.floor(value);
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPassiveDataTree(value: unknown, ancestors = new WeakSet<object>()): boolean {
	if (typeof value !== "object" || value === null) return true;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (descriptor.get || descriptor.set || !isPassiveDataTree(descriptor.value, ancestors)) return false;
		}
		ancestors.delete(value);
		return true;
	} catch {
		return false;
	}
}

function stringify(value: unknown, omitCacheMetadata = false): string {
	try {
		return (
			JSON.stringify(value, (key, child) => {
				if (omitCacheMetadata && (key === "cache_control" || key === "prompt_cache_breakpoint")) {
					return undefined;
				}
				return child;
			}) ?? "null"
		);
	} catch {
		return "[unserializable]";
	}
}

function hmac(key: Buffer, value: string): string {
	return createHmac("sha256", key).update(value).digest("hex");
}

function hashValue(key: Buffer, value: unknown, omitCacheMetadata = false): string {
	return hmac(key, stringify(value, omitCacheMetadata));
}

function fingerprintSegment(key: Buffer, value: unknown): { public: CacheSegmentFingerprint; itemHashes: string[] } {
	const serialized = stringify(value, true);
	const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	return {
		public: {
			hash: hmac(key, serialized),
			bytes: Buffer.byteLength(serialized, "utf8"),
			items: items.length,
		},
		itemHashes: items.map((item) => hashValue(key, item, true)),
	};
}

function safeBreakpointValue(value: unknown, allowed: ReadonlySet<string>): string | undefined {
	if (typeof value !== "string") return undefined;
	return allowed.has(value) ? value : "other";
}

function breakpointChildPath(path: string, key: string): string {
	return `${path}.${SAFE_BREAKPOINT_PATH_KEYS.has(key) ? key : "*"}`;
}

function collectBreakpoints(value: unknown): CacheBreakpointFingerprint[] {
	const result: CacheBreakpointFingerprint[] = [];
	const visit = (current: unknown, path: string): void => {
		if (result.length >= MAX_BREAKPOINTS_RECORDED) return;
		if (Array.isArray(current)) {
			for (let index = 0; index < current.length; index++) {
				visit(current[index], `${path}[${index}]`);
				if (result.length >= MAX_BREAKPOINTS_RECORDED) return;
			}
			return;
		}
		if (!isRecord(current)) return;
		for (const [key, child] of Object.entries(current)) {
			const childPath = breakpointChildPath(path, key).replace(/\[\d+\]/g, "[*]");
			if (key === "cache_control" && isRecord(child)) {
				const ttl = safeBreakpointValue(child.ttl, SAFE_CACHE_TTLS);
				const mode = safeBreakpointValue(child.type, SAFE_CACHE_MODES);
				result.push({
					kind: "cache_control",
					path: childPath,
					...(ttl ? { ttl } : {}),
					...(mode ? { mode } : {}),
				});
			} else if (key === "prompt_cache_breakpoint" && isRecord(child)) {
				const mode = safeBreakpointValue(child.mode, SAFE_CACHE_MODES);
				result.push({
					kind: "prompt_cache_breakpoint",
					path: childPath,
					...(mode ? { mode } : {}),
				});
			} else if (key === "prompt_cache_options" && isRecord(child)) {
				const ttl = safeBreakpointValue(child.ttl, SAFE_CACHE_TTLS);
				const mode = safeBreakpointValue(child.mode, SAFE_CACHE_MODES);
				result.push({
					kind: "prompt_cache_options",
					path: childPath,
					...(ttl ? { ttl } : {}),
					...(mode ? { mode } : {}),
				});
			} else {
				visit(child, childPath);
			}
			if (result.length >= MAX_BREAKPOINTS_RECORDED) return;
		}
	};
	visit(value, "$payload");
	return result;
}

function splitResponsesInput(input: unknown): { system?: unknown[]; messages: unknown } {
	if (!Array.isArray(input)) return { messages: input };
	let systemItems = 0;
	while (systemItems < input.length) {
		const item = input[systemItems];
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break;
		systemItems++;
	}
	return {
		...(systemItems > 0 ? { system: input.slice(0, systemItems) } : {}),
		messages: input.slice(systemItems),
	};
}

function splitPayload(
	payload: unknown,
	api: Api,
): {
	system?: unknown;
	tools?: unknown;
	messages?: unknown;
	config: JsonRecord;
	cacheKey?: string;
	segmentsClassified: boolean;
} {
	if (!isRecord(payload)) return { config: { payloadType: typeof payload }, segmentsClassified: false };
	const config: JsonRecord = {};
	const excluded = new Set<string>();
	let system: unknown;
	let tools: unknown;
	let messages: unknown;

	let segmentsClassified = true;
	if (api === "anthropic-messages") {
		system = payload.system;
		tools = payload.tools;
		messages = payload.messages;
		excluded.add("system");
		excluded.add("tools");
		excluded.add("messages");
	} else if (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") {
		const splitInput = splitResponsesInput(payload.input);
		system = payload.instructions === undefined ? splitInput.system : payload.instructions;
		tools = payload.tools;
		messages = splitInput.messages;
		excluded.add("instructions");
		excluded.add("tools");
		excluded.add("input");
	} else if (api === "openai-completions") {
		tools = payload.tools;
		messages = payload.messages;
		excluded.add("tools");
		excluded.add("messages");
	} else {
		segmentsClassified = false;
	}

	for (const [key, value] of Object.entries(payload)) {
		if (!excluded.has(key) && !VOLATILE_CONFIG_FIELDS.has(key)) config[key] = value;
	}
	return {
		system,
		tools,
		messages,
		config,
		cacheKey: typeof payload.prompt_cache_key === "string" ? payload.prompt_cache_key : undefined,
		segmentsClassified,
	};
}

function cacheNamespace(model: Model<Api>): string {
	let endpoint = model.baseUrl;
	try {
		const url = new URL(model.baseUrl);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		endpoint = url.toString();
	} catch {
		// Keep the configured string in memory only; it is never persisted.
	}
	return `${model.provider}\0${model.api}\0${endpoint}`;
}

function buildFingerprint(payload: unknown, model: Model<Api>, key: Buffer): InternalPayloadFingerprint {
	const serialized = stringify(payload);
	const sections = splitPayload(payload, model.api);
	const system = sections.system === undefined ? undefined : fingerprintSegment(key, sections.system);
	const tools = sections.tools === undefined ? undefined : fingerprintSegment(key, sections.tools);
	const messages = sections.messages === undefined ? undefined : fingerprintSegment(key, sections.messages);
	const breakpoints = collectBreakpoints(payload);
	const cachePolicyHash = hashValue(key, breakpoints);
	const continuation = isRecord(payload) && typeof payload.previous_response_id === "string";
	const cacheKeyHash = sections.cacheKey ? hmac(key, sections.cacheKey) : undefined;
	const configHash = hashValue(key, sections.config);
	return {
		public: {
			payloadHash: hmac(key, serialized),
			promptBytes: Buffer.byteLength(serialized, "utf8"),
			configHash,
			...(cacheKeyHash ? { cacheKeyHash } : {}),
			cacheConfigured: breakpoints.length > 0 || cacheKeyHash !== undefined,
			continuation,
			breakpoints,
			segments: {
				...(system ? { system: system.public } : {}),
				...(tools ? { tools: tools.public } : {}),
				...(messages ? { messages: messages.public } : {}),
			},
		},
		configHash,
		cachePolicyHash,
		continuation,
		systemHash: system?.public.hash,
		toolsHash: tools?.public.hash,
		messageItemHashes: messages?.itemHashes ?? [],
		segmentsClassified: sections.segmentsClassified,
	};
}

export function fingerprintProviderPayload(
	payload: unknown,
	model: Model<Api>,
	hmacKey: Buffer,
): ProviderPayloadFingerprint {
	return buildFingerprint(payload, model, hmacKey).public;
}

function commonPrefixLength(left: string[], right: string[]): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index++;
	return index;
}

function diffFingerprint(
	current: InternalPayloadFingerprint,
	previous: PreviousRequestFingerprint | undefined,
	model: Model<Api>,
): CacheEpochDiff {
	if (!previous) return { previousObserved: false, epochReason: "first_observed" };
	const commonMessages = commonPrefixLength(previous.messageItemHashes, current.messageItemHashes);
	const changed = {
		model: previous.model !== model.id || previous.cacheNamespace !== cacheNamespace(model),
		config: previous.configHash !== current.configHash || previous.cachePolicyHash !== current.cachePolicyHash,
		system: previous.systemHash !== current.systemHash,
		tools: previous.toolsHash !== current.toolsHash,
		messages:
			previous.messageItemHashes.length !== current.messageItemHashes.length ||
			commonMessages !== previous.messageItemHashes.length,
	};
	const appendOnly = commonMessages === previous.messageItemHashes.length;
	let epochReason: CacheEpochDiff["epochReason"];
	if (changed.model) epochReason = "model_changed";
	else if (!previous.segmentsClassified || !current.segmentsClassified) epochReason = "unclassified_payload";
	else if (changed.config) epochReason = "config_changed";
	else if (changed.system) epochReason = "system_changed";
	else if (changed.tools) epochReason = "tools_changed";
	else if (current.continuation) epochReason = "continuation";
	else if (!appendOnly) epochReason = "messages_rewritten";
	else if (changed.messages) epochReason = "append_only";
	else epochReason = "unchanged";
	return {
		previousObserved: true,
		epochReason,
		appendOnly,
		commonMessagePrefixItems: commonMessages,
		previousMessageItems: previous.messageItemHashes.length,
		changed,
	};
}

function copyCacheDiagnostics(message: AssistantMessage): CacheResultRecord["diagnostics"] {
	const result: NonNullable<CacheResultRecord["diagnostics"]> = [];
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "anthropic_cache_miss") continue;
		const reason = diagnostic.details?.reason;
		if (typeof reason !== "string" || !ANTHROPIC_CACHE_MISS_REASONS.has(reason)) continue;
		const cacheMissedInputTokens = diagnostic.details?.cacheMissedInputTokens;
		result.push({
			type: "anthropic_cache_miss",
			reason,
			...(typeof cacheMissedInputTokens === "number" &&
			Number.isFinite(cacheMissedInputTokens) &&
			cacheMissedInputTokens >= 0
				? { cacheMissedInputTokens }
				: {}),
		});
	}
	return result.length > 0 ? result : undefined;
}

function hasImplicitPromptCaching(model: Model<Api>): boolean {
	if (model.provider !== "openai" || (model.api !== "openai-responses" && model.api !== "openai-completions")) {
		return false;
	}
	try {
		const url = new URL(model.baseUrl);
		return url.protocol === "https:" && url.hostname.toLowerCase() === "api.openai.com";
	} catch {
		return false;
	}
}

function copyCost(cost: Usage["cost"]): Usage["cost"] {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		total: cost.total,
		...(cost.unknown ? { unknown: true } : {}),
	};
}

function readKey(path: string): Buffer {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid cache telemetry HMAC key");
	const encoded = readFileSync(path, "utf8").trim();
	if (!/^[a-f0-9]{64}$/i.test(encoded)) throw new Error("Invalid cache telemetry HMAC key");
	return Buffer.from(encoded, "hex");
}

function loadOrCreateKey(directory: string): Buffer {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const directoryInfo = lstatSync(directory);
	if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
		throw new Error("Cache telemetry directory must be a real directory");
	}
	try {
		chmodSync(directory, 0o700);
	} catch {
		// Best effort for filesystems that do not expose POSIX permissions.
	}
	const path = join(directory, "hmac.key");
	try {
		const key = readKey(path);
		chmodSync(path, 0o600);
		return key;
	} catch (error) {
		if (error instanceof Error && error.message === "Invalid cache telemetry HMAC key") throw error;
		const key = randomBytes(32);
		try {
			writeFileSync(path, key.toString("hex"), { encoding: "utf8", flag: "wx", mode: 0o600 });
			return key;
		} catch {
			const existing = readKey(path);
			chmodSync(path, 0o600);
			return existing;
		}
	}
}

export class CacheTelemetryRequest {
	private readonly startedAt = Date.now();
	private readonly recorder: CacheTelemetryRecorder;
	readonly requestId: string;
	readonly model: Model<Api>;
	readonly sessionId: string | undefined;
	private payloadReadyAt?: number;
	private responseAt?: number;
	private firstSemanticEventAt?: number;
	private fingerprint?: ProviderPayloadFingerprint;
	private epoch?: CacheEpochDiff;
	private observation?: CachePayloadObservation;
	private attempts = 0;
	private finished = false;
	private fallbackPayload?: unknown;
	private readonly epochBaseline: PreviousRequestFingerprint | undefined;

	constructor(
		recorder: CacheTelemetryRecorder,
		requestId: string,
		model: Model<Api>,
		sessionId: string | undefined,
		epochBaseline: PreviousRequestFingerprint | undefined,
	) {
		this.recorder = recorder;
		this.requestId = requestId;
		this.model = model;
		this.sessionId = sessionId;
		this.epochBaseline = epochBaseline;
	}

	observeFinalPayload(payload: unknown, observation: CachePayloadObservation = "provider_payload"): void {
		// Do not invoke accessors or traverse class instances before the provider does.
		// Skipping telemetry is preferable to changing an extension-supplied payload.
		if (!isPassiveDataTree(payload)) return;
		const observedAt = Date.now();
		this.payloadReadyAt ??= observedAt;
		this.attempts++;
		try {
			const recorded = this.recorder.recordRequest(
				this,
				payload,
				observedAt,
				this.epochBaseline,
				this.attempts,
				observation,
			);
			this.fingerprint = recorded.fingerprint;
			this.epoch = recorded.epoch;
			this.observation = observation;
		} catch {
			// Observability must not alter provider behavior, including for malformed
			// extension-supplied payloads that the provider will reject itself.
		}
	}

	setFallbackPayload(payload: unknown): void {
		this.fallbackPayload = payload;
	}

	observeResponse(): void {
		this.responseAt ??= Date.now();
	}

	observeEvent(event: AssistantMessageEvent): void {
		if (this.firstSemanticEventAt !== undefined) return;
		try {
			if (event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start") {
				this.firstSemanticEventAt = Date.now();
			}
		} catch {
			// Provider events may be extension-supplied; telemetry is always best effort.
		}
	}

	finish(message: AssistantMessage): void {
		if (this.finished) return;
		this.finished = true;
		if (!this.fingerprint && this.fallbackPayload !== undefined) {
			this.observeFinalPayload(this.fallbackPayload, "logical_fallback");
		}
		this.fallbackPayload = undefined;
		if (!this.fingerprint) return;
		try {
			this.recorder.recordResult(this, message, {
				startedAt: this.startedAt,
				payloadReadyAt: this.payloadReadyAt,
				responseAt: this.responseAt,
				firstSemanticEventAt: this.firstSemanticEventAt,
				fingerprint: this.fingerprint,
				epoch: this.epoch,
				attempts: this.attempts,
				observation: this.observation ?? "provider_payload",
			});
		} catch {
			// Observability must not alter provider completion semantics.
		}
	}
}

export class CacheTelemetryRecorder {
	private readonly key: Buffer;
	private readonly directory: string;
	private logPath: string;
	private activeToken: string;
	private readonly maxFileBytes: number;
	private readonly maxTotalBytes: number;
	private readonly maxAgeMs: number;
	private readonly now: () => number;
	private activeStartedAt: number;
	private readonly previous = new Map<string, PreviousRequestFingerprint>();
	private closed = false;

	static fromEnvironment(
		agentDir: string,
		value: string | undefined = process.env.PI_CACHE_TELEMETRY,
	): CacheTelemetryRecorder | undefined {
		if (!isTruthy(value)) return undefined;
		try {
			return new CacheTelemetryRecorder(join(agentDir, "telemetry", "cache"));
		} catch {
			return undefined;
		}
	}

	constructor(directory: string, retention: CacheTelemetryRetentionOptions = {}) {
		this.key = loadOrCreateKey(directory);
		this.directory = directory;
		this.maxFileBytes = retentionLimit(
			retention.maxFileBytes,
			CACHE_TELEMETRY_MAX_FILE_BYTES,
			"cache telemetry maxFileBytes",
		);
		this.maxTotalBytes = retentionLimit(
			retention.maxTotalBytes,
			CACHE_TELEMETRY_MAX_TOTAL_BYTES,
			"cache telemetry maxTotalBytes",
		);
		this.maxAgeMs = retentionLimit(retention.maxAgeMs, CACHE_TELEMETRY_MAX_AGE_MS, "cache telemetry maxAgeMs");
		this.now = retention.now ?? Date.now;
		this.activeStartedAt = this.currentTime();
		const active = this.createActiveLog(this.activeStartedAt);
		this.logPath = active.path;
		this.activeToken = active.token;
		LIVE_CACHE_TELEMETRY_LOGS.add(this.logPath);
		try {
			this.enforceRetention(this.currentTime());
		} catch (error) {
			LIVE_CACHE_TELEMETRY_LOGS.delete(this.logPath);
			try {
				unlinkSync(this.logPath);
			} catch {
				// Preserve the constructor error; a later retention pass can prune the orphan.
			}
			throw error;
		}
	}

	/** Retire this recorder's active log without creating a replacement. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		const activePath = this.logPath;
		LIVE_CACHE_TELEMETRY_LOGS.delete(activePath);
		try {
			const size = statSync(activePath).size;
			if (size > 0) {
				const archive = join(
					this.directory,
					`events.${Math.floor(this.activeStartedAt)}.${process.pid}.${this.activeToken}.jsonl`,
				);
				renameSync(activePath, archive);
				chmodSync(archive, 0o600);
			} else {
				unlinkSync(activePath);
			}
		} catch {
			try {
				unlinkSync(activePath);
			} catch {
				// Telemetry cleanup is best effort and must not affect Session disposal.
			}
		}
		try {
			this.enforceRetention(this.currentTime());
		} catch {
			// A later recorder will retry retention.
		}
	}

	start(model: Model<Api>, sessionId?: string): CacheTelemetryRequest {
		const stateKey = sessionId ? hmac(this.key, sessionId) : undefined;
		const epochBaseline = stateKey ? this.previous.get(stateKey) : undefined;
		return new CacheTelemetryRequest(this, randomBytes(12).toString("hex"), model, sessionId, epochBaseline);
	}

	recordRequest(
		request: CacheTelemetryRequest,
		payload: unknown,
		timestamp: number,
		epochBaseline: PreviousRequestFingerprint | undefined,
		attempt: number,
		observation: CachePayloadObservation,
	): RecordedRequest {
		const internal = buildFingerprint(payload, request.model, this.key);
		const stateKey = request.sessionId ? hmac(this.key, request.sessionId) : undefined;
		const epoch = diffFingerprint(internal, epochBaseline, request.model);
		if (stateKey && observation !== "logical_fallback") {
			this.previous.delete(stateKey);
			this.previous.set(stateKey, {
				...internal,
				model: request.model.id,
				cacheNamespace: cacheNamespace(request.model),
			});
			while (this.previous.size > MAX_PREVIOUS_REQUESTS) {
				const oldest = this.previous.keys().next().value;
				if (oldest === undefined) break;
				this.previous.delete(oldest);
			}
		}
		this.append({
			type: "cache_request",
			v: TELEMETRY_VERSION,
			requestId: request.requestId,
			attempt,
			observation,
			timestamp,
			...(stateKey ? { sessionHash: stateKey } : {}),
			provider: request.model.provider,
			api: request.model.api,
			model: request.model.id,
			fingerprint: internal.public,
			epoch,
		} satisfies CacheRequestRecord);
		return { fingerprint: internal.public, epoch };
	}

	recordResult(
		request: CacheTelemetryRequest,
		message: AssistantMessage,
		timing: {
			startedAt: number;
			payloadReadyAt?: number;
			responseAt?: number;
			firstSemanticEventAt?: number;
			fingerprint?: ProviderPayloadFingerprint;
			epoch?: CacheEpochDiff;
			attempts: number;
			observation: CachePayloadObservation;
		},
	): void {
		const usage = message.usage;
		const promptTokens = Math.max(0, usage.input + usage.cacheRead + usage.cacheWrite);
		const cacheConfigured = timing.fingerprint?.cacheConfigured;
		const diagnostics = copyCacheDiagnostics(message);
		const cacheObserved = usage.cacheRead > 0 || usage.cacheWrite > 0;
		const eligibility: CacheEligibility = cacheObserved
			? "eligible"
			: promptTokens < CACHE_ELIGIBILITY_MIN_TOKENS
				? "ineligible"
				: cacheConfigured === true || hasImplicitPromptCaching(request.model)
					? "eligible"
					: "unknown";
		const priorObserved = timing.epoch?.previousObserved ?? false;
		const cacheReuseExpected =
			timing.observation !== "logical_fallback" &&
			priorObserved &&
			(timing.epoch?.epochReason === "append_only" ||
				timing.epoch?.epochReason === "unchanged" ||
				timing.epoch?.epochReason === "continuation");
		const cacheOutcome: CacheOutcome =
			usage.cacheRead > 0 && usage.cacheWrite > 0
				? "hit_write"
				: usage.cacheRead > 0
					? "hit"
					: usage.cacheWrite > 0
						? "write"
						: eligibility === "eligible"
							? "miss"
							: eligibility;
		this.append({
			type: "cache_result",
			v: TELEMETRY_VERSION,
			requestId: request.requestId,
			attempts: timing.attempts,
			observation: timing.observation,
			timestamp: Date.now(),
			provider: request.model.provider,
			api: request.model.api,
			model: request.model.id,
			stopReason: message.stopReason,
			...(diagnostics ? { diagnostics } : {}),
			timing: {
				...(timing.payloadReadyAt !== undefined
					? { payloadReadyMs: Math.max(0, timing.payloadReadyAt - timing.startedAt) }
					: {}),
				...(timing.responseAt !== undefined
					? { responseHeadersMs: Math.max(0, timing.responseAt - timing.startedAt) }
					: {}),
				...(timing.firstSemanticEventAt !== undefined
					? { firstSemanticEventMs: Math.max(0, timing.firstSemanticEventAt - timing.startedAt) }
					: {}),
				totalMs: Math.max(0, Date.now() - timing.startedAt),
			},
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens: usage.totalTokens,
				cost: copyCost(usage.cost),
			},
			metrics: {
				promptTokens,
				requestHit: usage.cacheRead > 0,
				tokenHitRate: promptTokens > 0 ? usage.cacheRead / promptTokens : 0,
				writeShare: promptTokens > 0 ? usage.cacheWrite / promptTokens : 0,
				writeAmplification: usage.input > 0 ? usage.cacheWrite / usage.input : usage.cacheWrite > 0 ? null : 0,
				eligibility,
				cacheOutcome,
				priorObserved,
				cacheReuseExpected,
				eligibleMiss: eligibility === "eligible" && usage.cacheRead === 0 && cacheReuseExpected,
			},
		} satisfies CacheResultRecord);
	}

	observeStream(source: AssistantMessageEventStream, request: CacheTelemetryRequest): AssistantMessageEventStream {
		const observed = createAssistantMessageEventStream();
		const observedWithFailure = observed as AssistantMessageEventStream & { fail(error: unknown): void };
		let iterationFinished = false;
		let terminalEventSeen = false;
		let finalResult: AssistantMessage | undefined;
		let resultFailure: unknown;
		let resultSettled = false;
		let resultRejected = false;
		try {
			void source.result().then(
				(message) => {
					finalResult = message;
					resultSettled = true;
					if (iterationFinished && !terminalEventSeen) {
						request.finish(message);
						observed.end(message);
					}
				},
				(error) => {
					resultFailure = error;
					resultSettled = true;
					resultRejected = true;
					if (iterationFinished) observedWithFailure.fail(error);
				},
			);
		} catch {
			// A non-conforming custom result() must not break otherwise valid iteration.
		}
		void (async () => {
			try {
				for await (const event of source) {
					request.observeEvent(event);
					if (event.type === "done") {
						terminalEventSeen = true;
						request.finish(event.message);
					} else if (event.type === "error") {
						terminalEventSeen = true;
						request.finish(event.error);
					}
					observed.push(event);
				}
			} catch (error) {
				observedWithFailure.fail(error);
			} finally {
				iterationFinished = true;
				if (!terminalEventSeen && resultSettled) {
					if (resultRejected) observedWithFailure.fail(resultFailure);
					else if (finalResult !== undefined) {
						request.finish(finalResult);
						observed.end(finalResult);
					} else observed.end();
				} else {
					// Preserve iteration completion, but do not leave result() pending
					// forever when a non-conforming provider publishes no final result.
					observed.end();
					if (!terminalEventSeen && !resultSettled) {
						observedWithFailure.fail(new Error("Provider stream ended without a final result"));
					}
				}
			}
		})();
		return observed;
	}

	private append(record: CacheRequestRecord | CacheResultRecord): void {
		if (this.closed) return;
		try {
			const line = `${JSON.stringify(record)}\n`;
			const bytes = Buffer.byteLength(line, "utf8");
			if (!this.prepareAppend(bytes)) return;
			appendFileSync(this.logPath, line, { encoding: "utf8", mode: 0o600 });
		} catch {
			// Telemetry must never affect a provider request.
		}
	}

	private currentTime(): number {
		const now = this.now();
		if (!Number.isFinite(now)) throw new TypeError("cache telemetry clock must return a finite timestamp");
		return now;
	}

	private prepareAppend(bytes: number): boolean {
		if (bytes <= 0 || bytes > this.maxFileBytes || bytes > this.maxTotalBytes || this.maxAgeMs === 0) {
			return false;
		}
		const now = this.currentTime();
		let activeSize = statSync(this.logPath).size;
		if (now - this.activeStartedAt >= this.maxAgeMs) {
			this.rotateActive(now);
			activeSize = 0;
		}
		let total = this.enforceRetention(now, bytes);
		if (activeSize + bytes > this.maxFileBytes) {
			this.rotateActive(now);
			activeSize = 0;
			total = this.enforceRetention(now, bytes);
		}

		if (total + bytes <= this.maxTotalBytes) return true;
		if (activeSize > 0) {
			this.rotateActive(now);
			total = this.enforceRetention(now, bytes);
		}
		return total + bytes <= this.maxTotalBytes;
	}

	private rotateActive(now: number): void {
		const previousPath = this.logPath;
		try {
			const size = statSync(this.logPath).size;
			if (size > 0) {
				const archive = join(
					this.directory,
					`events.${Math.floor(this.activeStartedAt)}.${process.pid}.${this.activeToken}.jsonl`,
				);
				renameSync(this.logPath, archive);
				chmodSync(archive, 0o600);
			} else {
				unlinkSync(this.logPath);
			}
		} finally {
			LIVE_CACHE_TELEMETRY_LOGS.delete(previousPath);
		}
		this.activeStartedAt = now;
		const active = this.createActiveLog(now);
		this.logPath = active.path;
		this.activeToken = active.token;
		LIVE_CACHE_TELEMETRY_LOGS.add(this.logPath);
	}

	private createActiveLog(startedAt: number): { path: string; token: string } {
		for (let attempt = 0; attempt < 8; attempt++) {
			const token = randomBytes(6).toString("hex");
			const path = join(this.directory, `events.active.${Math.floor(startedAt)}.${process.pid}.${token}.jsonl`);
			try {
				writeFileSync(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
				chmodSync(path, 0o600);
				return { path, token };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		throw new Error("Could not allocate a unique cache telemetry log");
	}

	/** Remove expired/oversized archives and reserve space for the next atomic line append. */
	private enforceRetention(now: number, reserveBytes = 0): number {
		const logs: CacheTelemetryLogFile[] = [];
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (!entry.isFile() || entry.isSymbolicLink()) continue;
			const archiveMatch = CACHE_TELEMETRY_ARCHIVE_PATTERN.exec(entry.name);
			const activeMatch = CACHE_TELEMETRY_ACTIVE_PATTERN.exec(entry.name);
			if (!archiveMatch && !activeMatch && entry.name !== CACHE_TELEMETRY_LEGACY_LOG) continue;
			const path = join(this.directory, entry.name);
			let info: ReturnType<typeof lstatSync>;
			try {
				info = lstatSync(path);
			} catch {
				continue;
			}
			if (!info.isFile() || info.isSymbolicLink()) continue;
			const startedAt = archiveMatch
				? Number(archiveMatch[1])
				: activeMatch
					? Number(activeMatch[1])
					: info.birthtimeMs || info.mtimeMs;
			const ownerPid = activeMatch ? Number(activeMatch[2]) : undefined;
			const protectedLog =
				ownerPid !== undefined &&
				(ownerPid === process.pid ? LIVE_CACHE_TELEMETRY_LOGS.has(path) : processIsAlive(ownerPid));
			if (
				(!protectedLog && info.size > this.maxFileBytes) ||
				(!protectedLog && info.size > this.maxTotalBytes) ||
				(!protectedLog && !Number.isFinite(startedAt)) ||
				(!protectedLog && now - startedAt >= this.maxAgeMs)
			) {
				try {
					unlinkSync(path);
				} catch {
					// Another recorder may have pruned the same closed file.
				}
				continue;
			}
			logs.push({ path, size: info.size, startedAt, protected: protectedLog });
		}

		logs.sort((left, right) => left.startedAt - right.startedAt || left.path.localeCompare(right.path));
		let total = logs.reduce((sum, file) => sum + file.size, 0);
		const budget = Math.max(0, this.maxTotalBytes - reserveBytes);
		for (const log of logs) {
			if (total <= budget) break;
			if (log.protected) continue;
			try {
				unlinkSync(log.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
			}
			total -= log.size;
		}
		return total;
	}
}

function processIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
