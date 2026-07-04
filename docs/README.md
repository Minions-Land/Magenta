# Magenta3 Documentation

## Overview

Magenta3 is an AI coding assistant forked from Pi, with enhanced modular architecture, a harness execution layer, and a brand system.

## Documentation Structure

### Architecture
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Layered package architecture (pi-ai / agent-core / harness)
- **[BRANDING.md](./BRANDING.md)** - Brand system and multi-brand support
- **[specs/](./specs/)** - Technical specifications and design decisions
- **[../harness/docs/DEVELOPING.md](../harness/docs/DEVELOPING.md)** - Developer onboarding: how to add tools, capabilities, resources, and packages

### Setup
- **[AUTHENTICATION.md](./AUTHENTICATION.md)** - External auth (Claude Code / Codex credential auto-detect)

### Features
- **[features/](./features/)** - Planned and in-progress features
  - [Agentic Updating](./features/agentic-updating.md) - Self-evolution capability

### Project Information
- **[../README.md](../README.md)** - Project overview and quick start
- **[../harness/README.md](../harness/README.md)** - Harness architecture
- **[../harness/hcp/README.md](../harness/hcp/README.md)** - Assembly layer (HCP/Magnet/Registry)

## Key Concepts

### Brand System
Magenta uses a neutral brand registry allowing multiple brands (Magenta, Pi, custom) to coexist. See [BRANDING.md](./BRANDING.md).

### Harness Architecture
Modular component system with source separation by origin agent (`pi/`, `magenta/`, `codex/`, `claude-code/`) plus the Magenta memory package. See [harness/README.md](../harness/README.md).

### Assembly Layer
Component discovery, adaptation, and management at startup. See [harness/hcp/README.md](../harness/hcp/README.md).

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

## Self-Evolution Vision

Magenta is developing capabilities for self-development and self-evolution:
- Intelligent upstream merging
- Self-analysis and improvement
- Adaptive architecture
- Autonomous documentation

See [features/](./features/) for planned capabilities.
