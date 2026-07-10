# Harness Package Overlay

This directory defines Magenta3's generic package integration boundary. A
configured package can contribute components that override lower layers by
`kind:name`, but Magenta3 does not own concrete domain expert packages.

This directory contains package-overlay infrastructure. It is not a Harness
Module, owns no `HcpServer`, and is not a package content root. Magenta3's root
`packages/` contains only the generic contract and templates. Concrete domain
packages are independently managed and versioned in `MagentaPackages`.

This infrastructure owns parsing, profile expansion, component precedence, and
package-local resource paths. Its parser can be exercised against an explicit
repository root, but the production connector for external `MagentaPackages`
content is deferred. That connector must not hardcode or implicitly scan the
sibling repository. This layer does not own TUI selection, CLI
flags, or language/runtime adapter selection. Package `tool` descriptors are
adapted through the generated `tools/magenta/HcpMagnet.ts`; transport products
never become a new Module or Magnet subtype.

## Ownership boundary

Magenta3 keeps only the reusable interface material:

```text
packages/
  README.md
  templates/
    harness-package/
```

Domain package content belongs in `MagentaPackages`, under that repository's
own lifecycle. Future production integration must accept an explicit package
root instead of relying on a fixed sibling path. Manifest references remain
package-local relative references only.

## Manifest

Each package declares a root `package.toml`.

```toml
schema_version = "magenta.package.v1"
id = "ExampleDomain"
name = "ExampleDomain"
kind = "domain"
domain = "example"
description = "Example independently managed domain package."

[[components]]
kind = "skill"
name = "domain-guide"
path = "skills/domain-guide"
include_in_context = true

[[components]]
kind = "skill"
name = "domain-workflow"
path = "skills/domain-workflow"
include_in_context = true

[[components]]
kind = "tool"
name = "domain_environment"
path = "tools/domain-environment/domain-environment.toml"

[[components]]
kind = "tool"
name = "domain_compute"
path = "tools/domain-compute/domain-compute.toml"

[[components]]
kind = "python-runtime"
name = "domain_runtime"
path = "tools/domain-compute/python/domain_runtime"

[[components]]
kind = "env"
name = "pixi"
path = "tools/domain-environment/pixi.toml"
```

Selecting a configured package such as `ExampleDomain` loads its root
components directly. Profiles remain
supported for packages that need opt-in resource subsets, but flat domain
packages should prefer root components and capability names over nested
`general/` or `task/` harness wrappers.

## Components

`package.toml` root components use the same flat component shape as the
Magenta3 registry:

```toml
[[components]]
kind = "skill"
name = "domain-guide"
path = "skills/domain-guide"
include_in_context = true

[[components]]
kind = "tool"
name = "domain_compute"
path = "tools/domain-compute/domain-compute.toml"
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
name = "domain-guide"
path = "skills/domain-guide"
```

Known resource component kinds are `skill`, `prompt-template`, `prompt`, `theme`, `system-prompt`, `append-system-prompt`, and `brand`. Other component kinds remain in the overlay component list for later harness/tool integrations.

`system-prompt` and `append-system-prompt` components should point at a module
descriptor TOML, matching the built-in `HarnessComponentProtocol/system-prompt/system-prompt.toml`
shape. Package-owned descriptors can provide package-local prompt text through
`content_path`:

```toml
kind = "system-prompt"
name = "system-prompt"
source = "ExampleDomain"
content_path = "SYSTEM.md"
```

The descriptor selects a resource component that assembly attaches to existing
real ownership; it does not create a package-local HCP Module or Server. The
Markdown file is only that component's content asset, not the component path.
The overlay directory itself does not become the owner.

`harness` values are relative to the package root. Root component `path` values
in `package.toml` are relative to the package root. Profile component `path`
values are relative to the profile harness file that declares them. All
references must stay inside the package directory. Absolute paths and `..`
references that escape the explicitly supplied package root are invalid.

## Tool Assembly

Package `tool` components are descriptors. At assembly time,
`.HCP/assembly/session-hcp.ts` expands their build settings and routes them
through `tools/descriptor/HcpMagnet.ts`. That Magnet calls
`tools/descriptor/package-tool.ts::createPackageToolProduct()` to materialize
one or more product adapters. A `ProcessTool`, `PythonModuleTool`, or `McpTool`
is not a source role or `HcpMagnet`:

```toml
kind = "tool"
name = "domain_compute"
description = "Run a package-local domain computation."
runtime = "domain_runtime"
module = "domain_runtime"

[parameters]
type = "object"
required = ["subcommand"]
```

Currently implemented product adapters:

- `runtime = "process"` creates a `ProcessTool` for command-line tools and binaries.
- `runtime = "<name>"` plus a matching `python-runtime:<name>` component creates a `PythonModuleTool` using `python -m <module>`.
- `runtime = "mcp"` uses `createMcpTools()` and may fan one server descriptor out into multiple `McpTool` products.
- `runtime = "shell"`, `"python"`, `"node"`, `"r"`, or `"julia"` creates a script-backed `ProcessTool`. The descriptor must provide inline `code`/`script` or a package-local `script_path`; tool-call parameters are passed to the script runtime as stdin JSON and still drive `runtime://process` policy checks.

Declarative-only tools can set `execution = "declarative"`. They stay in the overlay for documentation and later integrations but are not converted into loop-ready `AgentTool`s.

Future Rust binaries, HTTP APIs, and WASM runtimes should extend this product
factory behind the same generated tools Magnet. Package selection still
resolves to uniform tool sources owned by a real tool Module/Server and source
Magnet before the agent loop starts.
Transport plumbing never owns a Server or registers an address.

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
