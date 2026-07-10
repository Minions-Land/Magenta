# Magenta3 Documentation

## Overview

Magenta3 is a terminal-native AI coding environment built on a Harness
execution layer, HCP assembly, a domain-package integration boundary, and a brand system. Its agent
loop, TUI, session system, and model providers are vendored from the upstream
Pi project.

## Documentation Structure

### Architecture
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Layered package architecture (pi-ai / agent-core / harness)
- **[BRANDING.md](./BRANDING.md)** - Brand system and multi-brand support
- **[../HarnessComponentProtocol/docs/DEVELOPING.md](../HarnessComponentProtocol/docs/DEVELOPING.md)** - Developer onboarding: how to add tools, capabilities, resources, and packages

### Setup
- **[AUTHENTICATION.md](./AUTHENTICATION.md)** - External auth (Claude Code / Codex credential auto-detect)

### Packages
- **[../packages/README.md](../packages/README.md)** - Generic domain-package integration contract and template

### Project Information
- **[../README.md](../README.md)** - Project overview and quick start
- **[../HarnessComponentProtocol/README.md](../HarnessComponentProtocol/README.md)** - Harness architecture
- **[../HarnessComponentProtocol/.HCP/HCP-OVERVIEW.md](../HarnessComponentProtocol/.HCP/HCP-OVERVIEW.md)** - Assembly layer (HCP/Magnet/Registry)

## Key Concepts

### Brand System
Magenta uses a neutral brand registry allowing multiple brands (Magenta, Pi, custom) to coexist. See [BRANDING.md](./BRANDING.md).

### Harness Architecture
Modular component system with source separation by origin agent (`pi/`, `magenta/`, `codex/`, `claude-code/`) plus the Magenta memory package. See [HarnessComponentProtocol/README.md](../HarnessComponentProtocol/README.md).

### Assembly Layer
Component discovery, adaptation, and management at startup. See [HarnessComponentProtocol/.HCP/HCP-OVERVIEW.md](../HarnessComponentProtocol/.HCP/HCP-OVERVIEW.md).

## Version Strategy

Magenta uses **two-layer versioning**:
- **Product layer** (Magenta-specific): v0.0.1
- **Infrastructure layer** (Pi/harness): v0.80.2

See [BRANDING.md](./BRANDING.md) for details.

## Contributing

When adding documentation:
1. Place in the appropriate subdirectory
2. Update this index
3. Use clear headings and examples
4. Link related documents
