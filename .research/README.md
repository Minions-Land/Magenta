# Architecture research archive

This directory preserves investigation notes, intermediate contracts, phase
plans, traces, and handoff records produced before the current HCP architecture
settled. It is evidence of how decisions were reached, not current
implementation guidance.

Archived files intentionally contain retired names and paths such as
`harness/`, `hcp-client/`, `ModuleHcpServer`, central capability tables, and
repository-owned domain Packages. Do not restore those structures from these
notes or rewrite the records to resemble the current tree.

Use the maintained documentation instead:

- [`../README.md`](../README.md) for the product and repository entry point;
- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for repository ownership;
- [`../HarnessComponentProtocol/docs/governance/hcp-architecture.md`](../HarnessComponentProtocol/docs/governance/hcp-architecture.md)
  for HCP assembly and routing;
- [`../HarnessComponentProtocol/docs/governance/hcp-naming.md`](../HarnessComponentProtocol/docs/governance/hcp-naming.md)
  for the entity-tree naming law; and
- [`../HarnessComponentProtocol/docs/governance/contract.md`](../HarnessComponentProtocol/docs/governance/contract.md)
  for current Harness development rules.

The current runtime law is:

```text
HcpClient -> HcpServer -> HcpMagnet
```
