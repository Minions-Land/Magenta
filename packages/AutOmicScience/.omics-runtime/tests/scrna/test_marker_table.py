"""
Tests for marker_table frozen helper.
"""

import pytest
import numpy as np
import pandas as pd
import scanpy as sc
from anndata import AnnData
import sys
import os as _os

from aose_omics_runtime.scrna.marker_table import (
    marker_table,
    format_marker_summary,
    export_markers_for_enrichment,
    DEFAULT_METHOD,
    DEFAULT_MIN_LOGFC,
)
from aose_omics_runtime.shared.conventions import OBS_LEIDEN


@pytest.fixture
def adata_with_clusters():
    """Create test AnnData with clusters."""
    np.random.seed(42)

    # Create 3 clusters with differential expression
    n_cells = 150
    n_genes = 100

    # Cluster 0: high expression of genes 0-20
    # Cluster 1: high expression of genes 30-50
    # Cluster 2: high expression of genes 60-80

    # Realistic sparse COUNT data: low baseline expression (most entries zero,
    # like real scRNA-seq) with cluster-specific marker genes strongly and
    # almost-exclusively expressed in their own cluster. randn() is wrong here
    # because pts (fraction nonzero) would be ~1.0 for every gene, so the
    # expression-fraction filter could never separate markers from background.
    X = np.random.negative_binomial(0.3, 0.7, (n_cells, n_genes)).astype(float)

    # Cluster-specific markers: high counts in own cluster, ~zero elsewhere.
    def plant(cells, genes):
        block = np.random.negative_binomial(20, 0.3, (len(cells), len(genes))).astype(float)
        for i, c in enumerate(cells):
            X[c, genes] = block[i]

    plant(range(0, 50), list(range(0, 20)))    # cluster 0 markers Gene_0..19
    plant(range(50, 100), list(range(30, 50)))  # cluster 1 markers Gene_30..49
    plant(range(100, 150), list(range(60, 80)))  # cluster 2 markers Gene_60..79

    adata = AnnData(X)
    adata.var_names = [f"Gene_{i}" for i in range(n_genes)]
    adata.layers["counts"] = X.copy()
    adata.obs[OBS_LEIDEN] = ["0"] * 50 + ["1"] * 50 + ["2"] * 50
    adata.obs[OBS_LEIDEN] = adata.obs[OBS_LEIDEN].astype('category')
    # Normalize + log so logFC / Wilcoxon behave like real preprocessed data.
    import scanpy as _sc
    _sc.pp.normalize_total(adata, target_sum=1e4)
    _sc.pp.log1p(adata)

    return adata


def test_marker_table_basic(adata_with_clusters):
    """Test basic marker gene finding."""
    markers, report = marker_table(adata_with_clusters)

    # Check output structure
    assert isinstance(markers, pd.DataFrame)
    assert "group" in markers.columns
    assert "names" in markers.columns
    assert "logfoldchanges" in markers.columns
    assert "pts" in markers.columns
    assert "pts_rest" in markers.columns
    assert "specificity" in markers.columns

    # Check report
    assert report is not None
    assert report["operation"] == "marker_table"
    assert report["n_groups"] == 3
    assert len(report["groups"]) == 3

    # Check all groups present
    assert set(markers["group"].unique()) <= {"0", "1", "2"}


def test_marker_table_filtering(adata_with_clusters):
    """Test marker filtering by logFC and expression."""
    markers, report = marker_table(
        adata_with_clusters,
        min_logfc=1.0,
        min_in_group_fraction=0.3,
        max_out_group_fraction=0.4,
    )

    # All markers should pass filters
    assert (markers["logfoldchanges"] >= 1.0).all()
    assert (markers["pts"] >= 0.3).all()
    assert (markers["pts_rest"] <= 0.4).all()

    # Check filtering stats in report
    assert "n_markers_before_filter" in report
    assert "n_markers_after_filter" in report
    assert report["n_markers_after_filter"] <= report["n_markers_before_filter"]


def test_marker_table_custom_groupby(adata_with_clusters):
    """Test with custom groupby key."""
    # Add custom grouping. Use BLOCK assignment aligned to the planted cluster
    # structure (cells 0-49, 50-99, 100-149) — not an interleaved A,B,C,A,B,C
    # pattern, which would scramble every group into a marker-less mix.
    adata_with_clusters.obs["custom_group"] = ["A"] * 50 + ["B"] * 50 + ["C"] * 50
    adata_with_clusters.obs["custom_group"] = adata_with_clusters.obs["custom_group"].astype('category')

    markers, report = marker_table(
        adata_with_clusters,
        groupby="custom_group",
    )

    # Every group has planted markers, so all three must appear.
    assert set(markers["group"].unique()) == {"A", "B", "C"}
    assert report["parameters"]["groupby"] == "custom_group"


def test_marker_table_missing_groupby(adata_with_clusters):
    """Test error when groupby key not found."""
    with pytest.raises(KeyError, match="Groupby key.*not found"):
        marker_table(
            adata_with_clusters,
            groupby="nonexistent",
        )


def test_marker_table_no_report(adata_with_clusters):
    """Test without report return."""
    markers, report = marker_table(
        adata_with_clusters,
        return_report=False,
    )

    assert isinstance(markers, pd.DataFrame)
    assert report is None


def test_marker_table_different_methods(adata_with_clusters):
    """Test different statistical methods."""
    for method in ["wilcoxon", "t-test"]:
        markers, report = marker_table(
            adata_with_clusters,
            method=method,
        )
        assert report["parameters"]["method"] == method
        assert len(markers) > 0


def test_marker_table_n_genes(adata_with_clusters):
    """Test limiting number of genes per group."""
    markers, report = marker_table(
        adata_with_clusters,
        n_genes=10,
    )

    # Before filtering, should have at most 10 genes per group
    # After filtering might be less
    assert report["parameters"]["n_genes"] == 10


def test_format_marker_summary(adata_with_clusters):
    """Test formatting marker summary."""
    markers, _ = marker_table(adata_with_clusters)

    summary = format_marker_summary(markers, top_n=3)

    assert isinstance(summary, str)
    assert "Marker genes (top 3 per group)" in summary
    assert "0:" in summary
    assert "1:" in summary
    assert "2:" in summary


def test_export_markers_for_enrichment_gene_list(adata_with_clusters):
    """Test exporting markers as gene lists."""
    markers, _ = marker_table(adata_with_clusters)

    export = export_markers_for_enrichment(
        markers,
        top_n=20,
        output_format="gene_list",
    )

    assert isinstance(export, dict)
    for group, genes in export.items():
        assert isinstance(genes, list)
        assert all(isinstance(g, str) for g in genes)
        assert len(genes) <= 20


def test_export_markers_for_enrichment_ranked(adata_with_clusters):
    """Test exporting markers as ranked lists."""
    markers, _ = marker_table(adata_with_clusters)

    export = export_markers_for_enrichment(
        markers,
        top_n=20,
        output_format="ranked",
    )

    assert isinstance(export, dict)
    for group, ranked_genes in export.items():
        assert isinstance(ranked_genes, list)
        assert all(isinstance(item, tuple) and len(item) == 2 for item in ranked_genes)
        assert all(isinstance(item[0], str) for item in ranked_genes)  # gene name
        assert all(isinstance(item[1], (int, float)) for item in ranked_genes)  # score


def test_export_markers_invalid_format(adata_with_clusters):
    """Test error with invalid output format."""
    markers, _ = marker_table(adata_with_clusters)

    with pytest.raises(ValueError, match="Unknown output_format"):
        export_markers_for_enrichment(markers, output_format="invalid")


def test_marker_table_specificity_calculation(adata_with_clusters):
    """Test that specificity score is calculated correctly."""
    markers, _ = marker_table(adata_with_clusters)

    # Specificity should be pts / (pts + pts_rest)
    expected_specificity = markers["pts"] / (markers["pts"] + markers["pts_rest"] + 1e-10)
    np.testing.assert_array_almost_equal(
        markers["specificity"].values,
        expected_specificity.values,
        decimal=5,
    )


def test_marker_table_sorted_output(adata_with_clusters):
    """Test that output is sorted by group then score."""
    markers, _ = marker_table(adata_with_clusters)

    # Check sorting
    for group in markers["group"].unique():
        group_markers = markers[markers["group"] == group]
        scores = group_markers["scores"].values

        # Scores should be in descending order
        assert all(scores[i] >= scores[i+1] for i in range(len(scores)-1))
