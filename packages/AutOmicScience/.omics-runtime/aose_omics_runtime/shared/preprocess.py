"""
Standard preprocessing pipeline for single-cell data.

Provides a deterministic QC -> normalize -> HVG -> PCA -> neighbors -> UMAP -> Leiden
workflow with fixed default parameters as the single source of truth.

Spec: 03-phase0-python.md §5.4
"""

from typing import Optional, Tuple, Literal
import numpy as np
import scanpy as sc
from anndata import AnnData
from datetime import datetime, UTC

from .conventions import LAYER_COUNTS, OBS_LEIDEN, OBSM_PCA, OBSM_UMAP

# Module-top constants: single source of truth for default parameters

# QC mode: "fixed" thresholds or "mad" adaptive outlier detection
QC_MODE: Literal["fixed", "mad"] = "fixed"

# QC thresholds (fixed mode)
QC_MIN_GENES: int = 200
QC_MIN_CELLS: int = 3
QC_MAX_PCT_MT: float = 20.0

# MAD adaptive QC (mad mode): flag cells as outliers when QC metrics are more
# than QC_MAD_NMADS median-absolute-deviations from the per-batch median.
# Computed on log1p-transformed library size / gene count and on raw pct-counts-mt.
QC_MAD_NMADS: float = 5.0      # n MADs for log-library-size / log-n-genes
QC_MAD_NMADS_MT: float = 3.0   # tighter n MADs for pct_counts_mt

MT_PREFIX: str = "MT-"  # human mitochondrial genes; override for mouse ("mt-")

# Normalization
NORM_TARGET_SUM: float = 1e4

# HVG — seurat_v3 expects RAW COUNTS, computed on layer=LAYER_COUNTS, not on normalized X
N_HVG: int = 2000
HVG_FLAVOR: str = "seurat_v3"  # requires scikit-misc

# Dimensionality reduction / graph / clustering
N_PCS: int = 50
N_NEIGHBORS: int = 15
LEIDEN_RESOLUTION: float = 1.0
LEIDEN_FLAVOR: str = "igraph"  # explicit; scanpy's own default is "leidenalg"

RANDOM_SEED: int = 0


def standard_preprocess(
    adata: AnnData,
    *,
    qc_mode: str = QC_MODE,
    min_genes: int = QC_MIN_GENES,
    min_cells: int = QC_MIN_CELLS,
    max_pct_mt: float = QC_MAX_PCT_MT,
    mad_nmads: float = QC_MAD_NMADS,
    mad_nmads_mt: float = QC_MAD_NMADS_MT,
    mt_prefix: str = MT_PREFIX,
    batch_key: Optional[str] = None,
    target_sum: float = NORM_TARGET_SUM,
    n_hvg: int = N_HVG,
    hvg_flavor: str = HVG_FLAVOR,
    n_pcs: int = N_PCS,
    n_neighbors: int = N_NEIGHBORS,
    resolution: float = LEIDEN_RESOLUTION,
    leiden_flavor: str = LEIDEN_FLAVOR,
    seed: int = RANDOM_SEED,
    run_doublets: bool = True,
    inplace: bool = False,
    return_report: bool = True,
) -> Tuple[AnnData, Optional[dict]]:
    """
    Standard scRNA preprocessing: QC -> normalize -> HVG -> PCA -> neighbors -> UMAP -> Leiden.

    This is a deterministic, tested workflow for routine scRNA-seq preprocessing.
    Use this when the data is a standard count matrix and you want speed + reproducibility.
    Adapt by hand when QC is unusual, batch effects need integration before neighbors,
    or the modality needs different features.

    Preconditions
    -------------
    Raw counts must be in adata.layers['counts'] OR an X that looks_like_counts.
    Raises ValueError if neither is present.

    Parameters
    ----------
    adata : AnnData
        Input dataset with raw counts
    qc_mode : {"fixed", "mad"}, default="fixed"
        QC filtering mode:
        - "fixed": hard thresholds (min_genes, max_pct_mt)
        - "mad": median-absolute-deviation adaptive outlier flagging
    min_genes : int, default=200
        Minimum genes per cell (fixed mode and gene filtering)
    min_cells : int, default=3
        Minimum cells per gene
    max_pct_mt : float, default=20.0
        Maximum mitochondrial percentage (fixed mode)
    mad_nmads : float, default=5.0
        N MADs for log-library-size / log-n-genes outlier detection (mad mode)
    mad_nmads_mt : float, default=3.0
        N MADs for pct_counts_mt outlier detection (mad mode)
    mt_prefix : str, default="MT-"
        Mitochondrial gene prefix (human: "MT-", mouse: "mt-")
    batch_key : str or None, default=None
        Obs column for batch; threaded into HVG, scrublet, and per-batch MAD
    target_sum : float, default=1e4
        Target sum for normalization
    n_hvg : int, default=2000
        Number of highly variable genes
    hvg_flavor : str, default="seurat_v3"
        HVG selection method (requires scikit-misc for seurat_v3)
    n_pcs : int, default=50
        Number of principal components
    n_neighbors : int, default=15
        Number of neighbors for graph construction
    resolution : float, default=1.0
        Leiden clustering resolution
    leiden_flavor : {"leidenalg", "igraph"}, default="igraph"
        Leiden implementation (igraph is much faster)
    seed : int, default=0
        Random seed for reproducibility
    run_doublets : bool, default=True
        Whether to run scrublet doublet detection (flags, never auto-drops)
    inplace : bool, default=False
        If False, work on a copy; if True, modify input
    return_report : bool, default=True
        Whether to return detailed report dict

    Returns
    -------
    adata : AnnData
        Preprocessed dataset with:
        - X: log1p-normalized
        - layers['counts']: preserved raw counts
        - obsm['X_pca'], obsm['X_umap']: embeddings
        - obs['leiden']: cluster labels
        - obs['predicted_doublet'], obs['doublet_score']: if run_doublets=True
    report : dict or None
        Structured report with params, shapes, counts, warnings (if return_report=True)

    Raises
    ------
    ValueError
        - If neither layers['counts'] nor counts-like X is present
        - If hvg_flavor="seurat_v3" and layers['counts'] is missing
        - If n_obs == 0 after QC (complete cell wipeout)
        - If qc_mode not in {"fixed", "mad"}
        - If leiden_flavor not in {"leidenalg", "igraph"}
        - If batch_key is specified but not present in adata.obs

    Notes
    -----
    - HVG with flavor="seurat_v3" is computed on the RAW COUNTS layer, not on log-normalized X
    - Doublets are FLAGGED in obs, never auto-removed (agent decides)
    - neighbors has NO batch_key; batch correction is upstream (feed integrated obsm["X_*"] via use_rep)
    - MAD mode computes per-batch medians when batch_key is set
    """
    start_time = datetime.now(UTC)

    # Validate qc_mode
    if qc_mode not in {"fixed", "mad"}:
        raise ValueError(f"qc_mode must be 'fixed' or 'mad', got: {qc_mode}")

    # Validate leiden_flavor
    if leiden_flavor not in {"leidenalg", "igraph"}:
        raise ValueError(f"leiden_flavor must be 'leidenalg' or 'igraph', got: {leiden_flavor}")

    # Validate batch_key
    if batch_key is not None and batch_key not in adata.obs.columns:
        raise ValueError(
            f"batch_key='{batch_key}' not found in adata.obs. "
            f"Available columns: {list(adata.obs.columns)}"
        )

    # Work on copy unless inplace=True
    if not inplace:
        adata = adata.copy()

    # Preserve raw counts in layers['counts'] if not already there
    if LAYER_COUNTS not in adata.layers:
        if _looks_like_counts(adata.X):
            adata.layers[LAYER_COUNTS] = adata.X.copy()
        else:
            raise ValueError(
                f"Neither layers['{LAYER_COUNTS}'] nor a counts-like X is present. "
                "Cannot proceed with normalization on already-normalized data. "
                "Ensure raw counts are available."
            )

    initial_shape = (adata.n_obs, adata.n_vars)
    warnings = []

    # 1. QC metrics
    adata.var['mt'] = adata.var_names.str.startswith(mt_prefix)
    sc.pp.calculate_qc_metrics(
        adata, qc_vars=['mt'], percent_top=None, log1p=False, inplace=True
    )

    # 2. QC filtering
    cells_filtered_min_genes = 0
    cells_filtered_pct_mt = 0
    cells_flagged_mad = 0

    if qc_mode == "fixed":
        # Filter cells by min_genes
        n_before = adata.n_obs
        sc.pp.filter_cells(adata, min_genes=min_genes)
        cells_filtered_min_genes = n_before - adata.n_obs

        # Filter cells by max_pct_mt
        n_before = adata.n_obs
        adata = adata[adata.obs['pct_counts_mt'] < max_pct_mt, :].copy()
        cells_filtered_pct_mt = n_before - adata.n_obs

    elif qc_mode == "mad":
        # Adaptive QC: flag outliers via median-absolute-deviation
        # Compute per-batch when batch_key is set
        if batch_key is not None:
            adata.obs['qc_pass'] = True
            for batch in adata.obs[batch_key].unique():
                batch_mask = adata.obs[batch_key] == batch
                batch_data = adata.obs.loc[batch_mask]

                for metric, nmads in [
                    ('n_genes_by_counts', mad_nmads),
                    ('total_counts', mad_nmads),
                    ('pct_counts_mt', mad_nmads_mt),
                ]:
                    if metric in ['n_genes_by_counts', 'total_counts']:
                        values = np.log1p(batch_data[metric])
                    else:
                        values = batch_data[metric]

                    median = np.median(values)
                    mad = np.median(np.abs(values - median))
                    if mad == 0:  # Avoid division by zero
                        continue
                    lower = median - nmads * mad
                    upper = median + nmads * mad

                    outlier = (values < lower) | (values > upper)
                    adata.obs.loc[batch_mask, 'qc_pass'] = (
                        adata.obs.loc[batch_mask, 'qc_pass'] & ~outlier
                    )

            cells_flagged_mad = (~adata.obs['qc_pass']).sum()
            adata = adata[adata.obs['qc_pass'], :].copy()
            adata.obs.drop(columns=['qc_pass'], inplace=True)
        else:
            # Global MAD
            adata.obs['qc_pass'] = True
            for metric, nmads in [
                ('n_genes_by_counts', mad_nmads),
                ('total_counts', mad_nmads),
                ('pct_counts_mt', mad_nmads_mt),
            ]:
                if metric in ['n_genes_by_counts', 'total_counts']:
                    values = np.log1p(adata.obs[metric])
                else:
                    values = adata.obs[metric]

                median = np.median(values)
                mad = np.median(np.abs(values - median))
                if mad == 0:
                    continue
                lower = median - nmads * mad
                upper = median + nmads * mad

                outlier = (values < lower) | (values > upper)
                adata.obs['qc_pass'] = adata.obs['qc_pass'] & ~outlier

            cells_flagged_mad = (~adata.obs['qc_pass']).sum()
            adata = adata[adata.obs['qc_pass'], :].copy()
            adata.obs.drop(columns=['qc_pass'], inplace=True)

    # Filter genes by min_cells
    genes_filtered = 0
    n_before = adata.n_vars
    sc.pp.filter_genes(adata, min_cells=min_cells)
    genes_filtered = n_before - adata.n_vars

    post_qc_shape = (adata.n_obs, adata.n_vars)

    # Fail loud if QC wiped out all cells
    if adata.n_obs == 0:
        raise ValueError(
            f"QC removed all {initial_shape[0]} cells. "
            f"QC mode: {qc_mode}, min_genes={min_genes}, max_pct_mt={max_pct_mt}. "
            "Adjust thresholds or check data quality."
        )

    # 3. Doublet detection (optional, flags only, never auto-drops)
    doublets_flagged = 0
    if run_doublets:
        try:
            sc.pp.scrublet(adata, batch_key=batch_key, random_state=seed)
            doublets_flagged = adata.obs['predicted_doublet'].sum()
        except Exception as e:
            warnings.append(f"Scrublet failed: {e}. Skipping doublet detection.")

    # 4. Normalization
    sc.pp.normalize_total(adata, target_sum=target_sum)
    sc.pp.log1p(adata)

    # 5. Highly variable genes
    # seurat_v3 requires raw counts and scikit-misc
    if hvg_flavor == "seurat_v3":
        if LAYER_COUNTS not in adata.layers:
            raise ValueError(
                f"hvg_flavor='seurat_v3' requires raw counts in layers['{LAYER_COUNTS}']. "
                "The counts layer is missing."
            )
        try:
            sc.pp.highly_variable_genes(
                adata,
                n_top_genes=n_hvg,
                flavor=hvg_flavor,
                layer=LAYER_COUNTS,
                batch_key=batch_key,
                subset=False,
            )
        except ImportError as e:
            raise ImportError(
                f"hvg_flavor='seurat_v3' requires scikit-misc (skmisc.loess). "
                f"Install with: pip install scikit-misc. Error: {e}"
            ) from e
    else:
        sc.pp.highly_variable_genes(
            adata,
            n_top_genes=n_hvg,
            flavor=hvg_flavor,
            batch_key=batch_key,
            subset=False,
        )

    # 6. PCA
    sc.tl.pca(adata, n_comps=n_pcs, random_state=seed, svd_solver='arpack')

    # 7. Neighbors (no batch_key; integration is upstream)
    sc.pp.neighbors(adata, n_neighbors=n_neighbors, n_pcs=n_pcs, random_state=seed)

    # 8. UMAP
    sc.tl.umap(adata, random_state=seed)

    # 9. Leiden clustering
    sc.tl.leiden(
        adata,
        resolution=resolution,
        flavor=leiden_flavor,
        random_state=seed,
        key_added=OBS_LEIDEN,
    )

    end_time = datetime.now(UTC)

    if return_report:
        report = {
            "operation": "standard_preprocess",
            "initial_shape": initial_shape,
            "post_qc_shape": post_qc_shape,
            "final_shape": (adata.n_obs, adata.n_vars),
            "qc_mode": qc_mode,
        }

        if qc_mode == "fixed":
            report.update({
                "cells_filtered_min_genes": cells_filtered_min_genes,
                "cells_filtered_pct_mt": cells_filtered_pct_mt,
            })
        elif qc_mode == "mad":
            report.update({
                "cells_flagged_mad": cells_flagged_mad,
                "mad_nmads": mad_nmads,
                "mad_nmads_mt": mad_nmads_mt,
            })

        report.update({
            "genes_filtered_min_cells": genes_filtered,
            "doublets_flagged": doublets_flagged if run_doublets else None,
            "batch_key": batch_key,
            "n_hvg": n_hvg,
            "hvg_flavor": hvg_flavor,
            "n_pcs": n_pcs,
            "n_neighbors": n_neighbors,
            "n_clusters": len(adata.obs[OBS_LEIDEN].unique()),
            "resolution": resolution,
            "leiden_flavor": leiden_flavor,
            "params": {
                "qc_mode": qc_mode,
                "min_genes": min_genes,
                "min_cells": min_cells,
                "max_pct_mt": max_pct_mt,
                "mad_nmads": mad_nmads,
                "mad_nmads_mt": mad_nmads_mt,
                "mt_prefix": mt_prefix,
                "batch_key": batch_key,
                "target_sum": target_sum,
                "n_hvg": n_hvg,
                "hvg_flavor": hvg_flavor,
                "n_pcs": n_pcs,
                "n_neighbors": n_neighbors,
                "resolution": resolution,
                "leiden_flavor": leiden_flavor,
                "seed": seed,
                "run_doublets": run_doublets,
            },
            "keys_written": {
                "X": "log1p-normalized",
                "layers": [LAYER_COUNTS],
                "obsm": [OBSM_PCA, OBSM_UMAP],
                "obs": [OBS_LEIDEN] + (["predicted_doublet", "doublet_score"] if run_doublets else []),
            },
            "warnings": warnings,
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "duration_seconds": (end_time - start_time).total_seconds(),
        })
        return adata, report
    else:
        return adata, None


def _looks_like_counts(matrix) -> bool:
    """
    Heuristic: all-finite, non-negative, integer-valued sample -> likely raw counts.
    Used only to warn, never to silently coerce.
    """
    if matrix is None:
        return False

    # Sample to avoid memory issues on large matrices
    if hasattr(matrix, 'toarray'):
        # Sparse matrix
        sample = matrix[:min(1000, matrix.shape[0]), :min(100, matrix.shape[1])].toarray()
    else:
        sample = matrix[:min(1000, matrix.shape[0]), :min(100, matrix.shape[1])]

    if not np.all(np.isfinite(sample)):
        return False
    if np.any(sample < 0):
        return False
    if not np.allclose(sample, np.round(sample)):
        return False

    return True


def main(args):
    """CLI entry for the `preprocess` subcommand: run the standard
    QC -> normalize -> HVG -> PCA -> neighbors -> UMAP -> Leiden pipeline and
    write the processed AnnData. Fails loud (no try/except swallowing) and prints
    a trailing-JSON report the Rust bridge parses."""
    import json
    from . import io

    adata, _load_meta = io.load_h5ad(path=args.input)
    adata, report = standard_preprocess(adata, return_report=True)
    save_meta = io.save_h5ad(adata=adata, path=args.output)

    report = report or {}
    report["input"] = args.input
    report["output"] = args.output
    report["modality"] = getattr(args, "modality", "scrna")
    report["saved_bytes"] = save_meta.get("bytes")
    print(json.dumps(report, indent=2, default=str))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--modality', default='scrna')
    main(parser.parse_args())
