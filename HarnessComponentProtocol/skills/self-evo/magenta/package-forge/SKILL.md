---
name: self-evo-package-forge
disable-model-invocation: true
---

# Sub-skill: Package Forge (Encapsulate an External Project as a Package)

> Chapter of `self-evo`. Not indexed, not independently invocable. Enter here
> from the parent skill when the input is a **whole external project** or a
> heavy/multi-component body of work that should stay isolated rather than
> become owned by the Magenta3 harness repository.

Where the Pi path integrates a small extension directly into the harness,
package-forge preserves an independent ownership boundary. The output is a
self-contained bundle in its own independently managed GitHub repository. It brings its
own components, environment, and process-backed tool descriptors where
required. A Package does not invent another HCP role or assembly system. When
explicitly integrated, its products still enter the one HcpClient path under
real Module `HcpServer` and Source `HcpMagnet` ownership.

## When to forge instead of integrate directly

Forge when any of these hold:

- The source is a full project / another agent's harness, not one extension.
- It carries a heavy or pinned runtime (Python + pixi, a Rust crate, native
  binaries).
- It is many components that belong together and want a boundary.
- It should be independently shippable / versioned.

Otherwise, prefer direct integration via intake + conversion. Do not create a package
for a single lightweight tool.

## Package anatomy

```
<Name>/
  package.toml                         — schema v2 manifest + [[components]]
  skills/<skill>/HcpServer.ts          — real Module Server
  skills/<skill>/<source>/             — Source identity lives in the path
    HcpMagnet.ts
    SKILL.md
  tools/<tool>/HcpServer.ts
  tools/<tool>/<source>/
    HcpMagnet.ts
    <tool>.toml                         — plus python/, rust/, pixi assets
  system-prompt/HcpServer.ts
  system-prompt/<source>/HcpMagnet.ts  — plus SYSTEM.md
  brand/HcpServer.ts                   — optional
  brand/<source>/HcpMagnet.ts
```

Key rules:

- **Ownership is separate.** Magenta3's root `packages/` retains the generic
  Package boundary, schema, templates, and API. Concrete domain Packages live in
  their own GitHub repositories and follow those repositories' lifecycles. Do
  not vendor them into Magenta3 or infer a sibling checkout.
- **Integration is explicit.** `HarnessComponentProtocol/_magenta/packages` is
  the generic boundary for a Package root supplied as `packagesRoot`. It does not
  own, discover by fixed filesystem convention, or release domain packages.
  Production can acquire `github:owner/repo/Package@version`; the coding-agent
  host selects the platform artifact, verifies SHA-256, validates and safely
  extracts it, then supplies the cached local root. Local development may pass
  `packagesRoot` directly.
  Use the existing API rather than adding a repository-specific loader:

  ```typescript
  await HcpClientdiscoverharnesspackages({ repoRoot, packagesRoot });
  await HcpClientloadpackageoverlay({ repoRoot, packagesRoot, selections });
  ```

  Harness TOML still generates `HCP_SERVERS` and `HCP_MAGNETS`; selected Package
  rows enter that same assembly through the overlay. A Package manifest does
  not create or hand-edit another generated list.
- **Package layout is HCP-isomorphic.** Every package Module owns a bare
  `HcpServer.ts`, and every Source owns a bare `HcpMagnet.ts`. Tools and skills
  therefore use `<module>/<item>/<source>/`; direct Resources use
  `<module>/<source>/`. The package id does not erase the Source entity.
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
   products (Tools / Capabilities / Resources). Capability here means a Magnet
   product for a slot/address, not another HCP role. This is the same dissection
   as the existing integration studies when available; do not infer an API from
   a package name.
2. **Decide the boundary.** What stays in the package vs. what (if anything)
   becomes harness-owned. Default: keep the domain-specific body packaged;
   only genuinely generic pieces migrate into `HarnessComponentProtocol/`.
3. **Scaffold the package in its own GitHub repository.** Write `package.toml`
   with `schema_version = "magenta.package.v2"`, `id`, `version`, `source`,
   profiles, and `[[components]]`. Add each real Module `HcpServer.ts` and Source
   `HcpMagnet.ts`. Use
   Magenta3's `packages/templates/harness-package/` only as the generic
   compatibility reference; do not create the domain package under Magenta3.
4. **Bring the runtime.** For Python: `pixi.toml` + `pixi.lock`, code under
   `tools/<tool>/python/`. For Rust: the crate under the tool dir. Keep built
   artifacts out of git.
5. **Declare tools/skills/resources** with package-local paths to their Source
   directories. Tool magnets expose `toTool()` and use the host-injected
   `HcpClientbuildtools` setting during static `build()`; Resource magnets expose
   `toResource()` with `contentPath` or inline content. Packaged tools, skills,
   and resources do **not** carry
   `[assumption]` (see the decision matrix in `docs/assumption-metadata.md`);
   only a packaged Capability product would, following the same assumption
   rule as a harness-owned Capability product.
6. **Preserve provenance.** Record origin repository + commit in package
   metadata. The package's origin tag reflects the external source, not
   `magenta`.
7. **Gate in the owning repository.** Run that repository's documented package
   checks. Run Magenta3's HCP build/test/inspect gates only when an explicit
   integration change is made here. For local tests, pass a temporary external
   root explicitly as `packagesRoot`; for released packages, use the versioned
   GitHub selector and publish all four platform archives plus checksums.

## Guardrails

- Do not put concrete domain package content in Magenta3's root `packages/` or
  under `HarnessComponentProtocol/`.
- Do not vendor huge environments into git.
- Do not let a package tool escape the process sandbox.
- Keep the package boundary honest: if everything should become harness-owned,
  use intake + conversion instead.

> TODO(pilot): add a worked external-project → package migration once the first
> forge target is selected.
