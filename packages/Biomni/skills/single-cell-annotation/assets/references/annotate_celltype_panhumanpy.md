# Tool: annotate_celltype_with_panhumanpy

## Description

Perform cell type annotation of single-cell RNA-seq data using Panhuman Azimuth Neural Network. This function implements the Panhuman Azimuth workflow for cell type annotation using the panhumanpy package, providing hierarchical cell type labels for tissues across the human body.

The Azimuth reference is a comprehensive neural network-based mapping tool trained on millions of human cells. It provides hierarchical annotations at multiple resolution levels and generates low-dimensional embeddings for visualization. Performance is optimized for normal human cells; accuracy is not ensured for diseased and/or non-human cells.

## Parameters

### Required

- **adata_path** (str): Path to the AnnData file containing scRNA-seq data

### Optional

- **feature_names_col** (str): Default `None`. Column name in `adata.var` containing gene symbols. If `None`, uses the index. Useful when gene names are stored in a specific column rather than as the index.
- **refine** (bool): Default `True`. Whether to perform additional label refinement for consistent granularity across predictions
- **umap** (bool): Default `True`. Whether to generate ANN embeddings and UMAP visualization
- **output_dir** (str): Default `"./output"`. Directory to save results

## Usage Example

```python
from biomni.tool.genomics import annotate_celltype_with_panhumanpy

# Basic annotation with default settings
result = annotate_celltype_with_panhumanpy(
    adata_path="./data/query_data.h5ad"
)

# Custom configuration with specific gene column
result = annotate_celltype_with_panhumanpy(
    adata_path="./data/query_data.h5ad",
    feature_names_col="gene_symbols",
    refine=True,
    umap=True,
    output_dir="./panhumanpy_results"
)

# Skip UMAP generation for faster processing
result = annotate_celltype_with_panhumanpy(
    adata_path="./data/query_data.h5ad",
    umap=False,
    output_dir="./annotations_only"
)
```

## Implementation Notes

### Conda Environment Management
- Automatically checks for `panhumanpy_env` conda environment
- Creates environment with Python 3.10 if not present
- Installs panhumanpy from GitHub repository: `git+https://github.com/satijalab/panhumanpy.git`
- Environment is reused across multiple runs for efficiency

### Isolated Execution
- Runs annotation in isolated conda environment to avoid dependency conflicts
- Generates temporary Python script with embedded parameters
- Uses `subprocess` to execute script in `panhumanpy_env`
- Captures results via JSON output file
- Cleans up temporary files after execution

### Annotation Workflow
1. **Load Data**: Reads AnnData object from specified path
2. **Initialize Azimuth**: Creates `ph.AzimuthNN` instance with optional feature name column
3. **Annotate Cells**: Generates hierarchical cell type predictions
4. **Generate Embeddings** (if `umap=True`): Computes ANN-based low-dimensional embeddings
5. **Calculate UMAP** (if `umap=True`): Projects embeddings to 2D for visualization
6. **Refine Labels** (if `refine=True`): Applies label refinement for consistent granularity
7. **Save Results**: Writes metadata, embeddings, and annotated object to output directory

### Error Handling
- Gracefully handles missing `feature_names_col` by falling back to index
- Returns log with error details if annotation steps fail
- Continues partial execution if embedding/UMAP generation fails
- Provides detailed error messages for debugging

### Output Files
- **annotated_cell_metadata.csv**: Cell-level metadata with hierarchical annotations
- **ann_embeddings.npy**: ANN embeddings (if `umap=True`)
- **ann_umap.npy**: UMAP coordinates (if `umap=True`)
- **annotated_obj.h5ad**: Complete annotated AnnData object with all results packed

## Dependencies

- **biomni package**: Core framework
- **panhumanpy**: Panhuman Azimuth annotation package (installed in separate conda env)
- **scanpy**: AnnData I/O operations
- **pandas**: Metadata manipulation
- **numpy**: Array operations for embeddings
- **conda**: Environment management
- **subprocess**: Isolated execution
- **tempfile**: Temporary file management

## Returns

**str**: Research log summarizing the analysis steps and results, formatted as newline-separated entries including:
- Loading confirmation with cell and gene counts
- Gene name source (index or specific column)
- Annotation success status
- Embedding generation status
- UMAP calculation status
- Label refinement results with refined column names
- File paths for all saved outputs

## Output Format

### Cell Metadata Columns
The `annotated_cell_metadata.csv` file contains hierarchical annotations with columns like:
- **azimuth_l1**: Level 1 (broad) cell type labels
- **azimuth_l2**: Level 2 (intermediate) cell type labels
- **azimuth_l3**: Level 3 (fine-grained) cell type labels
- **azimuth_confidence**: Prediction confidence scores
- Additional columns depending on tissue type and refinement settings

### Embeddings
- **ann_embeddings.npy**: Shape `(n_cells, n_dimensions)`, typically 50-100 dimensions
- **ann_umap.npy**: Shape `(n_cells, 2)`, 2D coordinates for visualization

### Annotated Object
The `annotated_obj.h5ad` file contains the original data with added:
- **adata.obs**: All cell metadata columns from Azimuth
- **adata.obsm['X_azimuth']**: ANN embeddings (if `umap=True`)
- **adata.obsm['X_azimuth_umap']**: UMAP coordinates (if `umap=True`)

## Best Practices

1. **Input Quality**: Ensure data is properly normalized and quality-controlled before annotation
2. **Gene Naming**: Use standard gene symbols (HGNC) for best results
3. **Human Data Only**: Designed for normal human tissues; may not work well for mouse or diseased samples
4. **Resource Requirements**: Large datasets may require significant memory for embedding generation
5. **Validation**: Cross-reference predictions with marker genes and known biology
6. **UMAP Toggle**: Disable UMAP for large datasets or when only annotations are needed
7. **Refinement**: Keep `refine=True` for most use cases to ensure consistent label granularity

## Performance Notes

- **Speed**: Annotation is relatively fast (minutes for typical datasets)
- **Memory**: Embedding generation can be memory-intensive for large datasets (>100k cells)
- **GPU**: Not required; runs on CPU
- **Scalability**: Tested on datasets up to ~100k cells

## Limitations

- **Species**: Optimized for human cells; not recommended for other species
- **Disease States**: Performance not ensured for diseased or perturbed cells
- **Novel Cell Types**: May assign generic labels for cell types not in training reference
- **Batch Effects**: Does not perform batch correction; consider preprocessing with Harmony or scVI
- **Dependency Isolation**: Requires conda; may conflict with other environment managers
- **Gene Coverage**: Predictions depend on overlap with Azimuth reference gene set

## Troubleshooting

- **Import Error**: If panhumanpy installation fails, manually install in conda environment
- **Gene Mismatch**: If many genes are missing, check gene naming convention (HGNC vs Ensembl)
- **Low Confidence**: May indicate novel cell types, poor data quality, or non-human/diseased cells
- **Memory Issues**: Disable UMAP or process smaller batches of cells
- **Conda Not Found**: Ensure conda is installed and available in PATH
