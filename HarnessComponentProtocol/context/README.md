# Context Provider

Workspace context discovery migrated from Magenta1 `context_provider.rs`.

The provider is read-only. It discovers project instruction files such as
`AGENTS.md`, `.magenta/RULES.md`, `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and
`.github/copilot-instructions.md`, expands local `@file` imports outside fenced
code blocks, and returns model-safe context text.
