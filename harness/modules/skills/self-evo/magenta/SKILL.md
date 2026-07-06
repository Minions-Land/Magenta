---
name: self-evo
description: Development mode for evolving Magenta3's own harness. Load this skill when the user wants Magenta to extend itself — absorb a Pi extension, pull in an external project/harness, forge a new package, or otherwise grow a new capability and wire it into the HCP address space with a Magnet. This is the engineering handbook for self-modification, not a normal task skill.
---

# Self-Evo — Magenta's Self-Evolution Mode

Self-evo is the mode in which Magenta modifies its own harness. The single
recurring action behind every self-evo task is the same:

> **Take a capability from somewhere, translate it into one of the harness's four
> primitives, and hang it in the HCP address space with a Magnet so the loop can
> use it.**

Everything else — where the capability comes from (Pi extension, external
project, hand-written idea), and whether it dissolves into the trunk or stays a
self-contained package — is a routing decision on top of that one action.

> **Source discipline.** This skill and its sub-skills live under
> `skills/self-evo/magenta/` — their source is `magenta`, because the *act of
> self-evolution* is Magenta's. The **artifacts** you produce carry the source
> of *their* origin: a converted Pi extension is tagged `source = "pi"`, a
> package migrated from an external repo carries that repo's origin. Never
> mislabel the product's provenance with `magenta` just because Magenta did the
> integration.

---

## The mental model (read this before doing anything)

The harness is organized as **Module → capability → source**, and every
component is exactly one of four **primitives**. Knowing which primitive you are
building decides where the code goes, whether it needs a code builder, and how
the Magnet binds it.

| Primitive | What it is | Model sees it? | Needs a code builder? | Magnet output |
|---|---|---|---|---|
| **Tool** | A callable function | Yes (in the tool list) | Yes (`execute` fn) | `toTool()` |
| **Capability** | A loop-internal slot impl (memory, policy, compaction, runtime, …) | No | Yes (`build` fn) | `toCapability()` |
| **Resource** | Content merged at assembly (system-prompt, skill, theme, brand, prompt) | Indirectly (as content) | **No** | `toResource()` |
| **Prompt** | A named prompt template | On invocation | Yes | (prompt-template) |

**The one-of invariant:** a Magnet produces *at most one* of tool / capability /
resource. Never build a hybrid. A tool never lands on the capability map; a
content-only resource (system-prompt, skill) must never be routed through a
capability code-builder — that misclassification is the classic
`capability_factory_missing` failure.

### What "HCP server" actually means here

HCP is **not** the loop's hot path. It is the assembly-time management and
discovery layer. Confirmed mechanics (`hcp-client/hcp-client.ts`):

- `HcpClient` routes URI-like target addresses by prefix: `tool:read`,
  `capability:compaction`, `capability:runtime:process`.
- A capability "becomes usable" only after this chain completes:
  `implementation` → `HcpMagnet` (binds it into a uniform interface, emits one
  primitive) → registered in `harness.toml` (in-trunk) or a package manifest
  (packaged) → `HcpClient` can resolve its target.
- The "HCP server" for a component is its endpoint in that address space.
  `NativeToolMagnet.toHcpServer()` is exactly what constructs one for a native
  tool.

So "put the function under the right HCP server and give it a Magnet" precisely
means: **pick the correct target address / primitive, write the Magnet that
binds the implementation, and register it so `HcpClient` resolves it.**

---

## Base-environment decision (do this first, every time)

Before writing anything, determine whether a home for this capability already
exists. This is the "what if there is no HCP server yet" branch.

1. **Identify the primitive.** Is the incoming capability a Tool, Capability,
   Resource, or Prompt? (Use the table above. When unsure, default to Tool —
   it has the shortest, most directly verifiable loop.)

2. **Probe for an existing slot / address.**
   - Does a matching module already exist under `harness/modules/tools/<name>/`,
     `harness/modules/<capability>/`, or a `packages/<Name>/`? Read `harness.toml` and
     `hcp-client/assembly/sources.ts`.
   - Is there already a target prefix this should register under?

3. **Branch on what you found:**

   - **Slot exists, same primitive** → add a new *source* under it
     (`tools/<name>/pi/`, or a `<module>/<source>/magnet.ts` for a capability),
     and register that source. No new server needed.
   - **No slot, but the capability is light and belongs in the trunk** → create
     a new native module + Magnet (a native tool gets its own
     `NativeToolMagnet` and thus its own `toHcpServer()`), then register it in
     `harness.toml`. **You are creating the HCP server** by writing that Magnet.
   - **No slot, capability is heavy / multi-component / needs isolation** → do
     not force it into the trunk. Route to `package-forge`: build a
     self-contained `packages/<Name>/` where process-backed tools get their HCP
     server via `runtime://process` + a process Magnet (the AutOmicScience
     pattern). The package brings its own server.

4. **Security gate.** If the capability opens a network endpoint, spawns
   processes, reads secrets, or writes outside the workspace, flag it and route
   it through `runtime://process` sandbox + policy checks. Never bypass the
   shared process boundary.

---

## Routing to a sub-skill

Once you know the primitive and whether a home exists, pick the workflow. The
three sub-skills below are **not indexed and cannot be invoked on their own** —
they are chapters of this handbook. Read the relevant one before acting.

```
Where is the capability coming from?
│
├─ A single Pi extension (local examples/, npm:<pkg>, git:<repo>)
│    └─ acquire the source ......... → extension-intake/SKILL.md
│    └─ translate injection points . → extension-conversion/SKILL.md
│
└─ A whole external project / harness, or a capability set that must stay
   isolated (heavy env, Rust crate, many components, its own boundary)
     └─ ................................ → package-forge/SKILL.md
```

- **Dissolve vs. encapsulate** is the core judgment. A lightweight, single-
  primitive extension *dissolves* into the trunk (intake + conversion,
  `source = "pi"`). A systemic, heavy, or independently-shippable body of work
  is *encapsulated* as a package (package-forge, origin-tagged).
- The two Pi paths compose: **intake** acquires and vets the source;
  **conversion** does the primitive translation and Magnet wiring. A packaged
  Pi project may use all three.

Sub-skill references (relative to this file):

- `package-forge/SKILL.md` — wrap an external project as a self-contained package.
- `extension-intake/SKILL.md` — acquire and vet a Pi extension from official/community sources.
- `extension-conversion/SKILL.md` — translate a Pi extension's injection points into harness primitives + Magnet.

---

## Landing procedure (applies to every self-evo change)

Whichever path you take, a new component lands the same way. Full rules:
`harness/docs/DEVELOPING.md` and `harness/docs/governance/contract.md` (the
authoritative contract). The short version:

1. Create the directory under the correct primitive and source
   (`harness/modules/tools/<name>/<source>/` for a trunk tool;
   `packages/<Name>/tools/<tool>/` for a packaged tool). Source = **origin
   agent name** (`pi`, `magenta`, `codex`, `claude-code`), never a language or
   protocol.
2. Write the `<name>.toml` descriptor (`kind`, `name`, `description`,
   `[exports]` module + factory, or process/runtime metadata). See
   `scripts/templates/module/module-name.toml` for the base shape.
   - **If the primitive is a Capability**, add an `[assumption]` block recording
     what model limitation it compensates for. This is required for capability
     modules and is how a future model bump knows what to re-check or prune.
     Schema and the full decision matrix (which primitives carry it, which do
     not) live in `docs/assumption-metadata.md`. In short: **only the Capability
     primitive carries `[assumption]`** — Tools, Resources, sources, config,
     and core do not. Safety-boundary capabilities (policy/sandbox/runtime) use
     `review_trigger = "never"`.
3. Wire the Magnet:
   - **Tool** → a `NativeToolMagnet` (or process Magnet) factory.
   - **Capability** → a `<module>/<source>/magnet.ts` exporting a
     `CapabilitySourceMagnet`, registered in the dumb barrel
     `hcp-client/assembly/sources.ts`. Do **not** hand-maintain a central builder map;
     defaults/hot-swap are derived from these descriptors.
   - **Resource** → give it a `content_path`. No code builder. Never add it to
     `CAPABILITY_KINDS`.
4. Register: `[[components]]` in `harness.toml` (trunk) or in the package's
   `package.toml` (package).
5. Keep the Magnet thin — binding + (for tools) transport selection only, no
   business logic. Respect the one-of invariant.

### Verification gate (run before any change lands, from `harness/`)

```bash
npm run build            # tsc + asset copy — must be green
npm test                 # vitest — no regression vs baseline
npm run check:structure  # enforces module/source layout rules
npm run check:assumptions # enforces [assumption] placement (capabilities only)
npm run inspect          # resolves the real registry + packages; check diagnostics
```

`npm run inspect` is the fastest confirmation that a new component resolves and
surfaces misclassification diagnostics like `capability_factory_missing`. When
the change touches pi, also run `npm --prefix pi/coding-agent run build`. If a
step fails twice, stop and diagnose the root cause instead of patching
incrementally.

---

## Guardrails specific to self-evo

- **Never fabricate the source's interface.** Read the extension/project before
  translating it. Confirm every event it hooks and every tool it registers.
- **No second selection registry.** Your Magnet only *binds*; which source wins
  a slot is decided once by the HcpClient / package overlay.
- **Preserve provenance.** The artifact's `source` is its origin agent, not
  `magenta`.
- **Prefer reuse over new modules.** If a slot already exists, add a source; do
  not spawn a parallel module.
- **Iterate in steps.** Land one primitive, pass the gate, then extend. Do not
  batch-convert an entire extension bundle in one unverified pass.

> Example intake/conversion/forge walkthroughs are intentionally deferred until
> a pilot artifact is chosen. TODO(pilot): add a worked example per sub-skill
> once the first migration target is selected.
