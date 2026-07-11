# Magenta3 Documentation

This directory contains repository-level documentation. Harness-specific
architecture and naming rules live beside the Harness source so there is only
one authoritative HCP specification.

## Start Here

- [`../README.md`](../README.md) - product overview, build, launch, and common commands
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) - package ownership, runtime flow, and integration boundaries
- [`DEVELOPING.md`](./DEVELOPING.md) - contribution workflow and verification gates
- [`AUTHENTICATION.md`](./AUTHENTICATION.md) - provider credential lookup and setup
- [`BRANDING.md`](./BRANDING.md) - build-time brand registry and synchronization

## Installation and Distribution

- [`USER_INSTALL.md`](./USER_INSTALL.md) - user installation guide
- [`UPDATE_SETUP_GUIDE.md`](./UPDATE_SETUP_GUIDE.md) - release and auto-update workflow for maintainers

## Harness And HCP

- [`../HarnessComponentProtocol/README.md`](../HarnessComponentProtocol/README.md) - current Harness layout
- [`../HarnessComponentProtocol/.HCP/HCP-OVERVIEW.md`](../HarnessComponentProtocol/.HCP/HCP-OVERVIEW.md) - HCP assembly walkthrough
- [`../HarnessComponentProtocol/docs/DEVELOPING.md`](../HarnessComponentProtocol/docs/DEVELOPING.md) - task-oriented component development
- [`../HarnessComponentProtocol/docs/governance/hcp-architecture.md`](../HarnessComponentProtocol/docs/governance/hcp-architecture.md) - authoritative HCP architecture
- [`../HarnessComponentProtocol/docs/governance/hcp-naming.md`](../HarnessComponentProtocol/docs/governance/hcp-naming.md) - authoritative entity-tree naming rules

## Other Boundaries

- [`../packages/README.md`](../packages/README.md) - retained domain Package contract and template
- [`../brands/README.md`](../brands/README.md) - brand registry implementation details
- [`../tests/README.md`](../tests/README.md) - end-to-end test suite
- [`../pi/README-upstream.md`](../pi/README-upstream.md) - preserved upstream Pi documentation

## Documentation Rules

1. Describe implemented behavior, not planned behavior, as current fact.
2. Keep HCP naming rules in the Harness governance document and link to them
   instead of creating another copy.
3. Distinguish Pi extension packages from Harness domain Packages.
4. Verify every command against the current root and workspace scripts.
5. Update this index when adding a repository-level document.
