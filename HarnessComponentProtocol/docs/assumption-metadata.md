# Component Assumption Metadata (`[assumption]`)

## Why

Every capability module in the harness exists to compensate for something the
model cannot (yet) do reliably on its own. As models improve, some of those
compensations become dead weight — the classic example from Anthropic's harness
write-ups is the "context anxiety" reset that was load-bearing on one model and
useless on the next.

Today that knowledge lives only in people's heads and scattered code comments.
The `[assumption]` block makes it a first-class, queryable property of each
component so that, when a model changes, we can mechanically list every
component whose justification should be re-checked — and pair each one with an
eval scenario that measures whether it still earns its place (see `eval/`).

This is the engineering form of the recurring question in that body of work:
**"what can I stop doing?"**

## Scope

`[assumption]` is added only to components whose TOML declares
`product = "capability"` — the live loop values that compensate for a model
limitation and could, in principle, be pruned. Foundation code under
`_magenta/` (`session`, `types`, `messages`,
`env`, `utils`) is architectural bedrock, not a model-compensating assumption,
and is **not** annotated. Protocol/type files and infrastructure under `.HCP/`
are likewise out of scope; they are not Harness Modules.

### Decision matrix (the authoritative RULE)

Uniformity here means a **consistent rule about where the block applies**, not
the block being present on every TOML. The block is meaningful only where its
semantics fit — "compensates for a model limitation; could become dead weight as
the model improves." Apply it by product:

| Component category | `[assumption]`? | Why |
|---|---|---|
| **Capability** module (compaction, context, memory, hooks, multiagent) | **Yes** | This is exactly what the block is for: a loop-internal slot that compensates for a model limitation. |
| **Capability** that is a safety/trust boundary (policy, sandbox, runtime guards) | **Yes**, with `review_trigger = "never"` | Annotated for provenance, but never pruned on a model bump — a boundary must not rely on a model limitation. |
| **Tool** (bash, edit, read, write, grep, find, ls, lsp, todo, tool-search, web-search, web-fetch, show) | **No** | A tool is the model's hands, not a compensation. A smarter model still cannot read/write files or run commands without one, so a tool never becomes dead weight. |
| **Tool sub-implementation / alternate source** (`tools/edit/magenta/edit-hashline.toml`, `ast-grep.toml`, `read-url.toml`, …) | **No** | Not a distinct component — an alternate *source* of a tool that itself carries no `[assumption]`. |
| **Resource** (skill, brand, theme, prompt content, `append-system-prompt`, a package's `SYSTEM.md`) | **No** | Inert content merged at assembly has no code provider. The capability that loads or constructs content is separate. |
| **System prompt / prompt template code capability** | **Yes** | A source Magnet builds a live provider. Package prompt content remains a Resource and carries no block. |
| **Config / data** (sandbox profile sub-files, `[[patterns]]` rows, env locks) | **No** | Parameters consumed by a component, not components themselves. |
| **Transport / infrastructure** (`HcpMagnetProcess`, `.HCP/transport`, `_magenta/mcp`, `_magenta/packages`) | **No** | Injectable/assembly plumbing and generic support, not a Module or model-compensating capability. Transport owns no Server and is never auto-assembled as one. |
| **Foundation code** (`_magenta/session`, `_magenta/types`, `_magenta/messages`, `_magenta/env`, `_magenta/utils`) | **No** | Architectural bedrock; exists regardless of model capability and is not a Harness Module. |
| **Configured external Package component** | **By product**, same rules | Once an already-downloaded Package is explicitly integrated, a Capability product → yes; a Tool or Resource product → no. Concrete domain Packages remain independently published on GitHub, not owned by this repository. |

Executable source of truth: a component carries `[assumption]` **iff its TOML
declares `product = "capability"`**. That field already determines which product
its source `HcpMagnet` must expose, so the audit does not maintain a second kind
table. Tools and Resources, sources, config, transport, and foundation code are
out of scope by design.

`scripts/audit-assumptions.mjs --check` enforces this rule mechanically
(`npm run check:assumptions`) from the component TOML files using the shared
`smol-toml` parser.

### Two kinds of assumption

- **Capability-compensating** (`review_trigger = "model-change"`): the component
  fills a gap in what the model can do on its own. As the model improves the gap
  may close, so these are the real pruning candidates.
- **Safety / trust boundary** (`review_trigger = "never"`): the component exists
  to constrain or gate actions regardless of how capable the model is. A smarter
  model does *not* remove the need for a sandbox or an approval gate — the
  write-ups explicitly warn against letting a security boundary rely on a model
  limitation. These are annotated for provenance but are never pruned on a model
  bump.

## Schema

Add the block to each repository component TOML whose `product` is
`"capability"`. The fields are additive metadata consumed by the assumption
audit; codegen and assembly ignore them except for structural validation.

```toml
[assumption]
# One sentence: the model limitation this component compensates for.
# Ground this in the actual behavior, not aspiration.
compensates = "..."

# How confident are we that the 'compensates' rationale is stated in code
# vs. inferred from structure. Keeps us honest about overclaiming.
#   stated   — a rationale comment in the code says this explicitly
#   inferred — the compensation is real but implied by structure, not documented
rationale = "stated"   # stated | inferred

# The model capability level this component assumes. NOT a claim that the code
# is hardcoded per-version (most thresholds derive from model.maxTokens and are
# model-agnostic) — it records the capability tier against which the component
# was last judged useful, so we know what to re-test when the tier moves.
calibrated_for = ["claude-sonnet-4-5", "claude-opus-4-5"]

# When this assumption should be re-examined.
#   model-change — re-check whenever the primary model changes
#   never        — structural/always-needed (rare for capability modules)
review_trigger = "model-change"

# Current load-bearing judgement. Updated from eval results.
#   verified       — eval (or deliberate manual check) confirms it still helps
#   suspected-stale — we suspect the model no longer needs this; needs an eval
#   dead-weight    — eval shows no benefit on current models; candidate for removal
#   unmeasured     — no eval yet; default for freshly-annotated components
load_bearing = "unmeasured"

# Eval scenario ids (under eval/scenarios/) that measure this component's value.
# Empty is allowed while eval coverage is being built out.
eval_scenarios = []
```

## Field discipline

- `compensates` must describe what the model *can't* do, not what the component
  *does*. "Retains facts across sessions because the model is stateless between
  runs" — not "stores JSONL facts."
- Set `rationale = "inferred"` unless there is an actual comment in the code
  stating the model-limitation rationale. Do not manufacture confidence.
- `load_bearing` starts at `unmeasured` and only moves to `verified` /
  `dead-weight` when an eval (or a documented deliberate check) backs it.

## Workflow when a model changes

1. `node scripts/audit-assumptions.mjs` (see below) lists every component with
   `review_trigger = "model-change"` and its current `load_bearing`.
2. For each, run its `eval_scenarios` on the new model with the component on and
   off (eval harness selects component sets via package-overlay profiles).
3. Update `load_bearing` from the result. `dead-weight` components become
   pruning candidates.
