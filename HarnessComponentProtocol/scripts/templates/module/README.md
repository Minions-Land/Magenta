# Harness Module Template

This directory provides the standard layout for a TOML-declared Harness Module.

```text
HarnessComponentProtocol/<module>/
  <module>.toml
  HcpServer.ts
  pi/
    HcpMagnet.ts
    *.ts
  magenta/
    HcpMagnet.ts
    *.ts
  README.md
```

Source directories identify origin (`pi`, `magenta`, `codex`,
`claude-code`), not technology. Rust, Python, process, and MCP details stay
inside the source that owns them.

## Required Roles

The module owns a real Server:

```typescript
export class HcpServer {
  readonly moduleName = "my-module";
  readonly description = "What this module provides.";
}
```

Each declared Source owns a bare Magnet class. A Capability Source looks like:

```typescript
import type { HcpMagnetBinding } from "../../.HCP/HcpMagnetTypes.ts";
import type { HcpMagnetBuildContext } from "../../.HCP/HcpMagnetTypes.ts";
import { MyProvider } from "./my-module.ts";

export class HcpMagnet {
  static readonly module = "my-module";
  static readonly kind = "my-module";
  static readonly source = "pi";
  static build(context: HcpMagnetBuildContext) {
    return new HcpMagnet(context);
  }

  readonly kind = "capability:my-module";
  readonly hotSwappable: boolean;
  private readonly provider: MyProvider;

  constructor(context: HcpMagnetBuildContext) {
    this.hotSwappable = context.hotSwappable ?? false;
    this.provider = new MyProvider(context);
  }

  toCapability(): HcpMagnetBinding<MyProvider> {
    return {
      kind: "my-module",
      name: "my-module",
      source: "pi",
      instance: this.provider,
    };
  }
}
```

A tool Magnet uses `toTool()`; a resource Magnet uses `toResource()`. A Magnet
must produce exactly one product. It never exposes `toHcpServer()` and never
selects among sources.

## TOML Declaration

1. Create `<module>.toml` with `kind`, `product`, `slot` when applicable,
   `name`, `source`, and Source-specific dependencies.
2. Add the component path to `harness.toml`.
3. Export the public product from `index.ts` when it is part of the package API.
4. Generate the static assembly map:

```bash
npm run generate:hcp-sources
```

Do not hand-edit `.HCP/assembly/sources.generated.ts` or add another Server list,
Source list, or builder table.

## Resources

Content-only components such as skills, package system prompts, themes, and
brands are Resources. Their TOML declares `product = "resource"`; they never
enter the Capability construction path.

## Verification

```bash
npm run generate:hcp-sources -- --check
npm run check:structure
npm run check:assumptions
npm run build
npm test
```
