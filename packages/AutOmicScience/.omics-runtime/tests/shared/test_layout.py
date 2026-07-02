"""
Tests for layout.py layout validator.

Validates that assert_layout and describe_layout work correctly
on synthetic AnnData objects with various key presence patterns.
"""

import pytest
import numpy as np
from pathlib import Path
import sys


from aose_omics_runtime.shared import conventions
from aose_omics_runtime.shared import layout


def test_describe_layout_minimal_adata(tiny_adata):
    """describe_layout should return layout info without raising."""
    report = layout.describe_layout(tiny_adata)

    assert report["n_obs"] == 10
    assert report["n_vars"] == 5
    assert "layers" in report
    assert "obsm" in report
    assert "obs_cols" in report
    assert "recognized_embeddings" in report


def test_describe_layout_with_embeddings(tiny_adata):
    """describe_layout should identify X_* embeddings."""
    # Add some embeddings
    tiny_adata.obsm["X_pca"] = np.random.randn(10, 10)
    tiny_adata.obsm["X_umap"] = np.random.randn(10, 2)
    tiny_adata.obsm["not_an_embedding"] = np.random.randn(10, 5)

    report = layout.describe_layout(tiny_adata)

    assert "X_pca" in report["obsm"]
    assert "X_umap" in report["obsm"]
    assert "not_an_embedding" in report["obsm"]
    assert "X_pca" in report["recognized_embeddings"]
    assert "X_umap" in report["recognized_embeddings"]
    assert "not_an_embedding" not in report["recognized_embeddings"]


def test_assert_layout_no_expectations_passes(tiny_adata):
    """assert_layout with no expectations should always pass."""
    report = layout.assert_layout(tiny_adata)

    assert report["n_obs"] == 10
    assert report["n_vars"] == 5
    assert report["all_checks_passed"] is True
    assert report["checked"]["layers"] == []
    assert report["checked"]["obsm"] == []
    assert report["checked"]["obs"] == []


def test_assert_layout_counts_layer_present(tiny_adata):
    """assert_layout should pass when expected layer is present."""
    # Add counts layer
    tiny_adata.layers[conventions.LAYER_COUNTS] = tiny_adata.X.copy()

    report = layout.assert_layout(
        tiny_adata,
        expect_layers=[conventions.LAYER_COUNTS]
    )

    assert report["all_checks_passed"] is True
    assert conventions.LAYER_COUNTS in report["layers"]
    assert report["checked"]["layers"] == [conventions.LAYER_COUNTS]


def test_assert_layout_counts_layer_missing_raises(tiny_adata):
    """assert_layout should raise KeyError when expected layer is missing."""
    # Don't add counts layer

    with pytest.raises(KeyError) as exc_info:
        layout.assert_layout(
            tiny_adata,
            expect_layers=[conventions.LAYER_COUNTS]
        )

    error_msg = str(exc_info.value)
    assert conventions.LAYER_COUNTS in error_msg
    assert "Available layers" in error_msg


def test_assert_layout_embedding_present(tiny_adata):
    """assert_layout should pass when expected obsm key is present."""
    # Add PCA embedding
    tiny_adata.obsm[conventions.OBSM_PCA] = np.random.randn(10, 20)

    report = layout.assert_layout(
        tiny_adata,
        expect_obsm=[conventions.OBSM_PCA]
    )

    assert report["all_checks_passed"] is True
    assert conventions.OBSM_PCA in report["obsm"]
    assert report["checked"]["obsm"] == [conventions.OBSM_PCA]


def test_assert_layout_embedding_missing_raises(tiny_adata):
    """assert_layout should raise KeyError when expected obsm key is missing."""
    # Don't add embedding

    with pytest.raises(KeyError) as exc_info:
        layout.assert_layout(
            tiny_adata,
            expect_obsm=[conventions.OBSM_UMAP]
        )

    error_msg = str(exc_info.value)
    assert conventions.OBSM_UMAP in error_msg
    assert "Available obsm keys" in error_msg
    assert conventions.EMBEDDING_PREFIX in error_msg


def test_assert_layout_obs_column_present(tiny_adata):
    """assert_layout should pass when expected obs column is present."""
    # Add leiden clustering result
    tiny_adata.obs[conventions.OBS_LEIDEN] = ["0"] * 5 + ["1"] * 5

    report = layout.assert_layout(
        tiny_adata,
        expect_obs=[conventions.OBS_LEIDEN]
    )

    assert report["all_checks_passed"] is True
    assert conventions.OBS_LEIDEN in report["obs_cols"]
    assert report["checked"]["obs"] == [conventions.OBS_LEIDEN]


def test_assert_layout_obs_column_missing_raises(tiny_adata):
    """assert_layout should raise KeyError when expected obs column is missing."""
    # Don't add cell type column

    with pytest.raises(KeyError) as exc_info:
        layout.assert_layout(
            tiny_adata,
            expect_obs=[conventions.OBS_CELLTYPE]
        )

    error_msg = str(exc_info.value)
    assert conventions.OBS_CELLTYPE in error_msg
    assert "Available obs columns" in error_msg


def test_assert_layout_multiple_expectations(tiny_adata):
    """assert_layout should check multiple expectations at once."""
    # Add all expected keys
    tiny_adata.layers[conventions.LAYER_COUNTS] = tiny_adata.X.copy()
    tiny_adata.obsm[conventions.OBSM_PCA] = np.random.randn(10, 20)
    tiny_adata.obsm[conventions.OBSM_UMAP] = np.random.randn(10, 2)
    tiny_adata.obs[conventions.OBS_LEIDEN] = ["0"] * 5 + ["1"] * 5
    tiny_adata.obs[conventions.OBS_CELLTYPE] = ["T cell"] * 10

    report = layout.assert_layout(
        tiny_adata,
        expect_layers=[conventions.LAYER_COUNTS],
        expect_obsm=[conventions.OBSM_PCA, conventions.OBSM_UMAP],
        expect_obs=[conventions.OBS_LEIDEN, conventions.OBS_CELLTYPE]
    )

    assert report["all_checks_passed"] is True
    assert conventions.LAYER_COUNTS in report["layers"]
    assert conventions.OBSM_PCA in report["obsm"]
    assert conventions.OBSM_UMAP in report["obsm"]
    assert conventions.OBS_LEIDEN in report["obs_cols"]
    assert conventions.OBS_CELLTYPE in report["obs_cols"]


def test_assert_layout_partial_failure(tiny_adata):
    """assert_layout should fail on first missing key."""
    # Add some but not all expected keys
    tiny_adata.layers[conventions.LAYER_COUNTS] = tiny_adata.X.copy()
    tiny_adata.obsm[conventions.OBSM_PCA] = np.random.randn(10, 20)
    # Missing OBSM_UMAP

    with pytest.raises(KeyError) as exc_info:
        layout.assert_layout(
            tiny_adata,
            expect_layers=[conventions.LAYER_COUNTS],
            expect_obsm=[conventions.OBSM_PCA, conventions.OBSM_UMAP]
        )

    error_msg = str(exc_info.value)
    assert conventions.OBSM_UMAP in error_msg


def test_imports_from_conventions_not_redeclared():
    """Verify that io_keys imports from conventions.py, doesn't redeclare."""
    # Check that io_keys uses the same constants as conventions
    assert layout.LAYER_COUNTS == conventions.LAYER_COUNTS
    assert layout.OBS_LEIDEN == conventions.OBS_LEIDEN
    assert layout.OBSM_PCA == conventions.OBSM_PCA
    assert layout.is_embedding_key == conventions.is_embedding_key

    # Verify the module imports are the same objects (identity check)
    assert layout.LAYER_COUNTS is conventions.LAYER_COUNTS
