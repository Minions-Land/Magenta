# Context Provider

The `context` Harness Module provides the selected workspace-context Capability.
`HcpServer.ts` owns its HCP endpoint, `context.toml` selects the `magenta`
Source, and `magenta/HcpMagnet.ts` builds the provider.

The provider is read-only. It discovers project instruction files such as
`AGENTS.md`, `.magenta/RULES.md`, `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and
`.github/copilot-instructions.md`, expands local `@file` imports outside fenced
code blocks, and returns model-safe context text. The implementation was adapted
from Magenta1 `context_provider.rs` and enters sessions through the generated
`HCP_SERVERS` and `HCP_MAGNETS` declarations.
