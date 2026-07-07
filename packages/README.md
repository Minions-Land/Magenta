# Magenta3 Packages

This directory holds Magenta3 harness overlay packages. It is intentionally
outside the npm workspaces: packages are content bundles assembled at runtime,
not build targets.

A package is a domain, brand, or harness bundle with a root `package.toml`.
Selecting a package loads the components it declares (skills, tools, system
prompts, brand, runtime). Selection names packages — it never loads arbitrary
external paths. Packages that carry many skills expose optional **profiles** so
a session can pull in a focused subset.

## Loading a package

```bash
# Load an entire package
magenta --harness-package AutOmicScience

# Load only selected profiles (comma-separated, package-defined)
magenta --harness-package ClaudeScience:structure,design

# Combine packages in one session
magenta --harness-package AutOmicScience --harness-package PantheonOS
```

The selector grammar is `PackageName[:profile1,profile2,...]`, parsed by
`parsePackageSelector` in
[`../harness/hcp-client/overlay/package-overlay.ts`](../harness/hcp-client/overlay/package-overlay.ts).
Project-local package settings live under `<project>/.magenta/settings.json`
and require a trust decision before they are honored.

## Packages in this repository

| Package | Domain | Shape | What it adds |
|---|---|---|---|
| [`AutOmicScience`](./AutOmicScience/) | Single-cell / spatial / bulk omics, cancer & clinical genomics | 11 skills · 5 tools · system prompt · brand · Python/Pixi runtime | Production omics analysis grounded in a real compute tool (`omics_compute`) |
| [`Biomni`](./Biomni/) | Biomedical AI (Stanford SNAP Lab) | 3 skills bundling executable tools | CRISPR sgRNA design, single-cell annotation, and a broad biomedical toolkit copied in-tree |
| [`ClaudeScience`](./ClaudeScience/) | Computational biology research | 32 skills · 9 profiles | Structure prediction, protein design, genomics, literature, viz, compute — selected by profile |
| [`PantheonOS`](./PantheonOS/) | Bioinformatics workflow best practices | 16 skills · 5 profiles | scverse/nf-core workflow guidance, foundation models, bio-imaging, scientific communication |

AutOmicScience is the **canonical reference package**: it is the only one that
ships tools, a system prompt, a brand, and a pinned runtime, so use its layout
when you need an executable example. The other three are skill-led knowledge
packages.

### Choosing between them

- **Production omics analysis** → `AutOmicScience` (grounded, tool-backed).
- **Wet-lab / biomedical breadth** → `Biomni` (executable tools across 20+ domains).
- **Model-heavy research** (folding, design, genomics FMs) → `ClaudeScience`, by profile.
- **Workflow / best-practice guidance** → `PantheonOS`.

They compose. A common research stack is `AutOmicScience` for grounded
computation plus `PantheonOS` for workflow discipline.

## Creating a new package

Follow [`templates/harness-package/README.md`](./templates/harness-package/README.md).
The template is README-only on purpose — copy the current, executable rules
rather than a stale scaffold:

- Keep skills under package-root `skills/<capability>/SKILL.md`.
- Put system prompts under `system-prompt/` with a `system-prompt.toml` descriptor.
- Put tool descriptors and their implementation assets under `tools/<tool>/`.
- Keep the package root itself limited to `package.toml`, `README.md`, and the
  convention directories — no scratch notes or migration reports.

See [`../harness/hcp-client/overlay/README.md`](../harness/hcp-client/overlay/README.md)
for the manifest schema and overlay precedence.
