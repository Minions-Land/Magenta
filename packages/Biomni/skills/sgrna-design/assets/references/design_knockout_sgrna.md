# Tool: design_knockout_sgrna

Design sgRNAs for CRISPR knockout by searching pre-computed sgRNA libraries from Addgene validated sequences.

## Description

Searches pre-computed sgRNA libraries containing 300+ experimentally validated knockout guide sequences. Returns optimized guide RNAs ranked by combined efficacy scores for targeting a specific gene. This is the fastest method for finding validated sgRNAs when experimental data exists.

The tool queries curated libraries from the Addgene CRISPR database, which aggregates published sgRNA sequences with experimental validation data.

## Parameters

### Required

- **gene_name** (str): Target gene symbol/name
  - Example: "EGFR", "TP53", "BRCA1"
  - Case-insensitive (converted to uppercase)
  - Supports partial matching if exact match fails

- **data_lake_path** (str): Path to the data lake containing sgRNA libraries
  - Must contain `sgRNA_KO_SP_human.txt` for human
  - Must contain `sgRNA_KO_SP_mouse.txt` for mouse

### Optional

- **species** (str): Target organism species
  - Default: "human"
  - Options: "human", "mouse"
  - Case-insensitive

- **num_guides** (int): Number of guides to return
  - Default: 1
  - Returns top-ranked guides by Combined Rank score
  - Recommend requesting 3-4 for experimental validation

## Returns

Dictionary containing:
- **explanation**: Description of output fields
- **gene_name**: Target gene name (uppercase)
- **species**: Target species
- **guides**: List of sgRNA sequences (20 bp, 5' to 3')

Returns empty guides list if gene not found in library.

## Usage Example

```python
from biomni.tool.molecular_biology import design_knockout_sgrna

# Single guide for human gene
result = design_knockout_sgrna(
    gene_name="TP53",
    data_lake_path="./data",
    species="human",
    num_guides=1
)

# Multiple guides for validation
result = design_knockout_sgrna(
    gene_name="EGFR",
    data_lake_path="./data",
    species="human",
    num_guides=4
)

# Mouse gene knockout
result = design_knockout_sgrna(
    gene_name="Trp53",
    data_lake_path="./data",
    species="mouse",
    num_guides=3
)

# Access results
print(f"Gene: {result['gene_name']}")
print(f"Species: {result['species']}")
for i, guide in enumerate(result['guides'], 1):
    print(f"Guide {i}: {guide}")
```

## Implementation Notes

### Library Format
The sgRNA libraries are tab-delimited files with columns:
- Target Gene Symbol
- sgRNA Sequence (20 bp)
- Combined Rank (lower is better)
- Additional metadata (efficacy scores, off-targets, etc.)

### Search Strategy
1. Exact match on gene symbol (case-insensitive)
2. If no exact match, tries partial matching (substring search)
3. Sorts results by Combined Rank
4. Returns top N guides

### Ranking
Guides are pre-ranked by Combined Rank, which aggregates:
- On-target activity scores
- Off-target specificity
- GC content optimization
- Experimental validation status

### Error Handling
- Raises `FileNotFoundError` if library file doesn't exist
- Raises `RuntimeError` if library fails to load
- Returns empty guides list if gene not found (no exception)

### Performance
- Fast lookup (indexed CSV read)
- No computational design - pre-computed results only
- Typical query: <1 second for any gene

## Data Source

**Library**: Addgene CRISPR Reference Database
- URL: https://www.addgene.org/crispr/reference/grna-sequence/
- Content: 300+ experimentally validated sgRNA sequences
- Species: Human, Mouse
- Update frequency: Periodic (check Addgene for latest)

**Quality**: All sequences have:
- Published experimental validation
- PubMed ID citations
- Efficacy data from original studies

## Limitations

### Coverage
- Limited to genes with published sgRNA data
- Not all genes have validated sequences
- For novel genes, use Tier 2 (CRISPick) or Tier 3 (de novo) tools

### PAM Compatibility
- Library contains primarily SpCas9 (NGG PAM) sequences
- Check PAM context if using alternative Cas enzymes

### Species Support
- Currently: Human, Mouse
- For other species, use computational design tools

## Best Practices

### Experimental Validation
Even with validated sequences:
1. Test 3-4 guides per target
2. Include non-targeting control
3. Verify by T7E1 or Sanger sequencing
4. Confirm protein knockout by Western blot

### Citation Requirements
When using results from this tool:
1. Cite original publication (find PubMed ID in Addgene database)
2. Acknowledge Addgene as data source
3. Cite Biomni tool: bioRxiv 2025.05.30.656746v1

### When to Use Other Tools
Use computational design (CRISPick, CHOPCHOP) if:
- Gene not found in library (empty guides list)
- Need custom PAM sequences
- Want multiple design algorithms for comparison
- Targeting non-coding regions

## Dependencies

- **biomni** package
- **pandas**: For library data loading
- **os**: For file path handling

## Related Tools

- [crispr_editing.md](crispr_editing.md): Simulate CRISPR editing outcomes
- CRISPick: Computational design for any gene
- CHOPCHOP: Alternative design algorithm

## Troubleshooting

**FileNotFoundError**: Library file not found
- Check `data_lake_path` is correct
- Verify sgRNA library files exist
- Download from Addgene if missing

**Empty guides list**: Gene not in library
- Try computational design (CRISPick)
- Check gene symbol spelling
- Try alternative gene names (synonyms)

**Wrong species**: Check species parameter
- Use "human" or "mouse" (case-insensitive)
- Verify gene name matches species conventions

## Source Attribution

- **Tool Source**: Biomni (Stanford SNAP Lab)
- **Data Source**: Addgene CRISPR Reference Database
- **License**: MIT (tool), CC BY 4.0 (data)
- **Paper**: bioRxiv 2025.05.30.656746v1
