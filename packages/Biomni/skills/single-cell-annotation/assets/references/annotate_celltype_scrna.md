# Tool: annotate_celltype_scRNA

## Description

Annotate cell types based on gene markers and transferred labels using LLM. After leiden clustering, annotate clusters using differentially expressed genes and optionally incorporate transferred labels from reference datasets.

This tool combines marker gene analysis with LLM reasoning to assign cell type labels to clusters. It identifies enriched genes for each cluster using Wilcoxon rank-sum test, optionally integrates transferred cell type composition from reference datasets, and uses a language model to predict cell types based on Cell Ontology terms from the CZI Census dataset.

## Parameters

### Required

- **adata_filename** (str): Name of the AnnData file containing scRNA-seq data
- **data_dir** (str): Directory containing the data files
- **data_info** (str): Information about the scRNA-seq data (e.g., "homo sapiens, brain tissue, normal")
- **data_lake_path** (str): Path to the data lake (used to access CZI Census cell type ontology)

### Optional

- **cluster** (str): Default `"leiden"`. Clustering method to use for cell type annotation
- **llm** (str): Default `"claude-3-5-sonnet-20241022"`. Language model instance for cell type prediction (e.g., 'claude-3-haiku-20240307')
- **composition** (pd.DataFrame): Default `None`. Transferred cell type composition for each cluster (optional reference information from label transfer)

## Usage Example

```python
from biomni.tool.genomics import annotate_celltype_scRNA

# Basic annotation without reference composition
result = annotate_celltype_scRNA(
    adata_filename="preprocessed_data.h5ad",
    data_dir="./data",
    data_info="homo sapiens, brain tissue, normal",
    data_lake_path="/path/to/data_lake",
    llm="claude-3-5-sonnet-20241022"
)

# With transferred cell type composition from reference
import pandas as pd
composition_df = pd.DataFrame(...)  # From label transfer step

result = annotate_celltype_scRNA(
    adata_filename="preprocessed_data.h5ad",
    data_dir="./data",
    data_info="homo sapiens, brain tissue, healthy adult",
    data_lake_path="/path/to/data_lake",
    cluster="leiden",
    llm="claude-3-5-sonnet-20241022",
    composition=composition_df
)
```

## Implementation Notes

### Marker Gene Identification
- Uses `sc.tl.rank_genes_groups()` with Wilcoxon rank-sum test
- Extracts top 20 marker genes per cluster
- Filters genes with positive scores only
- Stores results in `adata.uns['rank_genes_groups']`

### LLM Prompting Strategy
- Constructs prompt with cluster-specific enriched genes
- Optionally includes transferred cell type composition (only trusted when proportion > 0.5)
- References Cell Ontology terms from CZI Census v4 dataset
- Requires output format: "name; score; reason"
- Validates predicted cell type against Cell Ontology vocabulary
- Retries with additional context if format is incorrect or cell type not found

### Annotation Validation Loop
- For each cluster, iteratively queries the LLM
- Parses response into: predicted_celltype, confidence, reason
- Checks if predicted cell type exists in CZI cell ontology set
- Re-prompts if validation fails with additional constraints
- Stores annotation reasoning for interpretability

### Output Storage
- Adds `cell_type` column to `adata.obs` with predicted labels
- Adds `cell_type_reason` column with detailed reasoning
- Saves annotated object to `{data_dir}/annotated.h5ad` with gzip compression

## Dependencies

- **biomni package**: Core framework
- **scanpy**: Single-cell analysis and marker gene identification
- **pandas**: Data manipulation for composition dataframes
- **numpy**: Numerical operations for filtering marker genes
- **langchain_core.prompts**: LLM prompt templating
- **biomni.llm.get_llm**: LLM instance retrieval

## Returns

**str**: Steps performed and file paths where results were saved, formatted as newline-separated log entries including:
- Loading confirmation with file path
- Marker gene identification status
- Annotation progress for each cluster
- Output file path (`{data_dir}/annotated.h5ad`)

## Output Format

The annotated AnnData object contains:
- **adata.obs['cell_type']**: Predicted cell type label for each cell (mapped from cluster annotation)
- **adata.obs['cell_type_reason']**: Detailed reasoning for the cell type assignment
- **adata.uns['rank_genes_groups']**: Differential expression results used for annotation

## Best Practices

1. **Data Preparation**: Ensure data is preprocessed and clustered before annotation
2. **Data Info Specificity**: Provide detailed `data_info` (species, tissue, condition) for better LLM context
3. **Composition Integration**: Use transferred labels from `unsupervised_celltype_transfer_between_scRNA_datasets` for improved accuracy
4. **Model Selection**: Choose LLM based on speed/quality tradeoff (Haiku for speed, Sonnet for accuracy)
5. **Manual Review**: Always review `cell_type_reason` column to validate LLM predictions
6. **Iterative Refinement**: If annotations are inaccurate, adjust clustering resolution or provide better reference composition

## Limitations

- Requires CZI Census dataset at `{data_lake_path}/czi_census_datasets_v4.parquet`
- Limited to cell types present in Cell Ontology
- LLM predictions may require manual validation
- Composition information only trusted when proportion > 0.5
- Assumes Leiden clustering results are already present in the AnnData object
