# Magenta Coding Agent

Magenta is an autonomous terminal coding agent. The installed executable, application name, and user configuration directory are:

```text
command:     magenta
user state:  ~/.magenta/agent/
project:     .magenta/
```

Magenta supports interactive TUI, one-shot text output, JSON event output, RPC integration, and an embeddable SDK. Its coding tools are assembled through the Harness Component Protocol implementation.

## Requirements

- Node.js 22.19.0 or newer
- npm and a terminal with 24-bit color support recommended

## Install

### One-line installation (Recommended)

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash
```

Windows PowerShell 5.1 or later:

```powershell
irm https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/install.ps1 | iex
```

The installers download the pre-compiled binary and its version-matched runtime resources. Windows installation also runs a startup check before replacing an existing installation.

### Manual installation

Download the appropriate binary from [GitHub Releases](https://github.com/Minions-Land/Magenta-CLI/releases):

```bash
# macOS arm64
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos-arm64 -o ~/.local/bin/magenta
chmod +x ~/.local/bin/magenta

# Download runtime resources
cd ~/.local/bin
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-resources-universal.tar.gz | tar -xz

# Run
magenta
```

### From source

Requires Node.js 22.19.0+, Bun, and Rust toolchain:

```bash
git clone https://github.com/Minions-Land/Magenta.git
cd Magenta
npm install
npm run build:release-all
```

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
off, minimal, low, medium, high, xhigh, max, ultra
```

The native levels are a vocabulary, not a claim that every model supports every value. Model metadata supplies the actual mapping. `ultra` is different: it is a Magenta execution profile that maps to the selected model's highest native level and enables workflow and managed-teammate capabilities by default. It does not dispatch work automatically. Providers never receive `ultra` as a thinking value.

Examples:

```bash
magenta --model openai/gpt-5.6-sol:max
magenta --provider anthropic --model claude-sonnet-4-6 --thinking high
magenta --list-models gpt-5.6
```

The CLI accepts every native value plus `ultra` for `--thinking`, then resolves it against the selected model. Prefer the TUI selector when you need to see the exact supported subset.

## Interactive Use

Magenta starts in interactive mode when no print mode is requested:

```bash
cd /path/to/project
magenta
```

The native tools active by default are `read`, `bash`, `edit`, `write`,
`bg_shell`, `sub_agent`, `send_message`, `show`, `grep`, `find`, and `ls`.
HCP also activates `lsp`, `todo`, `web-search`, and `web-fetch` by default.
Standard profiles expose sessionless, one-shot `sub_agent` workers but omit
workflow templates and `multiagent`. Ultra enables both capabilities by
default without dispatching work automatically. It also makes the low-frequency,
real-activity-based background stall reminder proactive through the shared
external activation coordinator. `harness.workflows` and `harness.teammates` can
override either delegation capability.

A workflow orchestrates sessionless, one-shot workers through named presets with
fixed runtime-owned control flow. The public `sub_agent` tool does not execute
model-authored inline JavaScript; trusted programmatic workflow modules remain
an internal Harness capability. Use `multiagent` for a persistent teammate
Session when retained context, repeated collaboration, or explicit worktree
ownership matters. Lifecycle actions target only the returned Session id;
ordinary prompts and reports use `send_message`. Editing teammates can use
`workspace="worktree"`; Magenta creates versioned Main-Session-scoped checkouts
under `.magenta/tmp/collaboration/` and integrates or discards verified receipts
explicitly. Main shutdown preserves desired state and unintegrated generations
for exact-lineage recovery. There is no Assignment or blocking wait API. Use `--tools`, `--exclude-tools`,
`--no-tools`, or `--no-builtin-tools` to control the active set.

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
| `/side`, `/btw`, `/s` | Browse this main session's Side/BTW history or start a no-tools conversation |
| `/refresh` | Refresh settings, keybindings, extensions, skills, prompts, themes, and context files in process |
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

Side/BTW conversations are persisted as non-context session entries and reopen through a history menu. Their editor supports multiline input and bracketed paste; inside the window, Ctrl+C copies the current draft or latest message and Ctrl+T requests a human-confirmed teammate handoff. A handoff creates an invitation-only managed child from a bounded transcript. The child must message the main session to discuss and request dispatch; no assignment or ownership lease exists until the main agent formally assigns one.

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
magenta --validate-config --mode json --no-session
magenta --ssh user@host:/workspace
```

Print mode emits the final text response. JSON mode emits versioned JSONL with a `runtime_manifest`, the complete agent event stream, and one terminal `run_end`; its exit code agrees with that terminal status. RPC mode accepts JSONL commands on stdin and writes responses and events to stdout, including a startup manifest and graceful `shutdown` control.

Headless runs default to `--background-policy cancel`, preserving one-shot cleanup while reporting every cancelled background event in `run_end`. Use `wait` with `--background-wait-timeout`, or `error` to fail when the main agent leaves work running. Blocking extension UI defaults to an observable deny; `--non-interactive-ui error` makes any such request fail the run. `--harness-workflows` and `--harness-teammates` enable those capabilities independently of the selected thinking profile.

A source-built reference image is provided in [`Dockerfile.headless`](../../Dockerfile.headless). See [docs/json.md](docs/json.md), [docs/rpc.md](docs/rpc.md), [docs/containerization.md](docs/containerization.md), and [docs/sdk.md](docs/sdk.md).

## Customization

Magenta provides several extension surfaces:

- [Extensions](docs/extensions.md): TypeScript tools, commands, events, flags, and UI
- [Skills](docs/skills.md): reusable Agent Skills
- [Prompt templates](docs/prompt-templates.md): slash-expanded prompts
- [Themes](docs/themes.md): terminal color schemes
- [Custom models](docs/models.md): supported API definitions in `models.json`
- [Custom providers](docs/custom-provider.md): extension-owned APIs or OAuth

An extension's conventional parameter is still named `pi` because that is the public compatibility API:

```typescript
import type { ExtensionAPI } from "magenta";

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
2. Harness domain packages provide Harness components. The CLI selects them with `--harness-package`, `MAGENTA_HARNESS_PACKAGES`, or the compatibility variable `PI_HARNESS_PACKAGES`, then feeds their components into the ordinary Harness assembly path. A selector may name a local package or a versioned GitHub release. `--harness-packages-root` supplies an external root for local selectors; without it, Magenta falls back only to `<current-workspace>/packages`.

The loader does not scan sibling directories and does not require a
`MagentaPackages` checkout or submodule. For
`github:owner/repo/Package@version`, Magenta downloads the current platform's
release archive and checksum, validates both the archive and schema-v2
manifest, and caches the verified package before passing its root into the same
loader. `/harness package` also discovers official releases; selecting
**Download & load** performs this acquisition automatically and keeps the
verified cache when the Package is later unloaded.

```bash
magenta --harness-list
magenta --harness-packages-root /verified/cache/root --harness-package ExamplePackage
magenta --harness-package github:Minions-Land/Magenta-CLI/ClaudeScience@0.1.0
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
| `MAGENTA_PEER_MESSAGE_DB` | Override the shared peer-message mailbox path (used by managed teammates) |
| `PI_OFFLINE=1` | Disable startup network operations |
| `PI_TELEMETRY=0` | Disable install telemetry and optional provider attribution |
| `PI_SKIP_VERSION_CHECK=1` | Disable the startup version check |

Some `PI_*` environment names remain compatibility APIs and have not been renamed.

## Documentation

Start with [docs/index.md](docs/index.md), [docs/quickstart.md](docs/quickstart.md), and [docs/usage.md](docs/usage.md). Platform notes are available for [Windows](docs/windows.md), [Termux](docs/termux.md), [tmux](docs/tmux.md), and [terminal setup](docs/terminal-setup.md).

## License

MIT
