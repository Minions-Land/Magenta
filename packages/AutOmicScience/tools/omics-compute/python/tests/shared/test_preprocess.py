"""
Tests for preprocess module.

Validates standard_preprocess() pipeline with synthetic data. The asserted API
mirrors 03-phase0-python.md S5.4: keyword-only params (qc_mode in {"fixed","mad"},
max_pct_mt, n_hvg, ...) and the report dict (split QC counters
cells_filtered_min_genes / cells_filtered_pct_mt / genes_filtered_min_cells,
"params", "keys_written", n_clusters, timing).
"""

import pytest
import numpy as np
import pandas as pd
from anndata import AnnData
from scipy.sparse import csr_matrix

import sys
from pathlib import Path

from aose_omics_runtime.shared.preprocess import (
    standard_preprocess,
    N_HVG,
    LEIDEN_RESOLUTION,
    N_PCS,
    N_NEIGHBORS,
    QC_MIN_GENES,
    QC_MIN_CELLS,
    QC_MAX_PCT_MT,
    NORM_TARGET_SUM,
    RANDOM_SEED,
)
from aose_omics_runtime.shared.conventions import LAYER_COUNTS, OBS_LEIDEN, OBSM_PCA, OBSM_UMAP


def _make_counts_adata(*, n_obs=300, n_vars=500, seed=0, add_batch=False):
    """Tiny synthetic raw-count AnnData (integer counts, spiked MT genes).

    Deliberately integer-valued so the helper's counts-precondition holds. Per-gene
    means are spread over a range so the matrix has real variance structure -- this
    matters because sc.pp.scrublet runs its own internal HVG/PCA and fails on a
    featureless matrix. Seeds structured low-quality cells so fixed-mode QC has
    something to remove:
    - cells [0:30) express only 50 genes  -> dropped by min_genes=200
    - cells [40:50) have very high MT counts -> dropped by max_pct_mt=20
    """
    rng = np.random.default_rng(seed)
    gene_means = rng.uniform(0.5, 15.0, size=n_vars)
    X = rng.poisson(gene_means, size=(n_obs, n_vars)).astype(np.float32)
    X[:30, 50:] = 0          # low-complexity cells (few genes expressed)
    X[40:50, -10:] = 500     # high-MT cells
    gene_names = [f"GENE{i}" for i in range(n_vars - 10)] + [f"MT-CO{i}" for i in range(10)]
    obs = pd.DataFrame(index=[f"CELL{i:04d}" for i in range(n_obs)])
    if add_batch:
        obs["batch"] = (["A"] * (n_obs // 2) + ["B"] * (n_obs - n_obs // 2))
    var = pd.DataFrame({"gene_name": gene_names}, index=gene_names)
    return AnnData(X=csr_matrix(X), obs=obs, var=var)


@pytest.fixture
def raw_counts_adata():
    """Synthetic raw count data: 300 cells x 500 genes with low-quality cells."""
    return _make_counts_adata()


class TestStandardPreprocessConstants:
    """Module constants are correctly defined."""

    def test_default_parameters(self):
        assert N_HVG == 2000
        assert LEIDEN_RESOLUTION == 1.0
        assert N_PCS == 50
        assert N_NEIGHBORS == 15
        assert QC_MIN_GENES == 200
        assert QC_MIN_CELLS == 3
        assert QC_MAX_PCT_MT == 20
        assert NORM_TARGET_SUM == 1e4
        assert RANDOM_SEED == 0


class TestStandardPreprocess:
    """standard_preprocess() pipeline."""

    def test_basic_pipeline(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(raw_counts_adata)
        assert adata_proc.X is not None
        assert adata_proc.n_obs > 0
        assert adata_proc.n_vars > 0
        assert LAYER_COUNTS in adata_proc.layers
        assert OBSM_PCA in adata_proc.obsm
        assert OBSM_UMAP in adata_proc.obsm
        assert OBS_LEIDEN in adata_proc.obs.columns
        assert report is not None
        assert report["operation"] == "standard_preprocess"

    def test_qc_filtering(self, raw_counts_adata):
        initial_n_obs = raw_counts_adata.n_obs
        adata_proc, report = standard_preprocess(raw_counts_adata, qc_mode="fixed")
        # Split QC counters per spec S5.4; the seeded fixture loses some cells.
        cells_filtered = (
            report["cells_filtered_min_genes"] + report["cells_filtered_pct_mt"]
        )
        assert cells_filtered > 0
        assert report["initial_shape"][0] == initial_n_obs
        assert report["post_qc_shape"][0] <= initial_n_obs
        assert adata_proc.n_obs < initial_n_obs

    def test_preserves_raw_counts(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(raw_counts_adata)
        assert LAYER_COUNTS in adata_proc.layers
        assert adata_proc.layers[LAYER_COUNTS].dtype in [
            np.float32, np.float64, np.int32, np.int64
        ]

    def test_normalization(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(raw_counts_adata)
        assert adata_proc.X.max() < 20  # log1p scale
        assert adata_proc.X.min() >= 0

    def test_hvg_selection(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(raw_counts_adata, n_hvg=100)
        assert "highly_variable" in adata_proc.var.columns
        assert adata_proc.var["highly_variable"].sum() == 100
        assert report["hvg_flavor"] == "seurat_v3"

    def test_pca_dimensions(self, raw_counts_adata):
        n_pcs = 30
        adata_proc, report = standard_preprocess(raw_counts_adata, n_pcs=n_pcs)
        assert OBSM_PCA in adata_proc.obsm
        assert adata_proc.obsm[OBSM_PCA].shape[1] == n_pcs
        assert report["params"]["n_pcs"] == n_pcs

    def test_umap_dimensions(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(raw_counts_adata)
        assert OBSM_UMAP in adata_proc.obsm
        assert adata_proc.obsm[OBSM_UMAP].shape[1] == 2

    def test_leiden_clustering(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(raw_counts_adata, resolution=0.5)
        assert OBS_LEIDEN in adata_proc.obs.columns
        n_clusters = len(adata_proc.obs[OBS_LEIDEN].unique())
        assert n_clusters > 0
        assert report["n_clusters"] == n_clusters

    def test_custom_resolution(self, raw_counts_adata):
        _, report_low = standard_preprocess(raw_counts_adata, resolution=0.3)
        _, report_high = standard_preprocess(raw_counts_adata, resolution=2.0)
        assert report_low["n_clusters"] <= report_high["n_clusters"] * 2

    def test_reproducibility_with_seed(self, raw_counts_adata):
        a1, _ = standard_preprocess(_make_counts_adata(), seed=42)
        a2, _ = standard_preprocess(_make_counts_adata(), seed=42)
        np.testing.assert_array_almost_equal(a1.obsm[OBSM_PCA], a2.obsm[OBSM_PCA], decimal=5)
        np.testing.assert_array_almost_equal(a1.obsm[OBSM_UMAP], a2.obsm[OBSM_UMAP], decimal=5)
        assert (a1.obs[OBS_LEIDEN].values == a2.obs[OBS_LEIDEN].values).all()

    def test_different_seeds_produce_different_results(self):
        a1, _ = standard_preprocess(_make_counts_adata(), seed=0)
        a2, _ = standard_preprocess(_make_counts_adata(), seed=999)
        assert not np.allclose(a1.obsm[OBSM_UMAP], a2.obsm[OBSM_UMAP])

    def test_report_structure(self, raw_counts_adata):
        _, report = standard_preprocess(raw_counts_adata)
        for field in (
            "operation", "initial_shape", "post_qc_shape", "final_shape",
            "cells_filtered_min_genes", "cells_filtered_pct_mt",
            "genes_filtered_min_cells", "params", "keys_written", "n_clusters",
            "start_time", "end_time", "duration_seconds",
        ):
            assert field in report, f"missing report field: {field}"

    def test_report_parameters(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(
            raw_counts_adata, n_hvg=150, resolution=0.8, n_pcs=40, n_neighbors=20, seed=123,
        )
        params = report["params"]
        assert params["n_hvg"] == 150
        assert params["resolution"] == 0.8
        assert params["n_pcs"] == 40
        assert params["n_neighbors"] == 20
        assert params["seed"] == 123

    def test_no_report_option(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(raw_counts_adata, return_report=False)
        assert adata_proc is not None
        assert report is None

    def test_mad_qc_mode(self, raw_counts_adata):
        # qc_mode="mad" populates the MAD counters instead of the fixed ones.
        adata_proc, report = standard_preprocess(raw_counts_adata, qc_mode="mad")
        assert "cells_flagged_mad" in report
        assert report["mad_nmads"] == 5.0
        assert report["mad_nmads_mt"] == 3.0
        assert report["params"]["qc_mode"] == "mad"

    def test_invalid_qc_mode_raises(self, raw_counts_adata):
        with pytest.raises(ValueError):
            standard_preprocess(raw_counts_adata, qc_mode="adaptive")

    def test_custom_qc_parameters(self, raw_counts_adata):
        adata_proc, report = standard_preprocess(
            raw_counts_adata, qc_mode="fixed", min_genes=100, min_cells=5, max_pct_mt=10,
        )
        params = report["params"]
        assert params["min_genes"] == 100
        assert params["min_cells"] == 5
        assert params["max_pct_mt"] == 10

    def test_batch_key_threading(self):
        # batch_key is echoed in the report and accepted by HVG/scrublet/MAD.
        adata = _make_counts_adata(add_batch=True)
        adata_proc, report = standard_preprocess(adata, batch_key="batch")
        assert report["batch_key"] == "batch"
        assert report["params"]["batch_key"] == "batch"

    def test_missing_batch_key_raises(self, raw_counts_adata):
        with pytest.raises(ValueError):
            standard_preprocess(raw_counts_adata, batch_key="nonexistent_col")

    def test_doublets_flagged_not_dropped(self, raw_counts_adata):
        # Doublets are flagged in obs, never auto-removed (agent decides).
        n_before = raw_counts_adata.n_obs
        adata_proc, report = standard_preprocess(raw_counts_adata, run_doublets=True)
        assert "predicted_doublet" in adata_proc.obs.columns
        assert "doublet_score" in adata_proc.obs.columns
        assert report["doublets_flagged"] is not None
        # scrublet drops no rows; only QC filtering reduces cell count.
        post_qc = report["post_qc_shape"][0]
        assert adata_proc.n_obs == post_qc

    def test_already_normalized_raises(self):
        # Float, non-count X with no counts layer -> refuse to normalize.
        adata = _make_counts_adata()
        adata.layers.clear()
        adata.X = adata.X.toarray() * 0.001
        with pytest.raises(ValueError):
            standard_preprocess(adata)

    def test_does_not_modify_input(self, raw_counts_adata):
        original_shape = raw_counts_adata.shape
        original_obs_cols = set(raw_counts_adata.obs.columns)
        standard_preprocess(raw_counts_adata)
        assert raw_counts_adata.shape == original_shape
        assert set(raw_counts_adata.obs.columns) == original_obs_cols
        assert OBS_LEIDEN not in raw_counts_adata.obs.columns

    def test_handles_dense_input(self):
        adata = _make_counts_adata(n_obs=200, n_vars=120, seed=1)
        adata.X = adata.X.toarray()  # dense
        adata_proc, report = standard_preprocess(
            adata, n_hvg=80, n_pcs=20, min_genes=10, min_cells=1, max_pct_mt=100,
        )
        assert adata_proc is not None
        assert report["final_shape"][0] > 0

    def test_small_dataset(self):
        adata = _make_counts_adata(n_obs=120, n_vars=100, seed=2)
        adata_proc, report = standard_preprocess(
            adata, n_hvg=50, n_pcs=20, min_genes=10, min_cells=1, max_pct_mt=100,
        )
        assert adata_proc is not None
        assert adata_proc.n_obs > 0

    def test_timing_recorded(self, raw_counts_adata):
        _, report = standard_preprocess(raw_counts_adata)
        assert "start_time" in report
        assert "end_time" in report
        assert report["duration_seconds"] > 0
        assert report["duration_seconds"] < 300

    def test_neighbors_graph(self, raw_counts_adata):
        adata_proc, _ = standard_preprocess(raw_counts_adata)
        assert "neighbors" in adata_proc.uns
