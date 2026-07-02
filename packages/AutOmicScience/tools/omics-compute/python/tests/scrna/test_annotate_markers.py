"""
Tests for annotate_markers frozen helper.
"""

import pytest
import numpy as np
import pandas as pd
import scanpy as sc
from anndata import AnnData
import sys
import os as _os

from aose_omics_runtime.scrna.annotate_markers import (
    annotate_markers,
    format_annotation_summary,
    HUMAN_PBMC_REFERENCE,
    HUMAN_BRAIN_REFERENCE,
    DEFAULT_SUGGESTION_KEY,
)
from aose_omics_runtime.shared.conventions import OBS_LEIDEN, OBS_CELLTYPE


@pytest.fixture
def adata_with_clusters():
    """Create test AnnData with clusters."""
    np.random.seed(42)
    n_cells = 150
    n_genes = 100

    X = np.random.randn(n_cells, n_genes)
    adata = AnnData(X)
    adata.var_names = [f"Gene_{i}" for i in range(n_genes)]
    adata.obs[OBS_LEIDEN] = ["0"] * 50 + ["1"] * 50 + ["2"] * 50
    adata.obs[OBS_LEIDEN] = adata.obs[OBS_LEIDEN].astype('category')

    return adata


@pytest.fixture
def mock_markers():
    """Create mock marker DataFrame."""
    markers = pd.DataFrame({
        "group": ["0", "0", "0", "1", "1", "1", "2", "2", "2"],
        "names": [
            "CD3D", "CD3E", "CD8A",  # T cell markers - cluster 0
            "CD79A", "MS4A1", "CD19",  # B cell markers - cluster 1
            "CD14", "LYZ", "S100A8",  # Monocyte markers - cluster 2
        ],
        "scores": [10.0, 9.5, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0],
        "logfoldchanges": [2.0] * 9,
        "pts": [0.8] * 9,
        "pts_rest": [0.1] * 9,
        "specificity": [0.8] * 9,
    })
    return markers


@pytest.fixture
def simple_reference():
    """Create simple reference database."""
    return {
        "T cell": ["CD3D", "CD3E", "CD8A", "CD4"],
        "B cell": ["CD79A", "MS4A1", "CD19"],
        "Monocyte": ["CD14", "LYZ", "S100A8", "S100A9"],
    }


def test_annotate_markers_basic(adata_with_clusters, mock_markers, simple_reference):
    """Test basic suggestion: writes to the non-final suggestion key by default."""
    result, report = annotate_markers(
        adata_with_clusters,
        markers=mock_markers,
        reference_db=simple_reference,
    )

    # Route-1 boundary: suggestions land on the non-final suggestion key, never
    # the locked `cell_type` endpoint.
    assert DEFAULT_SUGGESTION_KEY in result.obs.columns
    assert result.obs[DEFAULT_SUGGESTION_KEY].dtype.name == "category"
    assert OBS_CELLTYPE not in result.obs.columns, (
        "annotate_markers must not occupy the final cell_type key by default"
    )

    # Check report
    assert report is not None
    assert report["operation"] == "annotate_markers"
    assert report["role"] == "route1_overlap_evidence"
    assert report["is_final"] is False
    assert report["n_clusters"] == 3
    assert "cluster_to_celltype" in report
    assert "annotation_details" in report


def test_annotate_markers_assignments(adata_with_clusters, mock_markers, simple_reference):
    """Test that correct cell types are assigned."""
    result, report = annotate_markers(
        adata_with_clusters,
        markers=mock_markers,
        reference_db=simple_reference,
        min_score=0.5,
        min_overlap=2,
    )

    # Check assignments (should match perfectly with mock data)
    assert report["cluster_to_celltype"]["0"] == "T cell"
    assert report["cluster_to_celltype"]["1"] == "B cell"
    assert report["cluster_to_celltype"]["2"] == "Monocyte"


def test_annotate_markers_unknown_assignment(adata_with_clusters, simple_reference):
    """Test that low-confidence clusters are labeled Unknown."""
    # Create markers with no overlap to reference
    poor_markers = pd.DataFrame({
        "group": ["0", "0", "0"],
        "names": ["RANDOM1", "RANDOM2", "RANDOM3"],
        "scores": [10.0, 9.5, 9.0],
        "logfoldchanges": [2.0] * 3,
        "pts": [0.8] * 3,
        "pts_rest": [0.1] * 3,
        "specificity": [0.8] * 3,
    })

    result, report = annotate_markers(
        adata_with_clusters,
        markers=poor_markers,
        reference_db=simple_reference,
        min_score=0.5,
        min_overlap=2,
    )

    # Should be labeled Unknown
    assert report["cluster_to_celltype"]["0"] == "Unknown"


def test_annotate_markers_min_score_threshold(adata_with_clusters, simple_reference):
    """Test that min_score threshold filters weak (partial-overlap) assignments.

    mock_markers overlaps the reference perfectly (score=1.0), so no threshold
    <= 1.0 could ever force Unknown — testing the threshold needs PARTIAL
    overlap. Here each cluster shares only 1 of 3 markers with its best
    reference (score = 1/3 ≈ 0.33), so a 0.5 threshold must produce Unknowns
    while a 0.2 threshold must assign them.
    """
    partial = pd.DataFrame({
        "group": ["0", "0", "0", "1", "1", "1", "2", "2", "2"],
        "names": [
            "CD3D", "FOO1", "FOO2",     # cluster 0: 1/3 overlap with T cell
            "CD79A", "BAR1", "BAR2",    # cluster 1: 1/3 overlap with B cell
            "CD14", "BAZ1", "BAZ2",     # cluster 2: 1/3 overlap with Monocyte
        ],
        "scores": [10.0, 9.5, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0],
        "logfoldchanges": [2.0] * 9,
        "pts": [0.8] * 9,
        "pts_rest": [0.1] * 9,
        "specificity": [0.8] * 9,
    })

    # High threshold (0.5 > 0.33) -> all clusters Unknown
    _, report_hi = annotate_markers(
        adata_with_clusters, markers=partial, reference_db=simple_reference,
        min_score=0.5, min_overlap=1)
    unknown_hi = sum(1 for ct in report_hi["cluster_to_celltype"].values() if ct == "Unknown")
    assert unknown_hi >= 1, f"high threshold should yield Unknowns, got {report_hi['cluster_to_celltype']}"

    # Low threshold (0.2 < 0.33) -> clusters get assigned
    _, report_lo = annotate_markers(
        adata_with_clusters, markers=partial, reference_db=simple_reference,
        min_score=0.2, min_overlap=1)
    assigned_lo = sum(1 for ct in report_lo["cluster_to_celltype"].values() if ct != "Unknown")
    assert assigned_lo >= 1, "low threshold should assign at least one cluster"


def test_annotate_markers_min_overlap_threshold(adata_with_clusters, mock_markers, simple_reference):
    """Test that min_overlap threshold filters assignments."""
    # High overlap requirement should prevent assignments
    result, report = annotate_markers(
        adata_with_clusters,
        markers=mock_markers,
        reference_db=simple_reference,
        min_score=0.1,
        min_overlap=10,  # Very high overlap requirement
    )

    # Most clusters should be Unknown with high overlap requirement
    unknown_count = sum(1 for ct in report["cluster_to_celltype"].values() if ct == "Unknown")
    assert unknown_count >= 1


def test_annotate_markers_missing_cluster_key(adata_with_clusters, mock_markers, simple_reference):
    """Test error when cluster key not found."""
    with pytest.raises(KeyError, match="Cluster key.*not found"):
        annotate_markers(
            adata_with_clusters,
            markers=mock_markers,
            reference_db=simple_reference,
            cluster_key="nonexistent",
        )


def test_annotate_markers_empty_reference(adata_with_clusters, mock_markers):
    """Test error with empty reference database."""
    with pytest.raises(ValueError, match="non-empty dict"):
        annotate_markers(
            adata_with_clusters,
            markers=mock_markers,
            reference_db={},
        )


def test_annotate_markers_invalid_markers_df(adata_with_clusters, simple_reference):
    """Test error with invalid markers DataFrame."""
    bad_markers = pd.DataFrame({
        "wrong_col": [1, 2, 3],
    })

    with pytest.raises(ValueError, match="must have 'group' and 'names' columns"):
        annotate_markers(
            adata_with_clusters,
            markers=bad_markers,
            reference_db=simple_reference,
        )


def test_annotate_markers_custom_keys(adata_with_clusters, mock_markers, simple_reference):
    """Test with custom cluster and target keys."""
    # Add custom cluster column
    adata_with_clusters.obs["custom_cluster"] = adata_with_clusters.obs[OBS_LEIDEN]

    result, report = annotate_markers(
        adata_with_clusters,
        markers=mock_markers,
        reference_db=simple_reference,
        cluster_key="custom_cluster",
        target_key="custom_celltype",
    )

    assert "custom_celltype" in result.obs.columns
    assert report["parameters"]["cluster_key"] == "custom_cluster"
    assert report["parameters"]["target_key"] == "custom_celltype"


def test_annotate_markers_no_report(adata_with_clusters, mock_markers, simple_reference):
    """Test without report return."""
    result, report = annotate_markers(
        adata_with_clusters,
        markers=mock_markers,
        reference_db=simple_reference,
        return_report=False,
    )

    assert DEFAULT_SUGGESTION_KEY in result.obs.columns
    assert report is None


def test_annotate_markers_case_insensitive(adata_with_clusters, simple_reference):
    """Test that gene name matching is case-insensitive."""
    # Create markers with lowercase gene names
    lowercase_markers = pd.DataFrame({
        "group": ["0", "0", "0"],
        "names": ["cd3d", "cd3e", "cd8a"],  # lowercase
        "scores": [10.0, 9.5, 9.0],
        "logfoldchanges": [2.0] * 3,
        "pts": [0.8] * 3,
        "pts_rest": [0.1] * 3,
        "specificity": [0.8] * 3,
    })

    result, report = annotate_markers(
        adata_with_clusters,
        markers=lowercase_markers,
        reference_db=simple_reference,
        min_score=0.5,
        min_overlap=2,
    )

    # Should still match T cell (case-insensitive)
    assert report["cluster_to_celltype"]["0"] == "T cell"


def test_format_annotation_summary(adata_with_clusters, mock_markers, simple_reference):
    """Test formatting the suggestion summary."""
    _, report = annotate_markers(
        adata_with_clusters,
        markers=mock_markers,
        reference_db=simple_reference,
    )

    summary = format_annotation_summary(report)

    assert isinstance(summary, str)
    assert "Cell Type Suggestion Summary" in summary
    assert "not final" in summary
    assert "Total clusters:" in summary
    assert "Per-cluster overlap suggestions" in summary


def test_human_pbmc_reference_structure():
    """Test that HUMAN_PBMC_REFERENCE has expected structure."""
    assert isinstance(HUMAN_PBMC_REFERENCE, dict)
    assert len(HUMAN_PBMC_REFERENCE) > 0

    # Check some expected cell types
    assert "T cell" in HUMAN_PBMC_REFERENCE
    assert "B cell" in HUMAN_PBMC_REFERENCE
    assert "Monocyte" in HUMAN_PBMC_REFERENCE

    # Check that values are lists of genes
    for celltype, genes in HUMAN_PBMC_REFERENCE.items():
        assert isinstance(genes, list)
        assert all(isinstance(g, str) for g in genes)
        assert len(genes) > 0


def test_human_brain_reference_structure():
    """Test that HUMAN_BRAIN_REFERENCE has expected structure."""
    assert isinstance(HUMAN_BRAIN_REFERENCE, dict)
    assert len(HUMAN_BRAIN_REFERENCE) > 0

    # Check some expected cell types
    assert "Excitatory neuron" in HUMAN_BRAIN_REFERENCE
    assert "Inhibitory neuron" in HUMAN_BRAIN_REFERENCE
    assert "Oligodendrocyte" in HUMAN_BRAIN_REFERENCE
    assert "Astrocyte" in HUMAN_BRAIN_REFERENCE


def test_annotation_details_structure(adata_with_clusters, mock_markers, simple_reference):
    """Test that annotation details have correct structure."""
    _, report = annotate_markers(
        adata_with_clusters,
        markers=mock_markers,
        reference_db=simple_reference,
    )

    details = report["annotation_details"]

    for cluster, info in details.items():
        assert "assigned_celltype" in info
        assert "best_score" in info
        assert "best_overlap" in info
        assert "all_scores" in info
        assert "top_markers" in info

        # Check all_scores structure
        for celltype, score_info in info["all_scores"].items():
            assert "score" in score_info
            assert "n_overlap" in score_info
            assert "overlapping_genes" in score_info
