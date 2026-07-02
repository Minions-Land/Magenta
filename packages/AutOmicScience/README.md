# AutOmicScience Package

This package is a Magenta3 migration of the AOSE omics harness content from `Minions-Land/AutOmicScience` `origin/main` at `57ae83b`, with the `UPDATING/` audit constraints applied.

Included:

- `skills/omics/**` pure Markdown playbooks and method docs.
- `.omics-runtime/aose_omics_runtime/**` as the single Python runtime package home.
- `.omics-runtime/tests/**` runtime tests.
- `pixi.toml` and `pixi.lock` for pinned task environments.
- Declarative `omics_preflight` and `omics_runtime` tool descriptors.

Excluded on purpose:

- `.omics-runtime/aose_agent/**`, the legacy Python package called out as orphaned.
- Bio-MAS ghost commands that call removed `aose_agent` subcommands.
- `census_query` and `geo_fetch` runtime exposure, because the audited source lacks the `aose_omics_runtime.data` implementation modules.
- Runtime `joint_embed`, `spatial_neighbors`, and `rna_atac_link` modules removed by the latest AOSE update.

Profiles:

- `AutOmicScience` loads `general`.
- `AutOmicScience:scrna` loads `general` plus `omics-scrna`.
- `AutOmicScience:spatial` loads `general` plus `omics-spatial`.
- `AutOmicScience:scatac` loads `general` plus `omics-scatac`.
- `AutOmicScience:multiome` loads `general` plus `omics-multiome`.
