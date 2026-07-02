"""
Tests for the read_spatial frozen helper.

The platform loaders (Visium/Xenium/MERFISH) need real on-disk datasets, so the
data-loading paths are covered only by their fail-loud error contracts here; the
no-real-data logic in validate_spatial_adata is tested directly. Exercised
through the flat re-export shim (the analyst-kernel import pattern).
"""

import pytest
import numpy as np
from anndata import AnnData
from scipy.sparse import csr_matrix
import sys
import os as _os


from aose_omics_runtime.spatial.read_spatial import (
    load_visium,
    load_xenium,
    load_merfish,
    validate_spatial_adata,
)
from aose_omics_runtime.shared.conventions import OBSM_SPATIAL, LAYER_COUNTS


def _spatial_adata(*, with_counts=True, n_dims=2) -> AnnData:
    rng = np.random.default_rng(0)
    n = 10
    adata = AnnData(rng.poisson(1.0, size=(n, 6)).astype(float))
    adata.obsm[OBSM_SPATIAL] = rng.random((n, n_dims))
    if with_counts:
        adata.layers[LAYER_COUNTS] = csr_matrix(adata.X)
    return adata


def test_validate_spatial_adata_valid():
    report = validate_spatial_adata(_spatial_adata())
    assert report["valid"] is True
    assert report["errors"] == []
    assert report["has_spatial_coords"] is True
    assert report["has_counts"] is True
    assert report["coordinate_shape"] == (10, 2)
    assert set(report["coordinate_range"]) == {"x_min", "x_max", "y_min", "y_max"}


def test_validate_spatial_adata_missing_coords():
    adata = AnnData(np.ones((5, 3)))
    report = validate_spatial_adata(adata)
    assert report["valid"] is False
    assert report["has_spatial_coords"] is False
    assert any("spatial coordinates" in e.lower() for e in report["errors"])


def test_validate_spatial_adata_missing_counts():
    report = validate_spatial_adata(_spatial_adata(with_counts=False), require_counts=True)
    assert report["valid"] is False
    assert report["has_counts"] is False
    assert any(LAYER_COUNTS in e for e in report["errors"])


def test_validate_spatial_adata_counts_not_required():
    report = validate_spatial_adata(_spatial_adata(with_counts=False), require_counts=False)
    assert report["valid"] is True


def test_validate_spatial_adata_wrong_dims():
    report = validate_spatial_adata(_spatial_adata(n_dims=3))
    assert report["valid"] is False
    assert any("(n_obs, 2)" in e for e in report["errors"])


def test_validate_spatial_adata_visium_warnings():
    # No in_tissue / images -> platform warnings, but still structurally valid.
    report = validate_spatial_adata(_spatial_adata(), platform="visium")
    assert report["valid"] is True
    assert len(report["warnings"]) >= 1


def test_load_visium_missing_path():
    with pytest.raises(FileNotFoundError, match="Visium data directory not found"):
        load_visium(path="/nonexistent/spaceranger/output/abc123")


def test_load_xenium_missing_path():
    with pytest.raises(FileNotFoundError):
        load_xenium(path="/nonexistent/xenium/output/abc123")


def test_load_merfish_missing_path():
    with pytest.raises(FileNotFoundError):
        load_merfish(
            path="/nonexistent/merfish/output/abc123",
            counts_file="counts.csv",
            metadata_file="cell_metadata.csv",
        )
