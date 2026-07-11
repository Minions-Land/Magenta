---
name: self-evo
description: Development mode for evolving Magenta3's own harness. Load this skill when the user wants Magenta to extend itself — create a skill, absorb a Pi extension, pull in an external project, forge a package, or otherwise add a component through the HcpClient/HcpServer/HcpMagnet path. This is the engineering handbook for self-modification, not a normal task skill.
---

# Self-Evo — Magenta's Self-Evolution Mode

Self-evo is the mode in which Magenta modifies its own harness. The single recurring action behind every self-evo task is the same:

> **Inspect a behavior at its source, place it under the correct Module, and connect one HcpMagnet product to the single HcpClient assembly path.**

Everything else — where the behavior comes from, and whether it becomes a
harness-owned component or stays in an independently managed Package — is a
boundary decision on top of that one action.

---

## The Mental Model: Three HCP Roles

The HCP entity tree has exactly three runtime roles:

- `HcpClient` is the sole runtime Client and address-routing owner; all
  assembly feeds that one Client path.
- Each Module owns a real `HcpServer` for its distinctive behavior.
- Each Source owns a thin `HcpMagnet` that constructs one product.

Module, Source, slot, product, and address are identities or data used by those
roles. They are not additional HCP roles, services, or layers. In particular,
Capability is not a fourth role: it is one legal Magnet product, selected for a
slot and resolved through a `capability:*` address.

An `HcpMagnet` can produce one of three product shapes:

| Magnet product | What it is | Model sees it? | Magnet output |
|---|---|---|---|
| **Tool** | A callable function | Yes (in the tool list) | `toTool()` |
| **Capability** | A loop-internal slot value (memory, policy, compaction, runtime, etc.) | No | `toCapability()` |
| **Resource** | Content merged at assembly (for example, a skill) | Indirectly | `toResource()` |

Prompt-template behavior belongs to the appropriate product; it is not a
fourth product. The one-of invariant is strict: one declared Source Magnet
produces exactly one Tool, Capability, or Resource. Preserve a legitimate
product even when no current session selects it; unused is not the same as
architecturally invalid.

### What "HCP" Actually Means

HCP is **not** the loop's hot path. Its static assembly chain is:

```text
TOML declarations
  -> codegen produces HCP_SERVERS and HCP_MAGNETS
  -> assembly calls the selected HcpMagnet.build(...)
  -> HcpClient owns the resulting runtime address map
```

`HCP_SERVERS` contains the real Module Server classes. `HCP_MAGNETS` contains
the declared Source Magnet rows and the data required to build them. They are
generated projections, not new runtime entities. Do not create a parallel
catalog, service, or selection mechanism around them.

`HcpClient` resolves addresses such as `tool:read`, `capability:compaction`, or
`capability:runtime:process`. The owning `HcpServer` remains the Module endpoint;
the `HcpMagnet` only connects a Source and constructs its product.

So "put the function under the right HCP Server and give it a Magnet" means:
**choose the Module and product, write the thin Source Magnet, declare it in
TOML, regenerate the two arrays, and let the one HcpClient assembly path use
it.**

---

## Source Discipline

This skill and its sub-skills live under `skills/self-evo/magenta/` — their source is `magenta`, because the *act of self-evolution* is Magenta's.

**The artifacts you produce carry the source of *their* origin:**
- A converted Pi extension is tagged `source = "pi"`
- A package published from its own GitHub repository carries its original project's origin
- Never mislabel the product's provenance with `magenta` just because Magenta did the integration

**Source = original agent name** (`pi`, `magenta`, `codex`, `claude-code`), never a language or protocol.

---

## Routing: What Are You Building?

Before diving in, identify what you're creating:

```
What are you building?
│
├─ 🎨 A new skill (instructions, workflow, domain expertise)
│   └─ → skill-creator/SKILL.md
│
├─ 📦 A single Pi extension (from npm/git/local examples)
│   └─ → pi-extension-integration/SKILL.md
│       (covers both intake and conversion in one flow)
│
├─ 🏢 An external project / heavy package (whole harness, Python suite, multi-component)
│   └─ → package-forge/SKILL.md
│
└─ ⚡ A one-off Tool or Capability product (hand-written, no existing source)
    └─ Stay in this parent skill, follow the base procedure below
```

Each sub-skill is a chapter with its own specialized guidance. Read the relevant one when you reach that branch.

### Harness-Owned vs. Independently Managed (The Core Judgment)

- **Harness-owned** (Pi path): a lightweight, single-product extension is
  integrated directly under `HarnessComponentProtocol/` with its origin Source
  preserved (for example, `source = "pi"`).
- **Independently managed** (package-forge): a systemic, heavy, or independently
  shippable body stays as a Package in its own GitHub repository.

---

## Sub-Skills Reference

All sub-skills are chapters of this handbook, marked `disable-model-invocation: true`. They cannot be invoked independently.

- **`skill-creator/SKILL.md`** — Create and iteratively improve Magenta skills. Full Claude-style workflow: capture intent, draft, test, evaluate with sub-agents, iterate, optimize description.

- **`pi-extension-integration/SKILL.md`** — Integrate a single Pi extension.
  Covers both intake (acquire, vet, enumerate injection points) and conversion
  (translate behavior, wire roles) as one end-to-end flow.

- **`package-forge/SKILL.md`** — Wrap an external project or heavy capability
  set for eventual publication as an independent GitHub package, following
  Magenta3's generic package contract.

---

## The Landing Procedure (Applies to Every Self-Evo Change)

Harness-owned components land through the HCP chain below. Domain Packages are
published from their own GitHub repositories and use the compatible package
manifest described by `package-forge`. Magenta3 retains `packages/` as its
generic Package boundary, schema, template, and API, but no concrete domain
Package lives there. A future acquisition layer will download and verify
packages. Current integration receives an explicit `packagesRoot` containing
already-downloaded content and must not infer a sibling path. Full rules are in
`HarnessComponentProtocol/docs/DEVELOPING.md` and
`HarnessComponentProtocol/docs/governance/contract.md`. The short version:

### 1. Create the Directory

Under the correct Module and Source:
- Harness-owned: `HarnessComponentProtocol/tools/<name>/<source>/` or `HarnessComponentProtocol/skills/<name>/<source>/`
- Domain package: `<package-repository>/tools/<tool>/` or
  `<package-repository>/skills/<skill>/`

**Source = origin agent name** (`pi`, `magenta`, `codex`), not a language.

### 2. Write the Descriptor

`<name>.toml` with `kind`, `product`, `name`, `source`, `description`, and
product-specific fields:

**Tool descriptor:**
```toml
kind = "tool"
product = "tool"
name = "tool-name"
source = "pi"
description = "What it does"
```

**Capability descriptor** (example policy slot; must include `[assumption]`):
```toml
kind = "policy"
product = "capability"
name = "policy"
source = "magenta"
slot = "policy"
description = "What it compensates for"

[assumption]
compensates = "What model limitation makes this loop-internal value necessary."
rationale = "stated"
calibrated_for = ["any"]
review_trigger = "model-change" # or "never" for safety boundaries
load_bearing = "unmeasured"
eval_scenarios = []
```

**Resource descriptor:**
```toml
kind = "skill"
product = "resource"
name = "skill-name"
source = "magenta"
autoload = true
description = "When to load and what it provides"
```

See `scripts/templates/module/module-name.toml` for base shapes.

### 3. Wire the Magnet

- **Tool** → source-local `<module>/<source>/HcpMagnet.ts` with `toTool()`
- **Capability** → source-local `HcpMagnet` with `toCapability()` plus the real module `HcpServer.ts`
- **Resource** → source-local `HcpMagnet` with `toResource()` plus the real
  Module `HcpServer.ts`; the product points to or contains its content.

Keep Magnets thin: bind one source and produce exactly one product. Never add
`toHcpServer()`; management behavior belongs to the real module Server.

### 4. Declare

`[[components]]` entry in:
- Harness-owned: `HarnessComponentProtocol/harness.toml`
- Domain package: `<package-repository>/package.toml`

For harness-owned components, run codegen after the TOML change. Package
manifests enter through the same product and assembly semantics via an explicit
`packagesRoot`; they do not create another HCP role or another assembly path.

### 5. Verification Gate (Run Before Any Change Lands)

From `HarnessComponentProtocol/`:

```bash
npm run generate:hcp-sources -- --check
npm run check:structure  # enforces module/source layout rules
npm run check:assumptions # enforces [assumption] placement (capabilities only)
npm run build            # tsc + asset copy — must be green
npm test                 # vitest — no regression
npm run inspect          # reports generated HCP declarations + Package diagnostics
```

`npm run inspect` is a quick structural view. The build and tests remain the
proof that the selected Magnet product assembles and resolves correctly.

If a step fails twice, stop and diagnose the root cause instead of patching incrementally.

---

## Guardrails Specific to Self-Evo

- **Never fabricate the source API.** Read the extension/project before translating it. Confirm every event it hooks and every tool it declares.
- **One selection path.** Your Magnet only binds and builds. Which Source wins a
  slot is decided once by HcpClient assembly, with Package input supplied
  through the generic overlay API.
- **Preserve provenance.** The artifact's `source` is its origin agent, not `magenta`.
- **Prefer reuse over new modules.** If a slot already exists, add a source; do not spawn a parallel module.
- **Iterate in steps.** Land one product, pass the gate, then extend. Do not batch-convert an entire extension bundle in one unverified pass.

---

## Example Scenarios

### Scenario 1: User says "I want to create a skill for analyzing research papers"

```
1. self-evo loads
2. Routes to skill-creator
3. Captures intent (what it should do, when to trigger)
4. Writes SKILL.md draft
5. Creates test cases
6. Spawns sub-agents (with_skill vs without_skill)
7. User reviews outputs
8. Iterates based on feedback
9. Optimizes description
10. Declares the component in `harness.toml` and regenerates the HCP arrays
```

### Scenario 2: User says "Add the Pi 'github-search' extension"

```
1. self-evo loads
2. Routes to pi-extension-integration
3. Acquires from pi/coding-agent/examples/extensions/github-search/
4. Reads entry module, enumerates: pi.registerTool({ name: "github_search", ... })
5. Maps dependencies (all TypeScript, light)
6. Security review (makes HTTP requests — OK with user control)
7. Decides: integrate directly (single clean tool)
8. Converts: strips ExtensionAPI, rebinds to harness context
9. Places: HarnessComponentProtocol/tools/github-search/pi/github-search.ts
10. Writes github-search.toml
11. Adds the real tool HcpServer and source-local HcpMagnet
12. Declares it in `harness.toml` and regenerates the HCP arrays
13. Gates: npm run build && test && check:structure && inspect
```

### Scenario 3: User says "Package this multi-component domain suite"

```
1. self-evo loads
2. Routes to package-forge
3. Audits: complete Python + pixi tool suite, many components
4. Decides: keep independent (heavy, separately managed environment)
5. Creates the package in its own independently managed GitHub repository
6. Writes package.toml
7. Copies pixi.toml + pixi.lock
8. Declares tools with process/runtime metadata
9. Runs the package repository's own gates and records its GitHub origin/ref
10. Tests Magenta3 with an explicit already-downloaded local `packagesRoot`
```

---

## Summary

Self-evo is Magenta's **self-modification engine**:
- **Architecture**: only HcpClient, HcpServer, and HcpMagnet roles; products and
  addresses are data owned by those roles
- **Three specialized paths**: skill-creator, pi-extension-integration, package-forge
- **Single landing chain**: TOML declaration → generated `HCP_SERVERS` and
  `HCP_MAGNETS` → assembly → HcpClient → gate
- **Principle**: Read first, translate precisely, preserve provenance, iterate in steps

Read the relevant sub-skill when you reach its branch. Each is a complete, self-contained guide for that path.
