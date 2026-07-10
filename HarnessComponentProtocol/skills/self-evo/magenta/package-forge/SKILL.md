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
bundle in the independently managed `MagentaPackages` repository. It brings its
own components, environment, and process-backed tool descriptors where
required. A package does not invent an HCP Server; when explicitly integrated,
its products stay under real Harness Modules and source Magnets.

## When to forge instead of dissolve

Forge when any of these hold:

- The source is a full project / another agent's harness, not one extension.
- It carries a heavy or pinned runtime (Python + pixi, a Rust crate, native
  binaries).
- It is many components that belong together and want a boundary.
- It should be independently shippable / versioned.

Otherwise, prefer dissolving via intake + conversion. Do not create a package
for a single lightweight tool.

## Package anatomy

```
<Name>/
  package.toml              — schema_version, id, name, kind, domain, [[components]]
  skills/<skill>/SKILL.md   — packaged skills (flat: no <source> subdir inside a package)
  tools/<tool>/<tool>.toml  — packaged tool descriptors (+ python/, rust/, pixi.toml, ...)
  system-prompt/            — packaged resources (append-system-prompt, etc.)
  brands/<Name>             — optional brand resource
```

Key rules:

- **Ownership is separate.** Magenta3's root `packages/` retains the generic
  contract and templates only. Concrete domain packages live in
  `MagentaPackages` and follow that repository's lifecycle. Do not vendor them
  into Magenta3 or hardcode the sibling repository's absolute path.
- **Integration is explicit.** `HarnessComponentProtocol/.HCP/overlay` is a
  generic boundary for a package root supplied by configuration. It does not
  own, discover by fixed filesystem convention, or release domain packages.
- **Package components use a flat `tools/<tool>/` / `skills/<skill>/` layout.**
  The `<name>/<source>/` split is for in-harness trunk components, not inside a
  package — the package itself is the source scope.
- **Ship manifest + lock, not built environments.** `pixi.toml` + `pixi.lock`
  are tracked; `.pixi/`, conda envs, and `runs/` outputs are gitignored.
  References inside a package are package-local relative paths only.

## Transport ownership

Heavy runtimes do not create another HCP role or infrastructure-owned Module:

- A process-backed package tool declares its runtime (e.g. `runtime =
  "domain_runtime"`). The overlay creates a `ProcessTool` or
  `PythonModuleTool` product that must remain owned by a real tool Module/Server
  and source Magnet. Transport never supplies that Server.
- For a JSONL HCP boundary, the owning source Magnet may inject and use
  `.HCP/transport/hcp-process.ts::HcpMagnetProcess`. It is not a Module, not a
  source role, not auto-assembled, and owns no Server or address.
- Transport remains off the loop hot path after assembly.
- Process/Python/HCP-JSONL/script tools must **not** bypass the shared
  `runtime://process` sandbox and policy checks.

## Forge procedure

1. **Audit the external project read-only.** Map its components to harness
   primitives (tools / skills / resources). This is the same dissection as the
   existing integration studies when available; do not infer an interface from
   a package name.
2. **Decide the boundary.** What stays in the package vs. what (if anything)
   dissolves into the trunk. Default: keep the domain-specific body packaged;
   only genuinely generic pieces migrate to the trunk.
3. **Scaffold the package in `MagentaPackages`.** Write `package.toml`
   (`schema_version`, `id`, `name`, `kind`, `domain`, `[[components]]`). Use
   Magenta3's `packages/templates/harness-package/` only as the generic
   compatibility reference; do not create the domain package under Magenta3.
4. **Bring the runtime.** For Python: `pixi.toml` + `pixi.lock`, code under
   `tools/<tool>/python/`. For Rust: the crate under the tool dir. Keep built
   artifacts out of git.
5. **Declare tools/skills/resources** with package-local relative paths. Tools
   get process/runtime metadata; skills are flat `SKILL.md`; resources get
   `content_path`. Packaged tools, skills, and resources do **not** carry
   `[assumption]` (see the decision matrix in `docs/assumption-metadata.md`);
   only a packaged *Capability* would, following the same rule as the trunk.
6. **Preserve provenance.** Record origin repository + commit in package
   metadata. The package's origin tag reflects the external source, not
   `magenta`.
7. **Gate in the owning repository.** Run `MagentaPackages`' documented package
   checks. Run Magenta3's HCP build/test/inspect gates only when an explicit
   integration change is made here. The production external-root connector is
   deferred; implement and test that boundary explicitly rather than assuming a
   sibling path.

## Guardrails

- Do not put concrete domain package content in Magenta3's root `packages/` or
  under `HarnessComponentProtocol/`.
- Do not vendor huge environments into git.
- Do not let a package tool escape the process sandbox.
- Keep the package boundary honest: if everything ends up dissolving into the
  trunk anyway, you should have used intake + conversion instead.

> TODO(pilot): add a worked external-project → package migration once the first
> forge target is selected.
