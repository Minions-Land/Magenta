---
name: self-evo-package-forge
disable-model-invocation: true
---

# Sub-skill: Package Forge (Encapsulate an External Project as a Package)

> Chapter of `self-evo`. Not indexed, not independently invocable. Enter here
> from the parent skill when the capability is a **whole external project** or a
> heavy/multi-component body of work that should stay isolated rather than
> dissolve into the trunk.

Where the Pi path (intake + conversion) *dissolves* a small extension into the
harness trunk, package-forge *encapsulates*. The output is a self-contained
`packages/<Name>/` bundle that brings its own components, its own environment,
and — for process-backed tools — its own HCP server. This is the AutOmicScience
pattern.

## When to forge instead of dissolve

Forge when any of these hold:

- The source is a full project / another agent's harness, not one extension.
- It carries a heavy or pinned runtime (Python + pixi, a Rust crate, native
  binaries).
- It is many components that belong together and want a boundary.
- It should be independently shippable / versioned.

Otherwise, prefer dissolving via intake + conversion. Do not create a package
for a single lightweight tool.

## Package anatomy (confirmed from `packages/AutOmicScience/`)

```
packages/<Name>/
  package.toml              — schema_version, id, name, kind, domain, [[components]]
  skills/<skill>/SKILL.md   — packaged skills (flat: no <source> subdir inside a package)
  tools/<tool>/<tool>.toml  — packaged tool descriptors (+ python/, rust/, pixi.toml, ...)
  system-prompt/            — packaged resources (append-system-prompt, etc.)
  brands/<Name>             — optional brand resource
```

Key rules:

- **`packages/` is the only package content root.** There is no
  `harness/packages`. The overlay loader (`hcp-client/overlay`) discovers and
  profile-expands packages; package components override lower layers by
  `kind:name`.
- **Package components use a flat `tools/<tool>/` / `skills/<skill>/` layout.**
  The `<name>/<source>/` split is for in-harness trunk components, not inside a
  package — the package itself is the source scope.
- **Ship manifest + lock, not built environments.** `pixi.toml` + `pixi.lock`
  are tracked; `.pixi/`, conda envs, and `runs/` outputs are gitignored.
  References inside a package are package-local relative paths only.

## The HCP-server-when-none-exists answer

This is where the parent skill's "no HCP server yet" branch resolves for heavy
capabilities:

- A process-backed package tool declares its runtime (e.g. `runtime =
  "aose_omics_runtime"`) and reaches the loop through `runtime://process` + a
  **process Magnet** (`HcpProcessMagnet`, JSONL transport). That Magnet **is**
  the tool's HCP server — you are creating the server by declaring the process
  tool and letting the process Magnet bind it.
- The transport is a Magnet implementation detail, never the loop hot path.
- Process/Python/HCP-JSONL/script tools must **not** bypass the shared
  `runtime://process` sandbox and policy checks.

## Forge procedure

1. **Audit the external project read-only.** Map its components to harness
   primitives (tools / skills / resources). This is the same dissection as the
   AutOmicScience and Visual Inspector integration studies at repo root —
   reuse that report style.
2. **Decide the boundary.** What stays in the package vs. what (if anything)
   dissolves into the trunk. Default: keep the domain-specific body packaged;
   only genuinely generic pieces migrate to the trunk.
3. **Scaffold `packages/<Name>/`.** Write `package.toml` (`schema_version`,
   `id`, `name`, `kind`, `domain`, `[[components]]`). Follow
   `packages/AutOmicScience/package.toml` as the shape reference and check
   `packages/templates/`.
4. **Bring the runtime.** For Python: `pixi.toml` + `pixi.lock`, code under
   `tools/<tool>/python/`. For Rust: the crate under the tool dir. Keep built
   artifacts out of git.
5. **Declare tools/skills/resources** with package-local relative paths. Tools
   get process/runtime metadata; skills are flat `SKILL.md`; resources get
   `content_path`. Packaged tools, skills, and resources do **not** carry
   `[assumption]` (see the decision matrix in `docs/assumption-metadata.md`);
   only a packaged *Capability* would, following the same rule as the trunk.
6. **Preserve provenance.** Record origin repo + commit in
   `package.toml`/metadata (as AutOmicScience records its AOSE origin ref). The
   package's origin tag reflects the external source, not `magenta`.
7. **Gate.** `npm run build && npm test && npm run check:structure && npm run
   inspect` from `harness/`. `inspect` lists every package's components and their
   executable transport — confirm the package resolves and process tools show
   the expected transport.

## Guardrails

- Do not smuggle a second content root under `harness/`.
- Do not vendor huge environments into git.
- Do not let a package tool escape the process sandbox.
- Keep the package boundary honest: if everything ends up dissolving into the
  trunk anyway, you should have used intake + conversion instead.

> TODO(pilot): add a worked external-project → package migration once the first
> forge target is selected.
