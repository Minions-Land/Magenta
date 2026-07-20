import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertFiniteTokenBudget,
	type CalibrationConfig,
	hasPairedModelMismatch,
	TokfanLedger,
} from "../scripts/tokfan-billing-calibration.ts";
import {
	assertQuotaBudget,
	buildCalibrationTurn,
	type CalibrationTurn,
	cacheableReuseRate,
	compareClientSummaries,
	consumeLogKeys,
	deterministicOrder,
	parseTokfanConsumeLogs,
	redactSecrets,
	selectNewConsumeLogs,
	summarizeClientTurns,
} from "../scripts/tokfan-billing-core.ts";

function tokenLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		created_at: 1_800_000_000,
		type: 2,
		quota: 125,
		model_name: "claude-sonnet-5",
		prompt_tokens: 20,
		completion_tokens: 3,
		channel: 17,
		token_name: "synthetic-calibration-token",
		request_id: "req-synthetic-1",
		other: JSON.stringify({
			cache_tokens: 80,
			cache_creation_tokens_5m: 10,
			cache_creation_tokens_1h: 5,
			upstream_model_name: "claude-sonnet-5",
			usage_semantic: "anthropic",
			request_path: "/v1/messages",
		}),
		...overrides,
	};
}

function turn(client: "claude-code" | "magenta", turnNumber: number, quota: number, reuse: number): CalibrationTurn {
	return {
		client,
		model: "claude-sonnet-5",
		cohort: 1,
		turn: turnNumber,
		phase: turnNumber === 1 ? "cold" : "warm",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:00:01.000Z",
		elapsedMs: 1000,
		chargedQuota: quota,
		requestCount: 1,
		requestFingerprints: [`fingerprint-${client}-${turnNumber}`],
		channels: [17],
		observedModels: ["claude-sonnet-5"],
		upstreamModels: ["claude-sonnet-5"],
		usage: { input: 1, output: 1, cacheRead: reuse * 100, cacheWrite: (1 - reuse) * 100 },
		cacheableReuseRate: reuse,
	};
}

function ledgerConfig(overrides: Partial<CalibrationConfig> = {}): CalibrationConfig {
	return {
		baseUrl: "https://tok.fan",
		apiKey: "synthetic-api-key",
		userAccessToken: "synthetic-user-token",
		userId: "42",
		tokenName: "synthetic-calibration-token",
		models: ["claude-sonnet-5"],
		turns: 4,
		cohorts: 1,
		seed: "test",
		profile: "minimal",
		maxQuota: 1000,
		maxMagentaWarmRatio: undefined,
		maxRequestsPerTurn: 4,
		logTimeoutMs: 1000,
		logPollMs: 1,
		logEndToleranceMs: 1000,
		claudeBin: "claude",
		magentaCli: "/tmp/magenta-cli.js",
		live: false,
		outputPath: undefined,
		...overrides,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("tok.fan billing calibration", () => {
	it("prefers token-scoped consume logs", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(
				async () => new Response(JSON.stringify({ success: true, data: [tokenLog()] }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const ledger = new TokfanLedger(ledgerConfig());

		expect(await ledger.discover()).toBe("token");
		expect((await ledger.logs())[0]?.quota).toBe(125);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://tok.fan/api/log/token",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer synthetic-api-key" }) }),
		);
	});

	it("reads finite dedicated-token quota for provider-enforced budget control", async () => {
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						code: true,
						data: {
							name: "synthetic-calibration-token",
							total_available: 500,
							total_used: 20,
							unlimited_quota: false,
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const ledger = new TokfanLedger(ledgerConfig());

		expect(await ledger.tokenUsage()).toEqual({
			tokenName: "synthetic-calibration-token",
			totalAvailable: 500,
			totalUsed: 20,
			unlimitedQuota: false,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://tok.fan/api/usage/token",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer synthetic-api-key" }) }),
		);
	});

	it("requires the provider-enforced finite token quota to fit under the configured cap", () => {
		expect(() =>
			assertFiniteTokenBudget(
				{ tokenName: "synthetic", totalAvailable: 500, totalUsed: 0, unlimitedQuota: false },
				500,
			),
		).not.toThrow();
		expect(() =>
			assertFiniteTokenBudget(
				{ tokenName: "synthetic", totalAvailable: 501, totalUsed: 0, unlimitedQuota: false },
				500,
			),
		).toThrow("above TOKFAN_MAX_QUOTA");
		expect(() =>
			assertFiniteTokenBudget(
				{ tokenName: "synthetic", totalAvailable: 1, totalUsed: 0, unlimitedQuota: true },
				500,
			),
		).toThrow("finite-quota");
	});

	it("falls back to user-scoped logs when token log endpoint is unavailable", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("not found", { status: 404 }))
			.mockImplementation(
				async () => new Response(JSON.stringify({ success: true, data: { items: [tokenLog()] } }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const ledger = new TokfanLedger(ledgerConfig());

		expect(await ledger.discover()).toBe("user");
		expect((await ledger.logs())[0]?.quota).toBe(125);
		expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/log/self?");
		expect(fetchMock.mock.calls[1]?.[1]).toEqual(
			expect.objectContaining({ headers: expect.objectContaining({ "New-Api-User": "42" }) }),
		);
	});

	it("rejects user fallback logs whose token_name is missing", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("not found", { status: 404 }))
			.mockImplementation(
				async () =>
					new Response(JSON.stringify({ success: true, data: { items: [tokenLog({ token_name: undefined })] } }), {
						status: 200,
					}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const ledger = new TokfanLedger(ledgerConfig());

		await expect(ledger.discover()).rejects.toThrow("token_name is missing or different");
	});

	it("waits for authoritative quota and usage fields to stabilize", async () => {
		const startedAt = new Date();
		const endedAt = new Date(startedAt.getTime() + 100);
		let call = 0;
		const fetchMock = vi.fn().mockImplementation(async () => {
			call++;
			const quota = call >= 3 ? 140 : 125;
			return new Response(
				JSON.stringify({
					success: true,
					data: [tokenLog({ created_at: Math.floor(startedAt.getTime() / 1000), quota })],
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const ledger = new TokfanLedger(ledgerConfig());

		const logs = await ledger.waitForNewLogs(new Set(), startedAt, endedAt);
		expect(logs[0]?.quota).toBe(140);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("rejects consume logs outside the turn attribution window", async () => {
		const startedAt = new Date();
		const endedAt = new Date(startedAt.getTime() + 100);
		const fetchMock = vi.fn().mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						data: [tokenLog({ created_at: Math.floor((endedAt.getTime() + 5000) / 1000) })],
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const ledger = new TokfanLedger(ledgerConfig({ logEndToleranceMs: 100 }));

		await expect(ledger.waitForNewLogs(new Set(), startedAt, endedAt)).rejects.toThrow(
			"after the turn attribution window",
		);
	});

	it("parses token-scoped logs and preserves authoritative quota", () => {
		const logs = parseTokfanConsumeLogs({ success: true, data: [tokenLog()] });

		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			key: "req-synthetic-1",
			quota: 125,
			model: "claude-sonnet-5",
			upstreamModel: "claude-sonnet-5",
			channel: 17,
			usageSemantic: "anthropic",
			requestPath: "/v1/messages",
			usage: { input: 20, output: 3, cacheRead: 80, cacheWrite: 15 },
		});
	});

	it("parses paginated user logs and normalized cache_write_tokens", () => {
		const logs = parseTokfanConsumeLogs({
			success: true,
			data: {
				page: 1,
				page_size: 10,
				total: 1,
				items: [tokenLog({ request_id: "req-synthetic-2", other: { cache_tokens: 40, cache_write_tokens: 12 } })],
			},
		});

		expect(logs[0]?.usage).toEqual({ input: 20, output: 3, cacheRead: 40, cacheWrite: 12 });
	});

	it("selects only new consume logs", () => {
		const before = parseTokfanConsumeLogs({ success: true, data: [tokenLog()] });
		const after = parseTokfanConsumeLogs({
			success: true,
			data: [
				tokenLog(),
				tokenLog({ request_id: "req-error", type: 5 }),
				tokenLog({ request_id: "req-synthetic-new", created_at: 1_800_000_001 }),
			],
		});

		expect(selectNewConsumeLogs(consumeLogKeys(before), after).map((log) => log.key)).toEqual(["req-synthetic-new"]);
	});

	it("uses the backend log row id when otherwise identical records lack request ids", () => {
		const first = parseTokfanConsumeLogs({
			success: true,
			data: [tokenLog({ id: 101, request_id: undefined })],
		});
		const second = parseTokfanConsumeLogs({
			success: true,
			data: [tokenLog({ id: 102, request_id: undefined })],
		});

		expect(first[0]?.key).toBe("log:101");
		expect(selectNewConsumeLogs(consumeLogKeys(first), second).map((log) => log.key)).toEqual(["log:102"]);
	});

	it("builds a redacted turn from one or more actual charge records", () => {
		const logs = parseTokfanConsumeLogs({
			success: true,
			data: [tokenLog(), tokenLog({ request_id: "req-synthetic-2", quota: 75, channel: 18 })],
		});
		const result = buildCalibrationTurn({
			client: "magenta",
			model: "claude-sonnet-5",
			cohort: 1,
			turn: 2,
			startedAt: new Date("2026-01-01T00:00:00Z"),
			endedAt: new Date("2026-01-01T00:00:01Z"),
			logs,
		});

		expect(result).toMatchObject({
			phase: "warm",
			chargedQuota: 200,
			requestCount: 2,
			channels: [17, 18],
			usage: { input: 40, output: 6, cacheRead: 160, cacheWrite: 30 },
			cacheableReuseRate: 160 / 190,
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("req-synthetic");
		expect(serialized).not.toContain("synthetic-calibration-token");
	});

	it("compares warm quota medians at the session/cohort level", () => {
		const claude = summarizeClientTurns([
			turn("claude-code", 1, 100, 0),
			turn("claude-code", 2, 20, 0.9),
			turn("claude-code", 3, 30, 0.8),
			turn("claude-code", 4, 25, 0.85),
		]);
		const magenta = summarizeClientTurns([
			turn("magenta", 1, 120, 0),
			turn("magenta", 2, 40, 0.7),
			turn("magenta", 3, 50, 0.6),
			turn("magenta", 4, 45, 0.65),
		]);

		expect(claude).toMatchObject({ coldQuota: 100, warmQuotaMedian: 25, warmToColdRatio: 0.25 });
		expect(magenta).toMatchObject({ coldQuota: 120, warmQuotaMedian: 45, warmToColdRatio: 0.375 });
		expect(compareClientSummaries(magenta, claude)).toMatchObject({
			magentaWarmQuota: 45,
			claudeCodeWarmQuota: 25,
			magentaToClaudeWarmQuotaRatio: 1.8,
		});
	});

	it("rejects a shared remap to the wrong model", () => {
		const exact = [turn("claude-code", 1, 100, 0), turn("magenta", 1, 100, 0)];
		const remapped = exact.map((entry) => ({
			...entry,
			observedModels: ["claude-haiku-4-5"],
			upstreamModels: ["claude-haiku-4-5"],
		}));

		expect(hasPairedModelMismatch(exact)).toBe(false);
		expect(hasPairedModelMismatch(remapped)).toBe(true);
	});

	it("uses cache read over read plus write as the supporting reuse metric", () => {
		expect(cacheableReuseRate({ input: 50, output: 5, cacheRead: 90, cacheWrite: 10 })).toBe(0.9);
		expect(cacheableReuseRate({ input: 50, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull();
	});

	it("enforces quota budgets and deterministic client order", () => {
		expect(() => assertQuotaBudget(99, 100)).not.toThrow();
		expect(() => assertQuotaBudget(101, 100)).toThrow("quota budget exceeded");
		expect(deterministicOrder("fixed-seed", 3)).toEqual(deterministicOrder("fixed-seed", 3));
		expect(new Set(deterministicOrder("fixed-seed", 3))).toEqual(new Set(["claude-code", "magenta"]));
	});

	it("redacts API keys, access tokens, and bearer headers from errors", () => {
		const apiKey = "sk-synthetic-secret-value";
		const accessToken = "synthetic-user-access-token";
		const result = redactSecrets(`Authorization: Bearer ${accessToken}; key=${apiKey}`, [apiKey, accessToken]);

		expect(result).not.toContain(apiKey);
		expect(result).not.toContain(accessToken);
		expect(result).toContain("[REDACTED]");
	});

	it("rejects unusable log response shapes instead of inventing cost", () => {
		expect(() => parseTokfanConsumeLogs({ success: false, message: "disabled" })).toThrow("success=false");
		expect(() => parseTokfanConsumeLogs({ success: true, data: {} })).toThrow("neither data[] nor data.items[]");
	});
});
