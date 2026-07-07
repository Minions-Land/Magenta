---
name: biomedical-tools
description: >
  General biomedical research tools covering database queries (PubMed, UniProt, KEGG),
  drug discovery (ADME prediction, docking), genomics analysis, bio-imaging, and lab
  automation. Use when querying biomedical databases, predicting drug properties,
  analyzing genomic data, processing microscopy images, or automating lab workflows.
tags:
- database
- drug-discovery
- genomics
- imaging
- lab-automation
source: Biomni
license: MIT
---

# Biomedical Research Tools

Comprehensive toolkit of 243 biomedical research functions from Biomni covering database access, computational analysis, and lab automation.

## When to Use This Skill

Use this skill when you need to:
- Query biomedical databases (PubMed, UniProt, KEGG, STRING, etc.)
- Predict drug properties (ADME, toxicity, binding affinity)
- Analyze genomic or genetic data
- Process bio-imaging data (cell segmentation, quantification)
- Automate laboratory workflows

## Tool Categories

### Database & Information (53 functions)

**Database queries** (45 functions in `database` module):
- PubMed literature search
- UniProt protein information
- KEGG pathway data
- STRING protein interactions
- cBioPortal cancer genomics
- Ensembl, NCBI, PDB structure data
- And 20+ more databases

**Literature analysis** (8 functions in `literature` module):
- Scientific paper search and analysis

**Usage**: Requires `pip install biomni`

```python
from biomni.tool.database import query_pubmed, query_uniprot

# Search literature
papers = query_pubmed("CRISPR gene editing", max_results=10)

# Get protein info
protein = query_uniprot(prompt="Find information about human insulin")
```

### Drug Discovery (42 functions)

**Pharmacology** (42 functions in `pharmacology` module):
- ADME property prediction
- Toxicity assessment
- Molecular docking (AutoDock Vina, DiffDock)
- Binding affinity prediction
- Drug-drug interactions
- Physicochemical property calculation

```python
from biomni.tool.pharmacology import predict_admet_properties, docking_autodock_vina

# Predict ADME
results = predict_admet_properties(
    smiles_list=["CC(C)CC1=CC=C(C=C1)C(C)C(=O)O"],
    ADMET_model_type="MPNN"
)

# Molecular docking
docking = docking_autodock_vina(
    smiles_list=["CCO"],
    receptor_pdb_file="protein.pdb",
    box_center=[10, 10, 10],
    box_size=[20, 20, 20]
)
```

### Genomics & Genetics (28 functions)

**Genomics** (20 functions in `genomics` module - excluding cell annotation):
- Variant calling and annotation
- Sequence alignment
- Coverage calculation
- Genome comparison

**Genetics** (8 functions in `genetics` module):
- GWAS analysis
- Linkage analysis
- Population genetics

```python
from biomni.tool.genomics import annotate_variants, align_sequences

# Annotate variants
variants = annotate_variants(
    vcf_file="variants.vcf",
    genome_version="hg38"
)
```

### Molecular Biology (23 functions)

**Molecular biology** (18 functions - excluding sgRNA design):
- PCR primer design
- Plasmid annotation
- Restriction enzyme analysis
- Golden Gate assembly
- Sequence mutations

```python
from biomni.tool.molecular_biology import design_primer, pcr_simple

# Design primers
primers = design_primer(
    template_sequence="ATGCGATCG...",
    target_tm=60
)

# Simulate PCR
pcr_result = pcr_simple(
    sequence="ATGC...",
    forward_primer="ATGC",
    reverse_primer="GCAT"
)
```

### Bio-Imaging & Pathology (20 functions)

**Bio-imaging** (10 functions):
- Cell segmentation (Cellpose, SAM, StarDist)
- Image quantification
- Microscopy data processing

**Pathology** (6 functions):
- Pathology image analysis
- Tissue quantification

**Cell biology** (4 functions):
- Cell-based assays

```python
from biomni.tool.bioimaging import analyze_pixel_distribution, find_roi_from_image

# Analyze image
stats = analyze_pixel_distribution("cell_image.png")

# Find regions of interest
rois = find_roi_from_image(
    image_path="tissue.tif",
    threshold=0.5
)
```

### Lab Automation (11 functions)

**Lab automation** (11 functions):
- Liquid handling robot control
- Plate layout optimization
- Worklist generation
- Protocol automation

```python
from biomni.tool.lab_automation import optimize_plate_layout, generate_worklist

# Optimize plate design
layout = optimize_plate_layout(
    samples=["A", "B", "C"],
    replicates=3,
    controls=["pos", "neg"],
    plate_format=96
)
```

### Immunology & Microbiology (20 functions)

**Immunology** (9 functions):
- Antibody design
- Immune repertoire analysis

**Microbiology** (11 functions):
- Microbiome analysis
- Metagenomics

### Cancer & Systems Biology (11 functions)

**Cancer biology** (5 functions):
- Somatic mutation analysis
- Structural variant detection
- Copy number analysis

**Systems biology** (6 functions):
- Network analysis
- Pathway simulation

### Physiology & Biochemistry (15 functions)

**Physiology** (10 functions):
- Physiological modeling

**Biochemistry** (5 functions):
- Protein analysis
- Enzyme kinetics

### Synthetic Biology & Bioengineering (16 functions)

**Synthetic biology** (7 functions):
- Genetic circuit design
- Metabolic engineering

**Bioengineering** (6 functions - excluding CRISPR editing):
- Tissue engineering
- Biomaterial design

**Biophysics** (2 functions):
- Biophysical calculations

**Glycoengineering** (3 functions):
- Glycan structure analysis

### Protocols & Support (12 functions)

**Protocols** (5 functions):
- Standard lab protocols

**Support tools** (7 functions):
- Utility functions

## Installation

All tools require Biomni package:

```bash
pip install biomni
```

Some tools may require additional dependencies. See Biomni documentation for details.

## Tool Organization

Tools are organized by domain in Biomni source:

- `biomni.tool.database` - Database queries
- `biomni.tool.pharmacology` - Drug discovery
- `biomni.tool.genomics` - Genomics analysis
- `biomni.tool.molecular_biology` - Molecular biology
- `biomni.tool.bioimaging` - Image analysis
- `biomni.tool.lab_automation` - Lab automation
- And 15 more modules...

## Finding Tools

**By domain**: See sections above

**By function name**: Check Biomni documentation at https://github.com/snap-stanford/Biomni

**Tool descriptions**: Biomni includes detailed parameter descriptions in `tool_description/` directory

## Usage Pattern

General pattern for using Biomni tools:

```python
# 1. Import the tool
from biomni.tool.{module} import {function_name}

# 2. Prepare parameters (see tool description)
params = {
    "required_param": "value",
    "optional_param": "value"
}

# 3. Call the function
result = function_name(**params)

# 4. Process results
print(result)
```

## Data Requirements

Some tools require Biomni data lake (~11GB):

```python
# Download on first run
from biomni.agent import A1

agent = A1(path='./data', llm='claude-sonnet-4')
# Data lake downloads automatically
```

## Resources

**Biomni Documentation**:
- GitHub: https://github.com/snap-stanford/Biomni
- Paper: bioRxiv 2025.05.30.656746v1
- Web UI: https://biomni.stanford.edu

**Tool Descriptions**:
- Complete parameter docs in `biomni/tool/tool_description/`
- 23 modules with full API schemas

## Citation

If using Biomni tools:

```
Biomni: A General-Purpose Biomedical AI Agent
bioRxiv 2025.05.30.656746v1
```

## License

- Tool code: MIT License
- This documentation: CC BY 4.0
- Commercial use: Allowed with attribution

## Related Skills

For specific workflows, see:
- **sgrna-design**: CRISPR guide RNA design
- **single-cell-annotation**: scRNA-seq cell type annotation
