# hcp-contract

The shared, source-agnostic **contracts** for the three HCP roles (spec §2).
Pure TypeScript interfaces and types — zero runtime logic. Every other HCP zone
depends on this one, and this one depends on nothing else in the harness.

## Files

- `hcp-server.ts` — the `HcpServer` role contract: `HcpServer`, `HcpRequest`,
  `HcpResponse`, `HcpServerDescription`, `HcpContext`, the `capabilityPrefix`
  address constant, and `CapabilityFactoryContext` (the assembly-time build
  context a capability source receives).
- `hcp-magnet.ts` — the `HcpMagnet` role contract: `HcpMagnet`,
  `CapabilityBinding`, `HcpResource`, `ResourceMergeMode`, and
  `CapabilitySourceMagnet` (the source-owned capability descriptor, spec §8).

## Why it exists

`HcpClient` (in `hcp-client/`) routes over these contracts, each Harness Module
implements them, and the `HcpMagnet` framework (in `hcp-magnet/`) produces them.
Keeping the contracts in a neutral module means all three depend on it in one
direction, with no back-dependencies — a module implementing `HcpServer` never
has to import the client that routes it.
