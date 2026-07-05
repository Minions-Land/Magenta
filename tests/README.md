# tests/

Repo-level end-to-end tests. These drive the built CLI/TUI as a real process,
so they complement (not replace) the per-package unit tests under each
workspace and `harness/`.

## Layout

```
tests/
└── e2e/                        # Playwright end-to-end specs
    ├── cli-conversation.test.ts  # real CLI conversation via external auth
    ├── tui.test.ts               # interactive TUI over a real PTY
    └── lazypi.test.ts            # extension-retirement / harness boundary checks
```

Configuration lives in [`playwright.config.ts`](../playwright.config.ts) at the
repo root. Tests run sequentially (`workers: 1`) because they share the CLI/TUI
process and terminal.

## What each spec covers

- `cli-conversation.test.ts` — one-shot prompts against a live model: simple
  reply, `read`/`bash`/`write` tool use, JSON output mode, `@` file attachments,
  and `--system-prompt` handling. Needs working credentials.
- `tui.test.ts` — boots the TUI in a real pseudo-terminal, checks the input
  prompt renders, holds a conversation, runs a slash command (`/help`), and uses
  a tool interactively. Needs credentials.
- `lazypi.test.ts` — structural assertions that retired built-in extensions are
  gone, migrated UX features live in Pi core/TUI, and reusable tools live in the
  harness. No model calls.

## Running

```bash
npm run build          # e2e drives the built CLI, so build first
npx playwright test                          # all e2e specs
npx playwright test tests/e2e/tui.test.ts    # a single spec
npx playwright test --project tui-tests      # a configured project
```

> [!NOTE]
> The conversation and TUI specs make real model calls and need credentials in
> the environment (see [`docs/AUTHENTICATION.md`](../docs/AUTHENTICATION.md)).
> `test.sh` at the repo root sets up an isolated, key-stripped environment for
> provider/auth test runs.
