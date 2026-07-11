# Package Support

This private support directory defines Magenta3's generic Package integration
boundary. A configured Package can contribute components that override lower
layers by `kind:name`, but Magenta3 does not own concrete domain expert
Packages.

This directory is not part of `.HCP/`, is not a Harness Module, owns no
`HcpServer`, and is not a Package content root. Magenta3's root `packages/`
contains only the generic contract and templates. Concrete domain Packages will
be maintained and published in independent GitHub repositories; this
integration does not depend on a fixed sibling checkout.

This infrastructure owns parsing, profile expansion, component precedence,
package-local resource paths, and the conversion from selected Package
declarations to ordinary HcpClient component inputs.
`discoverHarnessPackages()` and `loadPackageOverlay()` accept an optional
`packagesRoot`; production integration with external content should supply that
boundary. When omitted, the API resolves only `<repoRoot>/packages`. It never
hardcodes or scans a sibling repository, `MagentaPackages`, or a git submodule.
Download, version selection, verification, and caching belong to a future
acquisition layer; this support code only consumes Packages already present in
the resolved root. This directory does not own TUI selection, CLI flags, or
language/runtime adapter selection.

`HcpClientpackageinputfromoverlay()` maps the selected declarations to ordinary
component inputs and Source settings before they enter `.HCP/assembly/`. HCP
assembly therefore has no Package-specific branch: it only resolves component
dependencies, calls `HcpMagnet.build()`, routes returned Magnets, and disposes
rejected products. Package `tool` descriptors are constructed through the
repository-declared `tools/descriptor/HcpMagnet.ts`; transport products never
become a new Module or Magnet subtype.

## Ownership boundary

Magenta3 keeps only the reusable contract and template material:

```text
packages/
  README.md
  templates/
    harness-package/
```

Domain package content belongs in its own upstream GitHub repository and follows
that repository's lifecycle. External integration supplies its local Package
root after acquisition; the omitted-root fallback is only `<repoRoot>/packages`,
not a fixed sibling path.
Manifest references remain package-local relative references only.

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
packages should prefer root components and component names over nested
`general/` or `task/` harness wrappers.

## Components

`package.toml` root components use the same flat declaration shape as the
repository harness TOML files:

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
package root in their component folders. Optional profile harness files can
still select resource subsets, but they should not be used as a second domain or
task hierarchy when flat component names are enough.

For migration from Magenta packs, the loader also accepts the old grouped shape:

```toml
[[components.skill]]
name = "domain-guide"
path = "skills/domain-guide"
```

Known resource component kinds are `skill`, `prompt-template`, `prompt`, `theme`,
`system-prompt`, `append-system-prompt`, and `brand`. The overlay returns only
the canonical resolved component list; it does not derive per-kind resource
arrays or a second lookup system. `HcpClientpackageinputfromoverlay()` maps
supported declarations to ordinary inputs using the owning `skills`,
`prompt-templates`, `themes`, `system-prompt`, `brand`, or `tools` Module's
repository-declared `descriptor/HcpMagnet`. The resulting Resource or Tool is
resolved from the one HcpClient. Other component kinds remain in the canonical
component list for later harness/tool integrations.

`system-prompt` and `append-system-prompt` components should point at a module
descriptor TOML, matching the repository-declared
`HarnessComponentProtocol/system-prompt/system-prompt.toml`
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
The Package support directory itself does not become the owner.

`harness` values are relative to the package root. Root component `path` values
in `package.toml` are relative to the package root. Profile component `path`
values are relative to the profile harness file that declares them. All
references must stay inside the package directory. Absolute paths and `..`
references that escape the resolved Package root are invalid.

Tool commands follow one portable rule set: absolute commands remain explicit,
bare commands such as `node` or `pixi` use `PATH`, and relative commands that
contain a path separator resolve from the owning tool descriptor directory.
Resolved relative commands must stay inside the actual package directory found
by the overlay. Process, script, and MCP products use that directory as their
execution workspace; Python products keep the agent project as their working
workspace and load package code through an absolute package path.

## Tool Assembly

Package `tool` components are descriptors.
`HcpClientpackageinputfromoverlay()` turns each selected descriptor into a
normal `tools:descriptor` component plus Source settings. The real
`tools/descriptor/HcpMagnet.ts` owns construction and delegates Package
descriptor parsing and product adaptation to
`tools/descriptor/package-tool.ts`. `.HCP/assembly/session-hcp.ts` sees only the
normal component and returned Magnets; it does not know that the settings came
from a Package. A `ProcessTool`, `PythonModuleTool`, or `McpTool` is not a Source
role or `HcpMagnet`:

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
- `runtime = "mcp"` lets the descriptor Magnet expand one server descriptor into
  sibling Magnets, one single-product `McpTool` per discovered remote tool. The
  shared connection is retained and released by those products rather than by
  HCP assembly.
- `runtime = "shell"`, `"python"`, `"node"`, `"r"`, or `"julia"` creates a script-backed `ProcessTool`. The descriptor must provide inline `code`/`script` or a package-local `script_path`; tool-call parameters are passed to the script runtime as stdin JSON and still drive `runtime://process` policy checks.

Declarative-only tools can set `execution = "declarative"`. They stay in the overlay for documentation and later integrations but are not converted into loop-ready `AgentTool`s.

Configured user MCP servers use the same `tools/descriptor/HcpMagnet.ts`
construction boundary: the host supplies one ordinary component per server,
and the Magnet may return one sibling Magnet per discovered tool. Package and
user MCP paths therefore share Source construction without teaching `.HCP/`
about MCP discovery, servers, schemas, or connections.

Future Rust binaries, HTTP APIs, and WASM runtimes should extend product
adaptation behind the same descriptor Magnet. Package selection still resolves
to uniform tool Sources owned by a real tool Module/Server and Source Magnet
before the agent loop starts. Transport plumbing never owns a Server or address.

## Precedence

The intended runtime precedence is:

```text
explicit session or CLI package selection
> project package selection
> user/default package selection
> extension/general harness
> repository default selection
```

Within a resolved overlay, later selected packages and later profiles replace earlier components with the same `kind:name`.
