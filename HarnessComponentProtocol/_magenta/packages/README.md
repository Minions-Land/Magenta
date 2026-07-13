# Package Support

This private support directory defines Magenta's generic Package integration
boundary. A configured Package can contribute components that override lower
layers by `kind:name`, but Magenta does not own concrete domain expert Packages.

This directory is not part of `.HCP/`, is not a Harness Module, owns no
`HcpServer`, and is not a Package content root. Magenta's root `packages/`
contains only the generic contract and templates. Concrete domain Packages are
maintained and published in independent GitHub repositories; this integration
does not depend on a fixed sibling checkout.

The coding-agent host may resolve
`github:owner/repo/Package@version`, download the matching platform archive and
checksum, validate and safely extract it, and pass the cached local root to
`HcpClientloadpackageoverlay()`. Local development may supply `packagesRoot`
directly. When omitted, local discovery resolves only `<repoRoot>/packages`.
Neither path scans a sibling repository, `MagentaPackages`, or a git submodule.

`HcpClientpackageinputfromoverlay()` maps the selected declarations to ordinary
component inputs and Source settings before they enter `.HCP/assembly/`. HCP
assembly therefore has no Package-specific branch: it only resolves component
dependencies, calls `HcpMagnet.build()`, routes returned Magnets, and disposes
rejected products. Package `tool` descriptors are constructed through the
repository-declared `tools/descriptor/HcpMagnet.ts`; transport products never
become a new Module or Magnet subtype.

## Ownership boundary

Magenta keeps only the reusable contract and template material:

```text
packages/
  README.md
  templates/
    harness-package/
```

Domain package content belongs in its own upstream GitHub repository and follows
that repository's lifecycle. Platform release archives are host infrastructure,
not HCP roles. Manifest references remain package-local relative references
only.

## Manifest

Each package declares a root `package.toml`.

```toml
schema_version = "magenta.package.v2"
id = "ExampleDomain"
name = "ExampleDomain"
version = "1.0.0"
kind = "domain"
domain = "example"
source = "ExampleDomain"
description = "Example independently managed domain package."
default_profiles = []

[[components]]
kind = "skill"
name = "domain-guide"
source = "ExampleDomain"
path = "skills/domain-guide/ExampleDomain"
include_in_context = true

[[components]]
kind = "tool"
name = "domain_compute"
source = "ExampleDomain"
path = "tools/domain-compute/ExampleDomain"

[[components]]
kind = "python-runtime"
name = "domain_runtime"
source = "ExampleDomain"
path = "tools/domain-compute/python/domain_runtime"

[[components]]
kind = "env"
name = "pixi"
source = "ExampleDomain"
path = "tools/domain-environment/pixi.toml"
```

Every non-infrastructure component path points at a Source directory containing
`HcpMagnet.ts`. Its owning Module directory contains `HcpServer.ts`. Profiles
may narrow large packages without changing this entity tree.

## Components

Schema-v2 packages are HCP-isomorphic:

```text
skills/<skill>/HcpServer.ts
skills/<skill>/<source>/HcpMagnet.ts
tools/<tool>/HcpServer.ts
tools/<tool>/<source>/HcpMagnet.ts
brand/HcpServer.ts
brand/<source>/HcpMagnet.ts
system-prompt/HcpServer.ts
system-prompt/<source>/HcpMagnet.ts
```

Each role file exports only the bare role class. Resource Magnets expose
`toResource()` with `contentPath` or inline content. Tool Magnets expose
`toTool()` and use the Client-injected host builder during static `build()`.
This preserves the real package Source while reusing sandbox/runtime/MCP
construction. Package-local
infrastructure kinds (`python-runtime`, `runtime-tests`, `env`, `env-lock`) are
preserved in the tool context but do not own Magnets.

All manifest and descriptor references must remain inside the package root.
Absolute component paths, traversal, symlink escapes, unsafe release entries,
and tool-relative commands that escape the package are rejected.

Tool commands follow one portable rule set: absolute commands remain explicit,
bare commands such as `node` or `pixi` use `PATH`, and relative commands that
contain a path separator resolve from the owning tool descriptor directory.
Resolved relative commands must stay inside the actual package directory found
by the overlay. Process, script, and MCP products use that directory as their
execution workspace; Python products keep the agent project as their working
workspace and load package code through an absolute package path. Native
descriptors may add `command_windows`, `command_macos`, or `command_linux`, with
`command` as the fallback.

## Tool Assembly

Each selected package `tool` component keeps its package-owned `HcpMagnet`.
`HcpClientpackageinputfromoverlay()` injects the Client-owned
`HcpClientbuildtools` setting; the package Magnet calls it during `build()`, then
wraps the returned host-backed product and exposes `toTool()` itself. The shared
`HcpClientbuildpackagetoolproducts()` builder validates the package-local
descriptor and constructs the sandbox/runtime/MCP product without replacing
the package Source identity. `tools/descriptor/HcpMagnet.ts` remains only the
built-in descriptor Source. `.HCP/assembly/session-hcp.ts` sees ordinary real
Magnets and has no Package-specific path. A `ProcessTool`, `PythonModuleTool`,
or `McpTool` is not a Source role or `HcpMagnet`:

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
- `runtime = "mcp"` lets the Client builder expand one server descriptor into
  sibling products, one single-product `McpTool` per discovered remote tool.
  The package Magnet wraps those products as sibling Magnets. The shared
  connection is retained and released by the products rather than by HCP
  assembly.
- `runtime = "shell"`, `"python"`, `"node"`, `"r"`, or `"julia"` creates a script-backed `ProcessTool`. The descriptor must provide inline `code`/`script` or a package-local `script_path`; tool-call parameters are passed to the script runtime as stdin JSON and still drive `runtime://process` policy checks.

Declarative-only tools can set `execution = "declarative"`. They stay in the overlay for documentation and later integrations but are not converted into loop-ready `AgentTool`s.

Configured user MCP servers use the built-in `tools/descriptor/HcpMagnet.ts`:
the host supplies one ordinary component per server, and that Magnet may return
one sibling Magnet per discovered tool. Package and user MCP paths reuse the
same Client-owned product support without sharing or replacing Source identity,
and neither path teaches `.HCP/` about MCP discovery, servers, schemas, or
connections.

Future Rust binaries, HTTP APIs, and WASM runtimes should extend product
adaptation behind the same Client-owned builder. Package selection still
resolves to uniform tool Sources owned by a real tool Module/Server and Source
Magnet before the agent loop starts. Transport plumbing never owns a Server or
address.

## Precedence

The intended runtime precedence is:

```text
explicit session or CLI package selection
> project package selection
> user/default package selection
> extension/general harness
> repository default selection
```

Within a manifest, multiple Sources may offer the same `kind:name`, while an
exact duplicate `kind:name:source` is invalid. Within the resolved overlay,
later selected packages and profiles replace earlier components at the same
`kind:name` address.
