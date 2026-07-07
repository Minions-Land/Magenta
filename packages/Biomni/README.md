# Biomni Package for Magenta

Biomni is a general-purpose biomedical AI toolkit from Stanford SNAP Lab, fully integrated into Magenta with all 23 Python tool modules (248 functions) copied locally, plus 2 knowledge guide skills.

## Package Overview

**Source**: Stanford SNAP Lab - Biomni Project  
**Original Repo**: https://github.com/snap-stanford/Biomni  
**Paper**: bioRxiv 2025.05.30.656746v1  
**License**: MIT (tools), CC BY 4.0 (knowledge guides)  
**Integration**: Full code copy (1.8 MB), no external dependencies

## Contents

### Skills (2 Knowledge Guides)

1. **sgrna-design** - CRISPR sgRNA design guide
   - 300+ validated sgRNA sequences from Addgene
   - Three-tier design strategy (validated → CRISPick → de novo)
   - Citation guidelines and experimental validation

2. **single-cell-annotation** - scRNA-seq cell type annotation
   - Marker-based, automated, reference-based methods
   - Distilled from sc-best-practices.org
   - Practical workflows with Python code examples

### Python Tool Modules (23 Modules, 248 Functions)

All Python code **copied locally** from Biomni source:

| Module | Functions | Size | Description |
|--------|-----------|------|-------------|
| **database** | 45 | 194 KB | PubMed, UniProt, KEGG, STRING, cBioPortal, Ensembl, NCBI, PDB |
| **pharmacology** | 42 | 164 KB | Drug design, ADME prediction, toxicity, interactions |
| **genomics** | 20 | 110 KB | NGS analysis, variant annotation, alignment |
| **molecular_biology** | 18 | 89 KB | PCR design, cloning, protein expression |
| **immunology** | 9 | 79 KB | Antibody design, immune repertoire analysis |
| **genetics** | 8 | 65 KB | GWAS, linkage analysis |
| **microbiology** | 11 | 57 KB | Microbiome, metagenomics |
| **bioimaging** | 10 | 52 KB | Cell segmentation, image quantification |
| **synthetic_biology** | 7 | 51 KB | Synthetic biology design |
| **physiology** | 10 | 50 KB | Physiological modeling |
| **cancer_biology** | 5 | 51 KB | Cancer biology analysis |
| **pathology** | 6 | 40 KB | Pathology image analysis |
| **biochemistry** | 5 | 41 KB | Protein analysis, enzyme kinetics |
| **cell_biology** | 4 | 29 KB | Cell biology functions |
| **lab_automation** | 11 | 24 KB | Robot control, workflow automation |
| **bioengineering** | 6 | 51 KB | Bioengineering tools |
| **biophysics** | 2 | 19 KB | Biophysics calculations |
| **literature** | 8 | 14 KB | Literature search and analysis |
| **support_tools** | 7 | 14 KB | Support utilities |
| **protocols** | 5 | 11 KB | Protocol execution |
| **glycoengineering** | 3 | 6 KB | Glycoengineering design |
| **systems_biology** | 6 | 34 KB | Network analysis, pathway simulation |
| **tool_registry** | - | 3 KB | Tool discovery system |

**Total**: 1.8 MB of Python code

### Supporting Data

- **schema_db**: 25+ pre-integrated database schemas
- **tool_description**: Tool metadata and JSON schemas

## Usage

### Load All Resources (整包加载)

```bash
magenta --harness-package Biomni
```

Loads:
- 2 skills (knowledge guides)
- 23 Python modules (248 functions)
- 2 data components (schemas + descriptions)

**Total**: 27 components

### Integration with Other Packages

```bash
# Full biomedical stack
magenta --harness-package AutOmicScience --harness-package ClaudeScience --harness-package PantheonOS --harness-package Biomni

# Genomics focus
magenta --harness-package AutOmicScience --harness-package Biomni

# Drug discovery
magenta --harness-package Biomni  # pharmacology module included
```

## Unique Features

### vs. Other Magenta Packages

| Feature | Biomni | AutOmicScience | ClaudeScience | PantheonOS |
|---------|--------|----------------|---------------|------------|
| **Code Copy** | ✅ 1.8 MB | ✗ | ✗ | ✗ |
| **Database APIs** | ✅ 45 functions | ✗ | ✗ | ✗ |
| **Lab Automation** | ✅ 11 functions | ✗ | ✗ | ✗ |
| **Drug Design** | ✅ 42 functions | ✗ | ✗ | ✗ |
| **sgRNA Database** | ✅ 300+ sequences | ✗ | ✗ | ✗ |
| **Python Functions** | ✅ 248 | ✗ | ✗ | ✗ |
| **Skills (Docs)** | 2 | 11 | 32 | 16 |

### Biomni's Strengths

1. **Self-Contained** - All code copied locally, no external Biomni install needed
2. **Database Coverage** - 45 functions for 25+ databases
3. **Lab Automation** - Only package with robot control (Opentrons, Hamilton)
4. **Drug Discovery** - Largest pharmacology toolkit (42 functions)
5. **Validated Data** - 300+ experimental sgRNA sequences
6. **Executable** - 248 ready-to-use Python functions

## Architecture

### File Structure

```
Biomni/
├── package.toml              # Manifest (27 components)
├── README.md                 # This file
├── skills/                   # Knowledge guides
│   ├── sgrna-design/
│   │   └── SKILL.md
│   └── single-cell-annotation/
│       └── SKILL.md
└── tools/
    └── python/              # 1.8 MB of Python code
        ├── biochemistry.py
        ├── database.py       # 45 functions
        ├── pharmacology.py   # 42 functions
        ├── genomics.py       # 20 functions
        ├── ... (23 modules total)
        ├── schema_db/        # Database schemas
        └── tool_description/ # Tool metadata
```

### Component Types

- **skill**: Knowledge guide documents (2)
- **python-module**: Executable Python code (23)
- **data**: Supporting data files (2)

### No Profiles

Biomni uses **整包加载** (full package loading) - no selective profiles. All 27 components load together.

## Using Biomni Tools

### Direct Python Import

```python
# Import Biomni modules directly
import sys
sys.path.append('/Users/mjm/Magenta3/packages/Biomni/tools/python')

from database import query_pubmed, query_uniprot
from pharmacology import predict_adme, predict_toxicity
from genomics import annotate_variants
from molecular_biology import design_pcr_primers

# Use functions
papers = query_pubmed("CRISPR")
adme = predict_adme(compound_smiles)
primers = design_pcr_primers(template, region)
```

### Through Magenta Harness

When loaded via `--harness-package Biomni`, tools are available through Magenta's tool system.

## Requirements

### Minimal (Included)

- All Python code copied locally (1.8 MB)
- No external Biomni installation needed

### Optional for Full Functionality

Some functions may require additional packages:

```bash
# Cheminformatics (pharmacology module)
pip install rdkit chembl-webresource-client

# Bioinformatics (genomics/molecular biology)
pip install biopython primer3-py pysam

# Lab automation
pip install opentrons pyhamilton

# Single-cell (for skill examples)
pip install scanpy celltypist scvi-tools
```

## Citation

If using Biomni resources:

**Biomni System**:
```
Biomni: A General-Purpose Biomedical AI Agent
bioRxiv 2025.05.30.656746v1
https://github.com/snap-stanford/Biomni
```

**sgRNA Database**:
- Cite original publications (PubMed IDs in database)
- Acknowledge: "Validated sgRNA sequences obtained from Addgene"

**Single-Cell Guide**:
```
Luecken, M.D., Theis, F.J. et al. (2023)
Current best practices in single-cell RNA-seq analysis: a tutorial
Molecular Systems Biology
```

## License

- **Python Tools**: MIT License (from Biomni)
- **Knowledge Guides**: CC BY 4.0
- **Commercial Use**: ✅ Allowed with attribution

## Migration Notes

### From Original Biomni

This package contains:
- ✅ All 23 tool modules from `biomni/tool/`
- ✅ All supporting data (`schema_db`, `tool_description`)
- ✅ 2 knowledge guides from `biomni/know_how/`
- ✗ Agent framework (not needed in Magenta context)
- ✗ Task definitions (use Magenta's task system)

### Code Attribution

All Python code in `tools/python/` is copied from:
- **Source**: Stanford SNAP Lab Biomni
- **Commit**: Based on Biomni v1.0 release
- **License**: MIT License
- **Modifications**: None - exact copy

## Summary

**Biomni package provides**:
- ✅ 2 knowledge guide skills
- ✅ 248 executable Python functions across 23 modules
- ✅ 25+ database schemas
- ✅ 1.8 MB of copied code (self-contained)
- ✅整包加载 (all-in-one loading)
- ✅ No external dependencies on original Biomni

**Perfect for**: Drug discovery, database queries, lab automation, genomics analysis, and molecular biology workflows.
