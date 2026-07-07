# Tool: perform_crispr_cas9_genome_editing

Simulate CRISPR-Cas9 genome editing process including guide RNA validation, target site identification, delivery, and editing outcome analysis.

## Description

Simulates the complete CRISPR-Cas9 genome editing workflow to predict editing outcomes. This tool validates guide RNA sequences, identifies target sites with PAM sequences, models delivery efficiency based on cell type, and simulates editing outcomes including indel formation and knockout efficiency.

Use this tool for planning experiments, validating guide designs before wet lab work, and understanding expected editing outcomes.

## Parameters

### Required

- **guide_rna_sequences** (List[str]): List of guide RNA sequences targeting the genomic region
  - Each guide must be exactly 20 nucleotides
  - Valid nucleotides: A, T, G, C only
  - Provide multiple guides for comparison
  - Example: ["AGCTGACTGATCGATCGATC", "TCGATCGATCGATCGATCGA"]

- **target_genomic_loci** (str): Target genomic sequence to be edited
  - Must be longer than guide RNA sequences
  - Should contain target sites with PAM sequences (NGG)
  - Provide sufficient flanking sequence (≥50 bp on each side)
  - Example: Region from genome containing your target exon

- **cell_tissue_type** (str): Type of cell or tissue being edited
  - Affects delivery efficiency and editing outcomes
  - Examples: "HEK293T", "K562", "primary T cells", "mouse embryo", "iPSCs"
  - Model uses cell type to estimate transfection/delivery success

### Optional

None - all parameters are required for meaningful simulation.

## Returns

String containing detailed research log with:
- Date and experimental parameters
- Guide RNA validation (GC content, quality assessment)
- Target site identification (position, PAM presence)
- Delivery simulation (cell-specific efficiency)
- Editing outcomes (indel formation, knockout prediction)
- Recommendations for experimental design

## Usage Example

```python
from biomni.tool.bioengineering import perform_crispr_cas9_genome_editing

# Single guide editing simulation
guides = ["GACCCCCTCCACCCCGCCTC"]
target = "ATCGATCGATCGGACCCCCTCCACCCCGCCTCGGGCGATCGATCGATCGATCGATCG"
result = perform_crispr_cas9_genome_editing(
    guide_rna_sequences=guides,
    target_genomic_loci=target,
    cell_tissue_type="HEK293T"
)
print(result)

# Multiple guide comparison
guides = [
    "GACCCCCTCCACCCCGCCTC",
    "TCGATCGATCGATCGATCGA",
    "AGCTACTGATCGATCGATCG"
]
target_sequence = """
ATCGATCGATCGGACCCCCTCCACCCCGCCTCGGGCGATCGATCGATCGATCGATCG
TCGATCGATCGATCGATCGAGGGCGATCGATCGATAGCTACTGATCGATCGATCGGGG
""".replace("\n", "")

result = perform_crispr_cas9_genome_editing(
    guide_rna_sequences=guides,
    target_genomic_loci=target_sequence,
    cell_tissue_type="primary T cells"
)
print(result)
```

## Implementation Notes

### Guide RNA Validation

**Length Check**: Each guide must be exactly 20 bp
- Invalid if ≠ 20 nucleotides
- Standard SpCas9 guide length

**Nucleotide Validation**: Only A, T, G, C allowed
- Case-insensitive
- Invalid characters cause rejection

**GC Content Analysis**: Calculated for efficiency prediction
- Optimal: 40-60% GC
- Suboptimal: <40% or >60%
- Affects efficiency score

### Target Site Identification

**Search Strategy**:
1. Converts guide and target to uppercase
2. Searches for exact guide sequence match
3. Checks for PAM sequence (NGG) immediately 3' of guide
4. Reports position and PAM quality

**PAM Requirements**:
- Standard SpCas9 PAM: 5'-NGG-3'
- Must be present 3' of protospacer
- "Found": Valid NGG PAM detected
- "Not found": No valid PAM
- "Out of bounds": Target sequence too short

### Delivery Simulation

**Cell Type-Specific Efficiencies** (modeled):
- HEK293T: 70-90% (highly transfectable)
- K562: 60-80% (good)
- Primary T cells: 40-60% (moderate)
- iPSCs: 30-50% (challenging)
- Default: 50-70%

**Factors Simulated**:
- Transfection/electroporation efficiency
- Cas9 expression levels
- Nuclear localization
- Guide RNA stability

### Editing Outcomes

**Indel Formation**:
- Non-homologous end joining (NHEJ) simulation
- Frameshift mutations modeled
- Knockout efficiency estimated

**Success Metrics**:
- Guide quality score (GC content)
- PAM presence bonus
- Cell type delivery efficiency
- Combined editing success prediction

## Validation and Limitations

### This is a Simulation Tool
- Predicts outcomes based on known parameters
- Does NOT perform actual genome editing
- Use for planning, not as experimental data
- Wet lab validation always required

### Simplifications
- Off-target effects not modeled
- Chromatin accessibility not considered
- Guide RNA secondary structure ignored
- Repair outcomes simplified (NHEJ only)

### Assumptions
- SpCas9 with NGG PAM only
- Standard delivery methods
- Cell-specific efficiencies are averages
- No multiplexing effects modeled

## Best Practices

### Before Wet Lab
1. Run simulations on all candidate guides
2. Compare GC content and PAM quality
3. Verify target site matches genome reference
4. Check predicted efficiency for your cell type

### Guide Selection
- Prefer guides with "Optimal" GC content
- Ensure "Found" PAM status
- Test 3-4 guides experimentally
- Include positive/negative controls

### Experimental Design
- Account for cell type-specific delivery challenges
- Plan for lower efficiency in primary cells
- Optimize transfection method for your system
- Sequence edited clones for validation

## Cell Type Recommendations

**High Efficiency** (>70% delivery):
- HEK293T, HeLa, U2OS
- Use plasmid transfection or lipofection

**Moderate Efficiency** (50-70%):
- K562, Jurkat, A549
- Consider electroporation

**Low Efficiency** (<50%):
- Primary T cells, primary neurons, iPSCs
- Use nucleofection, viral delivery, or RNP
- Expect lower editing rates

## Output Interpretation

### Research Log Sections

**STEP 1: Guide RNA Validation**
- VALID/INVALID status for each guide
- GC content percentage and quality
- Efficiency scoring

**STEP 2: Target Site Identification**
- Genomic position of each guide match
- PAM sequence status
- Target site quality score

**STEP 3: CRISPR-Cas9 Delivery Simulation**
- Cell type-specific delivery efficiency
- Expected transfection success rate

**STEP 4: Editing Outcomes**
- Predicted indel formation rate
- Knockout efficiency estimate
- Recommended next steps

## Troubleshooting

**"No valid guide RNAs found"**:
- Check guide length (must be 20 bp)
- Verify only A, T, G, C nucleotides
- Remove any spaces or special characters

**"No matching target sites found"**:
- Verify guide sequence matches target
- Check target sequence contains guides
- Ensure sufficient target sequence length
- Verify correct strand orientation

**"PAM not found"**:
- Check for NGG sequence 3' of guide
- Target may not be suitable for SpCas9
- Consider alternative Cas proteins (SaCas9, Cas12a)

**Low predicted efficiency**:
- Try guides with better GC content
- Consider alternative delivery methods
- Test multiple guides in parallel
- Optimize for your specific cell type

## Related Tools

- [design_knockout_sgrna.md](design_knockout_sgrna.md): Find validated guide sequences
- CRISPick: Computational guide design with off-target prediction
- Benchling: Full CRISPR design workflow

## Dependencies

- **biomni** package
- **random**: For outcome simulation
- **datetime**: For logging
- **os**: For file operations

## Source Attribution

- **Tool Source**: Biomni (Stanford SNAP Lab)
- **License**: MIT
- **Paper**: bioRxiv 2025.05.30.656746v1

## Citation

When reporting simulation results:
1. State this is a computational prediction, not experimental data
2. Cite Biomni: bioRxiv 2025.05.30.656746v1
3. Validate predictions with wet lab experiments
4. Report actual experimental outcomes separately
