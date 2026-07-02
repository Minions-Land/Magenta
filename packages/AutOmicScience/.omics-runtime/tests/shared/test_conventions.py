"""
Tests for conventions module.

Validates key constants, is_embedding_key(), and validate_counts_layer().
"""

import pytest
from anndata import AnnData
import numpy as np
import pandas as pd

import sys
from pathlib import Path

from aose_omics_runtime.shared.conventions import (
    # Constants
    LAYER_COUNTS,
    LAYER_SPLICED,
    LAYER_UNSPLICED,
    OBS_LEIDEN,
    OBS_CELLTYPE,
    OBS_BATCH,
    OBS_CONDITION,
    OBSM_PCA,
    OBSM_UMAP,
    OBSM_HARMONY,
    OBSM_SPATIAL,
    VAR_HIGHLY_VARIABLE,
    EMBEDDING_PREFIX,
    # Functions
    is_embedding_key,
    validate_counts_layer,
)


class TestConstants:
    """Test that key constants follow expected conventions."""

    def test_layer_keys(self):
        """Layer keys should be simple strings."""
        assert LAYER_COUNTS == "counts"
        assert LAYER_SPLICED == "spliced"
        assert LAYER_UNSPLICED == "unspliced"

    def test_obs_keys(self):
        """Observation metadata keys should be snake_case."""
        assert OBS_LEIDEN == "leiden"
        assert OBS_CELLTYPE == "cell_type"
        assert OBS_BATCH == "batch"
        assert OBS_CONDITION == "condition"

    def test_obsm_keys_have_prefix(self):
        """Embedding keys in obsm should start with X_."""
        assert OBSM_PCA.startswith("X_")
        assert OBSM_UMAP.startswith("X_")
        assert OBSM_HARMONY.startswith("X_")

    def test_spatial_no_prefix(self):
        """Spatial coords should NOT have X_ prefix (not an embedding)."""
        assert not OBSM_SPATIAL.startswith("X_")
        assert OBSM_SPATIAL == "spatial"

    def test_var_keys(self):
        """Variable metadata keys should be snake_case."""
        assert VAR_HIGHLY_VARIABLE == "highly_variable"

    def test_embedding_prefix(self):
        """Embedding prefix constant should be X_."""
        assert EMBEDDING_PREFIX == "X_"


class TestIsEmbeddingKey:
    """Test is_embedding_key() function."""

    def test_valid_embedding_keys(self):
        """Keys starting with X_ should be recognized as embeddings."""
        assert is_embedding_key("X_pca") is True
        assert is_embedding_key("X_umap") is True
        assert is_embedding_key("X_tsne") is True
        assert is_embedding_key("X_pca_harmony") is True
        assert is_embedding_key("X_scVI") is True
        assert is_embedding_key("X_multivi") is True

    def test_invalid_embedding_keys(self):
        """Keys not starting with X_ should not be recognized as embeddings."""
        assert is_embedding_key("spatial") is False
        assert is_embedding_key("proportions") is False
        assert is_embedding_key("pca") is False
        assert is_embedding_key("velocity") is False
        assert is_embedding_key("distances") is False

    def test_edge_cases(self):
        """Test edge cases."""
        assert is_embedding_key("X_") is True  # Technically matches prefix
        assert is_embedding_key("x_pca") is False  # Case sensitive
        assert is_embedding_key("_X_pca") is False  # Wrong position
        assert is_embedding_key("") is False  # Empty string


class TestValidateCountsLayer:
    """Test validate_counts_layer() function."""

    def test_valid_counts_layer(self, small_adata):
        """Should pass when layers["counts"] exists."""
        # Should not raise
        validate_counts_layer(small_adata)
        validate_counts_layer(small_adata, layer_key=LAYER_COUNTS)

    def test_missing_counts_layer(self, tiny_adata):
        """Should raise KeyError when layers["counts"] missing."""
        # tiny_adata has no layers
        with pytest.raises(KeyError) as exc_info:
            validate_counts_layer(tiny_adata)

        error_msg = str(exc_info.value)
        assert "counts" in error_msg
        assert "not found" in error_msg
        assert "Available layers" in error_msg

    def test_custom_layer_key(self):
        """Should validate custom layer key."""
        adata = AnnData(
            X=np.random.randn(10, 5),
            obs=pd.DataFrame(index=[f"c{i}" for i in range(10)]),
            var=pd.DataFrame(index=[f"g{i}" for i in range(5)]),
        )
        adata.layers["spliced"] = np.random.randn(10, 5)

        # Should pass for existing layer
        validate_counts_layer(adata, layer_key="spliced")

        # Should fail for missing layer
        with pytest.raises(KeyError) as exc_info:
            validate_counts_layer(adata, layer_key="unspliced")

        assert "unspliced" in str(exc_info.value)

    def test_error_message_lists_available_layers(self):
        """Error message should list available layers to help debugging."""
        adata = AnnData(
            X=np.random.randn(10, 5),
            obs=pd.DataFrame(index=[f"c{i}" for i in range(10)]),
            var=pd.DataFrame(index=[f"g{i}" for i in range(5)]),
        )
        adata.layers["raw"] = np.random.randn(10, 5)
        adata.layers["normalized"] = np.random.randn(10, 5)

        with pytest.raises(KeyError) as exc_info:
            validate_counts_layer(adata)

        error_msg = str(exc_info.value)
        assert "raw" in error_msg or "normalized" in error_msg
        assert "Available layers" in error_msg

    def test_empty_layers(self):
        """Should handle AnnData with empty layers dict."""
        adata = AnnData(
            X=np.random.randn(10, 5),
            obs=pd.DataFrame(index=[f"c{i}" for i in range(10)]),
            var=pd.DataFrame(index=[f"g{i}" for i in range(5)]),
        )

        with pytest.raises(KeyError) as exc_info:
            validate_counts_layer(adata)

        # Should indicate no layers available
        error_msg = str(exc_info.value)
        assert "counts" in error_msg
        assert "not found" in error_msg


class TestIntegration:
    """Integration tests using fixtures."""

    def test_small_adata_conventions(self, small_adata):
        """small_adata fixture should follow conventions."""
        # Has counts layer
        assert LAYER_COUNTS in small_adata.layers
        validate_counts_layer(small_adata)

        # Has expected obs columns
        assert OBS_CELLTYPE in small_adata.obs.columns
        assert OBS_BATCH in small_adata.obs.columns

    def test_preprocessed_adata_conventions(self, preprocessed_adata):
        """preprocessed_adata fixture should follow conventions."""
        # Has counts layer
        assert LAYER_COUNTS in preprocessed_adata.layers
        validate_counts_layer(preprocessed_adata)

        # Has embeddings with proper prefix
        assert OBSM_PCA in preprocessed_adata.obsm
        assert OBSM_UMAP in preprocessed_adata.obsm
        assert is_embedding_key(OBSM_PCA)
        assert is_embedding_key(OBSM_UMAP)

        # Has clusters
        assert OBS_LEIDEN in preprocessed_adata.obs.columns

    def test_embedding_detection_in_fixture(self, adata_with_multiple_embeddings):
        """Should correctly identify all embeddings in fixture."""
        embeddings = [k for k in adata_with_multiple_embeddings.obsm.keys() if is_embedding_key(k)]

        # Should find 4 embeddings (X_pca, X_pca_harmony, X_umap, X_tsne)
        assert len(embeddings) == 4
        assert "X_pca" in embeddings
        assert "X_pca_harmony" in embeddings
        assert "X_umap" in embeddings
        assert "X_tsne" in embeddings

        # Should NOT include non-embedding keys
        assert "spatial" not in embeddings
        assert "proportions" not in embeddings
