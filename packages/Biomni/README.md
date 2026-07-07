# Biomni Package for Magenta

Biomni is a general-purpose biomedical AI toolkit from Stanford SNAP Lab, converted to Magenta harness package format with 2 knowledge guide skills and 23+ tool modules covering 248 functions.

## Package Overview

**Source**: Stanford SNAP Lab - Biomni Project  
**Original Repo**: https://github.com/snap-stanford/Biomni  
**Paper**: bioRxiv 2025.05.30.656746v1  
**License**: MIT (tools), CC BY 4.0 (knowledge guides)

## Contents

### Skills (2 Knowledge Guides)

1. **sgrna-design** - CRISPR sgRNA design guide
   - 300+ validated sgRNA sequences from Addgene
   - Three-tier design strategy
   - CRISPick integration

2. **single-cell-annotation** - scRNA-seq cell type annotation
   - Marker-based, automated, reference-based methods
   - Distilled from sc-best-practices.org
   - Practical workflows with code

### Tools (248 Functions in 23 Modules)

| Domain | Tool Module | Functions | Description |
|--------|-------------|-----------|-------------|
| 🗄️ **Database** | biomni_database | 45 | PubMed, UniProt, KEGG, STRING, cBioPortal |
| 💊 **Pharmacology** | biomni_pharmacology | 42 | Drug design, ADME, toxicity prediction |
| 🧬 **Genomics** | biomni_genomics | 20 | NGS analysis, variant annotation |
| 🧪 **Molecular Biology** | biomni_molecular_biology | 18 | PCR design, cloning, protein expression |
| 🤖 **Lab Automation** | biomni_lab_automation | 11 | Robot control, workflow automation |
| 🦠 **Microbiology** | biomni_microbiology | 11 | Microbiome, metagenomics |
| 🔬 **Bioimaging** | biomni_bioimaging | 10 | Cell segmentation, image analysis |
| 🫀 **Physiology** | biomni_physiology | 10 | Physiological modeling |
| 🛡️ **Immunology** | biomni_immunology | 9 | Antibody design, immune repertoire |
| 🧬 **Genetics** | biomni_genetics | 8 | GWAS, linkage analysis |
| + 13 more | ... | 64 | Cancer, systems bio, pathology, etc. |

## Usage

### Load All Resources

```bash
magenta --harness-package Biomni
```

### Selective Loading by Profile

```bash
# Knowledge guides only
magenta --harness-package Biomni:knowledge

# Database tools
magenta --harness-package Biomni:database

# Drug discovery stack
magenta --harness-package Biomni:drug,molbio

# Full genomics + automation
magenta --harness-package Biomni:genomics,automation

# Everything
magenta --harness-package Biomni:all
```

## Available Profiles

| Profile | Description | Components |
|---------|-------------|------------|
| `knowledge` | Knowledge guides | 2 skills |
| `database` | Database query tools | 2 tools, 53 functions |
| `genomics` | Genomics + genetics | 4 tools, 39 functions |
| `drug` | Pharmacology | 1 tool, 42 functions |
| `molbio` | Molecular biology | 8 tools, 52 functions |
| `imaging` | Bio-imaging + pathology | 3 tools, 20 functions |
| `automation` | Lab automation | 3 tools, 23 functions |
| `all` | All resources | 2 skills + 23 tools |

## Integration with Other Packages

### Recommended Combinations

**Research Workflow**:
```bash
magenta --harness-package ClaudeScience --harness-package Biomni:knowledge,database
```

**Genomics Analysis**:
```bash
magenta --harness-package AutOmicScience --harness-package Biomni:genomics
```

**Drug Discovery**:
```bash
magenta --harness-package Biomni:drug,molbio,database
```

**Full Biomedical Stack**:
```bash
magenta --harness-package AutOmicScience --harness-package ClaudeScience --harness-package PantheonOS --harness-package Biomni:all
```

## Unique Features

### vs. Other Magenta Packages

| Feature | Biomni | AutOmicScience | ClaudeScience | PantheonOS |
|---------|--------|----------------|---------------|------------|
| Database APIs | ✅ 25+ | ✗ | ✗ | ✗ |
| Lab Automation | ✅ | ✗ | ✗ | ✗ |
| Drug Design | ✅ 42 functions | ✗ | ✗ | ✗ |
| sgRNA Database | ✅ 300+ | ✗ | ✗ | ✗ |
| Tool Functions | ✅ 248 | 5 | 0 | 0 |
| Knowledge Docs | 2 | 0 | 0 | 88 |

### Biomni's Strengths

1. **Extensive Database Coverage** - 25+ pre-integrated APIs
2. **Lab Automation** - Only package with robot control
3. **Drug Discovery** - Largest pharmacology toolkit
4. **Function Library** - 248 ready-to-use Python functions
5. **Validated Data** - 300+ experimental sgRNA sequences

## Requirements

### Python Dependencies

```bash
pip install biomni rdkit biopython primer3-py pysam
```

### Optional for Full Features

```bash
# Lab automation
pip install opentrons pyhamilton

# Drug discovery
pip install chembl-webresource-client

# Single-cell
pip install scanpy celltypist scvi-tools
```

## Tool Implementation Notes

Tools are **descriptors** pointing to Biomni's Python modules. To use:

1. Install Biomni: `pip install biomni`
2. Load package in Magenta
3. Tools are available through Biomni's API

**Example**:
```python
from biomni.tool.pharmacology import predict_adme
from biomni.tool.database import query_pubmed

# Use Biomni functions directly
results = predict_adme(compound_smiles)
papers = query_pubmed("CRISPR")
```

## Citation

If using Biomni resources:

**Biomni System**:
```
Biomni: A General-Purpose Biomedical AI Agent
bioRxiv 2025.05.30.656746v1
```

**sgRNA Database**:
- Cite original publications (PubMed IDs in database)
- Acknowledge Addgene

**Single-Cell Guide**:
```
Luecken, M.D., Theis, F.J. et al. (2023)
Current best practices in single-cell RNA-seq analysis: a tutorial
Molecular Systems Biology
```

## License

- **Tools**: MIT License (from Biomni)
- **Knowledge Guides**: CC BY 4.0
- **Commercial Use**: ✅ Allowed with attribution

## Development

### Package Structure

```
Biomni/
├── package.toml           # Manifest with 2 skills + 23 tools
├── README.md             # This file
├── skills/
│   ├── sgrna-design/
│   │   └── SKILL.md
│   └── single-cell-annotation/
│       └── SKILL.md
└── tools/
    ├── database/
    │   └── database.toml
    ├── genomics/
    │   └── genomics.toml
    ├── pharmacology/
    │   └── pharmacology.toml
    ├── molecular-biology/
    │   └── molecular-biology.toml
    ├── lab-automation/
    │   └── lab-automation.toml
    └── ... (18 more tool modules)
```

### Adding More Tools

To add remaining 18 tool modules:

1. Create `tools/<module>/` directory
2. Create `<module>.toml` descriptor
3. Reference Biomni source: `biomni/tool/<module>.py`
4. Update `package.toml` components section

## See Also

- [Biomni GitHub](https://github.com/snap-stanford/Biomni)
- [Biomni Paper](https://www.biorxiv.org/content/10.1101/2025.05.30.656746v1)
- [AutOmicScience Package](../AutOmicScience/)
- [ClaudeScience Package](../ClaudeScience/)
- [PantheonOS Package](../PantheonOS/)
- [Magenta Self-evo skill-creator](../../harness/modules/skills/self-evo/magenta/skill-creator/SKILL.md)
