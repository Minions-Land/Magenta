# AutOmicScience Package

This package is a Magenta3 migration of the AOSE omics harness content from `Minions-Land/AutOmicScience` `origin/main` at `57ae83b`, with the `UPDATING/` audit constraints applied.

Included:

- `general/skills/omics-shared/**` pure Markdown shared playbook and method docs.
- `task/<modality>/skills/omics-*/**` task-specific Markdown playbooks and method docs.
- `tools/omics-compute/python/aose_omics_runtime/**` as the Python implementation for the `omics_compute` tool.
- `tools/omics-compute/python/tests/**` implementation tests.
- `pixi.toml` and `pixi.lock` for pinned task environments.
- Declarative `omics_preflight` and executable `omics_compute` tool descriptors.

Excluded on purpose:

- `tools/omics-compute/python/aose_agent/**`, the legacy Python package called out as orphaned.
- Bio-MAS ghost commands that call removed `aose_agent` subcommands.
- `census_query` and `geo_fetch` tool exposure, because the audited source lacks the `aose_omics_runtime.data` implementation modules.
- Implementation modules for `joint_embed`, `spatial_neighbors`, and `rna_atac_link` removed by the latest AOSE update.

Profiles:

- `AutOmicScience` loads `general`.
- `AutOmicScience:scrna` loads `general` plus `omics-scrna`.
- `AutOmicScience:spatial` loads `general` plus `omics-spatial`.
- `AutOmicScience:scatac` loads `general` plus `omics-scatac`.
- `AutOmicScience:multiome` loads `general` plus `omics-multiome`.
