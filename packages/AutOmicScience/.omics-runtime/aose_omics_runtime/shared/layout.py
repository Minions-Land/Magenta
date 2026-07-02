"""
Layout validator for AnnData/MuData/SpatialData objects.

Validates that required keys (layers, obsm, obs) are present per the
data conventions. Imports all key constants from conventions.py —
never re-declares them (single source of truth, 01-conventions.md §6).

Functions:
- assert_layout(): Fail-loud validator, raises KeyError if keys missing
- describe_layout(): Non-failing descriptor, returns report dict
"""

from typing import Any

try:
    import anndata as ad
except ImportError:
    ad = None

try:
    import mudata as md
except ImportError:
    md = None

# Import all key constants from conventions.py (single source of truth)
from .conventions import (
    LAYER_COUNTS,
    LAYER_SPLICED,
    LAYER_UNSPLICED,
    OBS_LEIDEN,
    OBS_CELLTYPE,
    OBS_BATCH,
    OBS_CONDITION,
    OBS_DONOR,
    OBS_TISSUE,
    OBSM_PCA,
    OBSM_HARMONY,
    OBSM_SCVI,
    OBSM_UMAP,
    OBSM_TSNE,
    OBSM_LSI,
    OBSM_SPECTRAL,
    OBSM_MULTIVI,
    OBSM_SPATIAL,
    OBSM_PROPORTIONS,
    VAR_HIGHLY_VARIABLE,
    VAR_GENE_NAME,
    VAR_GENE_ID,
    EMBEDDING_PREFIX,
    is_embedding_key,
)


def assert_layout(
    adata,
    *,
    expect_layers: list[str] = None,
    expect_obsm: list[str] = None,
    expect_obs: list[str] = None,
) -> dict[str, Any]:
    """
    Validate that expected keys are present in AnnData object.

    Raises KeyError with actionable message if any expected key is missing.
    On success, returns a report dict with layout info.

    Parameters
    ----------
    adata : AnnData or MuData
        Object to validate
    expect_layers : list[str], optional
        Layer keys that must be present (e.g., [LAYER_COUNTS])
    expect_obsm : list[str], optional
        Obsm keys that must be present (e.g., [OBSM_PCA, OBSM_UMAP])
    expect_obs : list[str], optional
        Obs column names that must be present (e.g., [OBS_LEIDEN, OBS_CELLTYPE])

    Returns
    -------
    dict
        Report with n_obs, n_vars, present keys, and checked expectations

    Raises
    ------
    KeyError
        If any expected key is missing, with actionable message
    """
    if expect_layers is None:
        expect_layers = []
    if expect_obsm is None:
        expect_obsm = []
    if expect_obs is None:
        expect_obs = []

    # Extract layout info
    n_obs = adata.n_obs
    n_vars = adata.n_vars
    present_layers = list(adata.layers.keys()) if hasattr(adata, 'layers') else []
    present_obsm = list(adata.obsm.keys()) if hasattr(adata, 'obsm') else []
    present_obs = list(adata.obs.columns) if hasattr(adata, 'obs') else []

    # Check expected layers
    for layer_key in expect_layers:
        if layer_key not in present_layers:
            raise KeyError(
                f"Expected layer '{layer_key}' not found. "
                f"Available layers: {present_layers}. "
                f"The data conventions require raw counts in layers['{LAYER_COUNTS}']. "
                f"Check that the input file has the expected structure."
            )

    # Check expected obsm keys
    for obsm_key in expect_obsm:
        if obsm_key not in present_obsm:
            raise KeyError(
                f"Expected obsm key '{obsm_key}' not found. "
                f"Available obsm keys: {present_obsm}. "
                f"Embeddings should follow the '{EMBEDDING_PREFIX}*' namespace convention."
            )

    # Check expected obs columns
    for obs_col in expect_obs:
        if obs_col not in present_obs:
            raise KeyError(
                f"Expected obs column '{obs_col}' not found. "
                f"Available obs columns: {present_obs[:20]}"
                + (f" (+{len(present_obs) - 20} more)" if len(present_obs) > 20 else "")
                + f". Ensure the upstream step produced this column."
            )

    # Build report
    report = {
        "n_obs": int(n_obs),
        "n_vars": int(n_vars),
        "layers": present_layers,
        "obsm": present_obsm,
        "obs_cols": present_obs,
        "checked": {
            "layers": expect_layers,
            "obsm": expect_obsm,
            "obs": expect_obs,
        },
        "all_checks_passed": True,
    }

    return report


def describe_layout(adata) -> dict[str, Any]:
    """
    Describe the layout of an AnnData/MuData object without validation.

    Never raises — returns current state of layers/obsm/obs for inspection.

    Parameters
    ----------
    adata : AnnData or MuData
        Object to describe

    Returns
    -------
    dict
        Report with n_obs, n_vars, and all present keys
    """
    n_obs = adata.n_obs
    n_vars = adata.n_vars
    present_layers = list(adata.layers.keys()) if hasattr(adata, 'layers') else []
    present_obsm = list(adata.obsm.keys()) if hasattr(adata, 'obsm') else []
    present_obs = list(adata.obs.columns) if hasattr(adata, 'obs') else []

    # Identify recognized embeddings (any obsm key matching X_* namespace)
    recognized_embeddings = [k for k in present_obsm if is_embedding_key(k)]

    report = {
        "n_obs": int(n_obs),
        "n_vars": int(n_vars),
        "layers": present_layers,
        "obsm": present_obsm,
        "obs_cols": present_obs,
        "recognized_embeddings": recognized_embeddings,
    }

    return report
