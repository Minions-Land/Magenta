# PantheonOS Package

Bioinformatics and scientific workflow skills migrated from [PantheonOS](https://github.com/standardgalactic/pantheon) covering single-cell/spatial omics, foundation models, bio-imaging, and scientific communication.

## Package Structure

PantheonOS is organized into **4 domain profiles** for selective loading:

### Available Profiles

| Profile | Description | Skills |
|---------|-------------|--------|
| `omics` | Single-cell & spatial omics analysis | 10 skills |
| `imaging` | Bio-image processing & segmentation | 2 skills |
| `communication` | Paper writing, figures, presentations | 3 skills |
| `infrastructure` | Data pipelines & HPC | 1 skill |
| `all` | All skills (extends all profiles above) | 16 skills |

## Usage

### Load All Skills (Default)

```bash
# Load all 16 PantheonOS skills
magenta --harness-package PantheonOS
```

### Profile Selection

```bash
# Load only omics analysis skills
magenta --harness-package PantheonOS:omics

# Load multiple profiles
magenta --harness-package PantheonOS:omics,communication

# Load all explicitly
magenta --harness-package PantheonOS:all
```

**Note**: Currently all components are at root level, so any profile selection loads all 16 skills. This is intentional for simplicity.

### Multi-Package Loading

```bash
# Combine with other packages
magenta --harness-package AutOmicScience --harness-package PantheonOS

# Full bioinformatics stack
magenta --harness-package AutOmicScience --harness-package ClaudeScience --harness-package PantheonOS
# → 59+ skills, tools, system prompts, and more!
```

## Skills Inventory

### Omics Analysis (10 skills)

| Skill | Description |
|-------|-------------|
| **omics** | Index skill for all omics workflows |
| **single-cell** | scRNA-seq QC, annotation, trajectory inference |
| **spatial** | Spatial transcriptomics, 3D visualization, mapping |
| **scfm** | Single-cell foundation models (scGPT, Geneformer, UCE) |
| **database-access** | Query genomic databases (gget, CELLxGENE Census) |
| **gene-panel** | Gene panel design for spatial transcriptomics |
| **sc-best-practices** | Reference from sc-best-practices.org |
| **upstream** | Raw data processing pipelines |
| **openst** | Open-ST spatial transcriptomics |
| **nfcore** | 143+ nf-core community pipelines |

### Bio-Imaging (2 skills)

| Skill | Description |
|-------|-------------|
| **bio-imaging** | Bio-image processing index |
| **cell-segmentation** | Cellpose, SAM, StarDist segmentation |

### Scientific Communication (3 skills)

| Skill | Description |
|-------|-------------|
| **paper-writing** | Academic and report templates (HTML/LaTeX) |
| **figure-styling** | Aesthetic guidelines for scientific figures |
| **presentation** | Marp slides and presentation templates |

### Infrastructure (1 skill)

| Skill | Description |
|-------|-------------|
| **data-analysis** | Environment setup, parallel computing, HPC |

## Key Technologies Covered

### Single-Cell & Spatial
- **Python ecosystem**: scanpy, squidpy, spatialdata, muon
- **Foundation models**: scGPT, Geneformer, UCE
- **Pipelines**: nf-core/scrnaseq, nf-core/spatialvi, Open-ST

### Bio-Imaging
- **Segmentation**: Cellpose, Segment Anything Model (SAM), StarDist
- **Frameworks**: napari, scikit-image

### Databases
- **gget**: 23 modules for Ensembl, NCBI, UniProt, ARCHS4, etc.
- **CELLxGENE Census**: 50M+ single-cell profiles

### Scientific Writing
- **Templates**: HTML reports, LaTeX academic papers
- **Figure styles**: Publication-ready matplotlib themes
- **Presentations**: Marp markdown slides

## Comparison with Other Packages

| Package | Focus | Skills | Tools | System Prompt |
|---------|-------|--------|-------|---------------|
| **AutOmicScience** | Production-grade omics analysis | 11 | 5 | Yes |
| **ClaudeScience** | Computational biology research | 32 | 0 | No |
| **PantheonOS** | Workflow best practices | 16 | 0 | No |

**Recommended combinations**:
- **Research workflow**: `ClaudeScience + PantheonOS`
- **Production analysis**: `AutOmicScience + PantheonOS`
- **Full stack**: `AutOmicScience + ClaudeScience + PantheonOS`

## Self-Evo Compliance

✅ **符合 Magenta Self-evo skill-creator 标准**:
- Standard `package.toml` with schema_version
- All skills have proper SKILL.md with frontmatter
- Organized with profiles for selective loading
- Clear component naming (no conflicts)
- BSD-2-Clause license preserved

## Testing

```bash
# Verify package structure
cd harness
npm test -- test/package-overlay.test.ts

# Check discovered packages
node -e "
const { discoverHarnessPackages } = require('./dist/hcp-client/overlay/package-overlay.js');
discoverHarnessPackages().then(r => {
  const p = r.packages.find(pkg => pkg.id === 'PantheonOS');
  console.log('Skills:', p.manifest.components.map(c => c.name));
});
"
```

## Migration Notes

- **Source**: PantheonOS-main/pantheon/factory/templates/skills/
- **Migrated**: 2026-07-07
- **Transformations**:
  - Flattened nested hierarchy (`omics/single_cell` → `single-cell`)
  - Standardized frontmatter (added `source`, `license`)
  - Moved sub-documents to `assets/references/`
  - Created package.toml with profiles

## License

All skills retain their original BSD-2-Clause license from PantheonOS.

## See Also

- [PantheonOS Repository](https://github.com/standardgalactic/pantheon)
- [Single-cell Best Practices](https://www.sc-best-practices.org)
- [scverse Documentation](https://scverse.org)
- [nf-core Pipelines](https://nf-co.re)
- [Magenta Self-evo skill-creator](../../harness/modules/skills/self-evo/magenta/skill-creator/SKILL.md)
