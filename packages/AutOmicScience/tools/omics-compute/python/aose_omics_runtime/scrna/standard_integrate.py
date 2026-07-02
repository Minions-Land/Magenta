"""
Standard batch integration for scRNA-seq data.

Provides standard_integrate() frozen helper that wraps Harmony
with standardized parameters and returns integrated embeddings.

This is the single source of truth for batch correction in scRNA-seq analysis.
"""

from typing import Optional, Literal
from datetime import datetime, UTC
import numpy as np
import scanpy as sc
from anndata import AnnData

from ..shared.conventions import (
    OBS_BATCH,
    OBSM_PCA,
    OBSM_HARMONY,
)

# Module-top constants (single source of truth)
DEFAULT_MAX_ITER_HARMONY = 10
DEFAULT_N_PCS = 50
DEFAULT_SIGMA = 0.1
DEFAULT_THETA = 2.0


def standard_integrate(
    adata: AnnData,
    *,
    batch_key: str = OBS_BATCH,
    method: Literal["harmony", "scanorama", "bbknn"] = "harmony",
    n_pcs: int = DEFAULT_N_PCS,
    max_iter_harmony: int = DEFAULT_MAX_ITER_HARMONY,
    sigma: float = DEFAULT_SIGMA,
    theta: float = DEFAULT_THETA,
    target_key: str = OBSM_HARMONY,
    return_report: bool = True,
) -> tuple[AnnData, Optional[dict]]:
    """
    Standard batch integration using Harmony (or other methods).

    Applies batch correction to PCA embeddings and stores corrected embeddings
    in obsm. Downstream neighbors/UMAP should use the corrected embeddings.

    Parameters
    ----------
    adata : AnnData
        Annotated data matrix with PCA embeddings in obsm[OBSM_PCA]
    batch_key : str, default=OBS_BATCH
        Key in adata.obs containing batch labels
    method : {'harmony', 'scanorama', 'bbknn'}, default='harmony'
        Integration method to use
    n_pcs : int, default=50
        Number of PCs to use for integration
    max_iter_harmony : int, default=10
        Maximum iterations for Harmony
    sigma : float, default=0.1
        Harmony ridge regression penalty parameter
    theta : float, default=2.0
        Harmony diversity clustering penalty parameter (higher = more diverse)
    target_key : str, default=OBSM_HARMONY
        Key in obsm to store corrected embeddings
    return_report : bool, default=True
        Whether to return detailed report dict

    Returns
    -------
    adata : AnnData
        Input AnnData with corrected embeddings added to obsm
    report : dict or None
        Structured report with all params and timestamps (if return_report=True)

    Raises
    ------
    KeyError
        If batch_key not found in obs or PCA not found in obsm
    ValueError
        If method is not supported or data is invalid
    ImportError
        If required integration package is not installed
    """
    start_time = datetime.now(UTC)

    # Validate inputs
    if batch_key not in adata.obs.columns:
        raise KeyError(
            f"Batch key '{batch_key}' not found in obs. "
            f"Available columns: {list(adata.obs.columns)}"
        )

    if OBSM_PCA not in adata.obsm:
        raise KeyError(
            f"PCA embedding '{OBSM_PCA}' not found in obsm. "
            f"Run PCA before integration. "
            f"Available embeddings: {list(adata.obsm.keys())}"
        )

    n_batches = adata.obs[batch_key].nunique()
    if n_batches < 2:
        raise ValueError(
            f"Integration requires at least 2 batches, found {n_batches}. "
            f"Check that '{batch_key}' contains multiple batch labels."
        )

    # Apply integration method
    if method == "harmony":
        # Call harmonypy DIRECTLY rather than through scanpy.external's
        # harmony_integrate. scanpy 1.11's wrapper does `Z_corr.T`, which assumes
        # the OLD harmonypy layout (n_pcs, n_cells); harmonypy >=2.0 already
        # returns (n_cells, n_pcs), so the wrapper transposes it to the wrong
        # shape and anndata rejects the assignment. Calling run_harmony ourselves
        # and orienting the output by the known cell count is version-robust.
        try:
            import harmonypy
        except ImportError as e:
            raise ImportError(
                "Harmony integration requires 'harmonypy' package. "
                "Install with: pip install harmonypy"
            ) from e

        ho = harmonypy.run_harmony(
            adata.obsm[OBSM_PCA],
            adata.obs,
            [batch_key],
            max_iter_harmony=max_iter_harmony,
            sigma=sigma,
            theta=theta,
        )
        Z = np.asarray(ho.Z_corr)
        # Orient to (n_cells, n_pcs) regardless of harmonypy version.
        if Z.shape[0] != adata.n_obs and Z.shape[1] == adata.n_obs:
            Z = Z.T
        adata.obsm[target_key] = Z

    elif method == "scanorama":
        try:
            import scanpy.external as sce
        except ImportError as e:
            raise ImportError(
                "Scanorama integration requires 'scanorama' package. "
                "Install with: pip install scanorama"
            ) from e

        sce.pp.scanorama_integrate(
            adata,
            key=batch_key,
            basis=OBSM_PCA,
            adjusted_basis=target_key,
        )

    elif method == "bbknn":
        raise NotImplementedError(
            "BBKNN integration modifies the neighbors graph directly. "
            "Use sc.external.pp.bbknn() manually if you need graph-based integration."
        )
    else:
        raise ValueError(
            f"Unknown integration method: {method}. "
            f"Supported methods: harmony, scanorama, bbknn"
        )

    end_time = datetime.now(UTC)

    if return_report:
        report = {
            "operation": "standard_integrate",
            "method": method,
            "n_batches": n_batches,
            "batch_sizes": adata.obs[batch_key].value_counts().to_dict(),
            "parameters": {
                "batch_key": batch_key,
                "n_pcs": n_pcs,
                "max_iter_harmony": max_iter_harmony if method == "harmony" else None,
                "sigma": sigma if method == "harmony" else None,
                "theta": theta if method == "harmony" else None,
                "target_key": target_key,
            },
            "input_embedding": OBSM_PCA,
            "output_embedding": target_key,
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "duration_seconds": (end_time - start_time).total_seconds(),
        }
        return adata, report
    else:
        return adata, None


def recompute_neighbors_after_integration(
    adata: AnnData,
    *,
    use_rep: str = OBSM_HARMONY,
    n_neighbors: int = 15,
    n_pcs: Optional[int] = None,
    seed: int = 0,
) -> AnnData:
    """
    Recompute neighbors graph using integrated embeddings.

    After batch correction, you should recompute neighbors on the corrected
    embeddings before running UMAP/Leiden.

    Parameters
    ----------
    adata : AnnData
        AnnData with integrated embeddings
    use_rep : str, default=OBSM_HARMONY
        Key in obsm to use for neighbor computation
    n_neighbors : int, default=15
        Number of neighbors
    n_pcs : int or None
        Number of dimensions to use (None = use all available)
    seed : int, default=0
        Random seed

    Returns
    -------
    adata : AnnData
        Input AnnData with updated neighbors graph
    """
    if use_rep not in adata.obsm:
        raise KeyError(
            f"Embedding '{use_rep}' not found in obsm. "
            f"Available embeddings: {list(adata.obsm.keys())}"
        )

    sc.pp.neighbors(
        adata,
        use_rep=use_rep,
        n_neighbors=n_neighbors,
        n_pcs=n_pcs,
        random_state=seed,
    )

    return adata


def main(args):
    """CLI entry for the `integrate` subcommand: run standard batch integration
    and write the corrected AnnData. Fails loud (no try/except swallowing) and
    prints a trailing-JSON report the Rust bridge parses."""
    import json
    from ..shared import io

    adata, _load_meta = io.load_h5ad(path=args.input)
    adata, report = standard_integrate(
        adata,
        batch_key=args.batch_key,
        method=args.method,
        return_report=True,
    )
    save_meta = io.save_h5ad(adata=adata, path=args.output)

    report = report or {}
    report["input"] = args.input
    report["output"] = args.output
    report["batch_key"] = args.batch_key
    report["method"] = args.method
    report["saved_bytes"] = save_meta.get("bytes")
    print(json.dumps(report, indent=2, default=str))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--batch-key', default='batch')
    parser.add_argument('--method', default='harmony')
    main(parser.parse_args())
