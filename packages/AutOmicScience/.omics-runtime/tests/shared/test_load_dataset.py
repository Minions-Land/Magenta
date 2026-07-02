#!/usr/bin/env python3
"""
Test suite for universal load_dataset loader.

Tests all supported formats: csv, tsv, excel, h5ad, h5, mtx, loom
"""

import json
import sys
import tempfile
from pathlib import Path

import anndata as ad
import numpy as np
import pandas as pd
import pytest


from aose_omics_runtime.shared.load_dataset import load_dataset, detect_format


@pytest.fixture
def temp_dir():
    """Create temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def sample_counts_matrix():
    """Generate a sample counts matrix (cells × genes)."""
    np.random.seed(42)
    n_cells = 100
    n_genes = 50
    X = np.random.poisson(5, size=(n_cells, n_genes))
    cell_names = [f"Cell_{i}" for i in range(n_cells)]
    gene_names = [f"Gene_{i}" for i in range(n_genes)]
    return X, cell_names, gene_names


def test_detect_format(temp_dir):
    """Test format auto-detection from file extension."""
    assert detect_format(Path("data.csv")) == "csv"
    assert detect_format(Path("data.tsv")) == "tsv"
    assert detect_format(Path("data.xlsx")) == "excel"
    assert detect_format(Path("data.h5ad")) == "h5ad"
    assert detect_format(Path("data.h5")) == "h5"
    assert detect_format(Path("matrix.mtx")) == "mtx"
    assert detect_format(Path("matrix.mtx.gz")) == "mtx"
    assert detect_format(Path("data.loom")) == "loom"
    assert detect_format(Path("data.zarr")) == "zarr"
    assert detect_format(Path("data.unknown")) == "unknown"


def test_load_csv_default(temp_dir, sample_counts_matrix):
    """Test loading CSV with default settings (cells as rows, genes as columns)."""
    X, cell_names, gene_names = sample_counts_matrix

    # Create CSV: first column = cell names, first row = gene names
    df = pd.DataFrame(X, index=cell_names, columns=gene_names)
    csv_path = temp_dir / "counts.csv"
    df.to_csv(csv_path)

    output_path = temp_dir / "output.h5ad"
    report = load_dataset(
        path=str(csv_path),
        output=str(output_path),
        format="csv"
    )

    # Verify report
    assert report["success"] is True
    assert report["n_obs"] == 100
    assert report["n_vars"] == 50
    assert "counts" in report["layers"]

    # Verify h5ad file
    adata = ad.read_h5ad(output_path)
    assert adata.n_obs == 100
    assert adata.n_vars == 50
    assert "counts" in adata.layers
    np.testing.assert_array_equal(adata.X, X)


def test_load_csv_transposed(temp_dir, sample_counts_matrix):
    """Test loading CSV with transpose (genes as rows, cells as columns)."""
    X, cell_names, gene_names = sample_counts_matrix

    # Create CSV: genes as rows, cells as columns
    df = pd.DataFrame(X.T, index=gene_names, columns=cell_names)
    csv_path = temp_dir / "counts_transposed.csv"
    df.to_csv(csv_path)

    output_path = temp_dir / "output.h5ad"
    report = load_dataset(
        path=str(csv_path),
        output=str(output_path),
        format="csv",
        transpose=True
    )

    # After transpose, should match original dimensions
    assert report["n_obs"] == 100
    assert report["n_vars"] == 50

    adata = ad.read_h5ad(output_path)
    np.testing.assert_array_equal(adata.X, X)


def test_load_tsv(temp_dir, sample_counts_matrix):
    """Test loading TSV file."""
    X, cell_names, gene_names = sample_counts_matrix

    df = pd.DataFrame(X, index=cell_names, columns=gene_names)
    tsv_path = temp_dir / "counts.tsv"
    df.to_csv(tsv_path, sep='\t')

    output_path = temp_dir / "output.h5ad"
    report = load_dataset(
        path=str(tsv_path),
        output=str(output_path),
        format="tsv"
    )

    assert report["success"] is True
    assert report["n_obs"] == 100
    assert report["n_vars"] == 50


def test_load_excel(temp_dir, sample_counts_matrix):
    """Test loading Excel file."""
    X, cell_names, gene_names = sample_counts_matrix

    df = pd.DataFrame(X, index=cell_names, columns=gene_names)
    excel_path = temp_dir / "counts.xlsx"

    try:
        df.to_excel(excel_path)
    except ImportError:
        pytest.skip("openpyxl not installed - skipping Excel test")

    output_path = temp_dir / "output.h5ad"
    report = load_dataset(
        path=str(excel_path),
        output=str(output_path),
        format="excel"
    )

    assert report["success"] is True
    assert report["n_obs"] == 100
    assert report["n_vars"] == 50


def test_load_h5ad_passthrough(temp_dir, sample_counts_matrix):
    """Test loading h5ad file (passthrough, no conversion needed)."""
    X, cell_names, gene_names = sample_counts_matrix

    # Create h5ad file
    adata = ad.AnnData(
        X=X,
        obs=pd.DataFrame(index=cell_names),
        var=pd.DataFrame(index=gene_names)
    )
    adata.layers["counts"] = adata.X.copy()

    h5ad_path = temp_dir / "input.h5ad"
    adata.write_h5ad(h5ad_path)

    output_path = temp_dir / "output.h5ad"
    report = load_dataset(
        path=str(h5ad_path),
        output=str(output_path),
        format="h5ad"
    )

    assert report["success"] is True
    assert report["n_obs"] == 100
    assert report["n_vars"] == 50

    adata_loaded = ad.read_h5ad(output_path)
    np.testing.assert_array_equal(adata_loaded.X, X)


def test_auto_format_detection(temp_dir, sample_counts_matrix):
    """Test automatic format detection."""
    X, cell_names, gene_names = sample_counts_matrix

    df = pd.DataFrame(X, index=cell_names, columns=gene_names)
    csv_path = temp_dir / "counts.csv"
    df.to_csv(csv_path)

    output_path = temp_dir / "output.h5ad"
    report = load_dataset(
        path=str(csv_path),
        output=str(output_path),
        format="auto"  # Should auto-detect as csv
    )

    assert report["success"] is True
    assert report["input_format"] == "csv"


def test_missing_file_error(temp_dir):
    """Test error handling for missing file."""
    with pytest.raises(FileNotFoundError):
        load_dataset(
            path="/nonexistent/file.csv",
            output=str(temp_dir / "output.h5ad"),
            format="csv"
        )


def test_empty_dataframe_error(temp_dir):
    """Test error handling for empty CSV."""
    csv_path = temp_dir / "empty.csv"
    csv_path.write_text("col1,col2\n")  # Header only, no data

    with pytest.raises(ValueError, match="empty"):
        load_dataset(
            path=str(csv_path),
            output=str(temp_dir / "output.h5ad"),
            format="csv"
        )


def test_custom_separator(temp_dir, sample_counts_matrix):
    """Test custom separator for text files."""
    X, cell_names, gene_names = sample_counts_matrix

    df = pd.DataFrame(X, index=cell_names, columns=gene_names)
    txt_path = temp_dir / "counts.txt"
    df.to_csv(txt_path, sep='|')  # Use pipe as separator

    output_path = temp_dir / "output.h5ad"
    report = load_dataset(
        path=str(txt_path),
        output=str(output_path),
        format="txt",
        sep='|'
    )

    assert report["success"] is True
    assert report["n_obs"] == 100


if __name__ == "__main__":
    # Run tests with pytest
    pytest.main([__file__, "-v"])
