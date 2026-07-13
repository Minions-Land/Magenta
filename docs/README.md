# Magenta Documentation

This directory contains the maintained product and contributor guides. Use each topic's authoritative document instead of copying commands or contracts into new status reports.

## Use Magenta

- [Installation](./USER_INSTALL.md): verified binary installation, source installation, update, and removal
- [Authentication](./AUTHENTICATION.md): credential resolution, provider login, and security boundaries
- [Coding-agent documentation](../pi/coding-agent/docs/index.md): CLI, settings, sessions, extensions, SDK, RPC, themes, and terminal behavior
- [Package loading](../pi/coding-agent/docs/packages.md): local and GitHub Package selectors

## Develop Magenta

- [Architecture](./ARCHITECTURE.md): workspace ownership, runtime flow, and assembly boundaries
- [Development](./DEVELOPING.md): repository setup, validation, and change workflow
- [Release](./UPDATE_SETUP_GUIDE.md): tag-driven binary release pipeline and updater contract
- [Brand configuration](../brands/README.md): build-time product metadata and synchronization
- [Repository scripts](../scripts/README.md): supported maintenance commands and mutating-script cautions

## HCP Governance

HCP has four durable sources of truth, each with a separate concern:

| Concern | Authority |
|---|---|
| Role and identifier naming | [HCP naming law](../HarnessComponentProtocol/docs/governance/hcp-naming.md) |
| Runtime architecture and ownership | [HCP architecture](../HarnessComponentProtocol/docs/governance/hcp-architecture.md) |
| Change discipline and invariants | [HCP contract](../HarnessComponentProtocol/docs/governance/contract.md) |
| Implementation workflow | [HCP development guide](../HarnessComponentProtocol/docs/DEVELOPING.md) |

The [Harness workspace README](../HarnessComponentProtocol/README.md) is the entry point. Module-specific READMEs describe only their owning module; they do not override the governance documents.

## Documentation Rules

- Link to an authority rather than duplicating its contract.
- Do not hardcode a release version, binary size, or supported model inventory. Obtain those from `magenta --version`, the current Release, or `magenta --list-models`.
- Commands in maintained docs must match a current `package.json` script, CLI option, workflow, or checked-in executable.
- Use repository-relative links for repository files and verify anchors after renaming headings.
- Historical research evidence belongs under `.research/`; it is not current product documentation.

Run the documentation gate from the repository root:

```bash
npm run check:docs
```
