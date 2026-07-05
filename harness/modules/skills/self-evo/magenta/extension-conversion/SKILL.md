---
name: self-evo-extension-conversion
disable-model-invocation: true
---

# Sub-skill: Extension Conversion (Translation to Harness Primitives)

> Chapter of `self-evo`. Not indexed, not independently invocable. Enter here
> from the parent skill (usually after `extension-intake`) to **translate** a Pi
> extension's injection points into harness primitives and wire the Magnet.

This is the heart of the Pi path: how we *connect* an extension and *convert* it.
It assumes intake has already produced the injection-point inventory and the
dissolve decision.

## The translation table

A Pi extension injects behavior through `ExtensionAPI`. Each injection point maps
to exactly one harness primitive. Respect the **one-of invariant**: one Magnet
emits one primitive.

| Pi injection point | Harness primitive | Magnet / wiring |
|---|---|---|
| `pi.registerTool({ name, parameters, execute })` | **Tool** | `NativeToolMagnet` (native TS) or a process Magnet (needs a runtime). `toTool()` yields the loop-ready `AgentTool`. |
| `pi.on("tool_call" \| "tool_result", ...)` that gates/mutates calls | **Capability** (policy) | `<policy>/pi/magnet.ts` `CapabilitySourceMagnet`, registered in `hcp-client/assembly/sources.ts`. |
| `pi.on("compact"/summarization, ...)` | **Capability** (compaction) | compaction source magnet. |
| `pi.on("session_start"/context injection, ...)` | **Capability** (context/memory) | matching capability slot. |
| system-prompt / help / static text contribution | **Resource** | `content_path` only. No code builder. Never add to `CAPABILITY_KINDS`. |
| `pi.registerCommand(...)` (user `/command`) | usually **not** a harness primitive | commands are a Pi TUI surface; re-express the useful behavior as a Tool or Capability, or drop it. Do not fabricate a "command" primitive. |

If one extension registers several tools plus an event hook, that is **several
components**, each with its own Magnet. Convert them one at a time and pass the
gate between them.

## Conversion procedure

1. **Strip the ExtensionAPI shell.** The `export default function(pi)` wrapper is
   Pi-runtime glue, not logic. Extract the pure pieces: for a tool, the `name`,
   the `typebox` parameter schema, and the body of `execute(...)`. These map
   directly onto `NativeToolSpec` (`name`, `parameters`, `createExecute(cwd)`).
2. **Rebind context.** Pi's `execute` receives `(toolCallId, params, signal,
   onUpdate, ctx)` and reaches into `ctx.ui` / session. Harness tools are pure
   over a bound `cwd`. Replace UI/session reach-through with harness-native
   equivalents; anything interactive that has no harness analogue must be
   redesigned or dropped, not faked.
3. **Place and rename.** Put it under the correct primitive + source:
   `harness/modules/tools/<name>/pi/<name>.ts` for a trunk tool. Rename to the harness
   convention (kebab tool name, `create<Name>Magnet` factory). The `source` dir
   is `pi` because the code's origin is Pi.
4. **Write the descriptor.** `<name>.toml` with `kind`, `name`, `description`,
   and `[exports]` (`module`, `factory`). Follow `tools/todo/todo.toml` as the
   shape reference.
5. **Wire the Magnet** per the table. Keep it thin: binding + transport
   selection only.
6. **Register.** Add `[[components]]` to `harness.toml`.
7. **Gate.** `npm run build && npm test && npm run check:structure && npm run
   inspect` from `harness/`. Confirm the component resolves in `inspect` output
   and shows no `capability_factory_missing` (the sign you misclassified a
   resource as a capability).

## Common conversion traps

- **Treating a system-prompt contribution as a capability.** It is a Resource;
  give it a `content_path`, no builder.
- **Porting `ctx.ui` prompts verbatim.** The harness loop has no interactive TUI
  hook on the tool hot path; redesign the interaction.
- **Bundling multiple registered tools into one Magnet.** Violates one-of; split
  them.
- **Tagging the artifact `source = "magenta"`.** The code came from Pi; tag it
  `pi`. `magenta` is only for the self-evo act itself.

> TODO(pilot): add a full extension→tool conversion diff once the first target
> is selected.
