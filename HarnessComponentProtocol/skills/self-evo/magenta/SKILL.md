---
name: self-evo
description: Development mode for evolving Magenta3's own harness. Load this skill when the user wants Magenta to extend itself — create a skill, absorb a Pi extension, pull in an external project, forge a package, or otherwise grow a new capability and wire it into the HCP address space with a Magnet. This is the engineering handbook for self-modification, not a normal task skill.
---

# Self-Evo — Magenta's Self-Evolution Mode

Self-evo is the mode in which Magenta modifies its own harness. The single recurring action behind every self-evo task is the same:

> **Take a capability from somewhere, translate it into one of the harness's four primitives, and hang it in the HCP address space with a Magnet so the loop can use it.**

Everything else — where the capability comes from, and whether it dissolves into the trunk or stays a self-contained package — is a routing decision on top of that one action.

---

## The Mental Model: Four Primitives + HCP

The harness is organized as **Module → capability → source**, and every component is exactly one of four **primitives**. Knowing which primitive you are building decides where the code goes, whether it needs a code builder, and how the Magnet binds it.

| Primitive | What it is | Model sees it? | Needs a code builder? | Magnet output |
|---|---|---|---|---|
| **Tool** | A callable function | Yes (in the tool list) | Yes (`execute` fn) | `toTool()` |
| **Capability** | A loop-internal slot impl (memory, policy, compaction, runtime, …) | No | Yes (`build` fn) | `toCapability()` |
| **Resource** | Content merged at assembly (system-prompt, **skill**, theme, brand, prompt) | Indirectly (as content) | **No** | `toResource()` |
| **Prompt** | A named prompt template | On invocation | Yes | (prompt-template) |

**The one-of invariant:** a Magnet produces *at most one* of tool / capability / resource. Never build a hybrid. A tool never lands on the capability map; a content-only resource (system-prompt, skill) must never be routed through a capability code-builder — that misclassification is the classic `capability_factory_missing` failure.

### What "HCP" Actually Means

HCP is **not** the loop's hot path. It is the assembly-time management and discovery layer:

- `HcpClient` routes URI-like target addresses by prefix: `tool:read`, `capability:compaction`, `capability:runtime:process`
- A capability "becomes usable" only after: `implementation` → `HcpMagnet` (binds it into uniform interface) → registered in `harness.toml` (trunk) or `package.toml` (package) → `HcpClient` can resolve its target
- The "HCP server" for a component is its endpoint in that address space

So "put the function under the right HCP server and give it a Magnet" precisely means: **pick the correct target address / primitive, write the Magnet that binds the implementation, and register it so `HcpClient` resolves it.**

---

## Source Discipline

This skill and its sub-skills live under `skills/self-evo/magenta/` — their source is `magenta`, because the *act of self-evolution* is Magenta's.

**The artifacts you produce carry the source of *their* origin:**
- A converted Pi extension is tagged `source = "pi"`
- A package managed in `MagentaPackages` carries its original project's origin
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
└─ ⚡ A one-off tool/capability (hand-written, no existing source)
    └─ Stay in this parent skill, follow the base procedure below
```

Each sub-skill is a chapter with its own specialized guidance. Read the relevant one when you reach that branch.

### Dissolve vs. Encapsulate (The Core Judgment)

- **Dissolve** (Pi path → trunk): Lightweight, single-primitive extension *dissolves* into the trunk (`pi-extension-integration`, `source = "pi"`)
- **Encapsulate** (package-forge): Systemic, heavy, or independently-shippable body of work is *encapsulated* as a package (origin-tagged)

---

## Sub-Skills Reference

All sub-skills are chapters of this handbook, marked `disable-model-invocation: true`. They cannot be invoked independently.

- **`skill-creator/SKILL.md`** — Create and iteratively improve Magenta skills. Full Claude-style workflow: capture intent, draft, test, evaluate with sub-agents, iterate, optimize description.

- **`pi-extension-integration/SKILL.md`** — Integrate a single Pi extension. Covers both intake (acquire, vet, inventory) and conversion (translate injection points, wire Magnets) as one end-to-end flow.

- **`package-forge/SKILL.md`** — Wrap an external project or heavy capability
  set as an independently managed package in `MagentaPackages`, following
  Magenta3's generic package contract.

---

## The Landing Procedure (Applies to Every Self-Evo Change)

Trunk components land through the HCP chain below. Domain packages remain in
`MagentaPackages` and use the compatible package manifest described by
`package-forge`; Magenta3 must not hardcode their repository path. Full rules in
`HarnessComponentProtocol/docs/DEVELOPING.md` and
`HarnessComponentProtocol/docs/governance/contract.md`. The short version:

### 1. Create the Directory

Under the correct primitive and source:
- Trunk: `HarnessComponentProtocol/tools/<name>/<source>/` or `HarnessComponentProtocol/skills/<name>/<source>/`
- Domain package: `MagentaPackages/<Name>/tools/<tool>/` or
  `MagentaPackages/<Name>/skills/<skill>/` (repository-relative notation)

**Source = origin agent name** (`pi`, `magenta`, `codex`), not a language.

### 2. Write the Descriptor

`<name>.toml` with `kind`, `name`, `description`, and primitive-specific fields:

**Tool descriptor:**
```toml
kind = "tool"
name = "tool-name"
description = "What it does"

[exports]
module = "tools/tool-name/<source>/tool-name.ts"
factory = "createToolNameMagnet"
```

**Capability descriptor** (must include `[assumption]`):
```toml
kind = "capability"
name = "capability-name"
description = "What it compensates for"

[assumption]
model_limitation = "what limitation this addresses"
review_trigger = "model_version_change"  # or "never" for safety boundaries
```

**Resource descriptor** (no code builder):
```toml
kind = "resource"
name = "skill-name"
description = "When to load and what it provides"
content_path = "skills/skill-name/<source>/SKILL.md"
```

See `scripts/templates/module/module-name.toml` for base shapes.

### 3. Wire the Magnet

- **Tool** → source-local `<module>/<source>/HcpMagnet.ts` with `toTool()`
- **Capability** → source-local `HcpMagnet` with `toCapability()` plus the real module `HcpServer.ts`
- **Resource** → Give it a `content_path`. No code builder. Never add to `CAPABILITY_KINDS`.

Keep Magnets thin: bind one source and produce exactly one product. Never add
`toHcpServer()`; management behavior belongs to the real module Server.

### 4. Register

`[[components]]` entry in:
- Trunk: `HarnessComponentProtocol/harness.toml`
- Domain package: `MagentaPackages/<Name>/package.toml`

### 5. Verification Gate (Run Before Any Change Lands)

From `HarnessComponentProtocol/`:

```bash
npm run generate:hcp-sources -- --check
npm run check:structure  # enforces module/source layout rules
npm run check:assumptions # enforces [assumption] placement (capabilities only)
npm run build            # tsc + asset copy — must be green
npm test                 # vitest — no regression
npm run inspect          # resolves registry + packages; check diagnostics
```

`npm run inspect` is the fastest confirmation that a new component resolves. It surfaces misclassification diagnostics like `capability_factory_missing`.

If a step fails twice, stop and diagnose the root cause instead of patching incrementally.

---

## Guardrails Specific to Self-Evo

- **Never fabricate the source's interface.** Read the extension/project before translating it. Confirm every event it hooks and every tool it registers.
- **No second selection registry.** Your Magnet only *binds*; which source wins a slot is decided once by the HcpClient / package overlay.
- **Preserve provenance.** The artifact's `source` is its origin agent, not `magenta`.
- **Prefer reuse over new modules.** If a slot already exists, add a source; do not spawn a parallel module.
- **Iterate in steps.** Land one primitive, pass the gate, then extend. Do not batch-convert an entire extension bundle in one unverified pass.

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
10. Registers in harness.toml
```

### Scenario 2: User says "Add the Pi 'github-search' extension"

```
1. self-evo loads
2. Routes to pi-extension-integration
3. Acquires from pi/coding-agent/examples/extensions/github-search/
4. Reads entry module, enumerates: pi.registerTool({ name: "github_search", ... })
5. Maps dependencies (all TypeScript, light)
6. Security review (makes HTTP requests — OK with user control)
7. Decides: dissolve (single clean tool)
8. Converts: strips ExtensionAPI, rebinds to harness context
9. Places: HarnessComponentProtocol/tools/github-search/pi/github-search.ts
10. Writes github-search.toml
11. Adds the real tool HcpServer and source-local HcpMagnet
12. Registers in harness.toml
13. Gates: npm run build && test && check:structure && inspect
```

### Scenario 3: User says "Package this multi-component domain suite"

```
1. self-evo loads
2. Routes to package-forge
3. Audits: complete Python + pixi tool suite, many components
4. Decides: encapsulate (heavy, independent environment)
5. Creates the package in the independently managed `MagentaPackages` repository
6. Writes package.toml
7. Copies pixi.toml + pixi.lock
8. Declares tools with process/runtime metadata
9. Runs the package repository's own gates
10. Changes Magenta3 only when an explicit integration contract is requested
```

---

## Summary

Self-evo is Magenta's **self-modification engine**:
- **Architecture layer**: Four primitives, HCP address space, Magnets, source discipline
- **Three specialized paths**: skill-creator, pi-extension-integration, package-forge
- **Single landing chain**: descriptor → real Server + source Magnet → HcpClient → gate
- **Principle**: Read first, translate precisely, preserve provenance, iterate in steps

Read the relevant sub-skill when you reach its branch. Each is a complete, self-contained guide for that path.
