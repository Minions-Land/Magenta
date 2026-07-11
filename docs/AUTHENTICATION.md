# Authentication

Magenta can use credentials stored by Magenta, supplied for the current
process, or discovered from compatible local tools. User login state is stored
under the active Magenta agent directory, normally:

```text
~/.magenta/agent/auth.json
```

## Recommended Setup

Start the TUI and run `/login`:

```bash
./bin/magenta
```

```text
/login
```

The provider selector performs the supported OAuth or credential flow and
writes the result to `auth.json`. `/logout` removes stored credentials for a
provider.

For API keys, environment variables are also straightforward:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...

./bin/magenta --provider anthropic --model claude-sonnet-4-5
```

Run `./bin/magenta --help` for the common environment variables documented by
the CLI.

## Lookup Order

For a provider request, Magenta resolves credentials in this order:

1. Runtime `--api-key` override
2. Provider credential stored in `~/.magenta/agent/auth.json`
3. Compatible external credential discovery
4. Provider environment fallback

External discovery itself is first-match per provider:

1. Process environment
2. Claude Code settings
3. Codex credentials

Environment discovery currently handles the common Anthropic, OpenAI, and
Google variables directly. The provider layer supplies fallback mappings for
the broader provider set.

## External Tool Discovery

### Claude Code

Magenta reads:

```text
~/.claude/settings.json
```

It looks inside the top-level `env` object for
`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, plus optional
`ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` values. Magenta does not modify this
file.

### Codex

Magenta reads:

```text
~/.codex/auth.json
~/.codex/config.toml
```

`auth.json` can provide `OPENAI_API_KEY`. `config.toml` can provide the active
model provider's `base_url` and a top-level default `model`. Magenta does not
modify either file.

This integration expects the current `~/.codex/` layout; `~/.openai/auth.json`
is not the configured lookup path.

## Common Providers

| Provider | Environment variable |
|---|---|
| Anthropic | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` plus endpoint settings |
| OpenRouter | `OPENROUTER_API_KEY` |
| Amazon Bedrock | Standard AWS profile, key, region, or bearer-token variables |

Provider-specific base URLs and additional variables are implemented in
`pi/ai/src/providers/`; `./bin/magenta --help` lists the common user-facing
subset.

## Custom Agent Directory

Override the default Magenta agent directory with:

```bash
export MAGENTA_CODING_AGENT_DIR=/absolute/path/to/agent-state
```

This changes the location of `auth.json`, `settings.json`, models, themes, and
related agent state. Session storage can be overridden separately with
`MAGENTA_CODING_AGENT_SESSION_DIR` or `--session-dir`.

## Verification

List models visible with the configured credentials:

```bash
./bin/magenta --list-models
```

Then make a minimal live call:

```bash
./bin/magenta --provider openai --model gpt-5.6-sol --print --no-session "Reply with OK"
```

`--version` only prints application metadata; it does not verify a provider
credential.

## Security

- Do not pass secrets in shell history unless the environment permits it;
  prefer `/login` or environment management over `--api-key` for routine use.
- Never commit `auth.json`, `.env` files, session exports, or provider tokens.
- External Claude Code and Codex files are read-only inputs to Magenta.
- Treat custom base URLs as privileged configuration because they receive model
  prompts and credentials.
- Use a separate `MAGENTA_CODING_AGENT_DIR` for isolated development or test
  runs.

## Troubleshooting

**No models are available**

- Confirm the provider name and corresponding environment variable.
- Run `./bin/magenta --list-models <search>`.
- Inspect `/login` and `/logout` state in the TUI.
- Check that the expected external credential file exists and is valid JSON or
  TOML.

**Claude Code credentials are ignored**

- Confirm the token is in `~/.claude/settings.json` under `env`, not in an
  unrelated file.
- An existing process environment credential wins for the same provider.

**Codex endpoint or model is wrong**

- Confirm `~/.codex/config.toml` declares the intended top-level
  `model_provider`.
- Put `base_url` in that provider's `[model_providers.<name>]` table.
- A process `OPENAI_API_KEY` takes precedence over Codex discovery.

**Stored OAuth expired**

- Magenta attempts a locked refresh automatically.
- If refresh fails, run `/login` again; credentials remain stored for retry.
