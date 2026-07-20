# Tok.fan Billing Calibration

This is an opt-in live test for comparing the **actual Tok.fan charge** of real Claude Code and real Magenta. It does not use the Magenta TUI price display or the catalog prices in `pi-ai`.

The test reads Tok.fan consume logs (`type=2`) and treats each log's `quota` as authoritative. Cache token fields are reported as supporting evidence. A balance change is not used as the primary result because New API can pre-consume, refund, and batch-update quota.

## Safety

The test is dry-run unless `--live` is supplied. Live mode also requires:

```bash
export TOKFAN_BILLING_CONFIRM=I_UNDERSTAND_THIS_SPENDS_REAL_BALANCE
export TOKFAN_API_KEY='the dedicated Tok.fan API token'
export TOKFAN_TOKEN_NAME='the dedicated token name'
export TOKFAN_MAX_QUOTA='raw Tok.fan quota-unit stop budget'
```

Use a dedicated, finite-quota Tok.fan API token exclusively for the two clients launched by this run. Set that token's remaining raw quota to no more than `TOKFAN_MAX_QUOTA`. Live mode probes `GET /api/usage/token` and aborts before any model request if the token is unlimited, exhausted, belongs to a different token name, or has more remaining quota than the configured cap. Tok.fan then enforces the actual maximum spend at the token boundary.

The token-log endpoint (`GET /api/log/token`) is preferred because it scopes records to that token and does not require an administrator credential. If that endpoint is unavailable, provide the user access token and user ID for the read-only fallback:

```bash
export TOKFAN_USER_ACCESS_TOKEN='user access token'
export TOKFAN_USER_ID='matching New-Api user id'
```

The access token is only held in memory. It is never written to the report or passed to either model client. The report contains quota integers, token counts, model/channel IDs, timestamps, and hashed request/session identifiers; it does not contain prompts, responses, API keys, access tokens, or raw headers.

Do not use the account for other requests while the test is running. The harness rejects ambiguous or missing consume-log correlation instead of claiming a cache result.

## Dry Run

From the repository root:

```bash
npx tsx pi/coding-agent/scripts/tokfan-billing-calibration.ts \
  --dry-run --model claude-haiku-4-5 --turns 4 --cohorts 1
```

No provider or Tok.fan request is made by this command.

## Live Run

Build the current coding agent first so the RPC runner uses the intended binary:

```bash
npm --prefix pi/coding-agent run build
```

Then run one inexpensive Haiku cohort before Sonnet:

```bash
TOKFAN_BASE_URL='https://tok.fan' \
TOKFAN_BILLING_CONFIRM='I_UNDERSTAND_THIS_SPENDS_REAL_BALANCE' \
TOKFAN_API_KEY="$TOKFAN_API_KEY" \
TOKFAN_TOKEN_NAME='magenta-cache-calibration' \
TOKFAN_MAX_QUOTA='100000' \
npm --prefix pi/coding-agent run test:tokfan-billing -- \
  --live --model claude-haiku-4-5 --turns 4 --cohorts 1 \
  --output /tmp/tokfan-haiku-billing.json
```

For Sonnet, replace only the model ID. `--profile core` (the default) uses each client's normal built-in tools with local customizations disabled. `--profile minimal` disables tools in both clients and is a transport/cache-control experiment rather than a product-level comparison.

The clients are run serially in a deterministic but seed-controlled order. Each client gets a fresh session, then one cold turn and three warm turns inside the same session. The prompt is fixed and asks for `OK`; tool calls are forbidden by the prompt and each client is limited to one model turn per prompt.

## Reading Results

Each turn reports:

- `chargedQuota`: the sum of Tok.fan's authoritative `quota` fields for that turn.
- The hard spend boundary is the dedicated token's finite remaining quota, verified before the first request and every later turn. The harness also checks accumulated consume-log quota as a secondary circuit breaker.
- `requestCount`: detects retries or hidden extra model calls.
- `usage.cacheRead` and `usage.cacheWrite`: provider/router-reported cache components when Tok.fan exposes them.
- `cacheableReuseRate`: `cacheRead / (cacheRead + cacheWrite)`, kept separate from actual charge.
- `channels` and `observedModels`: detects route/model changes.

Each paired cohort reports:

- `warmToColdRatio` for each client.
- `magentaToClaudeWarmQuotaRatio`: actual Magenta warm-turn quota divided by actual Claude Code warm-turn quota.
- The comparison is invalid if logs are missing, the model was remapped, or request counts exceed the configured limit.

For a later regression gate, pass `--max-magenta-warm-ratio N` (or set `TOKFAN_MAX_MAGENTA_WARM_RATIO`). The test writes the report first and then exits non-zero if Magenta exceeds that ratio or the paired logs are not comparable. Choose `N` only after collecting a stable Sonnet/Haiku baseline; it is not a universal cache threshold.

The pure parsing/statistics checks run with the normal coding-agent tests:

```bash
npm --prefix pi/coding-agent exec vitest --run test/tokfan-billing-calibration.test.ts
```
