# PantheonOS Skills Package

This package contains bioinformatics and scientific workflow skills migrated from [PantheonOS](https://github.com/standardgalactic/pantheon) (BSD-2-Clause license).

## Overview

PantheonOS skills provide comprehensive guidance for:
- **Single-cell & spatial omics** analysis (scRNA-seq, scATAC-seq, spatial transcriptomics)
- **Foundation models** for single-cell (scGPT, Geneformer, UCE)
- **Bio-image processing** (cell/nucleus segmentation)
- **Scientific communication** (paper writing, figure styling, presentations)
- **Bioinformatics pipelines** (nf-core, OpenST)

## Skills Inventory

### Omics Analysis (13 skills)

| Skill | Description |
|-------|-------------|
| **omics** | Index skill for all omics workflows |
| **single-cell** | scRNA-seq QC, annotation, trajectory inference |
| **spatial** | Spatial transcriptomics, 3D visualization, single-cell to spatial mapping |
| **scfm** | Single-cell foundation models (scGPT, Geneformer, UCE) |
| **database-access** | gget, iSeq, CELLxGENE Census API |
| **gene-panel** | Gene panel design workflow for spatial transcriptomics |
| **data-analysis** | Environment setup, parallel computing, HPC data transfer |
| **sc-best-practices** | Comprehensive reference from sc-best-practices.org |
| **upstream** | Raw data processing pipelines |
| **nfcore** | nf-core community pipelines (143+ workflows) |
| **openst** | Open-ST spatial transcriptomics processing |
| **bio-imaging** | Bio-image processing index |
| **cell-segmentation** | Cellpose, SAM, StarDist, InstanSeg, Mesmer |

### Scientific Communication (3 skills)

| Skill | Description |
|-------|-------------|
| **paper-writing** | Academic and report templates (HTML/LaTeX) |
| **figure-styling** | Aesthetic guidelines for scientific figures |
| **presentation** | Marp slides and presentation templates |

## Structure

Each skill follows the Magenta package structure:

```
skill-name/
├── SKILL.md                # Main skill document with YAML frontmatter
└── assets/                 # Optional bundled resources
    ├── references/         # Method documentation (loaded on-demand)
    ├── scripts/            # Helper scripts
    └── templates/          # Output templates
```

## Usage in Magenta

Skills are automatically discoverable by the Magenta harness:

```typescript
import { loadSkills } from "@magenta/harness";

const { skills } = await loadSkills(env, [
  "/path/to/Magenta3/packages/PantheonOS/skills"
]);

// Skills are now available to agents
```

## Skill Relationships

**Hierarchical structure:**
- `omics` → Index for all omics skills
  - `single-cell` → scRNA-seq workflows
  - `spatial` → Spatial transcriptomics
  - `scfm` → Foundation models
  - `upstream` → Raw data processing
    - `nfcore` → nf-core pipelines
    - `openst` → OpenST pipeline

**Cross-references:**
- `single-cell` references `sc-best-practices` for deeper background
- `spatial` references `single-cell` for expression-based workflows
- `cell-segmentation` supports spatial analysis (image-based segmentation)

## Key Features

### 1. Comprehensive Omics Coverage
- End-to-end single-cell workflows (QC → annotation → downstream)
- Spatial transcriptomics (mapping, domains, CCC)
- Foundation model integration (embeddings, validation)
- Public database access (programmatic queries)

### 2. Best Practices
- Evidence-based methods from sc-best-practices.org
- Validated workflows for common tasks
- Troubleshooting guidance for failure modes

### 3. Upstream Processing
- nf-core pipelines for standard workflows
- Technology-specific processing (OpenST)
- Environment management and reproducibility

### 4. Scientific Communication
- Report templates (HTML, LaTeX)
- Figure styling for venues (Nature, NeurIPS, IEEE)
- Presentation tools (Marp)

## Dependencies

Most skills describe **scanpy/scverse ecosystem** workflows:
- `scanpy` — Single-cell analysis
- `squidpy` — Spatial transcriptomics
- `muon` — Multimodal integration
- `scvi-tools` — Deep generative models
- `cellpose` — Cell segmentation

Foundation model skills may reference:
- `scGPT`, `geneformer`, `UCE` (embeddings)
- Model-specific environments

## Migration Notes

- **Source**: `PantheonOS-main/pantheon/factory/templates/skills/`
- **Migrated**: 2026-07-07
- **Transformations**:
  - Flattened nested hierarchy (`omics/single_cell` → `single-cell`)
  - Standardized frontmatter (added `source`, `license`)
  - Moved sub-documents to `assets/references/`
  - Updated cross-references to new paths

## License

All skills retain their original BSD-2-Clause license from PantheonOS.

## See Also

- [PantheonOS Repository](https://github.com/standardgalactic/pantheon)
- [Single-cell Best Practices](https://www.sc-best-practices.org)
- [scverse Documentation](https://scverse.org)
- [nf-core Pipelines](https://nf-co.re)
