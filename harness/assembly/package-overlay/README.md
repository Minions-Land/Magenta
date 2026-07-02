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
    .omics-runtime/
      aose_omics_runtime/
      tests/
    pixi.toml
    pixi.lock
    general/
      harness.toml
      skills/
      tools/
    task/
      scrna/
        harness.toml
        skills/
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
default_profiles = ["general"]

[[components]]
kind = "python-runtime"
name = "aose_omics_runtime"
path = ".omics-runtime/aose_omics_runtime"

[[components]]
kind = "env"
name = "pixi"
path = "pixi.toml"

[[profiles]]
name = "general"
description = "Shared omics harness resources."
harness = "general/harness.toml"

[[profiles]]
name = "scrna"
description = "Single-cell RNA-seq task harness."
extends = ["general"]
harness = "task/scrna/harness.toml"
```

Selecting `AutOmicScience` loads `default_profiles`. Selecting `AutOmicScience:scrna` loads the selected profile plus its `extends` chain. Selecting `AutOmicScience:*` loads every profile.

## Components

Profile harness files use the same flat component shape as the Magenta3 registry:

```toml
name = "omics-general"
description = "Shared omics package profile."

[[components]]
kind = "skill"
name = "omics-shared"
path = "skills/omics-shared"
include_in_context = true

[[components]]
kind = "tool"
name = "omics_runtime"
path = "tools/omics-runtime.toml"
```

Root-level `[[components]]` in `package.toml` are package-owned implementation
assets that should be available to every selected profile, such as package-local
runtimes, pinned environments, locks, runtime tests, or shared binaries. Profile
harness files should select user-facing resources for that profile, such as
skills, tools, prompt templates, themes, brands, and system-prompt fragments.

For migration from Magenta packs, the loader also accepts the old grouped shape:

```toml
[[components.skill]]
name = "omics-shared"
path = "skills/omics-shared"
```

Known resource component kinds are `skill`, `prompt-template`, `prompt`, `theme`, `system-prompt`, `append-system-prompt`, and `brand`. Other component kinds remain in the overlay component list for later harness/tool integrations.

`harness` values are relative to the package root. Root component `path` values
in `package.toml` are relative to the package root. Profile component `path`
values are relative to the profile harness file that declares them. All
references must stay inside the package directory. Absolute paths and `..`
references that escape `packages/<PackageName>/` are invalid.

## Tool Assembly

Package `tool` components are descriptors. At assembly time, `assemblePackageToolMagnets()` passes those descriptors to `assembly/magnet/pi/package-tool.ts`, which chooses the appropriate Magnet cable:

```toml
kind = "tool"
name = "omics_runtime"
description = "Dispatch to the package-local Python runtime."
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
