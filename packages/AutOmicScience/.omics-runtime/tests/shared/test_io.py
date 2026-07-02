"""
Tests for I/O module.

Validates load_h5ad, save_h5ad, load_h5mu, save_h5mu, and validate_processed_adata.
"""

import pytest
from pathlib import Path
import tempfile
import shutil
import numpy as np
import pandas as pd
from anndata import AnnData
import mudata as md

from aose_omics_runtime.shared.io import (
    load_h5ad,
    save_h5ad,
    load_h5mu,
    save_h5mu,
    validate_processed_adata,
)
from aose_omics_runtime.shared.conventions import LAYER_COUNTS, OBS_LEIDEN, OBSM_PCA


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    tmpdir = tempfile.mkdtemp()
    yield Path(tmpdir)
    shutil.rmtree(tmpdir)


class TestSaveLoadH5ad:
    """Test save_h5ad and load_h5ad roundtrip."""

    def test_save_and_load_tiny_adata(self, tiny_adata, temp_dir):
        """Should save and load minimal AnnData."""
        output_path = temp_dir / "tiny.h5ad"

        # Save
        save_report = save_h5ad(adata=tiny_adata, path=output_path)

        assert save_report["path"] == str(output_path.resolve())
        assert save_report["n_obs"] == 10
        assert save_report["n_vars"] == 5
        assert save_report["size_bytes"] > 0
        assert output_path.exists()

        # Load
        loaded_adata, load_report = load_h5ad(path=output_path)

        assert load_report["path"] == str(output_path.resolve())
        assert load_report["n_obs"] == 10
        assert load_report["n_vars"] == 5
        assert load_report["backed"] is False
        assert loaded_adata.shape == tiny_adata.shape

    def test_save_and_load_with_layers(self, small_adata, temp_dir):
        """Should preserve layers during save/load."""
        output_path = temp_dir / "small.h5ad"

        # Save
        save_report = save_h5ad(adata=small_adata, path=output_path)
        assert LAYER_COUNTS in save_report["layers"]

        # Load
        loaded_adata, load_report = load_h5ad(path=output_path)
        assert LAYER_COUNTS in load_report["layers"]
        assert LAYER_COUNTS in loaded_adata.layers

        # Verify data integrity
        np.testing.assert_array_equal(
            loaded_adata.layers[LAYER_COUNTS],
            small_adata.layers[LAYER_COUNTS]
        )

    def test_save_creates_parent_directories(self, tiny_adata, temp_dir):
        """Should create parent directories if they don't exist."""
        output_path = temp_dir / "nested" / "subdir" / "test.h5ad"

        save_h5ad(adata=tiny_adata, path=output_path)

        assert output_path.exists()
        assert output_path.parent.exists()

    def test_load_nonexistent_file(self, temp_dir):
        """Should raise FileNotFoundError for missing file."""
        missing_path = temp_dir / "nonexistent.h5ad"

        with pytest.raises(FileNotFoundError) as exc_info:
            load_h5ad(path=missing_path)

        error_msg = str(exc_info.value)
        assert "not found" in error_msg
        assert str(missing_path) in error_msg

    def test_save_none_adata(self, temp_dir):
        """Should raise ValueError when trying to save None."""
        output_path = temp_dir / "test.h5ad"

        with pytest.raises(ValueError) as exc_info:
            save_h5ad(adata=None, path=output_path)

        assert "None" in str(exc_info.value)

    def test_load_with_validation(self, small_adata, temp_dir):
        """Should validate counts layer when requested."""
        output_path = temp_dir / "small.h5ad"
        save_h5ad(adata=small_adata, path=output_path)

        # Should pass validation
        loaded_adata, report = load_h5ad(path=output_path, validate_counts=True)
        assert LAYER_COUNTS in loaded_adata.layers

    def test_load_validation_fails_without_counts(self, tiny_adata, temp_dir):
        """Should raise KeyError when validating file without counts."""
        output_path = temp_dir / "tiny.h5ad"
        save_h5ad(adata=tiny_adata, path=output_path)

        with pytest.raises(KeyError) as exc_info:
            load_h5ad(path=output_path, validate_counts=True)

        assert "counts" in str(exc_info.value)

    def test_save_with_compression(self, small_adata, temp_dir):
        """Should support different compression options."""
        path_gzip = temp_dir / "gzip.h5ad"
        path_lzf = temp_dir / "lzf.h5ad"
        path_none = temp_dir / "none.h5ad"

        report_gzip = save_h5ad(adata=small_adata, path=path_gzip, compression="gzip")
        report_lzf = save_h5ad(adata=small_adata, path=path_lzf, compression="lzf")
        report_none = save_h5ad(adata=small_adata, path=path_none, compression=None)

        # All should succeed
        assert path_gzip.exists()
        assert path_lzf.exists()
        assert path_none.exists()

        # Uncompressed should be larger
        assert report_none["size_bytes"] > report_gzip["size_bytes"]

    def test_backed_mode(self, small_adata, temp_dir):
        """Should support backed mode for lazy loading."""
        output_path = temp_dir / "backed.h5ad"
        save_h5ad(adata=small_adata, path=output_path)

        # Load in backed mode
        loaded_adata, report = load_h5ad(path=output_path, backed="r")

        assert report["backed"] is True
        assert loaded_adata.isbacked


class TestSaveLoadH5mu:
    """Test save_h5mu and load_h5mu for MuData."""

    def test_save_and_load_mudata(self, small_adata, temp_dir):
        """Should save and load MuData with multiple modalities."""
        # Create MuData with two modalities
        rna_data = small_adata.copy()
        atac_data = small_adata[:, :30].copy()  # Different n_vars
        atac_data.layers[LAYER_COUNTS] = np.random.poisson(3, size=atac_data.shape)

        mdata = md.MuData({"rna": rna_data, "atac": atac_data})
        output_path = temp_dir / "multi.h5mu"

        # Save
        save_report = save_h5mu(mdata=mdata, path=output_path)

        assert save_report["n_obs"] == 100
        assert "rna" in save_report["modalities"]
        assert "atac" in save_report["modalities"]
        assert save_report["modalities"]["rna"]["n_vars"] == 50
        assert save_report["modalities"]["atac"]["n_vars"] == 30

        # Load
        loaded_mdata, load_report = load_h5mu(path=output_path)

        assert load_report["n_obs"] == 100
        assert "rna" in load_report["modalities"]
        assert "atac" in load_report["modalities"]
        assert loaded_mdata.n_obs == mdata.n_obs

    def test_load_h5mu_with_validation(self, small_adata, temp_dir):
        """Should validate counts in all modalities."""
        mdata = md.MuData({"rna": small_adata})
        output_path = temp_dir / "validated.h5mu"
        save_h5mu(mdata=mdata, path=output_path)

        # Should pass validation
        loaded_mdata, report = load_h5mu(path=output_path, validate_counts=True)
        assert LAYER_COUNTS in loaded_mdata.mod["rna"].layers

    def test_load_h5mu_validation_fails(self, tiny_adata, temp_dir):
        """Should raise KeyError when modality missing counts."""
        mdata = md.MuData({"bad_mod": tiny_adata})
        output_path = temp_dir / "bad.h5mu"
        save_h5mu(mdata=mdata, path=output_path)

        with pytest.raises(KeyError) as exc_info:
            load_h5mu(path=output_path, validate_counts=True)

        error_msg = str(exc_info.value)
        assert "bad_mod" in error_msg or "counts" in error_msg

    def test_save_none_mudata(self, temp_dir):
        """Should raise ValueError when saving None."""
        output_path = temp_dir / "test.h5mu"

        with pytest.raises(ValueError) as exc_info:
            save_h5mu(mdata=None, path=output_path)

        assert "None" in str(exc_info.value)


class TestValidateProcessedAdata:
    """Test validate_processed_adata validation function."""

    def test_valid_preprocessed_adata(self, preprocessed_adata):
        """Should pass validation for fully preprocessed data."""
        report = validate_processed_adata(
            preprocessed_adata,
            require_counts=True,
            require_embedding=True,
            require_clusters=True,
        )

        assert report["valid"] is True
        assert len(report["errors"]) == 0
        assert report["has_counts"] is True
        assert report["has_embedding"] is True
        assert report["has_clusters"] is True
        assert len(report["embeddings"]) >= 2  # X_pca and X_umap

    def test_missing_counts_layer(self, preprocessed_adata_no_counts):
        """Should detect missing counts layer."""
        report = validate_processed_adata(
            preprocessed_adata_no_counts,
            require_counts=True,
        )

        assert report["valid"] is False
        assert report["has_counts"] is False
        assert any("counts" in err for err in report["errors"])

    def test_missing_embeddings(self, small_adata):
        """Should detect missing embeddings."""
        report = validate_processed_adata(
            small_adata,
            require_embedding=True,
        )

        assert report["valid"] is False
        assert report["has_embedding"] is False
        assert any("embedding" in err.lower() for err in report["errors"])

    def test_missing_clusters(self, small_adata):
        """Should detect missing cluster annotations."""
        report = validate_processed_adata(
            small_adata,
            require_clusters=True,
        )

        assert report["valid"] is False
        assert report["has_clusters"] is False
        assert any("leiden" in err for err in report["errors"])

    def test_optional_validation(self, tiny_adata):
        """Should pass when no requirements specified."""
        report = validate_processed_adata(
            tiny_adata,
            require_counts=False,
            require_embedding=False,
            require_clusters=False,
        )

        assert report["valid"] is True
        assert len(report["errors"]) == 0

    def test_warnings_for_missing_recommended_keys(self, preprocessed_adata_no_counts):
        """Should generate warnings for missing recommended keys."""
        report = validate_processed_adata(
            preprocessed_adata_no_counts,
            require_counts=False,
        )

        # Should have warnings even if valid
        assert len(report["warnings"]) > 0

    def test_multiple_embeddings_detected(self, adata_with_multiple_embeddings):
        """Should detect all X_ embeddings."""
        report = validate_processed_adata(
            adata_with_multiple_embeddings,
            require_embedding=True,
        )

        assert report["valid"] is True
        assert report["has_embedding"] is True
        assert len(report["embeddings"]) == 4  # X_pca, X_pca_harmony, X_umap, X_tsne
        assert "X_pca" in report["embeddings"]
        assert "spatial" not in report["embeddings"]  # Not an X_ embedding
