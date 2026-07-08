# Strict Model B (Plan A) — Frozen Interface Contract

**Status**: FROZEN. All branches implement against these signatures. No deviation.
**Rule**: No backward-compat shims. No facade objects. No per-magnet server returned from `resolve()`. Tests may be freely rewritten. The goal is a clean architecture that keeps future development flexible, NOT preservation of old call sites.

## The Core Principle

The resolution chain is EXACTLY:

```
HcpClient → HcpServer(module-level) → HcpMagnet(source) → source impl
```

`HcpClient.resolve(address)` returns a **module-level `HcpServer`** (a `ModuleHcpServer`).
It NEVER returns a per-magnet server directly. The module server routes to the
correct source magnet by selector. A consumer that resolved a multi-slot module
MUST pass a selector to `.instance(selector)`.

There is NO `byExact` facade map. There is NO per-address wrapper object.

## Contract 1 — `hcp-contract/hcp-server.ts` (already widened, verify only)

```typescript
export interface HcpServer {
	describe(): HcpServerDescription;
	call(call: HcpRequest): Promise<unknown> | unknown;
	/** selector REQUIRED for multi-slot module servers; ignored by single-product servers. */
	instance?<T = unknown>(selector?: string): T | undefined;
}
```

Already correct. `instance?(selector?)` stays. No change needed beyond confirming.

## Contract 2 — `hcp-magnet/module-server.ts` (ModuleHcpServer IS an HcpServer)

`ModuleHcpServer` MUST `implements HcpServer`. It is the object `resolve()` returns.

```typescript
export class ModuleHcpServer implements HcpServer {
	readonly moduleName: string;
	constructor(moduleName: string, slots: Map<string, HcpMagnet>);

	/** Addresses this module owns, for the client's address→module index. */
	slotAddresses(): Array<{ address: string; selector: string }>;

	/** HcpServer.describe(): module-level aggregate description (kind:"module"). */
	describe(): HcpServerDescription;

	/** HcpServer.call(): route op to a slot's magnet server, or handle module-level "describe". */
	call(call: HcpRequest): Promise<unknown> | unknown;

	/**
	 * HcpServer.instance(selector): route to the source magnet's instance.
	 * - multi-slot module (tools, runtime): selector REQUIRED; undefined selector → undefined.
	 * - single-slot module (compaction, …): selector optional; when omitted, use the sole slot.
	 */
	instance<T>(selector?: string): T | undefined;

	/** Per-slot descriptions for describeAll()/menu drill-down. */
	describeSlots(): HcpServerDescription[];

	/** Which selectors this module owns (for menu + tests). */
	selectors(): string[];
}
```

Single-slot convenience: when a module has exactly one slot, `instance()` with no
selector returns that slot's instance. Multi-slot modules REQUIRE a selector and
return `undefined` if none/unknown is given. This is the ONLY ergonomic allowance,
and it is a real routing rule, not a compat shim.

Remove `serverFor()` from the public surface if unused after the refactor (it
becomes an internal helper of `instance`/`call`). No facade factory methods.

## Contract 3 — `hcp-client/hcp-client.ts` (module-level resolution ONLY)

```typescript
export class HcpClient {
	// Storage:
	//   byModule:      Map<moduleName, ModuleHcpServer>       // the real servers
	//   addrToModule:  Map<address, {module, selector}>       // routing index (thin pointers)
	//   byPrefix:      Map<prefix, HcpServer>                 // multi-endpoint providers (context://, runtime://)
	//   byAddress:     Map<address, HcpServer>                // leaf/package standalone (hcp-process, package tools)
	// NO byExact facade map.

	/** Register a module server; indexes its slot addresses. Replaces by name. */
	registerModule(module: ModuleHcpServer): string[];

	/** Register a standalone leaf server (package tools, hcp-process). */
	registerServer(address: string, server: HcpServer): this;

	/** Register a multi-endpoint provider under a scheme prefix. */
	register(prefix: string, server: HcpServer): this;

	/**
	 * Resolve an address to the MODULE-LEVEL server that owns it.
	 * Order: byAddress (leaf) → addrToModule→byModule (module server) → byPrefix.
	 * For a module-owned address, returns the ModuleHcpServer (NOT the magnet server).
	 */
	resolve(address: string): HcpServer | undefined;

	/**
	 * Resolve an address directly to the source impl, routing the selector.
	 * This is the ONE-CALL path consumers use instead of resolve().instance(sel).
	 *   resolveInstance("tool:read")            → module "tools".instance("read")
	 *   resolveInstance("capability:compaction")→ module "compaction".instance("compaction")
	 *   resolveInstance("capability:runtime:process") → module "runtime".instance("runtime:process")
	 * Leaf/prefix servers: call their .instance() (selector from address tail if any).
	 */
	resolveInstance<T>(address: string): T | undefined;

	/** Capability-by-name sugar over resolveInstance. name → "capability:<name>". */
	resolveCapability<T>(name: string): T | undefined;

	resolveModule(name: string): ModuleHcpServer | undefined;
	modules(): string[];
	describeModules(): HcpServerDescription[];
	describeAll(): HcpServerDescription[];    // expands module slots + leaves + prefix
	addresses(): string[];
	moduleServers(): ModuleHcpServer[];        // for merge
	standaloneEntries(): Array<{ address: string; server: HcpServer }>;  // for merge
	dispatch(call: HcpRequest): Promise<unknown>;
}
```

**Selector derivation for `resolveInstance`/`resolveCapability`:** the `addrToModule`
entry already stores the exact `selector` the module expects (e.g. `"read"`,
`"compaction"`, `"runtime:process"`). `resolveInstance` looks up that entry and
calls `module.instance(selector)`. This keeps the selector convention in ONE place
(the index built at registration), so consumers never compute selectors.

## Contract 4 — Consumer call-site conversions (Wave 2)

Every consumer stops using `resolve(addr).instance()` and uses `resolveInstance(addr)`
(or `resolveCapability(name)` which already exists). Exhaustive list:

| File | Old | New |
|------|-----|-----|
| `pi/agent-session.ts:2879-2881` | `resolve(\`tool:${name}\`)?.instance?.()` | `resolveInstance<AgentTool>(\`tool:${name}\`)` |
| `pi/agent-session.ts:498` | `resolveCapability("compaction")` | unchanged (already sugar) |
| `pi/agent-session.ts:516,521,527` | `resolveCapability(...)` | unchanged |
| `pi/extensions/runner.ts:326` | `resolveCapability("hook")` | unchanged |
| `harness/agent-harness.ts:206,219` | `resolveCapability("compaction")` | unchanged |
| `harness/package-overlay.ts:475` | `resolve(target)?.instance?.()` | `resolveInstance(target)` |

`resolveCapability` call sites need NO change because its INTERNAL implementation
changes to route via module. `resolve().instance()` call sites MUST switch to
`resolveInstance()`. The menu (`interactive-mode.ts:4741`) uses `describeAll()` —
unchanged signature, but now sourced from module slots.

## Contract 5 — Assembly merge (`session-hcp.ts` copyRegistrations)

Merge copies MODULES as modules and LEAVES as leaves, preserving override
precedence (skipExisting: an address already resolvable in target is not
overwritten). Package capability overrides win because they are copied BEFORE
built-in defaults with skipExisting on the defaults pass. This behavior is
already implemented against `moduleServers()`/`standaloneEntries()`; verify it
still holds after the core change.

## Verification gates (every branch)

- harness: `npm run build` clean, `npx vitest --run` all green.
- pi: `npx tsc --noEmit` no NEW errors (4 pre-existing allowed: bg-shell.test eventData, tui es2024 regex), `npx vitest --run --maxWorkers=4` all green.
- No occurrence of `.instance?.()` on a `resolve()` result anywhere (grep gate).
- No `byExact`, no `facadeFor`, no `facades()` anywhere (grep gate).

## Build-order reality (why waves, not N-way fan-out)

`pi` imports `@magenta/harness` via built `dist/index.js`. Wave-2 consumer
branches CANNOT compile until Wave-1 core lands and harness is rebuilt. Therefore:

- **Wave 1** (done by lead, indivisible): contracts 1–3 + 5 + all harness tests.
- **Wave 2** (parallel subagent branches off the Wave-1 branch, DISJOINT files):
  - branch `model-b/pi-tools`: `pi/agent-session.ts`
  - branch `model-b/pi-hooks-menu`: `pi/extensions/runner.ts` + `pi/interactive-mode.ts`
  - branch `model-b/harness-consumers`: `harness/agent-harness.ts` + `harness/package-overlay.ts` (these are harness-internal, could fold into Wave 1)

Disjoint file sets → trivial human merge, zero conflicts on the core.
