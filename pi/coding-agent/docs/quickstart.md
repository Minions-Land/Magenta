# Quickstart

This page gets the `magenta` TUI running in a project.

## Install

Node.js 22.19.0 or newer is required.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

The npm package name retains its upstream compatibility name, but it installs the `magenta` executable.

To uninstall, use the same package manager that installed it:

```bash
npm uninstall -g @earendil-works/pi-coding-agent
# or: pnpm remove -g / yarn global remove / bun uninstall -g
```

Uninstalling the package does not remove settings, credentials, sessions, or installed extension packages under `~/.magenta/agent/`.

To use the repository checkout instead:

```bash
npm install
npm run build
node pi/coding-agent/dist/cli.js
```

## Authenticate

Start Magenta in the project it should work on:

```bash
cd /path/to/project
magenta
```

Then run `/login`. Choose either a subscription login or an API-key provider. Stored credentials are written to `~/.magenta/agent/auth.json`.

Environment variables also work:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
magenta
```

Magenta can reuse supported external configuration when its own credential is absent:

- `~/.claude/settings.json`: Anthropic token/key, endpoint, and model fields
- `~/.codex/auth.json`: `OPENAI_API_KEY`
- `~/.codex/config.toml`: the active Codex provider's endpoint and default model

See [Providers](providers.md) for exact precedence and provider-specific environment variables.

## First Session

Type a request and press Enter:

```text
Summarize this repository and run its documented checks.
```

The default active tools are `read`, `bash`, `edit`, `write`, `bg_shell`,
`sub_agent`, `web-search`, and `web-fetch`. The two web tools are autoloaded
through HCP. `grep`, `find`, and `ls` are available as optional read-only tools.
All tools and extensions run with the permissions of the Magenta process;
project trust is not a sandbox.

## Project Instructions

Add an `AGENTS.md` file to the repository:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Magenta loads:

- `~/.magenta/agent/AGENTS.md` for user-wide instructions
- `AGENTS.md` or `CLAUDE.md` while walking from filesystem ancestors to the current directory

Run `/refresh` after changing resources in an active session. Use `/reload` only when you need to recompile Magenta and restart the TUI while retaining the current session. Context files are read independently of project trust; executable project resources under `.magenta/` require trust.

## Models And Reasoning

Use `/model` or Ctrl+L to select a configured model. Shift+Tab cycles only the reasoning levels supported by that model.

Built-in GPT-5.6 entries for OpenAI, Azure OpenAI Responses, and OpenRouter support `off`, `low`, `medium`, `high`, `xhigh`, and `max`. They do not support `minimal` or `ultra`; `max` is their highest GPT-5.6 level.

```bash
magenta --model openai/gpt-5.6-sol:max
```

## Common Workflows

Reference files with `@`:

```bash
magenta @README.md "Summarize this"
magenta @src/app.ts @src/app.test.ts "Review these together"
```

Run a one-shot prompt:

```bash
magenta -p "Summarize this codebase"
cat README.md | magenta -p "Summarize this text"
magenta -p @screenshot.png "What is shown here?"
```

Continue work later:

```bash
magenta -c                  # most recent session
magenta -r                  # session picker
magenta --name "my task"    # named session
magenta --session <path|id> # exact file or matching ID
```

In the TUI, `/tree`, `/fork`, and `/clone` operate on session history. `/compact` summarizes older context without deleting the JSONL history.

## Next Steps

- [Using Magenta](usage.md)
- [Providers](providers.md)
- [Models](models.md)
- [Settings](settings.md)
- [Security](security.md)
- [Sessions](sessions.md)
