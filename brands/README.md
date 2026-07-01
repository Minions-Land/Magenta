# Brand Registry System

Centralized brand configuration system for the agent. Supports multiple brands (Pi, Magenta, custom) with automatic synchronization.

## Structure

```
brands/
  registry.toml              # Brand registry (declares active brand)
  brand.interface.ts         # TypeScript interface for brand configs
  
  magenta/
    magenta.brand.ts         # Magenta brand configuration
  
  pi/
    pi.brand.ts              # Pi (upstream) brand configuration
  
  template/
    template.brand.ts        # Template for creating new brands
```

## Active Brand

The active brand is set in `brands/registry.toml`:

```toml
active = "magenta"
```

Change `active` to any registered brand name and run `npm run sync-brand`.

## Registered Brands

### Magenta
- **Name**: Magenta
- **Version**: 0.0.1 (product version)
- **Theme**: Pink/Magenta (#E91E63) + Purple (#9C27B0)
- **CLI**: `magenta`
- **Scope**: `@magenta/*`

### Pi
- **Name**: Pi
- **Version**: 0.80.2 (matches infrastructure)
- **Theme**: Blue (#2196F3)
- **CLI**: `pi`
- **Scope**: `@earendil-works/*`

## Brand Configuration Interface

All brand configs export `BRAND_CONFIG: BrandConfig`:

```typescript
interface BrandConfig {
  name: string;              // Agent name
  version: string;           // Product version
  packageScope: string;      // NPM scope (@magenta, @yourcompany)
  
  theme: {
    primaryColor: string;    // Main brand color (hex)
    accentColor: string;
    successColor: string;
    warningColor: string;
    errorColor: string;
  };
  
  cli: {
    binaryName: string;      // Command name
    description: string;
    welcomeMessage: string;
    prompt: string;
  };
  
  urls: {
    homepage: string;
    docs: string;
    issues: string;
    repository: string;
  };
  
  infra: {
    piVersion: string;       // Infrastructure version (pi/*)
    harnessVersion: string;  // Harness version
    renamePiPackages: boolean; // Rename to @{scope}/* or keep @earendil-works/pi-*
  };
  
  productPackages?: string[]; // Brand-specific packages
}
```

## Synchronization

Run the sync script to apply brand configuration to all packages:

```bash
# Apply active brand from registry.toml
npm run sync-brand

# Dry-run (preview changes without modifying files)
npm run sync-brand -- --dry-run

# Override active brand temporarily
npm run sync-brand -- --brand=pi

# Switch active brand permanently
# 1. Edit brands/registry.toml: active = "pi"
# 2. Run: npm run sync-brand
# 3. npm install && npm run build
```

The sync script updates:
- All package.json `version` fields (product packages → brand version, infra → infra version)
- All package.json `name` fields (if `renamePiPackages: true`)
- Workspace dependency versions
- CLI binary name, description (future)
- Theme colors (future)

## Creating a New Brand

1. **Copy template**:
   ```bash
   cp -r brands/template brands/yourbrand
   mv brands/yourbrand/template.brand.ts brands/yourbrand/yourbrand.brand.ts
   ```

2. **Edit configuration**:
   ```typescript
   // brands/yourbrand/yourbrand.brand.ts
   export const BRAND_CONFIG: BrandConfig = {
     name: "YourAgent",
     version: "0.0.1",
     packageScope: "@youragent",
     theme: { primaryColor: "#007ACC", ... },
     cli: { binaryName: "youragent", ... },
     // ...
   };
   ```

3. **Register in `brands/registry.toml`**:
   ```toml
   [[brands]]
   name = "yourbrand"
   path = "yourbrand/yourbrand.brand.ts"
   description = "Your custom agent"
   ```

4. **Activate and sync**:
   ```bash
   # Edit registry.toml: active = "yourbrand"
   npm run sync-brand
   npm install
   npm run build
   ```

5. **Verify**:
   ```bash
   node pi/coding-agent/dist/cli.js --version  # Should show your version
   ```

## Two-Layer Versioning

- **Product layer** (`@magenta/memory` and other Magenta-specific packages) → Uses `BRAND_CONFIG.version`
- **Harness layer** (`@magenta/harness`) → Uses `BRAND_CONFIG.infra.harnessVersion`
- **Infrastructure layer** (`pi/*` packages) → Uses `BRAND_CONFIG.infra.piVersion`

This allows:
- Magenta product releases (0.0.1 → 0.1.0) independent of infrastructure updates
- Tracking upstream pi updates (0.80.2 → 0.81.0) without forcing a Magenta product bump
- Clear separation: product features vs. foundation updates

## CLI Version Display

Currently `--version` shows the infrastructure version (0.80.2, from coding-agent's package.json).

**Future enhancement**: Show both layers:
```
Magenta 0.0.1
  Infrastructure: pi@0.80.2, harness@0.1.0
```

See `docs/BRANDING.md` for full design rationale.
