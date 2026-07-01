# Brand Configuration System

**Purpose**: Centralized brand registry for agent identity, theming, and versioning. Supports multiple brands (Pi, Magenta, custom) with automatic synchronization.

## Quick Start

```bash
# View current active brand
cat brands/registry.toml

# Sync all packages to active brand configuration
npm run sync-brand

# Preview changes without modifying files
npm run sync-brand -- --dry-run

# Temporarily switch to a different brand
npm run sync-brand -- --brand=pi

# Switch active brand permanently
# 1. Edit brands/registry.toml: active = "yourbrand"
# 2. npm run sync-brand
# 3. npm install && npm run build
```

## Architecture

All brand configurations live under `brands/`:

```
brands/
  registry.toml              # Declares active brand
  brand.interface.ts         # TypeScript interface for all brands
  
  magenta/
    magenta.brand.ts         # Magenta brand configuration
  
  pi/
    pi.brand.ts              # Pi (upstream) brand configuration
  
  template/
    template.brand.ts        # Template for creating new brands
  
  README.md                  # Complete documentation
```

**See `brands/README.md` for detailed documentation, including:**
- Brand configuration interface
- Creating new brands (6-step workflow)
- Two-layer versioning strategy
- Synchronization details

## Two-Layer Versioning

The system maintains separate versions for infrastructure and product:

**Infrastructure Layer** (foundation packages)
- `@earendil-works/pi-ai`, `pi-tui`, `pi-agent-core`, `pi-coding-agent` → **0.80.2**
- `@magenta/harness` → **0.1.0**
- Track upstream evolution, easier to pull updates

**Product Layer** (brand-specific)
- `@magenta/memory` and other Magenta-specific packages → **0.0.1**
- Independent release cycle for product features
- Currently minimal (most code is infrastructure)

This allows:
- Magenta releases (0.0.1 → 0.1.0) without forcing infrastructure bumps
- Pulling pi updates (0.80.2 → 0.81.0) without Magenta version changes
- Clear separation: product identity vs. shared foundation

## Available Brands

### Magenta (default)
- **Version**: 0.0.1
- **Theme**: Pink/Magenta (#E91E63) + Purple (#9C27B0)
- **CLI**: `magenta`
- **Scope**: `@magenta/*`

### Pi
- **Version**: 0.80.2 (matches infrastructure)
- **Theme**: Blue (#2196F3)
- **CLI**: `pi`
- **Scope**: `@earendil-works/*`

## Creating a New Brand

1. Copy `brands/template/` to `brands/yourbrand/`
2. Edit `yourbrand.brand.ts` (name, colors, URLs, CLI)
3. Register in `brands/registry.toml`
4. Run `npm run sync-brand`
5. Build and verify

See `brands/README.md` for step-by-step guide with examples.

## Future Integration

The brand configuration system is currently used for:
- ✅ Package versioning (via `npm run sync-brand`)
- ✅ Package naming (product vs. infrastructure)
- ✅ Workspace dependency management

**Planned integrations**:
- [ ] CLI config (`pi/coding-agent/src/config.ts` imports from active brand)
- [ ] TUI theme (`pi/tui/src/theme.ts` uses brand colors)
- [ ] CLI `--version` output (show both product and infrastructure versions)
- [ ] Documentation generation (auto-interpolate brand name/URLs)

## Migration Note

Previously `magenta.config.ts` was at project root. It has been moved to `brands/magenta/magenta.brand.ts` as part of the multi-brand registry system.
