# Tool duplication analysis (for C2)

## Finding: pi tool files are WRAPPERS, not duplicates

Each `pi/coding-agent/src/core/tools/<t>.ts` already imports the pure logic from
`@magenta/harness`:

| tool  | imports from harness (logic layer)                                  |
|-------|---------------------------------------------------------------------|
| bash  | createBashExecute, bashSchema, BASH_TOOL_DESCRIPTION, BashToolOptions|
| edit  | createEditExecute, editSchema, computeEditsDiff, prepareEditArguments|
| read  | createReadExecute, readSchema, DEFAULT_MAX_BYTES/LINES, formatSize   |
| write | createWriteExecute, writeSchema                                     |
| grep  | createGrepExecute, grepSchema, GREP_DESCRIPTION, GREP_PROMPT_SNIPPET |
| find  | createFindExecute, findSchema, FIND_DEFAULT_LIMIT                    |
| ls    | createLsExecute, lsSchema, LS_DEFAULT_LIMIT                          |

So the harness `modules/tools/<t>/pi/*.ts` IS already the single source of the
execute function + schema + description. The pi `.ts` wrapper adds only:
- TUI rendering (Component/Container/Text from pi-tui, theme, keyHint)
- operations injection (e.g. createLocalBashOperations, SSH operations)
- ToolDefinition wrapper (wrapToolDefinition) with render callbacks

## Implication for C2

C2 does NOT need to rewrite tool logic. It needs to:
1. Register each built-in tool as a NativeToolMagnet in the unified HCP, using
   the SAME harness `createXExecute` + schema the pi wrapper already imports.
2. Keep pi's render layer as a name-keyed decoration applied AFTER resolving the
   AgentTool from HCP (renderer-registry.ts already keys by tool name).
3. The `createExecute` in NativeToolSpec must accept the pi operations injection
   (SSH ops, local bash ops) — so the magnet spec needs an options passthrough,
   OR pi supplies the bound execute to the magnet.

## Risk

pi tools inject runtime options (SSH ops, shellPath, commandPrefix, autoResize)
at `createAllToolDefinitions` time (agent-session.ts ~2694). The tool magnet must
carry these options through `createExecute(cwd)` closure or an options field.
NativeToolMagnet.spec.createExecute is `(cwd) => execute` — needs to also thread
options. This is the main C2 wiring detail, not a blocker.
