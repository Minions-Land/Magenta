# Harness Package Overlay

Packages are Magenta3 harness overlay bundles migrated into this repository under `packages/<PackageName>/`. They are selected above the built-in/general harness and extension layers, and their components override lower layers by `kind:name`.

This assembly module is the package overlay loader. It is not the package root.
Actual package contents live only in the repository-level `packages/` directory.

This module owns package discovery, profile expansion, component precedence, and package resource paths. It does not own TUI selection, CLI flags, or language/runtime adapter selection. Package `tool` descriptors are handed to the Magnet layer for descriptor-to-Magnet assembly.

## Root

The repository package root is:

```text
packages/
  AutOmicScience/
    package.toml
    skills/
      omics-shared/
      single-cell/
      spatial/
      bulk/
      bioml/
    tools/
      omics-environment/
        omics-environment.toml
        pixi.toml
        pixi.lock
      omics-compute/
        omics-compute.toml
        python/
          aose_omics_runtime/
          tests/
      omics-preflight/
        omics-preflight.toml
```

`packages/` is not an npm workspace and package selection is not an external path loader. Manifest references are package-local relative references only.

## Manifest

Each package declares a root `package.toml`.

```toml
schema_version = "magenta.package.v1"
id = "AutOmicScience"
name = "AutOmicScience"
kind = "domain"
domain = "bioinformatics"
description = "Multi-omics analysis harness package."

[[components]]
kind = "skill"
name = "omics-shared"
path = "skills/omics-shared"
include_in_context = true

[[components]]
kind = "skill"
name = "rna"
path = "skills/rna"
include_in_context = true

[[components]]
kind = "tool"
name = "omics_environment"
path = "tools/omics-environment/omics-environment.toml"

[[components]]
kind = "tool"
name = "omics_compute"
path = "tools/omics-compute/omics-compute.toml"

[[components]]
kind = "python-runtime"
name = "aose_omics_runtime"
path = "tools/omics-compute/python/aose_omics_runtime"

[[components]]
kind = "env"
name = "pixi"
path = "tools/omics-environment/pixi.toml"
```

Selecting `AutOmicScience` loads its root components directly. Profiles remain
supported for packages that need opt-in resource subsets, but flat domain
packages should prefer root components and capability names over nested
`general/` or `task/` harness wrappers.

## Components

`package.toml` root components use the same flat component shape as the
Magenta3 registry:

```toml
[[components]]
kind = "skill"
name = "omics-shared"
path = "skills/omics-shared"
include_in_context = true

[[components]]
kind = "tool"
name = "omics_compute"
path = "tools/omics-compute/omics-compute.toml"
```

Root-level `[[components]]` in `package.toml` are the preferred package layout:
skills, tools, tool-owned implementations, pinned environments, locks, tests,
prompt templates, themes, brands, and system-prompt fragments all stay under the
package root in their capability folders. Optional profile harness files can
still select resource subsets, but they should not be used as a second domain or
task hierarchy when flat capability names are enough.

For migration from Magenta packs, the loader also accepts the old grouped shape:

```toml
[[components.skill]]
name = "omics-shared"
path = "skills/omics-shared"
```

Known resource component kinds are `skill`, `prompt-template`, `prompt`, `theme`, `system-prompt`, `append-system-prompt`, and `brand`. Other component kinds remain in the overlay component list for later harness/tool integrations.

`system-prompt` and `append-system-prompt` components should point at a module
descriptor TOML, matching the built-in `harness/modules/system-prompt/system-prompt.toml`
shape. Package-owned descriptors can provide package-local prompt text through
`content_path`:

```toml
kind = "system-prompt"
name = "system-prompt"
source = "AutOmicScience"
content_path = "SYSTEM.md"
```

The descriptor remains the selected Harness Module. The Markdown file is only
the module's content asset, not the component path.

`harness` values are relative to the package root. Root component `path` values
in `package.toml` are relative to the package root. Profile component `path`
values are relative to the profile harness file that declares them. All
references must stay inside the package directory. Absolute paths and `..`
references that escape `packages/<PackageName>/` are invalid.

## Tool Assembly

Package `tool` components are descriptors. At assembly time, `assemblePackageToolMagnets()` passes those descriptors to `hcp-magnet/package-tool.ts`, which chooses the appropriate Magnet cable:

```toml
kind = "tool"
name = "omics_compute"
description = "Run package-local omics compute subcommands."
runtime = "aose_omics_runtime"
module = "aose_omics_runtime"

[parameters]
type = "object"
required = ["subcommand"]
```

Currently implemented cables:

- `runtime = "process"` creates a `ProcessToolMagnet` for command-line tools and binaries.
- `runtime = "<name>"` plus a matching `python-runtime:<name>` component creates a `PythonModuleToolMagnet` using `python -m <module>`.
- `runtime = "shell"`, `"python"`, `"node"`, `"r"`, or `"julia"` creates a script-runtime Magnet. The descriptor must provide inline `code`/`script` or a package-local `script_path`; tool-call parameters are passed to the script runtime as stdin JSON and still drive `runtime://process` policy checks.

Declarative-only tools can set `execution = "declarative"`. They stay in the overlay for documentation and later integrations but are not converted into loop-ready `AgentTool`s.

Rust binaries, MCP servers, HTTP APIs, Node/R/Julia script adapters, and WASM runtimes should extend the same Magnet factory when their cables are added. Package selection should still resolve to a uniform `AgentTool` list before the agent loop starts.

## Precedence

The intended runtime precedence is:

```text
explicit session or CLI package selection
> project package selection
> user/default package selection
> extension/general harness
> built-in harness
```

Within a resolved overlay, later selected packages and later profiles replace earlier components with the same `kind:name`.
