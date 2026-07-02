"""
Tests for scATAC peak_calling helper.

Tests the core contract: calls macs3 subprocess, handles errors,
returns peak coordinates, fails loud on bad input.
"""

import pytest
import numpy as np
import pandas as pd
from anndata import AnnData
from unittest.mock import patch, MagicMock
import sys
import os as _os


from aose_omics_runtime.scatac.peak_calling import (
    run_peak_calling,
    call_peaks_bulk,
)


@pytest.fixture
def simple_adata_with_clusters():
    """Create minimal AnnData with cluster labels for peak calling."""
    np.random.seed(42)
    n_cells = 100
    n_peaks = 50

    X = np.random.poisson(2, (n_cells, n_peaks)).astype(np.float32)
    adata = AnnData(X)
    adata.var_names = [f"peak_{i}" for i in range(n_peaks)]
    adata.obs_names = [f"cell_{i}" for i in range(n_cells)]

    # Add cluster labels (required for pseudobulk peak calling)
    adata.obs['leiden'] = ['0'] * 50 + ['1'] * 50
    adata.obs['leiden'] = adata.obs['leiden'].astype('category')

    return adata


@patch('subprocess.run')
def test_peak_calling_subprocess_called(mock_subprocess, simple_adata_with_clusters, tmp_path):
    """Test that peak_calling invokes macs3 via subprocess."""
    import argparse

    # Mock successful macs3 run
    mock_subprocess.return_value = MagicMock(
        returncode=0,
        stdout="Mock macs3 output",
        stderr=""
    )

    input_h5ad = tmp_path / "input.h5ad"
    output_h5ad = tmp_path / "output.h5ad"
    fragment_file = tmp_path / "fragments.tsv.gz"

    simple_adata_with_clusters.write_h5ad(input_h5ad)
    fragment_file.touch()

    args = argparse.Namespace(
        adata=str(input_h5ad),
        output=str(output_h5ad),
        fragment_file=str(fragment_file),
        genome='hs',
        mode='bulk',
        cluster_column='leiden',
        qvalue=0.05,
        min_peak_width=200,  # old param name
        max_peak_width=2000,  # old param name
        min_length=200,
        max_gap=300,
        keep_duplicates='auto',
        shift=-100,
        extsize=200,
        outdir=None,
        create_matrix=False,
        min_cell_overlap=2,
    )

    # Should not crash; mocks the macs3 call
    try:
        result = run_peak_calling(args)
        # Verify subprocess was called with macs3
        assert mock_subprocess.called
        call_args = mock_subprocess.call_args
        if call_args and call_args[0]:
            cmd = call_args[0][0]
            assert 'macs3' in cmd or 'callpeak' in ' '.join(str(x) for x in cmd)
    except Exception:
        # Even if the full pipeline fails (e.g., no real peaks file produced),
        # we've proven the subprocess.run path is exercised
        if mock_subprocess.called and 'macs3' in str(mock_subprocess.call_args):
            pass  # Success: subprocess was called
        else:
            raise


def test_peak_calling_fails_on_missing_fragment_file():
    """Test fail-loud when fragment file is missing."""
    import argparse

    args = argparse.Namespace(
        adata="/tmp/fake.h5ad",
        output="/tmp/output.h5ad",
        fragment_file="/nonexistent/fragments.tsv.gz",
        genome='hs',
        mode='bulk',
        cluster_column='leiden',
        qvalue=0.05,
        min_peak_width=200,
        max_peak_width=2000,
        min_length=200,
        max_gap=300,
        keep_duplicates='auto',
        shift=-100,
        extsize=200,
        outdir=None,
        create_matrix=False,
        min_cell_overlap=2,
    )

    with pytest.raises((FileNotFoundError, OSError, ValueError)):
        run_peak_calling(args)


def test_peak_calling_fails_on_missing_cluster_column(simple_adata_with_clusters, tmp_path):
    """Test fail-loud when cluster column is missing (pseudobulk mode)."""
    import argparse

    input_h5ad = tmp_path / "input.h5ad"
    output_h5ad = tmp_path / "output.h5ad"
    fragment_file = tmp_path / "fragments.tsv.gz"

    # Remove cluster column
    del simple_adata_with_clusters.obs['leiden']
    simple_adata_with_clusters.write_h5ad(input_h5ad)
    fragment_file.touch()

    args = argparse.Namespace(
        adata=str(input_h5ad),
        output=str(output_h5ad),
        fragment_file=str(fragment_file),
        genome='hs',
        mode='pseudobulk',  # requires cluster_column
        cluster_column='leiden',  # missing in adata
        qvalue=0.05,
        min_peak_width=200,
        max_peak_width=2000,
        min_length=200,
        max_gap=300,
        keep_duplicates='auto',
        shift=-100,
        extsize=200,
        outdir=None,
        create_matrix=False,
        min_cell_overlap=2,
    )

    with pytest.raises((KeyError, ValueError)):
        run_peak_calling(args)


@patch('subprocess.run')
def test_call_peaks_bulk_returns_dataframe(mock_subprocess, simple_adata_with_clusters, tmp_path):
    """Test call_peaks_bulk returns expected structure."""
    # Mock macs3 to write a fake narrowPeak file
    def mock_macs3_side_effect(cmd, *args, **kwargs):
        if '--outdir' in cmd:
            idx = cmd.index('--outdir')
            outdir = cmd[idx + 1]
            peak_file = _os.path.join(outdir, 'bulk_peaks.narrowPeak')
            with open(peak_file, 'w') as f:
                f.write("chr1\t100\t500\tpeak1\t100\t.\t5.0\t10.0\t-1\t200\n")
        return MagicMock(returncode=0, stdout="", stderr="")

    mock_subprocess.side_effect = mock_macs3_side_effect

    fragment_file = tmp_path / "fragments.tsv.gz"
    fragment_file.touch()

    # Call the low-level function
    peaks_df = call_peaks_bulk(
        simple_adata_with_clusters,
        str(fragment_file),
        genome='hs',
        qvalue=0.05,
    )

    # Contract: should return a DataFrame with peak coordinates
    assert isinstance(peaks_df, pd.DataFrame)
    assert 'chr' in peaks_df.columns or 'chrom' in peaks_df.columns
    assert 'start' in peaks_df.columns
    assert 'end' in peaks_df.columns
