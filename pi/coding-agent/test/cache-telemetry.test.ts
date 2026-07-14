import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type CacheRequestRecord,
	type CacheResultRecord,
	CacheTelemetryRecorder,
} from "../src/core/cache-telemetry.ts";

const SENTINEL_SYSTEM = "private-system-sentinel";
const SENTINEL_TOOL = "private-tool-sentinel";
const SENTINEL_MESSAGE = "private-message-sentinel";
const SENTINEL_DIAGNOSTIC = "private-diagnostic-sentinel";

function model(): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 4096,
	};
}

function openAIModel(baseUrl = "https://api.openai.com/v1"): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 4096,
	};
}

function codexModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 4096,
	};
}

function payload(messages: unknown[], system = SENTINEL_SYSTEM): Record<string, unknown> {
	return {
		model: "claude-test",
		max_tokens: 4096,
		stream: true,
		system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
		tools: [
			{
				name: "private_tool",
				description: SENTINEL_TOOL,
				input_schema: { type: "object", properties: {} },
				cache_control: { type: "ephemeral" },
			},
		],
		messages,
	};
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "provider output is not written by cache telemetry" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 100,
			output: 1,
			cacheRead: 900,
			cacheWrite: 100,
			totalTokens: 1101,
			cost: { input: 0.0001, output: 0.000005, cacheRead: 0.00009, cacheWrite: 0.000125, total: 0.00032 },
		},
		stopReason: "stop",
		diagnostics: [
			{
				type: "anthropic_cache_miss",
				timestamp: Date.now(),
				details: { reason: "tools_changed", cacheMissedInputTokens: 321 },
			},
			{
				type: "provider_retry",
				timestamp: Date.now(),
				error: { message: SENTINEL_DIAGNOSTIC },
			},
			{
				type: "anthropic_cache_miss",
				timestamp: Date.now(),
				details: { reason: SENTINEL_DIAGNOSTIC },
			},
		],
		timestamp: Date.now(),
	};
}

function readRecords(directory: string): Array<CacheRequestRecord | CacheResultRecord> {
	return readFileSync(join(directory, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as CacheRequestRecord | CacheResultRecord);
}

describe("cache telemetry", () => {
	it("records final-payload hashes, append epochs, usage, and timing without plaintext", async () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const firstMessages = [
			{
				role: "user",
				content: [{ type: "text", text: SENTINEL_MESSAGE, cache_control: { type: "ephemeral" } }],
			},
		];
		const firstRequest = recorder.start(model(), "session-secret");
		firstRequest.observeFinalPayload(payload(firstMessages));
		firstRequest.observeResponse();

		const source = createAssistantMessageEventStream();
		const observed = recorder.observeStream(source, firstRequest);
		const eventTypes = (async () => {
			const types: string[] = [];
			for await (const event of observed) types.push(event.type);
			return types;
		})();
		const message = assistantMessage();
		source.push({ type: "start", partial: message });
		source.push({ type: "text_start", contentIndex: 0, partial: message });
		source.push({ type: "done", reason: "stop", message });
		source.end();
		await observed.result();
		expect(await eventTypes).toEqual(["start", "text_start", "done"]);

		const secondRequest = recorder.start(model(), "session-secret");
		secondRequest.observeFinalPayload(
			payload([
				...firstMessages,
				{ role: "assistant", content: [{ type: "text", text: "answer" }] },
				{ role: "user", content: [{ type: "text", text: "next" }] },
			]),
		);

		const thirdRequest = recorder.start(model(), "session-secret");
		thirdRequest.observeFinalPayload(payload(firstMessages, "changed system"));

		const rawLog = readFileSync(join(directory, "events.jsonl"), "utf8");
		expect(rawLog).not.toContain(SENTINEL_SYSTEM);
		expect(rawLog).not.toContain(SENTINEL_TOOL);
		expect(rawLog).not.toContain(SENTINEL_MESSAGE);
		expect(rawLog).not.toContain("provider output is not written by cache telemetry");
		expect(rawLog).not.toContain(SENTINEL_DIAGNOSTIC);
		expect(statSync(join(directory, "hmac.key")).mode & 0o777).toBe(0o600);
		expect(statSync(join(directory, "events.jsonl")).mode & 0o777).toBe(0o600);

		const records = readRecords(directory);
		const requests = records.filter((record): record is CacheRequestRecord => record.type === "cache_request");
		const result = records.find((record): record is CacheResultRecord => record.type === "cache_result");
		expect(requests).toHaveLength(3);
		expect(requests[0].fingerprint.breakpoints).toHaveLength(3);
		expect(requests[0].fingerprint.breakpoints.every((breakpoint) => !/\[\d+\]/.test(breakpoint.path))).toBe(true);
		expect(requests[0].fingerprint.segments.system?.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(requests[0].epoch).toMatchObject({ previousObserved: false, epochReason: "first_observed" });
		expect(requests[1].epoch).toMatchObject({
			previousObserved: true,
			epochReason: "append_only",
			appendOnly: true,
			commonMessagePrefixItems: 1,
			previousMessageItems: 1,
		});
		expect(requests[2].epoch.epochReason).toBe("system_changed");
		expect(result?.requestId).toBe(requests[0].requestId);
		expect(result?.timing).toMatchObject({
			payloadReadyMs: expect.any(Number),
			responseHeadersMs: expect.any(Number),
			firstSemanticEventMs: expect.any(Number),
			totalMs: expect.any(Number),
		});
		expect(result?.metrics).toMatchObject({
			promptTokens: 1100,
			requestHit: true,
			cacheOutcome: "hit_write",
			writeShare: 100 / 1100,
			writeAmplification: 1,
			eligibility: "eligible",
			eligibleMiss: false,
		});
		expect(result?.usage.cost.total).toBe(0.00032);
		expect(result?.diagnostics).toEqual([
			{ type: "anthropic_cache_miss", reason: "tools_changed", cacheMissedInputTokens: 321 },
		]);
	});

	it("ignores request-scoped diagnostics when classifying cache epochs", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const messages = [{ role: "user", content: [{ type: "text", text: "same" }] }];

		const first = recorder.start(model(), "session");
		first.observeFinalPayload({
			...payload(messages),
			diagnostics: { previous_message_id: "msg_first" },
		});
		const second = recorder.start(model(), "session");
		second.observeFinalPayload({
			...payload(messages),
			diagnostics: { previous_message_id: "msg_second" },
		});

		const requests = readRecords(directory).filter(
			(record): record is CacheRequestRecord => record.type === "cache_request",
		);
		expect(requests[1].epoch).toMatchObject({
			epochReason: "unchanged",
			changed: { config: false, system: false, tools: false, messages: false },
		});
	});

	it("compares concurrent requests with the epoch visible when each request started", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const baseMessages = [{ role: "user", content: [{ type: "text", text: "base" }] }];
		const baseline = recorder.start(model(), "shared-session");
		baseline.observeFinalPayload(payload(baseMessages));

		const left = recorder.start(model(), "shared-session");
		const right = recorder.start(model(), "shared-session");
		left.observeFinalPayload(
			payload([...baseMessages, { role: "assistant", content: "left answer" }, { role: "user", content: "left" }]),
		);
		right.observeFinalPayload(
			payload([...baseMessages, { role: "assistant", content: "right answer" }, { role: "user", content: "right" }]),
		);

		const requests = readRecords(directory).filter(
			(record): record is CacheRequestRecord => record.type === "cache_request",
		);
		expect(requests.map((request) => request.epoch.epochReason)).toEqual([
			"first_observed",
			"append_only",
			"append_only",
		]);
		expect(requests[1].epoch.commonMessagePrefixItems).toBe(1);
		expect(requests[2].epoch.commonMessagePrefixItems).toBe(1);
	});

	it("classifies cache policy, namespace, and OpenAI system changes on the right epoch axis", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const messages = [{ role: "user", content: [{ type: "text", text: "same" }] }];

		const ttlBefore = recorder.start(model(), "ttl-session");
		ttlBefore.observeFinalPayload(payload(messages));
		const ttlPayload = payload(messages);
		((ttlPayload.system as Array<Record<string, unknown>>)[0].cache_control as Record<string, unknown>).ttl = "1h";
		const ttlAfter = recorder.start(model(), "ttl-session");
		ttlAfter.observeFinalPayload(ttlPayload);

		const endpointBefore = recorder.start(openAIModel(), "endpoint-session");
		endpointBefore.observeFinalPayload({ model: "gpt-test", input: [{ role: "user", content: "same" }] });
		const endpointAfter = recorder.start(openAIModel("https://proxy.example/v1"), "endpoint-session");
		endpointAfter.observeFinalPayload({ model: "gpt-test", input: [{ role: "user", content: "same" }] });

		const systemBefore = recorder.start(openAIModel(), "system-session");
		systemBefore.observeFinalPayload({
			model: "gpt-test",
			input: [
				{ role: "developer", content: [{ type: "input_text", text: "system one" }] },
				{ role: "user", content: [{ type: "input_text", text: "same" }] },
			],
		});
		const systemAfter = recorder.start(openAIModel(), "system-session");
		systemAfter.observeFinalPayload({
			model: "gpt-test",
			input: [
				{ role: "developer", content: [{ type: "input_text", text: "system two" }] },
				{ role: "user", content: [{ type: "input_text", text: "same" }] },
			],
		});

		const requests = readRecords(directory).filter(
			(record): record is CacheRequestRecord => record.type === "cache_request",
		);
		expect(requests[1].epoch.epochReason).toBe("config_changed");
		expect(requests[3].epoch.epochReason).toBe("model_changed");
		expect(requests[5].epoch.epochReason).toBe("system_changed");
		expect(requests[5].fingerprint.segments).toMatchObject({
			system: { items: 1 },
			messages: { items: 1 },
		});
	});

	it("normalizes untrusted breakpoint paths and values before persistence", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const request = recorder.start(model(), "session");
		request.observeFinalPayload({
			"tenant@example.com": {
				cache_control: { type: "private-mode", ttl: "private-ttl" },
			},
			prompt_cache_options: { mode: "private-mode", ttl: "private-ttl" },
		});

		const raw = readFileSync(join(directory, "events.jsonl"), "utf8");
		expect(raw).not.toContain("tenant@example.com");
		expect(raw).not.toContain("private-mode");
		expect(raw).not.toContain("private-ttl");
		const requestRecord = readRecords(directory)[0] as CacheRequestRecord;
		expect(requestRecord.fingerprint.breakpoints).toEqual([
			{ kind: "cache_control", path: "$payload.*.cache_control", ttl: "other", mode: "other" },
			{
				kind: "prompt_cache_options",
				path: "$payload.prompt_cache_options",
				ttl: "other",
				mode: "other",
			},
		]);
	});

	it("labels provider-native continuation deltas instead of treating them as history rewrites", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const baseline = recorder.start(codexModel(), "codex-session");
		baseline.observeFinalPayload(
			{
				type: "response.create",
				model: "gpt-test",
				instructions: "stable",
				input: [{ role: "user", content: "first" }],
			},
			"wire",
		);
		const continuation = recorder.start(codexModel(), "codex-session");
		continuation.observeFinalPayload(
			{
				type: "response.create",
				model: "gpt-test",
				instructions: "stable",
				previous_response_id: "resp_private",
				input: [{ role: "user", content: "next" }],
			},
			"wire",
		);

		const requests = readRecords(directory).filter(
			(record): record is CacheRequestRecord => record.type === "cache_request",
		);
		expect(requests[1].fingerprint.continuation).toBe(true);
		expect(requests[1].epoch.epochReason).toBe("continuation");
		expect(readFileSync(join(directory, "events.jsonl"), "utf8")).not.toContain("resp_private");
	});

	it("records multiple wire attempts under one request and correlates the final result", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const baseline = recorder.start(model(), "session");
		baseline.observeFinalPayload(payload([{ role: "user", content: "base" }]));
		const request = recorder.start(model(), "session");
		request.observeFinalPayload(
			payload([
				{ role: "user", content: "base" },
				{ role: "assistant", content: "first attempt" },
			]),
			"wire",
		);
		request.observeFinalPayload(
			payload([
				{ role: "user", content: "base" },
				{ role: "assistant", content: "fallback attempt" },
			]),
			"wire",
		);
		request.finish(assistantMessage());

		const records = readRecords(directory);
		const attempts = records.filter(
			(record): record is CacheRequestRecord =>
				record.type === "cache_request" && record.requestId === request.requestId,
		);
		const result = records.find(
			(record): record is CacheResultRecord =>
				record.type === "cache_result" && record.requestId === request.requestId,
		);
		expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
		expect(attempts.map((attempt) => attempt.observation)).toEqual(["wire", "wire"]);
		expect(attempts.map((attempt) => attempt.epoch.epochReason)).toEqual(["append_only", "append_only"]);
		expect(result?.attempts).toBe(2);
		expect(result?.observation).toBe("wire");
		expect(result?.metrics.priorObserved).toBe(true);
		expect(result?.metrics.cacheReuseExpected).toBe(true);
	});

	it("classifies first-party OpenAI implicit caching without treating proxies as eligible", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const message: AssistantMessage = {
			...assistantMessage(),
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 1100,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1101,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const direct = recorder.start(openAIModel(), "direct-session");
		direct.observeFinalPayload({ model: "gpt-test", input: [{ role: "user", content: "hello" }], stream: true });
		direct.finish(message);
		const warmDirect = recorder.start(openAIModel(), "direct-session");
		warmDirect.observeFinalPayload({
			model: "gpt-test",
			input: [{ role: "user", content: "hello" }],
			stream: true,
		});
		warmDirect.finish(message);
		const rewrittenDirect = recorder.start(openAIModel(), "direct-session");
		rewrittenDirect.observeFinalPayload({
			model: "gpt-test",
			input: [{ role: "user", content: "rewritten" }],
			stream: true,
		});
		rewrittenDirect.finish(message);
		const proxy = recorder.start(openAIModel("https://proxy.example/v1"));
		proxy.observeFinalPayload({ model: "gpt-test", input: [{ role: "user", content: "hello" }], stream: true });
		proxy.finish(message);

		const results = readRecords(directory).filter(
			(record): record is CacheResultRecord => record.type === "cache_result",
		);
		expect(results[0].metrics).toMatchObject({
			eligibility: "eligible",
			cacheOutcome: "miss",
			priorObserved: false,
			cacheReuseExpected: false,
			eligibleMiss: false,
		});
		expect(results[1].metrics).toMatchObject({
			eligibility: "eligible",
			priorObserved: true,
			cacheReuseExpected: true,
			eligibleMiss: true,
		});
		expect(results[2].metrics).toMatchObject({
			eligibility: "eligible",
			priorObserved: true,
			cacheReuseExpected: false,
			eligibleMiss: false,
		});
		expect(results[3].metrics).toMatchObject({ eligibility: "unknown", eligibleMiss: false });
	});

	it("treats provider-reported cache activity as definitive eligibility evidence", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const request = recorder.start(model(), "small-hit-session");
		request.observeFinalPayload(payload([{ role: "user", content: "small" }]));
		request.finish({
			...assistantMessage(),
			usage: {
				input: 90,
				output: 1,
				cacheRead: 10,
				cacheWrite: 0,
				totalTokens: 101,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});

		const result = readRecords(directory).find(
			(record): record is CacheResultRecord => record.type === "cache_result",
		);
		expect(result?.metrics).toMatchObject({
			promptTokens: 100,
			eligibility: "eligible",
			cacheOutcome: "hit",
			requestHit: true,
		});
	});

	it("does not affect provider behavior for an unserializable extension payload", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const request = recorder.start(model(), "session");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(() => request.observeFinalPayload(cyclic)).not.toThrow();
		request.finish(assistantMessage());
		expect(readFileSync(join(directory, "events.jsonl"), "utf8")).toBe("");
	});

	it("does not invoke payload accessors before the provider serializes them", () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const request = recorder.start(model(), "session-accessor");
		let reads = 0;
		const accessorPayload = {} as Record<string, unknown>;
		Object.defineProperty(accessorPayload, "messages", {
			enumerable: true,
			get() {
				reads++;
				return [{ role: "user", content: "side effect" }];
			},
		});

		request.observeFinalPayload(accessorPayload);

		expect(reads).toBe(0);
		expect(readFileSync(join(directory, "events.jsonl"), "utf8")).toBe("");
	});

	it("does not turn malformed result telemetry into a provider failure", async () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const request = recorder.start(model(), "session-malformed-result");
		request.observeFinalPayload(payload([{ role: "user", content: "safe" }]));
		const source = createAssistantMessageEventStream();
		const message = {
			...assistantMessage(),
			get usage(): never {
				throw new Error("malformed usage");
			},
		} as unknown as AssistantMessage;
		const observed = recorder.observeStream(source, request);

		source.push({ type: "done", reason: "stop", message });
		source.end();

		await expect(observed.result()).resolves.toBe(message);
	});

	it("propagates custom provider iterator failures without hanging result consumers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const request = recorder.start(model(), "session");
		request.observeFinalPayload(payload([{ role: "user", content: "hello" }]));
		const source = createAssistantMessageEventStream();
		const observed = recorder.observeStream(source, request);
		const iteration = (async () => {
			for await (const _event of observed) {
				// Consume until the source failure is propagated.
			}
		})();

		source.fail(new Error("custom stream failed"));
		await expect(iteration).rejects.toThrow("custom stream failed");
		await expect(observed.result()).rejects.toThrow("custom stream failed");
	});

	it("does not hang iteration when a custom provider ends without a terminal result", async () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const request = recorder.start(model(), "session");
		request.observeFinalPayload(payload([{ role: "user", content: "hello" }]));
		const source = createAssistantMessageEventStream();
		const observed = recorder.observeStream(source, request);
		const iteration = (async () => {
			for await (const _event of observed) {
				// No events are expected.
			}
		})();

		source.end();

		await expect(iteration).resolves.toBeUndefined();
		await expect(observed.result()).rejects.toThrow("Provider stream ended without a final result");
	});

	it("finishes a wrapper when a custom provider ends with only a final result", async () => {
		const directory = mkdtempSync(join(tmpdir(), "magenta-cache-telemetry-"));
		const recorder = new CacheTelemetryRecorder(directory);
		const request = recorder.start(model(), "session");
		request.observeFinalPayload(payload([{ role: "user", content: "hello" }]));
		const source = createAssistantMessageEventStream();
		const observed = recorder.observeStream(source, request);
		const message = assistantMessage();
		source.end(message);

		await expect(observed.result()).resolves.toBe(message);
		const records = readRecords(directory);
		expect(records.map((record) => record.type)).toEqual(["cache_request", "cache_result"]);
	});
});
