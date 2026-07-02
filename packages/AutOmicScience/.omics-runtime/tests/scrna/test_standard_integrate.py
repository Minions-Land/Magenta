"""
Tests for standard_integrate frozen helper.
"""

import pytest
import numpy as np
import scanpy as sc
from anndata import AnnData
import sys
import os as _os

from aose_omics_runtime.scrna.standard_integrate import (
    standard_integrate,
    recompute_neighbors_after_integration,
    DEFAULT_MAX_ITER_HARMONY,
    DEFAULT_N_PCS,
)
from aose_omics_runtime.shared.conventions import OBS_BATCH, OBSM_PCA, OBSM_HARMONY


@pytest.fixture
def adata_with_batch():
    """Create test AnnData with batch effects."""
    np.random.seed(42)

    # Create two batches with slight shift
    n_cells_per_batch = 100
    n_genes = 50

    batch1 = np.random.randn(n_cells_per_batch, n_genes)
    batch2 = np.random.randn(n_cells_per_batch, n_genes) + 0.5  # shift

    X = np.vstack([batch1, batch2])
    adata = AnnData(X)
    adata.var_names = [f"Gene_{i}" for i in range(n_genes)]
    adata.obs[OBS_BATCH] = ["batch1"] * n_cells_per_batch + ["batch2"] * n_cells_per_batch

    # Add PCA
    sc.pp.pca(adata, n_comps=10)

    return adata


def test_standard_integrate_harmony_basic(adata_with_batch):
    """Test basic Harmony integration."""
    result, report = standard_integrate(
        adata_with_batch,
        method="harmony",
        n_pcs=10,
    )

    # Check corrected embeddings added
    assert OBSM_HARMONY in result.obsm
    assert result.obsm[OBSM_HARMONY].shape == (200, 10)

    # Check report
    assert report is not None
    assert report["operation"] == "standard_integrate"
    assert report["method"] == "harmony"
    assert report["n_batches"] == 2
    assert report["batch_sizes"]["batch1"] == 100
    assert report["batch_sizes"]["batch2"] == 100


def test_standard_integrate_missing_batch_key(adata_with_batch):
    """Test error when batch key not found."""
    with pytest.raises(KeyError, match="Batch key 'nonexistent' not found"):
        standard_integrate(
            adata_with_batch,
            batch_key="nonexistent",
        )


def test_standard_integrate_missing_pca(adata_with_batch):
    """Test error when PCA not computed."""
    # Remove PCA
    del adata_with_batch.obsm[OBSM_PCA]

    with pytest.raises(KeyError, match="PCA embedding.*not found"):
        standard_integrate(adata_with_batch)


def test_standard_integrate_insufficient_batches():
    """Test error when only one batch present."""
    adata = AnnData(np.random.randn(50, 30))
    adata.obs[OBS_BATCH] = ["batch1"] * 50
    sc.pp.pca(adata, n_comps=10)

    with pytest.raises(ValueError, match="at least 2 batches"):
        standard_integrate(adata)


def test_standard_integrate_no_report(adata_with_batch):
    """Test without report return."""
    result, report = standard_integrate(
        adata_with_batch,
        method="harmony",
        return_report=False,
    )

    assert OBSM_HARMONY in result.obsm
    assert report is None


def test_standard_integrate_custom_parameters(adata_with_batch):
    """Test with custom Harmony parameters."""
    result, report = standard_integrate(
        adata_with_batch,
        method="harmony",
        max_iter_harmony=5,
        sigma=0.2,
        theta=1.5,
        target_key="X_harmony_custom",
    )

    assert "X_harmony_custom" in result.obsm
    assert report["parameters"]["max_iter_harmony"] == 5
    assert report["parameters"]["sigma"] == 0.2
    assert report["parameters"]["theta"] == 1.5


def test_recompute_neighbors_after_integration(adata_with_batch):
    """Test recomputing neighbors on integrated embeddings."""
    # First integrate
    adata_with_batch, _ = standard_integrate(
        adata_with_batch,
        method="harmony",
    )

    # Then recompute neighbors
    result = recompute_neighbors_after_integration(
        adata_with_batch,
        use_rep=OBSM_HARMONY,
        n_neighbors=10,
    )

    # Check neighbors graph exists
    assert "neighbors" in result.uns
    assert "connectivities" in result.obsp
    assert "distances" in result.obsp


def test_recompute_neighbors_missing_embedding(adata_with_batch):
    """Test error when embedding not found."""
    with pytest.raises(KeyError, match="Embedding.*not found"):
        recompute_neighbors_after_integration(
            adata_with_batch,
            use_rep="X_nonexistent",
        )


def test_bbknn_not_implemented(adata_with_batch):
    """Test that BBKNN raises NotImplementedError."""
    with pytest.raises(NotImplementedError, match="BBKNN integration"):
        standard_integrate(
            adata_with_batch,
            method="bbknn",
        )


def test_invalid_method(adata_with_batch):
    """Test error with invalid integration method."""
    with pytest.raises(ValueError, match="Unknown integration method"):
        standard_integrate(
            adata_with_batch,
            method="invalid_method",
        )
