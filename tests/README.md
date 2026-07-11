# End-to-end tests

Repository-level Playwright tests launch the compiled coding-agent as a real
process. Workspace unit and integration tests remain under `pi/*/test` and
`HarnessComponentProtocol/test`.

| Project | Test | External model credentials |
|---|---|---|
| `cli-conversation` | One-shot conversation, tools, JSON output, attachments, and system prompts | Required |
| `tui-tests` | TUI boot, conversation, slash command, and tool execution through a real PTY | Required |
| `lazypi-tests` | Static retirement and ownership-boundary assertions | Not required |

The suite is sequential (`workers: 1`) because tests create CLI/TUI processes
and shared terminal state.

```bash
npm run build

npx playwright test
npx playwright test --project cli-conversation
npx playwright test --project tui-tests
npx playwright test --project lazypi-tests
```

`npm test` runs workspace tests; it does not invoke this root Playwright suite.
`./test.sh` runs workspace tests with an isolated temporary `HOME` and clears
provider environment variables. This hides Magenta, Claude Code, Codex, AWS,
and other home-directory credentials without moving the user's real files.

Live CLI/TUI tests can incur provider usage. Confirm authentication and the
selected model before running them; see
[`docs/AUTHENTICATION.md`](../docs/AUTHENTICATION.md).
