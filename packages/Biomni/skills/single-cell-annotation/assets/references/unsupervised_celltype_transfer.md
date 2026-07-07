# Tool: unsupervised_celltype_transfer_between_scRNA_datasets

## Description

Transfer cell type labels from an annotated reference scRNA-seq dataset to an unannotated query dataset using popV. This tool loads both AnnData .h5ad files, prepares count layers for scVI-based models, processes the query against the reference, and runs selected annotation methods.

popV (population-level variation) is a benchmarking framework that enables comparison of multiple cell type annotation methods. By default, it uses SCANVI_POPV, a semi-supervised variational autoencoder that combines batch correction with label transfer. The tool supports 10 different annotation methods, each with distinct strengths for different scenarios.

This function allows you to use different annotation methods: CELLTYPIST, KNN_BBKNN, KNN_HARMONY, KNN_SCANORAMA, KNN_SCVI, ONCLASS, Random_Forest, SCANVI_POPV, Support_Vector, XGBoost. Based on your transfer task, you can select multiple best annotation methods. Beware each annotation method adds computational requirements for running the tool.

## Parameters

### Required

- **path_to_annotated_h5ad** (str): Path to annotated reference AnnData (.h5ad) with cell type labels
- **path_to_not_annotated_h5ad** (str): Path to unannotated query AnnData (.h5ad) to be annotated
- **ref_labels_key** (str): Column in reference `adata.obs` with cell type labels

### Optional

#### Batch Information
- **query_batch_key** (str): Default `None`. Column in query `adata.obs` with batch information
- **ref_batch_key** (str): Default `None`. Column in reference `adata.obs` with batch information

#### Annotation Methods (Boolean flags)

- **CELLTYPIST** (bool): Default `False`. Enable CELLTYPiST (reference-based classifier). How it works: regularized logistic regression trained on curated references predicts per-cell probabilities; optional neighbor correction refines labels. Strengths: fast, scalable, strong on common human/mouse types. Weaknesses: depends on reference coverage; limited for novel or out-of-distribution cell types.

- **KNN_BBKNN** (bool): Default `False`. Enable KNN with BBKNN integration. How it works: builds a batch-balanced kNN graph by enforcing a fixed number of neighbors per batch, then uses this graph for downstream analyses. Strengths: simple, fast, preserves local neighborhood structure across batches. Weaknesses: limited global alignment; residual batch effects when shared cell types are sparse; sensitive to k/neighbor parameters.

- **KNN_HARMONY** (bool): Default `False`. Enable KNN with Harmony integration. How it works: iteratively adjusts PCA embeddings via soft clustering and linear correction to minimize batch effects while preserving structure. Strengths: scalable, effective batch correction in low-D space, often preserves biology. Weaknesses: can overcorrect and merge true biological differences; depends on PCA/parameters.

- **KNN_SCANORAMA** (bool): Default `False`. Enable KNN with Scanorama integration. How it works: identifies mutual nearest neighbors across datasets and performs manifold alignment/low-rank correction to merge 'panoramas'. Strengths: strong cross-dataset alignment for shared populations. Weaknesses: slower and more memory-intensive on large data; may distort rare or unique populations.

- **KNN_SCVI** (bool): Default `False`. Enable KNN with scVI integration (KNN in scVI latent space). How it works: trains a variational autoencoder (negative binomial likelihood) to learn a batch-corrected latent space; runs KNN in this space to transfer labels. Strengths: robust probabilistic embedding that models counts and batch; good transfer performance. Weaknesses: requires training (GPU preferred); sensitive to embedding quality and k.

- **ONCLASS** (bool): Default `False`. Enable OnClass (ontology-aware classifier). How it works: embeds the Cell Ontology graph and trains a classifier over ontology nodes; uses semantic similarity to generalize to unseen labels (zero-shot). Strengths: leverages Cell Ontology; can map to unseen/fine-grained types; interpretable. Weaknesses: dependent on ontology completeness and mapping quality; may assign overly generic labels.

- **Random_Forest** (bool): Default `False`. Enable Random Forest classifier. How it works: ensemble of decision trees trained on bootstrap samples with feature subsampling; predictions aggregated by majority vote/probabilities. Strengths: robust to noise and nonlinear signals; quick to train; feature importance available. Weaknesses: probability calibration can be poor; needs feature selection with sparse data; sensitive to class imbalance.

- **SCANVI_POPV** (bool): Default `True`. Enable scANVI with popV. How it works: semi-supervised variational autoencoder extends scVI with label information; conditions the generative model on known labels, transfers via latent space. Strengths: state-of-the-art transfer performance; models batch and labels jointly; handles partial labels. Weaknesses: training time (GPU recommended); hyperparameter tuning; can be overconfident.

- **Support_Vector** (bool): Default `False`. Enable Support Vector Machine classifier. How it works: finds maximum-margin hyperplane in feature/kernel space to separate classes; uses one-vs-rest for multiclass. Strengths: strong with high-dimensional sparse features; kernel trick for nonlinear boundaries. Weaknesses: training slow on large datasets; probability calibration requires additional fitting; sensitive to class imbalance.

- **XGboost** (bool): Default `False`. Enable XGBoost classifier. How it works: gradient boosting with regularization, tree pruning, and efficient implementation; iteratively adds trees to minimize loss. Strengths: excellent accuracy on tabular data; handles missing values; built-in feature importance. Weaknesses: hyperparameter tuning required; can overfit without regularization; slower than random forest at inference.

#### Processing Parameters
- **n_jobs** (int): Default `1`. Number of parallel jobs for processing
- **output_folder** (str): Default `"./tmp/"`. Directory to save output files and trained models
- **n_samples_per_label** (int): Default `10`. Number of samples per label (currently unused)

## Usage Example

```python
from biomni.tool.genomics import unsupervised_celltype_transfer_between_scRNA_datasets

# Basic usage with default SCANVI_POPV method
result = unsupervised_celltype_transfer_between_scRNA_datasets(
    path_to_annotated_h5ad="./reference/pbmc_annotated.h5ad",
    path_to_not_annotated_h5ad="./query/pbmc_query.h5ad",
    ref_labels_key="cell_type",
    output_folder="./label_transfer_results"
)

# With batch information
result = unsupervised_celltype_transfer_between_scRNA_datasets(
    path_to_annotated_h5ad="./reference/pbmc_annotated.h5ad",
    path_to_not_annotated_h5ad="./query/pbmc_query.h5ad",
    ref_labels_key="cell_type",
    query_batch_key="batch",
    ref_batch_key="donor",
    output_folder="./label_transfer_results"
)

# Multiple annotation methods for comprehensive comparison
result = unsupervised_celltype_transfer_between_scRNA_datasets(
    path_to_annotated_h5ad="./reference/tissue_atlas.h5ad",
    path_to_not_annotated_h5ad="./query/new_samples.h5ad",
    ref_labels_key="celltype",
    query_batch_key="batch",
    ref_batch_key="batch",
    SCANVI_POPV=True,
    KNN_SCVI=True,
    CELLTYPIST=True,
    Random_Forest=True,
    n_jobs=8,
    output_folder="./multi_method_transfer"
)

# Fast annotation with KNN-based methods only
result = unsupervised_celltype_transfer_between_scRNA_datasets(
    path_to_annotated_h5ad="./reference/annotated.h5ad",
    path_to_not_annotated_h5ad="./query/to_annotate.h5ad",
    ref_labels_key="cell_type_label",
    KNN_HARMONY=True,
    KNN_BBKNN=True,
    SCANVI_POPV=False,  # Disable default
    n_jobs=4,
    output_folder="./knn_methods"
)
```

## Implementation Notes

### Data Preparation
- Sets UTF-8 encoding via `os.environ["PYTHONUTF8"] = "1"` for compatibility
- Loads both reference and query AnnData objects from .h5ad files
- Creates `layers['counts']` by copying `X` matrix (required for scVI/scANVI models)
- Configures popV with `n_jobs` for parallel processing

### popV Processing Pipeline
1. **Query Processing**: Calls `popv.preprocessing.Process_Query()` with:
   - Reference and query datasets
   - Label and batch keys
   - Save path for trained models
   - `prediction_mode="retrain"` (trains new models rather than using pretrained)
   - `cl_obo_folder=False` (skips Cell Ontology folder requirement)

2. **Method Execution**: Iterates through selected annotation methods
   - Converts boolean flags to method list
   - Runs each enabled classifier via popV framework
   - Saves intermediate trained models to `output_folder`

3. **Result Aggregation**: Consolidates predictions from all methods
   - Saves consolidated predictions to `{output_folder}/popv_output/predictions.csv`
   - Includes per-method confidence scores and labels

### Output Generation
- Creates output folder if it doesn't exist
- Saves trained models for potential reuse
- Generates CSV with per-cell predictions from each method
- Returns step-by-step log of the process

## Dependencies

- **biomni package**: Core framework
- **popv**: Population-level variation framework for cell type annotation benchmarking
- **scanpy**: AnnData I/O and preprocessing
- **scvi-tools**: Variational inference models (scVI, scANVI) - installed with popV
- **bbknn**: Batch-balanced KNN graph construction
- **harmony-pytorch**: Harmony integration
- **scanorama**: Panorama alignment
- **celltypist**: Reference-based cell type classifier
- **onclass**: Ontology-aware classifier
- **scikit-learn**: Random Forest, SVM, KNN classifiers
- **xgboost**: Gradient boosting classifier

## Returns

**str**: Steps performed formatted as newline-separated log entries including:
- Initialization message
- Dataset loading confirmations with cell/gene counts
- Output folder creation
- Query processing status
- Method execution progress
- Output file path for predictions

## Output Format

### Predictions CSV
The main output file `{output_folder}/popv_output/predictions.csv` contains:
- **Index**: Cell barcodes from query dataset
- **[method_name]_prediction**: Predicted cell type label from each method
- **[method_name]_confidence**: Confidence score (0-1) for each method's prediction
- Additional method-specific columns (e.g., second-best predictions, probability distributions)

### Trained Models
Saved in `{output_folder}/trained_models/`:
- scVI/scANVI model checkpoints
- Classifier pickle files (Random Forest, SVM, XGBoost)
- Integration preprocessing results

## Best Practices

1. **Method Selection**: 
   - Use SCANVI_POPV for most cases (best overall performance)
   - Add KNN_SCVI or CELLTYPIST for consensus validation
   - Enable multiple methods only when compute resources allow

2. **Batch Information**:
   - Provide batch keys when datasets have batch effects
   - Improves integration and transfer accuracy
   - Critical for KNN_BBKNN and KNN_HARMONY methods

3. **Reference Quality**:
   - Use well-annotated, high-quality reference datasets
   - Ensure reference covers expected cell types in query
   - Check reference and query have sufficient gene overlap

4. **Computational Considerations**:
   - Use GPU for scVI/scANVI models (orders of magnitude faster)
   - Increase `n_jobs` for parallel processing of KNN/tree-based methods
   - Each additional method increases runtime significantly

5. **Result Interpretation**:
   - Compare predictions across multiple methods for consensus
   - Check confidence scores - low scores indicate uncertain predictions
   - Validate transferred labels with marker gene expression

6. **Common Issues**:
   - Ensure raw counts in `.X` or `.layers['counts']`
   - Check gene name format consistency between datasets
   - Verify batch keys exist in `.obs` before running

## Limitations

- Requires matched gene features between reference and query
- Performance depends on reference dataset quality and coverage
- scVI-based methods benefit from GPU but can run on CPU (slowly)
- OnClass requires Cell Ontology mapping (may be slow or fail without proper setup)
- XGBoost and Random Forest may require feature selection for very high-dimensional data
- Does not handle species mismatch (reference and query should be same species)
- Assumes query and reference are from similar biological contexts

## Method Selection Guide

**When to use each method:**

- **SCANVI_POPV**: Default choice; best overall performance; handles batch effects well
- **CELLTYPIST**: Fast baseline; good for standard human/mouse tissues; less accurate for novel types
- **KNN methods**: Fast alternatives; good when computation is limited; KNN_SCVI often best KNN variant
- **ONCLASS**: When you need ontology-aware predictions or zero-shot capability
- **Random_Forest/XGBoost**: Strong baselines; good feature importance; useful for comparison
- **Support_Vector**: High-dimensional sparse data; when maximum-margin separation is desired

**Recommended combinations:**
- **Speed-focused**: CELLTYPIST only
- **Accuracy-focused**: SCANVI_POPV + KNN_SCVI + CELLTYPIST
- **Comprehensive benchmark**: All methods enabled (resource-intensive)
- **Novel cell types**: SCANVI_POPV + ONCLASS
