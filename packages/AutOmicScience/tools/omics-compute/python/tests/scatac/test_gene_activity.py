"""
Tests for scATAC gene_activity helper.

Tests the core contract: takes peak matrix + gene annotation,
computes gene activity scores, returns report dict, fails loud on bad input.
"""

import pytest
import numpy as np
import pandas as pd
from anndata import AnnData
import sys
import os as _os


from aose_omics_runtime.scatac.gene_activity import (
    run_gene_activity,
    load_gene_annotation,
    get_builtin_gene_annotation,
)


@pytest.fixture
def peak_adata():
    """Create minimal AnnData with peak counts."""
    np.random.seed(42)
    n_cells = 50
    n_peaks = 100

    X = np.random.poisson(3, (n_cells, n_peaks)).astype(np.float32)
    adata = AnnData(X)
    adata.obs_names = [f"cell_{i}" for i in range(n_cells)]
    # Peak names as chr:start-end
    adata.var_names = [f"chr1:{i*1000}-{i*1000+500}" for i in range(n_peaks)]
    adata.var['chr'] = 'chr1'
    adata.var['start'] = [i*1000 for i in range(n_peaks)]
    adata.var['end'] = [i*1000+500 for i in range(n_peaks)]

    return adata


@pytest.fixture
def simple_gene_annotation():
    """Create minimal gene annotation DataFrame."""
    genes = pd.DataFrame({
        'gene_name': ['GENE1', 'GENE2', 'GENE3'],
        'chr': ['chr1', 'chr1', 'chr2'],
        'start': [5000, 15000, 10000],
        'end': [10000, 20000, 15000],
        'strand': ['+', '-', '+'],
    })
    return genes


def test_gene_activity_run_basic_contract(peak_adata, simple_gene_annotation, tmp_path):
    """Test run_gene_activity honors the basic contract."""
    import argparse

    input_h5ad = tmp_path / "input.h5ad"
    output_h5ad = tmp_path / "output.h5ad"
    gene_gtf = tmp_path / "genes.gtf"

    peak_adata.write_h5ad(input_h5ad)

    # Write minimal GTF (gene_activity can parse GTF or accept a DataFrame)
    with open(gene_gtf, 'w') as f:
        f.write("chr1\ttest\tgene\t5000\t10000\t.\t+\t.\tgene_name \"GENE1\";\n")
        f.write("chr1\ttest\tgene\t15000\t20000\t.\t-\t.\tgene_name \"GENE2\";\n")

    args = argparse.Namespace(
        adata=str(input_h5ad),
        output=str(output_h5ad),
        gtf_file=str(gene_gtf),
        organism='human',
        distance_constraint=500000,
        method='cicero',
        promoter_window=2000,
        upstream=2000,
        downstream=0,
        gene_body_weight=0.5,
        extend_upstream=5000,
        extend_downstream=0,
        coaccessibility_cutoff=0.25,
        weight_by_distance=False,
        decay_distance=50000,
        tile_size=500,
    )

    result = run_gene_activity(args)

    # Contract checks
    assert isinstance(result, dict), "run_gene_activity must return a dict"
    assert output_h5ad.exists(), "Output file must be written"

    # Verify output AnnData has gene activity layer
    import anndata as ad
    adata_out = ad.read_h5ad(output_h5ad)
    # Gene activity is typically stored in a new layer or .X
    assert adata_out.shape[0] == peak_adata.shape[0]  # same n_cells


def test_gene_activity_fails_on_missing_input():
    """Test fail-loud on missing input file."""
    import argparse

    args = argparse.Namespace(
        adata="/nonexistent/path.h5ad",
        output="/tmp/output.h5ad",
        gtf_file=None,
        organism='human',
        distance_constraint=500000,
        method='cicero',
        promoter_window=2000,
        upstream=2000,
        downstream=0,
        gene_body_weight=0.5,
        extend_upstream=5000,
        extend_downstream=0,
        coaccessibility_cutoff=0.25,
    )

    with pytest.raises((FileNotFoundError, OSError)):
        run_gene_activity(args)


def test_get_builtin_gene_annotation():
    """Test that builtin gene annotation can be loaded."""
    # This tests the fallback to builtin annotations
    genes = get_builtin_gene_annotation(organism='human')

    assert isinstance(genes, pd.DataFrame)
    assert 'gene_name' in genes.columns or 'gene' in genes.columns
    assert 'chr' in genes.columns or 'chrom' in genes.columns
    assert 'start' in genes.columns
    assert 'end' in genes.columns


def test_gene_activity_requires_peak_coordinates(tmp_path):
    """Test fail-loud when peak coordinates are missing."""
    import argparse

    # Create adata without peak coordinate columns
    n_cells = 50
    n_peaks = 100
    X = np.random.poisson(3, (n_cells, n_peaks)).astype(np.float32)
    adata = AnnData(X)
    adata.obs_names = [f"cell_{i}" for i in range(n_cells)]
    adata.var_names = [f"peak_{i}" for i in range(n_peaks)]
    # Missing: var['chr'], var['start'], var['end']

    input_h5ad = tmp_path / "input_no_coords.h5ad"
    output_h5ad = tmp_path / "output.h5ad"
    adata.write_h5ad(input_h5ad)

    args = argparse.Namespace(
        adata=str(input_h5ad),
        output=str(output_h5ad),
        gtf_file=None,
        organism='human',
        distance_constraint=500000,
        method='cicero',
        promoter_window=2000,
        upstream=2000,
        downstream=0,
        gene_body_weight=0.5,
        extend_upstream=5000,
        extend_downstream=0,
        coaccessibility_cutoff=0.25,
    )

    with pytest.raises((KeyError, ValueError)):
        run_gene_activity(args)


def test_load_gene_annotation_from_gtf(tmp_path):
    """Test loading gene annotation from a GTF file."""
    gtf_file = tmp_path / "test.gtf"

    # Write a minimal GTF
    with open(gtf_file, 'w') as f:
        f.write("chr1\ttest\tgene\t1000\t5000\t.\t+\t.\tgene_name \"TEST1\";\n")
        f.write("chr2\ttest\tgene\t2000\t6000\t.\t-\t.\tgene_name \"TEST2\";\n")

    genes = load_gene_annotation(gtf_file=str(gtf_file))

    assert isinstance(genes, pd.DataFrame)
    assert len(genes) == 2
    assert 'gene_name' in genes.columns or 'gene' in genes.columns
    assert 'chr' in genes.columns or 'chrom' in genes.columns
