# Magenta3 Documentation

## Overview

Magenta3 is an AI coding assistant forked from Pi, with enhanced modular architecture and brand system.

## Documentation Structure

### Architecture
- **[BRANDING.md](./BRANDING.md)** - Brand system and multi-brand support
- **[specs/](./specs/)** - Technical specifications and design decisions

### Features
- **[features/](./features/)** - Planned and in-progress features
  - [Agentic Updating](./features/agentic-updating.md) - Self-evolution capability

### Project Information
- **[../README.md](../README.md)** - Project overview and quick start
- **[../harness/README.md](../harness/README.md)** - Harness architecture
- **[../harness/assembly/README.md](../harness/assembly/README.md)** - Assembly layer (HCP/Magnet/Registry)

## Key Concepts

### Brand System
Magenta uses a neutral brand registry allowing multiple brands (Magenta, Pi, custom) to coexist. See [BRANDING.md](./BRANDING.md).

### Harness Architecture
Modular component system with source separation (pi/, rust/, mcp/). See [harness/README.md](../harness/README.md).

### Assembly Layer
Component discovery, adaptation, and management at startup. See [harness/assembly/README.md](../harness/assembly/README.md).

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
