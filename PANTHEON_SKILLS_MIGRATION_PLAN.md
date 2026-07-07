# PantheonOS Skills Migration Plan

## Overview

Migrate all PantheonOS skills from `BioAgent/PantheonOS-main/pantheon/factory/templates/skills/` to `Magenta3/packages/PantheonOS/skills/` using Magenta's self-evo capability.

## Source Skills Inventory

### From PantheonOS (`pantheon/factory/templates/skills/`)

#### 1. Omics Skills Hierarchy
- `omics/SKILL.md` (index) → migrate as `pantheon-omics/SKILL.md`
  - `omics/single_cell/SKILL.md` → `pantheon-single-cell/SKILL.md`
  - `omics/spatial/SKILL.md` → `pantheon-spatial/SKILL.md`
  - `omics/scfm/SKILL.md` → `pantheon-scfm/SKILL.md`
  - `omics/database_access/SKILL.md` → `pantheon-database-access/SKILL.md`
  - `omics/gene_panel_selection/SKILL.md` → `pantheon-gene-panel/SKILL.md`
  - `omics/general_data_analysis/SKILL.md` → `pantheon-data-analysis/SKILL.md`
  - `omics/sc_best_practices/SKILL.md` → `pantheon-sc-best-practices/SKILL.md`
  - `omics/upstream_processing/SKILL.md` → `pantheon-upstream/SKILL.md`
    - `omics/upstream_processing/nfcore/SKILL.md` → `pantheon-nfcore/SKILL.md`
    - `omics/upstream_processing/openst/SKILL.md` → `pantheon-openst/SKILL.md`

#### 2. Bio Image Processing
- `bio_image_processing/SKILL.md` → `pantheon-bio-imaging/SKILL.md`
  - `bio_image_processing/segmentation/SKILL.md` → `pantheon-cell-segmentation/SKILL.md`

#### 3. Scientific Writing & Presentation
- `paper_writing/SKILL.md` → `pantheon-paper-writing/SKILL.md`
- `figure_styling/SKILL.md` → `pantheon-figure-styling/SKILL.md`
- `presentation/SKILL.md` → `pantheon-presentation/SKILL.md`

**Total: 16 skills**

## Target Structure (Magenta Package Skills)

```
packages/PantheonOS/skills/
├── pantheon-omics/
│   └── SKILL.md
├── pantheon-single-cell/
│   └── SKILL.md
├── pantheon-spatial/
│   └── SKILL.md
├── pantheon-scfm/
│   └── SKILL.md
├── pantheon-database-access/
│   └── SKILL.md
├── pantheon-gene-panel/
│   └── SKILL.md
├── pantheon-data-analysis/
│   └── SKILL.md
├── pantheon-sc-best-practices/
│   └── SKILL.md
├── pantheon-upstream/
│   └── SKILL.md
├── pantheon-nfcore/
│   └── SKILL.md
├── pantheon-openst/
│   └── SKILL.md
├── pantheon-bio-imaging/
│   └── SKILL.md
├── pantheon-cell-segmentation/
│   └── SKILL.md
├── pantheon-paper-writing/
│   └── SKILL.md
├── pantheon-figure-styling/
│   └── SKILL.md
└── pantheon-presentation/
    └── SKILL.md
```

## Migration Strategy

### Approach: Batch Copy + Adapt

Instead of using self-evo/skill-creator iteratively (which would take 16 iterations), we'll:

1. **Batch copy** all SKILL.md files to target locations
2. **Adapt frontmatter** to Magenta package format:
   - Ensure `name` field uses kebab-case
   - Keep `description` concise (< 1024 chars)
   - Add any missing required fields
3. **Flatten hierarchy** - convert nested paths to flat package structure with `pantheon-` prefix
4. **Update cross-references** - fix internal links between skills

### Frontmatter Transformation

**From (PantheonOS):**
```yaml
---
id: single_cell_skills_index
name: Single-Cell Analysis Skills Index
description: |
  Core skills for single-cell RNA-seq analysis...
tags: [single-cell, qc, annotation]
---
```

**To (Magenta Package):**
```yaml
---
name: pantheon-single-cell
description: Core skills for single-cell RNA-seq analysis - QC, cell type annotation, and trajectory inference. These are high-priority actionable workflows.
tags: [pantheon, single-cell, qc, annotation, scanpy]
source: PantheonOS
license: BSD-2-Clause
---
```

## Execution Steps

1. Create target directory structure
2. Copy all SKILL.md files with new names
3. Transform frontmatter in each file
4. Update internal cross-references
5. Validate all skills load correctly

## Key Transformations

- **Name normalization**: `single_cell_skills_index` → `pantheon-single-cell`
- **Description flattening**: Multi-line YAML `|` blocks → single paragraph
- **Add metadata**: `source: PantheonOS`, `license: BSD-2-Clause`
- **Path updates**: `./spatial/SKILL.md` → `../pantheon-spatial/SKILL.md`
- **Prefix convention**: All skills get `pantheon-` prefix to avoid name collision

## Validation

After migration:
- [ ] All 16 SKILL.md files present
- [ ] All frontmatter valid YAML
- [ ] No broken cross-references
- [ ] Skills loadable by Magenta harness
- [ ] No duplicate names with AutOmicScience skills
