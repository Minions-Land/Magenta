# Magenta Coding Agent

Magenta is the terminal coding agent in this repository. The npm package is `@earendil-works/pi-coding-agent`, but the installed executable, application name, and user configuration directory are branded for Magenta:

```text
command:     magenta
user state:  ~/.magenta/agent/
project:     .magenta/
```

The package names and extension API retain their upstream `pi` names for compatibility. They are library identifiers, not alternate CLI commands.

Magenta supports interactive TUI, one-shot text output, JSON event output, RPC integration, and an embeddable SDK. Its normal coding tools are assembled through the repository's Harness Component Protocol implementation.

## Requirements

- Node.js 22.19.0 or newer
- npm and a terminal with 24-bit color support recommended

## Install

Install the published package globally:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
magenta
```

`--ignore-scripts` prevents dependency lifecycle scripts. The package does not require install scripts for normal npm use.

Build and run the current repository checkout:

```bash
git clone git@github.com:Minions-Land/Magenta.git
cd Magenta
npm install
npm run build
node pi/coding-agent/dist/cli.js
```

Useful repository checks:

```bash
npm run check
npm test
```

See [docs/development.md](docs/development.md) for focused package commands.

## Authentication

The interactive `/login` command supports both subscription OAuth and stored API keys. `/logout` removes only credentials saved by `/login`; it does not modify shell environment variables or external tool configuration.

```bash
magenta
# Run /login, choose a method, then choose a provider.
```

You can also provide credentials in the environment:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
magenta
```

Credentials saved by Magenta live in `~/.magenta/agent/auth.json` with user-only file permissions. The runtime can also reuse:

- Anthropic credentials and endpoint settings from `~/.claude/settings.json`
- an `OPENAI_API_KEY` from `~/.codex/auth.json`, plus the active provider endpoint from `~/.codex/config.toml`

Environment credentials take precedence over those external files. Explicit `--api-key` and credentials in Magenta's own `auth.json` take precedence over both. See [docs/providers.md](docs/providers.md) for the complete provider and resolution reference.

## Models And Reasoning

Use `/model` or Ctrl+L to select a configured model. Use Shift+Tab to cycle only the reasoning levels supported by that model; unsupported choices are omitted from the selector.

The shared reasoning vocabulary is:

```text
off, minimal, low, medium, high, xhigh, max
```

This is a vocabulary, not a claim that every model supports every value. Model metadata supplies the actual mapping. Built-in GPT-5.6 entries for OpenAI, Azure OpenAI Responses, and OpenRouter expose `off`, `low`, `medium`, `high`, `xhigh`, and `max`; they do not expose `minimal`, and Magenta does not support an `ultra` level. `max` is their highest GPT-5.6 request value.

Examples:

```bash
magenta --model openai/gpt-5.6-sol:max
magenta --provider anthropic --model claude-sonnet-4-6 --thinking high
magenta --list-models gpt-5.6
```

The CLI accepts every library-level value for `--thinking`, then resolves it against the selected model. Prefer the TUI selector when you need to see the exact supported subset.

## Interactive Use

Magenta starts in interactive mode when no print mode is requested:

```bash
cd /path/to/project
magenta
```

The default coding surface includes `read`, `bash`, `edit`, `write`, `bg_shell`,
`sub_agent`, `web-search`, and `web-fetch`. The two web tools are autoloaded
through HCP. Read-only `grep`, `find`, and `ls` tools are available but disabled
by default. Use `--tools`, `--exclude-tools`, `--no-tools`, or
`--no-builtin-tools` to control the active set.

Common commands:

| Command | Purpose |
|---|---|
| `/login`, `/logout` | Add or remove stored provider credentials |
| `/model` | Select a configured model |
| `/scoped-models` | Control the Ctrl+P model cycle |
| `/settings` | Configure reasoning, theme, delivery, transport, trust, and compaction |
| `/resume`, `/new` | Resume a session or start a new one |
| `/session` | Inspect current session identity and usage |
| `/tree`, `/fork`, `/clone` | Navigate or branch session history |
| `/compact [prompt]` | Compact the current context |
| `/refresh` | Refresh settings, keybindings, extensions, skills, prompts, and themes in process |
| `/reload` | Recompile Magenta and restart the TUI with the current session |
| `/hotkeys` | Show all active keybindings |
| `/quit` | Exit |

Common keys:

| Key | Action |
|---|---|
| Ctrl+L | Select model |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models |
| Shift+Tab | Cycle supported reasoning levels |
| Ctrl+O | Expand or collapse tool output |
| Ctrl+T | Expand or collapse reasoning blocks |
| Escape | Abort the active run |
| Ctrl+C twice | Exit |

Type `@` to search project files. Prefix a shell command with `!` to run it and send its output to the model, or `!!` to run it without adding output to model context.

## Sessions

Sessions are JSONL trees stored under `~/.magenta/agent/sessions/`, grouped by working directory.

```bash
magenta -c                  # continue the most recent session
magenta -r                  # select a previous session
magenta --no-session        # ephemeral run
magenta --name "release"   # name a new session
magenta --session <path|id> # open by path or partial ID
magenta --fork <path|id>    # fork into a new session file
```

See [docs/sessions.md](docs/sessions.md) and [docs/session-format.md](docs/session-format.md).

## Configuration

| Path | Scope |
|---|---|
| `~/.magenta/agent/settings.json` | User settings |
| `.magenta/settings.json` | Project settings |
| `~/.magenta/agent/auth.json` | Stored API-key and OAuth credentials |
| `~/.magenta/agent/models.json` | Custom models and provider overrides |
| `~/.magenta/agent/keybindings.json` | Keybinding overrides |
| `~/.magenta/agent/AGENTS.md` | User-wide instructions |
| `AGENTS.md` or `CLAUDE.md` | Project instructions, discovered from ancestors through cwd |

Project-local settings and executable resources are loaded only after project trust is resolved. Trust is an input-loading guard, not a sandbox. Magenta's tools and extensions run with the permissions of the Magenta process. See [docs/settings.md](docs/settings.md) and [docs/security.md](docs/security.md).

## Non-Interactive Modes

```bash
magenta -p "Summarize this repository"
cat build.log | magenta -p "Explain this failure"
magenta --mode json -p "Review src/"
magenta --mode rpc
magenta --ssh user@host:/workspace
```

Print mode emits the final text response. JSON mode emits JSONL events. RPC mode accepts JSONL commands on stdin and writes responses and events to stdout. See [docs/json.md](docs/json.md), [docs/rpc.md](docs/rpc.md), and [docs/sdk.md](docs/sdk.md).

## Customization

Magenta preserves the upstream extension surfaces:

- [Extensions](docs/extensions.md): TypeScript tools, commands, events, flags, and UI
- [Skills](docs/skills.md): reusable Agent Skills
- [Prompt templates](docs/prompt-templates.md): slash-expanded prompts
- [Themes](docs/themes.md): terminal color schemes
- [Custom models](docs/models.md): supported API definitions in `models.json`
- [Custom providers](docs/custom-provider.md): extension-owned APIs or OAuth

An extension's conventional parameter is still named `pi` because that is the public compatibility API:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("status", {
    description: "Show project status",
    handler: async (_args, ctx) => ctx.ui.notify("Ready", "info"),
  });
}
```

## Package Boundaries

Two package surfaces must not be conflated:

1. Extension packages bundle extensions, skills, prompts, and themes. `magenta install`, `remove`, `list`, `update`, and `config` manage these npm, git, HTTPS, SSH, or local sources. Their package manifest key remains `pi` for compatibility.
2. Harness domain packages provide Harness components. The CLI selects them with `--harness-package`, `MAGENTA_HARNESS_PACKAGES`, or the compatibility variable `PI_HARNESS_PACKAGES`, then feeds their components into the ordinary Harness assembly path. `--harness-packages-root` should point at an externally prepared and verified cache root. Without it, Magenta falls back only to `<current-workspace>/packages`.

The loader does not scan sibling directories and does not require a `MagentaPackages` checkout or submodule. Future domain-package acquisition is expected to download and verify GitHub-hosted packages into a local cache before passing that cache as the package root. That network acquisition layer is not implemented here yet.

```bash
magenta --harness-list
magenta --harness-packages-root /verified/cache/root --harness-package ExamplePackage
```

See [docs/packages.md](docs/packages.md) for extension packages. Harness package architecture is documented with `@magenta/harness`.

## CLI Reference

The executable is the authoritative CLI reference:

```bash
magenta --help
magenta install --help
magenta update --help
```

Important environment variables:

| Variable | Purpose |
|---|---|
| `MAGENTA_CODING_AGENT_DIR` | Override `~/.magenta/agent` |
| `MAGENTA_CODING_AGENT_SESSION_DIR` | Override the session directory |
| `MAGENTA_HARNESS_PACKAGES` | Comma-separated Harness package selectors |
| `PI_OFFLINE=1` | Disable startup network operations |
| `PI_TELEMETRY=0` | Disable install telemetry and optional provider attribution |
| `PI_SKIP_VERSION_CHECK=1` | Disable the startup version check |

Some `PI_*` environment names remain compatibility APIs and have not been renamed.

## Documentation

Start with [docs/index.md](docs/index.md), [docs/quickstart.md](docs/quickstart.md), and [docs/usage.md](docs/usage.md). Platform notes are available for [Windows](docs/windows.md), [Termux](docs/termux.md), [tmux](docs/tmux.md), and [terminal setup](docs/terminal-setup.md).

## License

MIT
