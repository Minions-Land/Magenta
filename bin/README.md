# Magenta launchers

`bin/magenta` is the repository launcher for the built coding-agent CLI.
`bin/api` currently follows the same execution path and is retained as a
compatibility alias.

Both scripts:

1. resolve `pi/coding-agent/dist/cli.js` relative to the script location;
2. prepend `bin/` to `PATH` so child Magenta processes can launch `magenta`;
3. pass every argument through unchanged.

Credential discovery is implemented by the TypeScript CLI, not by these shell
scripts. The external credential loader checks environment variables first,
then Claude Code (`~/.claude/settings.json`), then Codex
(`~/.codex/auth.json` and `~/.codex/config.toml`). Stored Magenta credentials
and CLI overrides have their own precedence; see
[`docs/AUTHENTICATION.md`](../docs/AUTHENTICATION.md).

## Usage

Build once from the repository root, then launch from any working directory:

```bash
npm install
npm run build

./bin/magenta
./bin/magenta -p "Summarize this repository"
./bin/magenta --help
```

The npm package exposes the same compiled entry point as the `magenta` binary.
