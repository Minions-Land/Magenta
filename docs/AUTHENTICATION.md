# Authentication

Magenta resolves credentials at runtime through the coding agent's `AuthStorage`. Use the interactive `/login` flow for managed credentials, environment variables for ephemeral automation, or an explicitly configured custom model command when a secret manager must supply the key.

## Interactive Login

Start Magenta and run:

```text
/login
```

The dialog shows the login methods registered by the installed provider adapters. Depending on the provider, it stores either an API key or refreshable OAuth credentials in:

```text
~/.magenta/agent/auth.json
```

The parent directory is created with user-only permissions and the file is written with mode `0600` on platforms that support POSIX permissions. Writes and OAuth refreshes use a file lock so concurrent Magenta processes do not overwrite one another.

Use `/logout` to remove a stored provider credential. Do not hand-edit `auth.json` while Magenta is running.

## Environment Variables

Magenta supports the provider environment variables listed by:

```bash
magenta --help
```

Common examples include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`. Base URL variables are also honored where the provider supports an alternate endpoint. Set credentials in the process environment or a secret manager, not in a committed shell script or repository `.env` file.

For built-in Anthropic, OpenAI, and Google routes, the external-auth loader also understands their documented token aliases and endpoint variables. The model registry remains the authority for which providers and models are available in the current build; inspect it with `magenta --list-models` rather than relying on a static list here.

## Existing Tool Credentials

Without copying credentials into Magenta, the external-auth loader can reuse:

- Anthropic configuration from `~/.claude/settings.json`, including its top-level `env` values.
- OpenAI configuration from `~/.codex/auth.json`, with endpoint and model metadata from `~/.codex/config.toml`.

Malformed files are ignored. Environment values take priority within this external-loader path. A credential explicitly stored by Magenta still takes priority over these external files.

## Resolution Order

For a model request, credential resolution is:

1. A runtime override supplied by the caller or `--api-key`.
2. A Magenta API key stored in `auth.json`.
3. Magenta OAuth credentials in `auth.json`, refreshed under a lock when needed.
4. A supported external environment or local-tool credential.
5. A provider's normal environment fallback when fallback lookup is enabled.

Custom models in `~/.magenta/agent/models.json` may use a literal `apiKey` or an `apiKeyCommand`. Prefer `apiKeyCommand` for long-lived secrets because its stdout is resolved only when needed. See [custom providers](../pi/coding-agent/docs/custom-provider.md) for the schema and process behavior.

## Isolated Configuration

Set `MAGENTA_CODING_AGENT_DIR` to use a different agent configuration directory. This changes the location of `auth.json`, models, settings, and related user resources for that process:

```bash
MAGENTA_CODING_AGENT_DIR=/secure/path/to/agent magenta
```

This is useful for CI or separate work identities. Protect the selected directory with operating-system permissions.

## Security Boundaries

- Never commit API keys, OAuth tokens, private Package credentials, or populated MCP headers.
- `--api-key` is process-scoped but may be visible to local process inspection or shell history; prefer an environment supplied by a secret manager.
- `auth.json` is sensitive even with restricted permissions. Back it up only to encrypted storage.
- MCP server `env` and `headers` can contain secrets and are passed to child processes or remote endpoints. Their values are not printed in MCP diagnostics, but the configuration file remains user-owned sensitive data.
- Extensions, Packages, hooks, tools, and MCP servers execute with delegated access. Install only trusted code and review its configuration before exposing credentials.

For implementation details, see [`auth-storage.ts`](../pi/coding-agent/src/core/auth-storage.ts) and [`external-auth-loader.ts`](../pi/coding-agent/src/core/external-auth-loader.ts).
