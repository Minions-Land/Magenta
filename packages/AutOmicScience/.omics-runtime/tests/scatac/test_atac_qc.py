"""
Tests for scATAC atac_qc helper.

Tests the core contract: takes AnnData, populates QC metrics in .obs,
returns a report dict, fails loud on bad input.
"""

import pytest
import numpy as np
import pandas as pd
from anndata import AnnData
import sys
import os as _os


from aose_omics_runtime.scatac.atac_qc import (
    run_atac_qc,
    compute_tss_enrichment,
    compute_fragment_size_distribution,
    count_fragments_per_cell,
    compute_frip,
)


@pytest.fixture
def simple_adata():
    """Create minimal AnnData for contract testing (no real fragments)."""
    np.random.seed(42)
    n_cells = 50
    n_peaks = 100

    # Sparse peak matrix (simulates ATAC counts)
    X = np.random.poisson(2, (n_cells, n_peaks)).astype(np.float32)
    adata = AnnData(X)
    adata.var_names = [f"peak_{i}" for i in range(n_peaks)]
    adata.obs_names = [f"cell_{i}" for i in range(n_cells)]

    # Pre-populate some QC metrics (simulating what a real pipeline would compute)
    adata.obs['tsse'] = np.random.uniform(3, 15, n_cells)
    adata.obs['n_fragment'] = np.random.randint(1000, 50000, n_cells)
    adata.obs['frac_dup'] = np.random.uniform(0.1, 0.4, n_cells)
    adata.obs['frac_mito'] = np.random.uniform(0.01, 0.1, n_cells)

    return adata


def test_atac_qc_run_basic_contract(simple_adata, tmp_path):
    """Test run_atac_qc honors the basic contract: modifies .obs, returns report."""
    import argparse

    # Write input to disk (run_atac_qc expects file paths)
    input_h5ad = tmp_path / "input.h5ad"
    output_h5ad = tmp_path / "output.h5ad"
    simple_adata.write_h5ad(input_h5ad)

    args = argparse.Namespace(
        adata=str(input_h5ad),
        output=str(output_h5ad),
        compute_tsse=False,  # skip (needs fragment file)
        compute_fragment_size=False,
        compute_frip=False,
        fragment_file=None,
        tss_bed=None,
        tss_window=2000,
        filter=False,
        min_fragments=1000,
        max_fragments=100000,
        min_tsse=5.0,
        max_nucleosome_signal=2.0,
        min_frip=0.15,
    )

    result = run_atac_qc(args)

    # Contract checks
    assert isinstance(result, dict), "run_atac_qc must return a dict"
    # The actual return structure uses 'evidence' + cell counts
    assert "evidence" in result or "n_cells_after" in result
    assert output_h5ad.exists(), "Output file must be written"

    # Verify output AnnData has expected QC columns
    import anndata as ad
    adata_out = ad.read_h5ad(output_h5ad)
    assert 'n_fragment' in adata_out.obs.columns or 'total_counts' in adata_out.obs.columns


def test_count_fragments_per_cell_fails_loud_on_missing_file(simple_adata, tmp_path):
    """count_fragments_per_cell fails loud on a missing fragment file (no inference/fabrication)."""
    simple_adata.obs['total_counts'] = simple_adata.obs['n_fragment'].copy()
    del simple_adata.obs['n_fragment']

    fragment_file = tmp_path / "nonexistent.tsv.gz"

    # Fail-loud: a missing fragment file must raise, not silently infer from total_counts.
    with pytest.raises((RuntimeError, FileNotFoundError, OSError)):
        count_fragments_per_cell(simple_adata, str(fragment_file))


def test_atac_qc_fails_on_missing_input():
    """Test fail-loud on missing input file."""
    import argparse

    args = argparse.Namespace(
        adata="/nonexistent/path.h5ad",
        output="/tmp/output.h5ad",
        compute_tsse=False,
        compute_fragment_size=False,
        compute_frip=False,
        fragment_file=None,
        tss_bed=None,
        tss_window=2000,
        filter=False,
        min_fragments=1000,
        max_fragments=100000,
        min_tsse=5.0,
        max_nucleosome_signal=2.0,
        min_frip=0.15,
    )

    with pytest.raises((FileNotFoundError, OSError)):
        run_atac_qc(args)


def test_atac_qc_report_has_required_keys(simple_adata, tmp_path):
    """Test that the report dict has the expected structure."""
    import argparse

    input_h5ad = tmp_path / "input.h5ad"
    output_h5ad = tmp_path / "output.h5ad"
    simple_adata.write_h5ad(input_h5ad)

    args = argparse.Namespace(
        adata=str(input_h5ad),
        output=str(output_h5ad),
        compute_tsse=False,
        compute_fragment_size=False,
        compute_frip=False,
        fragment_file=None,
        tss_bed=None,
        tss_window=2000,
        filter=False,
        min_fragments=1000,
        max_fragments=100000,
        min_tsse=5.0,
        max_nucleosome_signal=2.0,
        min_frip=0.15,
    )

    result = run_atac_qc(args)

    # Check the actual return structure (evidence-based reporting)
    assert isinstance(result, dict)
    assert "evidence" in result
    assert isinstance(result["evidence"], list)
    assert "n_cells_after" in result
    assert "n_cells_before" in result or "cells_removed" in result


def test_atac_qc_preserves_input_on_error(simple_adata, tmp_path):
    """Test that a failed QC run doesn't corrupt the input file."""
    import argparse

    input_h5ad = tmp_path / "input.h5ad"
    output_h5ad = tmp_path / "output.h5ad"
    simple_adata.write_h5ad(input_h5ad)

    # Force an error by requesting TSSE without a TSS BED file
    args = argparse.Namespace(
        adata=str(input_h5ad),
        output=str(output_h5ad),
        compute_tsse=True,  # will fail without tss_bed
        compute_fragment_size=False,
        compute_frip=False,
        fragment_file=None,
        tss_bed=None,  # missing, should raise
        tss_window=2000,
        filter=False,
        min_fragments=1000,
        max_fragments=100000,
        min_tsse=5.0,
        max_nucleosome_signal=2.0,
        min_frip=0.15,
    )

    # Should fail loud, but input file should remain intact
    try:
        run_atac_qc(args)
    except (RuntimeError, ValueError, FileNotFoundError, TypeError):
        pass  # expected (fail-loud)

    # Verify input file is still readable
    import anndata as ad
    adata_check = ad.read_h5ad(input_h5ad)
    assert adata_check.shape == simple_adata.shape
