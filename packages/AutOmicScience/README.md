# AutOmicScience Package

This package is a Magenta3 migration of the AOSE omics harness content from `Minions-Land/AutOmicScience` `origin/main` at `57ae83b`, with the `UPDATING/` audit constraints applied.

Included:

- `brands/AutOmicScience/**` package-local brand override using the AOSE Nature-inspired TUI palette.
- `skills/omics-shared/**` pure Markdown shared playbook and method docs.
- `skills/{multi-omics,scatac-seq,rna,spatial}/**` modality Markdown playbooks and method docs.
- `tools/omics-compute/python/aose_omics_runtime/**` as the Python implementation for the `omics_compute` tool.
- `tools/omics-compute/python/tests/**` implementation tests.
- `tools/omics-environment/pixi.toml` and `tools/omics-environment/pixi.lock` for pinned task environments.
- Declarative `omics_environment` / `omics_preflight` and executable `omics_compute` tool descriptors.

Excluded on purpose:

- `tools/omics-compute/python/aose_agent/**`, the legacy Python package called out as orphaned.
- Bio-MAS ghost commands that call removed `aose_agent` subcommands.
- `census_query` and `geo_fetch` tool exposure, because the audited source lacks the `aose_omics_runtime.data` implementation modules.
- Implementation modules for `joint_embed`, `spatial_neighbors`, and `rna_atac_link` removed by the latest AOSE update.

Selection:

- `AutOmicScience` loads the flattened package brand, skills, and tools directly.
- The package does not define `general` or task profiles; modality behavior is
  expressed by the flat skills `multi-omics`, `scatac-seq`, `rna`, and
  `spatial`.
