"""
Tests for the markers module.

`markers.py` is now a thin re-export of the canonical `marker_table` module
(the historical near-duplicate implementation was removed per the CLAUDE.md
Generalization Principle). These tests pin that contract: the public names
resolve to the SAME objects as marker_table, and the marker-calling behaviour
works through the markers namespace. Exercised via the flat re-export shim.
"""

import pytest
import numpy as np
import pandas as pd
from anndata import AnnData
import sys
import os as _os


from aose_omics_runtime.scrna import markers
from aose_omics_runtime.scrna import marker_table as mt
from aose_omics_runtime.shared.conventions import OBS_LEIDEN


def test_markers_reexports_canonical_marker_table():
    # Single source of truth: markers.* must BE marker_table.* (same objects).
    assert markers.marker_table is mt.marker_table
    assert markers.format_marker_summary is mt.format_marker_summary
    assert markers.export_markers_for_enrichment is mt.export_markers_for_enrichment
    assert markers.is_noise_gene is mt.is_noise_gene


def test_markers_is_noise_gene():
    # Ribosomal / mito / MALAT1 / hemoglobin are noise; real genes are not.
    assert markers.is_noise_gene("MT-CO1") is True
    assert markers.is_noise_gene("RPS6") is True
    assert markers.is_noise_gene("MALAT1") is True
    assert markers.is_noise_gene("HBB") is True
    assert markers.is_noise_gene("CD3D") is False
    assert markers.is_noise_gene("HBEGF") is False  # real gene, not hemoglobin


@pytest.fixture
def clustered_adata():
    np.random.seed(0)
    n_cells, n_genes = 90, 60
    X = np.random.negative_binomial(0.3, 0.7, (n_cells, n_genes)).astype(float)

    def plant(cells, genes):
        block = np.random.negative_binomial(20, 0.3, (len(cells), len(genes))).astype(float)
        for i, c in enumerate(cells):
            X[c, genes] = block[i]

    plant(range(0, 30), list(range(0, 12)))
    plant(range(30, 60), list(range(20, 32)))
    plant(range(60, 90), list(range(40, 52)))

    adata = AnnData(X)
    adata.var_names = [f"Gene_{i}" for i in range(n_genes)]
    adata.layers["counts"] = X.copy()
    adata.obs[OBS_LEIDEN] = (["0"] * 30 + ["1"] * 30 + ["2"] * 30)
    adata.obs[OBS_LEIDEN] = adata.obs[OBS_LEIDEN].astype("category")
    import scanpy as sc
    sc.pp.normalize_total(adata, target_sum=1e4)
    sc.pp.log1p(adata)
    return adata


def test_markers_marker_table_returns_tuple(clustered_adata):
    # Canonical contract: (DataFrame, report dict | None).
    table, report = markers.marker_table(clustered_adata, groupby=OBS_LEIDEN)
    assert isinstance(table, pd.DataFrame)
    assert {"group", "names", "logfoldchanges", "pts", "specificity"} <= set(table.columns)
    assert report["operation"] == "marker_table"
    assert report["n_groups"] == 3


def test_markers_format_marker_summary(clustered_adata):
    table, _ = markers.marker_table(clustered_adata, groupby=OBS_LEIDEN)
    summary = markers.format_marker_summary(table, top_n=3)
    assert isinstance(summary, str)
    assert "Marker genes (top 3 per group)" in summary
