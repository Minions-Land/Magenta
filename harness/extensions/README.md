# Extensions Module

The **extensions** module owns bundled pi agent extensions that are loaded by the coding-agent runtime.

## Layout

- `extensions/pi/extensions.ts` exports path helpers for bundled extension discovery.
- `extensions/pi/bundled/` contains the concrete built-in extension implementations.

Package manifests should only declare/select extension resources. Concrete bundled implementations live here under `harness/extensions` so the harness registry shows agent-callable built-ins in one place.
