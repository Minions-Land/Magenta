# Using Magenta

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current execution profile, with a rainbow border for Ultra
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `$VISUAL` or `$EDITOR` |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/refresh` | Refresh keybindings, extensions, skills, prompts, themes, and context files in process |
| `/reload` | Recompile Magenta and restart the TUI with the current session |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit Magenta |

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want Magenta to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.magenta/agent/sessions/`, organized by working directory.

```bash
magenta -c                  # Continue most recent session
magenta -r                  # Browse and select a session
magenta --no-session        # Ephemeral mode; do not save
magenta --name "my task"    # Set session display name at startup
magenta --session <path|id> # Use a specific session file or session ID
magenta --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

Magenta loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.magenta/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.magenta/SYSTEM.md` for a project
- `~/.magenta/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

### Project Trust

On interactive startup, Magenta asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.magenta/agent/trust.json`. Trusting a project allows Magenta to load `.magenta/settings.json` and `.magenta` resources, install missing project extension packages, and execute project extensions.

Before the trust decision, Magenta loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.magenta/agent/settings.json`, or change it with `/settings`.

`magenta config` and extension-package commands use the same project trust flow, except `magenta update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.magenta/agent/trust.json` only; the current session is not reloaded, so restart Magenta for changes to take effect.


## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

Session export and sharing retain their upstream data formats, so existing compatible tooling can consume exported JSONL.

## CLI Reference

```bash
magenta [options] [@files...] [messages...]
```

### Package Commands

```bash
magenta install <source> [-l]       # Install extension package, -l for project-local
magenta remove <source> [-l]        # Remove extension package
magenta uninstall <source> [-l]     # Alias for remove
magenta update [source|self|magenta] # Update Magenta or one extension source
magenta update --all                # Update Magenta and extension packages
magenta update --extensions         # Update extension packages only
magenta update --self               # Update Magenta only
magenta update --extension <src>    # Update one extension package
magenta list                        # List installed extension packages
magenta config                      # Enable/disable extension-package resources
```

These commands manage extension packages, not Harness domain packages. `magenta update` can also update the Magenta CLI installation. To uninstall Magenta itself, see [Quickstart](quickstart.md#install). `magenta config` and project extension-package commands accept `--approve`/`--no-approve`; `magenta update` never prompts for project trust.

See [Extension Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, Magenta also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | magenta -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

The native levels use each model's `thinkingLevelMap`. Ultra is a Magenta execution profile: it maps to the model's highest native level and defaults Harness workflows and teammates on. Providers never receive `ultra` as a thinking value.

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist tool names across every configured source |
| `--exclude-tools <list>`, `-xt <list>` | Disable tool names across every configured source |
| `--no-builtin-tools`, `-nbt` | Disable native application and repository-default HCP tools; keep extension/custom, Package, and user MCP tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Standard profiles activate native `read`, `bash`, `edit`, `write`, `bg_shell`,
`sub_agent`, `send_message`, `show`, `grep`, `find`, and `ls`. They retain one-shot
`sub_agent` tasks but omit workflow templates and `teammate_agent`. Ultra activates
both by default. `harness.workflows` and `harness.teammates` explicitly override
those defaults in either direction. Use `sub_agent` for disposable delegated work
and `teammate_agent` for a persistent hidden collaborator whose assignments and
results travel through `send_message`.

HCP also autoloads `web-search` and `web-fetch`, so both are active by default
unless the tool-selection options disable them.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |
| `--harness-list` | List generated Harness components and selected Sources |
| `--harness-package <selector>` | Select a Harness domain package; repeatable |
| `--harness-packages-root <dir>` | Use an explicit local Harness package root |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
magenta --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
magenta @prompt.md "Answer this"
magenta -p @screenshot.png "What's in this image?"
magenta @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
magenta "List all .ts files in src/"

# Non-interactive
magenta -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | magenta -p "Summarize this text"

# Named one-shot session
magenta --name "release audit" -p "Audit this repository"

# Different model
magenta --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
magenta --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
magenta --model openai/gpt-5.6-sol:max "Solve this complex problem"

# Limit model cycling
magenta --models "claude-*,gpt-5.6*"

# Read-only mode
magenta --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
magenta --exclude-tools ask_question
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MAGENTA_CODING_AGENT_DIR` | Override config directory; default is `~/.magenta/agent` |
| `MAGENTA_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `MAGENTA_HARNESS_PACKAGES` | Comma-separated Harness package selectors |
| `MAGENTA_PEER_MESSAGE_DB` | Override the shared peer-message mailbox path; managed teammates inherit it |
| `PI_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `PI_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `PI_SKIP_VERSION_CHECK` | Skip the startup version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

## Runtime Boundaries

Magenta includes first-class `bg_shell`, `sub_agent`, `send_message`, and
`teammate_agent` tools and can load user MCP tools through the Harness path.
Teammates are clean persistent sessions managed by the parent; their RPC
channel controls lifecycle and interrupt, while work communication uses the
shared peer mailbox. Workflow-specific UI and commands remain extension
surfaces.

Extension packages and Harness domain packages are separate. Local selectors use
`--harness-packages-root` or `<current-workspace>/packages`; Magenta does not
scan sibling directories or require a `MagentaPackages` checkout/submodule.
Versioned `github:owner/repo/Package@version` selectors are downloaded,
SHA-256 verified, and cached under `~/.magenta/harness-packages`. In the TUI,
`/harness package` discovers official releases and **Download & load** performs
that acquisition before reloading the current HCP session.
