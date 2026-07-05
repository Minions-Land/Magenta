# bin/

Launcher scripts for the Magenta CLI. Each is a thin bash wrapper that
autodetects credentials, exports them into the environment, then hands off to
the built Pi coding-agent CLI at `pi/coding-agent/dist/cli.js`.

| Script | Purpose |
|---|---|
| `magenta` | Primary launcher for the interactive TUI and one-shot runs |
| `api` | Same launch path, kept for API/scripted entry (comments in Chinese) |

## Credential autodetection

Both scripts resolve credentials in this priority order, only filling a value if
it is not already set:

1. Existing environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …)
2. Codex — `~/.codex/auth.json` (key) + `~/.codex/config.toml` (`base_url`)
3. Claude Code — `~/.claude/settings.json` (`env.ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`)

No secrets are written anywhere — values are exported for the child process only.

## Usage

```bash
./bin/magenta                 # interactive TUI
./bin/magenta -p "prompt"     # one-shot, print result and exit
./bin/magenta --help          # full flag reference
```

> [!NOTE]
> These wrappers require a built CLI. Run `npm run build` from the repo root
> first (they exec `pi/coding-agent/dist/cli.js`).

See [`docs/AUTHENTICATION.md`](../docs/AUTHENTICATION.md) for credential setup
details.
