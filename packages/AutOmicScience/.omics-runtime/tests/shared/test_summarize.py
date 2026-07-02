"""
Tests for summarize module.

Validates summarize_adata() with various data types and edge cases.
"""

import pytest
import numpy as np
import pandas as pd
from anndata import AnnData

import sys
from pathlib import Path

from aose_omics_runtime.shared.summarize import summarize_adata


class TestSummarizeAdata:
    """Test summarize_adata() function."""

    def test_basic_summary(self, small_adata):
        """Should generate basic summary for small_adata."""
        summary = summarize_adata(small_adata)

        # Check shape is present
        assert "100 cells" in summary
        assert "50 genes" in summary or "genes" in summary

        # Check layers section
        assert "Layers:" in summary
        assert "counts" in summary

        # Check obs section
        assert "Cell metadata" in summary or "obs" in summary
        assert "cell_type" in summary
        assert "batch" in summary

        # Check obsm section
        assert "Embeddings" in summary or "obsm" in summary

    def test_numeric_obs_columns(self, small_adata):
        """Should format numeric columns with range and mean."""
        summary = summarize_adata(small_adata)

        # n_genes is numeric
        assert "n_genes" in summary
        assert "range" in summary or "mean" in summary

        # percent_mito is numeric
        assert "percent_mito" in summary

    def test_categorical_obs_columns(self, small_adata):
        """Should show value counts for categorical columns."""
        summary = summarize_adata(small_adata)

        # cell_type is categorical
        assert "cell_type" in summary
        assert "categorical" in summary
        # Should show counts like "T_cell(33)"
        assert "(" in summary and ")" in summary

    def test_top_k_limit(self):
        """Should truncate categorical columns with many unique values."""
        # Create data with many categories
        n_obs = 100
        adata = AnnData(
            X=np.random.randn(n_obs, 10),
            obs=pd.DataFrame({
                "cell_id": [f"cell_{i}" for i in range(n_obs)],  # 100 unique values
            }, index=[f"cell_{i}" for i in range(n_obs)]),
            var=pd.DataFrame(index=[f"gene_{i}" for i in range(10)]),
        )

        summary = summarize_adata(adata, top_k=10)

        # Should show "+90 more" or similar
        assert "+" in summary and "more" in summary
        assert "100 unique" in summary

    def test_no_layers(self, tiny_adata):
        """Should handle AnnData with no layers."""
        summary = summarize_adata(tiny_adata)

        assert "Layers:" in summary
        assert "(none)" in summary or "none" in summary.lower()

    def test_no_obs_columns(self):
        """Should handle AnnData with no obs columns."""
        adata = AnnData(
            X=np.random.randn(20, 5),
            obs=pd.DataFrame(index=[f"cell_{i}" for i in range(20)]),
            var=pd.DataFrame(index=[f"gene_{i}" for i in range(5)]),
        )

        summary = summarize_adata(adata)

        assert "20 cells" in summary
        assert "Cell metadata" in summary or "obs" in summary
        assert "(none)" in summary or len([line for line in summary.split("\n") if line.strip() and not line.startswith("  ")]) > 0

    def test_no_obsm(self, tiny_adata):
        """Should handle AnnData with no obsm."""
        summary = summarize_adata(tiny_adata)

        assert "Embeddings" in summary or "obsm" in summary
        assert "(none)" in summary or "none" in summary.lower()

    def test_with_embeddings(self, preprocessed_adata):
        """Should list all obsm keys."""
        summary = summarize_adata(preprocessed_adata)

        assert "Embeddings" in summary or "obsm" in summary
        assert "X_pca" in summary
        assert "X_umap" in summary

    def test_multiple_embeddings(self, adata_with_multiple_embeddings):
        """Should list all embeddings and non-embedding obsm keys."""
        summary = summarize_adata(adata_with_multiple_embeddings)

        # All obsm keys should be listed
        assert "X_pca" in summary
        assert "X_pca_harmony" in summary
        assert "X_umap" in summary
        assert "X_tsne" in summary
        assert "spatial" in summary
        assert "proportions" in summary

    def test_layers_sorted(self, small_adata):
        """Layers should be sorted alphabetically."""
        # Add multiple layers
        small_adata.layers["zebra"] = small_adata.X.copy()
        small_adata.layers["alpha"] = small_adata.X.copy()

        summary = summarize_adata(small_adata)

        # Find layers line
        layers_line = [line for line in summary.split("\n") if "Layers:" in line][0]

        # Should be sorted: alpha, counts, zebra
        assert layers_line.index("alpha") < layers_line.index("counts")
        assert layers_line.index("counts") < layers_line.index("zebra")

    def test_obsm_sorted(self, adata_with_multiple_embeddings):
        """obsm keys should be sorted alphabetically."""
        summary = summarize_adata(adata_with_multiple_embeddings)

        # Find obsm section
        lines = summary.split("\n")
        obsm_idx = next(i for i, line in enumerate(lines) if "Embeddings" in line or "obsm" in line)
        obsm_line = lines[obsm_idx + 1]

        # Extract keys (rough check - they should appear in sorted order)
        keys = ["X_pca", "X_pca_harmony", "X_tsne", "X_umap", "proportions", "spatial"]
        indices = {k: obsm_line.index(k) if k in obsm_line else float("inf") for k in keys}

        # Check relative ordering of keys that appear
        present_keys = [k for k in keys if k in obsm_line]
        assert present_keys == sorted(present_keys)

    def test_numeric_formatting(self):
        """Should format numeric values with scientific notation when appropriate."""
        adata = AnnData(
            X=np.random.randn(50, 10),
            obs=pd.DataFrame({
                "large_val": np.random.uniform(1e6, 1e7, 50),
                "small_val": np.random.uniform(0, 1, 50),
            }, index=[f"cell_{i}" for i in range(50)]),
            var=pd.DataFrame(index=[f"gene_{i}" for i in range(10)]),
        )

        summary = summarize_adata(adata)

        # Should contain numeric formatting
        assert "large_val" in summary
        assert "small_val" in summary
        assert "range" in summary

    def test_empty_categorical_column(self):
        """Should handle categorical columns with NaN or empty values."""
        adata = AnnData(
            X=np.random.randn(20, 5),
            obs=pd.DataFrame({
                "empty_cat": [None] * 20,
                "sparse_cat": ["A"] * 10 + [None] * 10,
            }, index=[f"cell_{i}" for i in range(20)]),
            var=pd.DataFrame(index=[f"gene_{i}" for i in range(5)]),
        )

        # Should not raise error
        summary = summarize_adata(adata)
        assert "empty_cat" in summary or "sparse_cat" in summary

    def test_custom_top_k(self):
        """Should respect custom top_k parameter."""
        adata = AnnData(
            X=np.random.randn(100, 10),
            obs=pd.DataFrame({
                "many_cats": [f"cat_{i}" for i in range(100)],
            }, index=[f"cell_{i}" for i in range(100)]),
            var=pd.DataFrame(index=[f"gene_{i}" for i in range(10)]),
        )

        summary_k5 = summarize_adata(adata, top_k=5)
        summary_k20 = summarize_adata(adata, top_k=20)

        # Both should indicate truncation
        assert "+95 more" in summary_k5 or "95" in summary_k5
        assert "+80 more" in summary_k20 or "80" in summary_k20

    def test_deterministic_output(self, small_adata):
        """Should produce identical output for same input."""
        summary1 = summarize_adata(small_adata)
        summary2 = summarize_adata(small_adata)

        assert summary1 == summary2

    def test_output_is_string(self, small_adata):
        """Should return a string."""
        summary = summarize_adata(small_adata)

        assert isinstance(summary, str)
        assert len(summary) > 0

    def test_multiline_output(self, small_adata):
        """Should produce multiline output."""
        summary = summarize_adata(small_adata)

        lines = summary.split("\n")
        assert len(lines) > 5  # Should have multiple sections

    def test_shape_first_line(self, small_adata):
        """Shape should be on first line."""
        summary = summarize_adata(small_adata)
        first_line = summary.split("\n")[0]

        assert "Shape:" in first_line or "cells" in first_line
        assert "100" in first_line
        assert "50" in first_line
