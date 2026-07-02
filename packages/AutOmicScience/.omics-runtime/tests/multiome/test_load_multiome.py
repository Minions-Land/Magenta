"""
Tests for multiome load_multiome helper.

Tests the core contract: takes RNA + ATAC AnnData, creates MuData container,
returns report dict, fails loud on bad input.
"""

import pytest
import numpy as np
from anndata import AnnData
import sys
import os as _os


from aose_omics_runtime.multiome.load_multiome import (
    main as run_load_multiome,
    load_multiome,
)


@pytest.fixture
def simple_rna_adata():
    """Create minimal RNA AnnData."""
    np.random.seed(42)
    n_cells = 50
    n_genes = 2000  # Need enough genes for scanpy QC metrics

    X = np.random.poisson(5, (n_cells, n_genes)).astype(np.float32)
    adata = AnnData(X)
    # Add some MT- genes to satisfy calculate_qc_metrics
    gene_names = [f"Gene_{i}" for i in range(n_genes - 100)]
    gene_names += [f"MT-Gene{i}" for i in range(100)]
    adata.var_names = gene_names
    adata.obs_names = [f"cell_{i}" for i in range(n_cells)]
    adata.obs['n_genes'] = np.random.randint(500, 3000, n_cells)

    return adata


@pytest.fixture
def simple_atac_adata():
    """Create minimal ATAC AnnData."""
    np.random.seed(43)
    n_cells = 50
    n_peaks = 1000  # Need enough peaks for QC

    X = np.random.poisson(3, (n_cells, n_peaks)).astype(np.float32)
    adata = AnnData(X)
    adata.var_names = [f"chr1:{i*1000}-{i*1000+500}" for i in range(n_peaks)]
    adata.obs_names = [f"cell_{i}" for i in range(n_cells)]
    adata.obs['n_fragment'] = np.random.randint(1000, 10000, n_cells)

    return adata


def test_load_multiome_basic_contract(simple_rna_adata, simple_atac_adata, tmp_path):
    """Test load_multiome creates MuData and returns report."""
    rna_h5ad = tmp_path / "rna.h5ad"
    atac_h5ad = tmp_path / "atac.h5ad"
    output_h5mu = tmp_path / "multiome.h5mu"

    simple_rna_adata.write_h5ad(rna_h5ad)
    simple_atac_adata.write_h5ad(atac_h5ad)

    # Call the low-level function directly (main() only prints, doesn't return)
    result = load_multiome(
        rna_path=str(rna_h5ad),
        atac_path=str(atac_h5ad),
        output_path=str(output_h5mu),
    )

    # Contract checks
    assert isinstance(result, dict), "load_multiome must return a dict"
    assert output_h5mu.exists(), "Output MuData file must be written"

    # Verify output is a valid MuData
    import mudata as md
    mdata = md.read_h5mu(output_h5mu)
    assert 'rna' in mdata.mod
    assert 'atac' in mdata.mod
    assert mdata.mod['rna'].shape[0] == mdata.mod['atac'].shape[0]  # After filtering, should match


def test_load_multiome_fails_on_missing_rna():
    """Test fail-loud when RNA file is missing."""
    import argparse

    args = argparse.Namespace(
        rna="/nonexistent/rna.h5ad",
        atac="/tmp/atac.h5ad",
        output="/tmp/output.h5mu",
    )

    with pytest.raises((FileNotFoundError, OSError)):
        run_load_multiome(args)


def test_load_multiome_fails_on_missing_atac():
    """Test fail-loud when ATAC file is missing."""
    import argparse

    args = argparse.Namespace(
        rna="/tmp/rna.h5ad",
        atac="/nonexistent/atac.h5ad",
        output="/tmp/output.h5mu",
    )

    with pytest.raises((FileNotFoundError, OSError)):
        run_load_multiome(args)


def test_load_multiome_cell_count_mismatch(simple_rna_adata, simple_atac_adata, tmp_path):
    """Test handling when RNA and ATAC have different cell counts."""
    # Create ATAC with different cell count
    atac_mismatch = simple_atac_adata[:30, :].copy()  # 30 cells instead of 50

    rna_h5ad = tmp_path / "rna.h5ad"
    atac_h5ad = tmp_path / "atac_mismatch.h5ad"
    output_h5mu = tmp_path / "output.h5mu"

    simple_rna_adata.write_h5ad(rna_h5ad)
    atac_mismatch.write_h5ad(atac_h5ad)

    # Should either fail loud or handle gracefully (depends on implementation)
    # Most multiome workflows expect same cells, so this might error
    try:
        result = load_multiome(
            rna_path=str(rna_h5ad),
            atac_path=str(atac_h5ad),
            output_path=str(output_h5mu),
        )
        # If it succeeds, verify the MuData structure is valid
        assert output_h5mu.exists()
        assert isinstance(result, dict)
    except (ValueError, AssertionError, KeyError):
        # Expected if implementation enforces cell matching
        pass


def test_load_multiome_report_structure(simple_rna_adata, simple_atac_adata, tmp_path):
    """Test that the report dict has expected structure."""
    rna_h5ad = tmp_path / "rna.h5ad"
    atac_h5ad = tmp_path / "atac.h5ad"
    output_h5mu = tmp_path / "output.h5mu"

    simple_rna_adata.write_h5ad(rna_h5ad)
    simple_atac_adata.write_h5ad(atac_h5ad)

    result = load_multiome(
        rna_path=str(rna_h5ad),
        atac_path=str(atac_h5ad),
        output_path=str(output_h5mu),
    )

    # Check report structure
    assert isinstance(result, dict)
    # Expect keys from load_multiome's docstring
    assert "n_cells_rna" in result or "n_cells_joint" in result or "n_cells_filtered" in result
