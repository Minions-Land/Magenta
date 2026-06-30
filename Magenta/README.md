# Magenta

Magenta is a local TypeScript-first agent workspace built from two reference layers:

- `pi/`: the upstream Pi monorepo, used as the core agent runtime and CLI.
- `LazyPi/`: the personal Pi configuration and extension layer.
- `.pi/agent/`: the active Magenta project config copied from `LazyPi/agent`.

## Development

Install Pi dependencies:

```bash
npm run install:pi
```

Build all Pi packages:

```bash
npm run build
```

Run Magenta from TypeScript sources:

```bash
npm run dev -- --help
```

Run Magenta after building:

```bash
npm run start -- --help
```

The development scripts set `MAGENTA_CODING_AGENT_DIR=$PWD/.pi/agent` so Magenta uses the project-local LazyPi-derived config instead of your global `~/.pi` config.

## Local Credentials

`./.pi/agent/auth.json` is configured to reuse credentials already present on this machine:

- OpenAI/OpenAI Codex: reads `~/.codex/auth.json` at runtime.
- Anthropic/Claude: reads `~/.claude/settings.json` at runtime.

The project auth file stores command references, not copied API keys.

`./.pi/agent/extensions/local-credential-bridge.ts` also reads provider URLs at startup:

- OpenAI provider URL: `~/.codex/config.toml` `model_provider` -> `[model_providers.<name>].base_url`.
- Anthropic provider URL: `~/.claude/settings.json` `env.ANTHROPIC_BASE_URL`.

This keeps Magenta following local Codex and Claude Code config changes without copying keys or URLs into the repo.
