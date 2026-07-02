"""
Pytest fixtures for omics helper module tests.

Provides synthetic AnnData objects with known characteristics for testing.
"""

import numpy as np
import pandas as pd
import pytest
from anndata import AnnData
from scipy.sparse import csr_matrix


@pytest.fixture
def tiny_adata():
    """
    Minimal synthetic AnnData: 10 cells × 5 genes.

    - Raw counts in X (sparse)
    - No layers, no obsm, minimal obs
    - For testing basic I/O and validation
    """
    np.random.seed(42)
    X = csr_matrix(np.random.poisson(5, size=(10, 5)).astype(np.float32))

    obs = pd.DataFrame({
        "cell_id": [f"cell_{i}" for i in range(10)],
    }, index=[f"cell_{i}" for i in range(10)])

    var = pd.DataFrame({
        "gene_name": [f"gene_{i}" for i in range(5)],
    }, index=[f"gene_{i}" for i in range(5)])

    return AnnData(X=X, obs=obs, var=var)


@pytest.fixture
def small_adata():
    """
    Small synthetic AnnData: 100 cells × 50 genes.

    - Raw counts in layers["counts"]
    - Normalized data in X
    - Cell type annotations and batch labels
    - For testing summarize and conventions
    """
    np.random.seed(42)
    n_obs, n_vars = 100, 50

    # Raw counts
    counts = np.random.negative_binomial(5, 0.3, size=(n_obs, n_vars)).astype(np.float32)

    # Normalized (fake log-normalized)
    X = np.log1p(counts / counts.sum(axis=1, keepdims=True) * 1e4)

    obs = pd.DataFrame({
        "cell_type": np.random.choice(["T_cell", "B_cell", "Monocyte"], size=n_obs),
        "batch": np.random.choice(["batch1", "batch2"], size=n_obs),
        "n_genes": np.random.randint(200, 500, size=n_obs),
        "percent_mito": np.random.uniform(0, 15, size=n_obs),
    }, index=[f"cell_{i}" for i in range(n_obs)])

    var = pd.DataFrame({
        "gene_name": [f"GENE{i}" for i in range(n_vars)],
        "highly_variable": np.random.choice([True, False], size=n_vars),
    }, index=[f"GENE{i}" for i in range(n_vars)])

    # Add MT genes
    var.loc["GENE0":"GENE2", "gene_name"] = ["MT-CO1", "MT-ND1", "MT-ATP6"]
    var.index = var["gene_name"]

    adata = AnnData(X=X, obs=obs, var=var)
    adata.layers["counts"] = counts

    return adata


@pytest.fixture
def preprocessed_adata():
    """
    Fully preprocessed synthetic AnnData: 200 cells × 100 genes.

    - Raw counts in layers["counts"]
    - Normalized data in X
    - PCA and UMAP embeddings in obsm
    - Leiden clusters in obs
    - For testing validation and full pipeline verification
    """
    np.random.seed(42)
    n_obs, n_vars = 200, 100

    # Raw counts
    counts = np.random.negative_binomial(10, 0.2, size=(n_obs, n_vars)).astype(np.float32)

    # Normalized
    X = np.log1p(counts / counts.sum(axis=1, keepdims=True) * 1e4)

    obs = pd.DataFrame({
        "cell_type": np.random.choice(["CD4_T", "CD8_T", "NK", "B_cell"], size=n_obs),
        "leiden": np.random.choice(["0", "1", "2", "3"], size=n_obs),
        "batch": np.random.choice(["A", "B", "C"], size=n_obs),
        "n_genes": np.random.randint(300, 800, size=n_obs),
        "n_counts": np.random.randint(1000, 5000, size=n_obs),
        "percent_mito": np.random.uniform(0, 10, size=n_obs),
    }, index=[f"cell_{i}" for i in range(n_obs)])

    var = pd.DataFrame({
        "gene_name": [f"GENE{i}" for i in range(n_vars)],
        "highly_variable": np.random.choice([True, False], size=n_vars, p=[0.2, 0.8]),
    }, index=[f"GENE{i}" for i in range(n_vars)])

    # Add MT genes
    for i in range(5):
        var.loc[f"GENE{i}", "gene_name"] = f"MT-GENE{i}"
    var.index = var["gene_name"]

    adata = AnnData(X=X, obs=obs, var=var)
    adata.layers["counts"] = counts

    # Add embeddings
    adata.obsm["X_pca"] = np.random.randn(n_obs, 50).astype(np.float32)
    adata.obsm["X_umap"] = np.random.randn(n_obs, 2).astype(np.float32)

    # Add unstructured
    adata.uns["neighbors"] = {"connectivities_key": "connectivities", "distances_key": "distances"}
    adata.uns["umap"] = {"params": {"n_neighbors": 15}}

    return adata


@pytest.fixture
def preprocessed_adata_no_counts():
    """
    Preprocessed AnnData missing layers["counts"].

    For testing validation error paths.
    """
    np.random.seed(42)
    n_obs, n_vars = 50, 30

    X = np.random.randn(n_obs, n_vars).astype(np.float32)

    obs = pd.DataFrame({
        "leiden": np.random.choice(["0", "1"], size=n_obs),
    }, index=[f"cell_{i}" for i in range(n_obs)])

    var = pd.DataFrame({
        "gene_name": [f"GENE{i}" for i in range(n_vars)],
    }, index=[f"GENE{i}" for i in range(n_vars)])

    adata = AnnData(X=X, obs=obs, var=var)
    adata.obsm["X_pca"] = np.random.randn(n_obs, 20).astype(np.float32)

    return adata


@pytest.fixture
def adata_with_multiple_embeddings():
    """
    AnnData with multiple embedding types.

    For testing embedding detection and validation.
    """
    np.random.seed(42)
    n_obs, n_vars = 80, 40

    X = np.random.randn(n_obs, n_vars).astype(np.float32)

    obs = pd.DataFrame({
        "cluster": np.random.choice(["A", "B", "C"], size=n_obs),
    }, index=[f"cell_{i}" for i in range(n_obs)])

    var = pd.DataFrame({
        "gene_name": [f"GENE{i}" for i in range(n_vars)],
    }, index=[f"GENE{i}" for i in range(n_vars)])

    adata = AnnData(X=X, obs=obs, var=var)
    adata.layers["counts"] = np.random.poisson(5, size=(n_obs, n_vars)).astype(np.float32)

    # Multiple embeddings
    adata.obsm["X_pca"] = np.random.randn(n_obs, 50).astype(np.float32)
    adata.obsm["X_pca_harmony"] = np.random.randn(n_obs, 50).astype(np.float32)
    adata.obsm["X_umap"] = np.random.randn(n_obs, 2).astype(np.float32)
    adata.obsm["X_tsne"] = np.random.randn(n_obs, 2).astype(np.float32)
    adata.obsm["spatial"] = np.random.randn(n_obs, 2).astype(np.float32)  # Not an embedding
    adata.obsm["proportions"] = np.random.dirichlet([1]*5, size=n_obs).astype(np.float32)  # Not an embedding

    return adata
