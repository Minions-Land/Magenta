# Magenta3 Documentation

## Overview

Magenta3 is a terminal-native AI coding environment built on a Harness
execution layer, HCP assembly, domain packages, and a brand system. Its agent
loop, TUI, session system, and model providers are vendored from the upstream
Pi project.

## Documentation Structure

### Architecture
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Layered package architecture (pi-ai / agent-core / harness)
- **[BRANDING.md](./BRANDING.md)** - Brand system and multi-brand support
- **[../harness/docs/DEVELOPING.md](../harness/docs/DEVELOPING.md)** - Developer onboarding: how to add tools, capabilities, resources, and packages

### Setup
- **[AUTHENTICATION.md](./AUTHENTICATION.md)** - External auth (Claude Code / Codex credential auto-detect)

### Packages
- **[../packages/README.md](../packages/README.md)** - Domain packages (AutOmicScience, Biomni, ClaudeScience, PantheonOS) and how they load

### Project Information
- **[../README.md](../README.md)** - Project overview and quick start
- **[../harness/README.md](../harness/README.md)** - Harness architecture
- **[../harness/hcp-client/HCP-OVERVIEW.md](../harness/hcp-client/HCP-OVERVIEW.md)** - Assembly layer (HCP/Magnet/Registry)

## Key Concepts

### Brand System
Magenta uses a neutral brand registry allowing multiple brands (Magenta, Pi, custom) to coexist. See [BRANDING.md](./BRANDING.md).

### Harness Architecture
Modular component system with source separation by origin agent (`pi/`, `magenta/`, `codex/`, `claude-code/`) plus the Magenta memory package. See [harness/README.md](../harness/README.md).

### Assembly Layer
Component discovery, adaptation, and management at startup. See [harness/hcp-client/HCP-OVERVIEW.md](../harness/hcp-client/HCP-OVERVIEW.md).

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
