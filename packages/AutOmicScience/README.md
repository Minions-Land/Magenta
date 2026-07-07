# AutOmicScience Package

This package is a Magenta3 migration of the AOSE omics harness content from `Minions-Land/AutOmicScience` `origin/main` at `57ae83b`, with the `UPDATING/` audit constraints applied.

Included:

- `brands/AutOmicScience/**` package-local brand override using the AOSE Nature-inspired TUI palette.
- `skills/omics-shared/**` pure Markdown shared playbook and method docs (the common foundation every modality skill builds on).
- `skills/single-cell/**` single-cell omics: parent router + `rna/` (scRNA-seq), `atac/` (scATAC-seq), `multiome/` (paired RNA+ATAC) subskills.
- `skills/spatial/**` spatial transcriptomics: QC, spatial statistics, domains, deconvolution, cell-cell communication, cellular neighborhood detection.
- `skills/bulk/**` bulk omics: parent router + `rna/` (bulk RNA-seq) and `epigenomics/` (ChIP-seq / bulk ATAC-seq) subskills.
- `skills/bioml/**` bioinformatics ML: parent router + `repro/`, `deep-models/`, `sequence-fm/`, `coding/`, `figure-check/` subskills.
- `skills/cancer-genomics/**` tabular cancer genomics: MAF/CNA parsing, variant classification, recurrence, TMB, pathway alteration, oncoplots.
- `skills/proteomics/**` plasma Olink & mass-spec proteomics: NPX QC/DE, MaxQuant parsing, phosphoproteomics, enrichment.
- `skills/cancer-dependency/**` DepMap/CCLE dependency analysis: CRISPR gene-effect, selective dependency, druggability, synthetic lethality.
- `skills/metabolomics/**` plasma metabolomics & lipidomics: metabolite/lipid DE, covariate-adjusted association, annotation, mediation.
- `skills/clinical-survival/**` survival analysis: Kaplan-Meier, log-rank, Cox proportional-hazards regression, PH checks.
- `skills/microbiome/**` 16S rRNA & metagenomic abundance: CLR transformation, alpha/beta diversity, differential abundance, taxon-phenotype association.
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
  expressed by the modality skills `single-cell`, `spatial`, `bulk`, `bioml`,
  `cancer-genomics`, `proteomics`, `cancer-dependency`, `metabolomics`,
  `clinical-survival`, and `microbiome`, each of which extends the shared
  `omics-shared` foundation.
