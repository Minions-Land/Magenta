# Magenta Documentation

Magenta is the terminal coding agent built by this repository. Its executable is `magenta`; its default user directory is `~/.magenta/agent`, and project-local resources live under `.magenta/`.

The published package and TypeScript APIs retain `@earendil-works/pi-*` and some `pi` identifiers for compatibility. Those identifiers do not change the CLI command.

## Quick Start

Magenta requires Node.js 22.19.0 or newer.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
magenta
```

Authenticate from the TUI with `/login`, provide an API key in the environment, or use supported external Claude Code/Codex credentials. See [Quickstart](quickstart.md) and [Providers](providers.md).

To run this repository checkout:

```bash
npm install
npm run build
node pi/coding-agent/dist/cli.js
```

## Start Here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session
- [Using Magenta](usage.md) - TUI, slash commands, context files, and CLI reference
- [Providers](providers.md) - authentication and provider setup
- [Models](models.md) - custom models and model-specific reasoning levels
- [Settings](settings.md) - user and project configuration
- [Security](security.md) - trust and process-permission boundaries
- [Sessions](sessions.md) - persistence, branching, and navigation
- [Compaction](compaction.md) - context compaction and branch summaries

## Customization

- [Extensions](extensions.md) - TypeScript tools, commands, events, and UI
- [Skills](skills.md) - reusable Agent Skills
- [Prompt templates](prompt-templates.md) - slash-expanded prompts
- [Themes](themes.md) - terminal themes
- [Extension packages](packages.md) - npm, git, HTTPS, SSH, and local packages
- [Custom providers](custom-provider.md) - extension-owned APIs and OAuth

Extension APIs and package manifest keys preserve their upstream `pi` names. Harness domain packages are a separate input: an external cache should be passed with `--harness-packages-root`; without it, Magenta checks only `<current-workspace>/packages`. It does not scan sibling directories or require a package submodule. Future GitHub acquisition is outside the current loader.

## Integration

- [SDK](sdk.md) - embed the coding agent in Node.js
- [RPC](rpc.md) - integrate over stdin/stdout JSONL
- [JSON mode](json.md) - consume structured one-shot events
- [TUI](tui.md) - build extension UI components
- [Session format](session-format.md) - JSONL schema and SessionManager API

## Platform And Development

- [Development](development.md)
- [Containerization](containerization.md)
- [Windows](windows.md)
- [Termux](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)
