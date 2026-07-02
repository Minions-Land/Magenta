"""
I/O utilities for loading and saving AnnData and MuData objects.

Provides:
- load_h5ad / save_h5ad for single-modality AnnData
- load_h5mu / save_h5mu for multi-modality MuData
- Validation of required keys per convention (01-conventions.md)
- Fail-loud error messages with actionable hints
- Report dicts for downstream logging/provenance

All functions use keyword-only args and return structured reports.
"""

from pathlib import Path
from typing import Any

import anndata as ad
import mudata as md

from .conventions import (
    LAYER_COUNTS,
    OBS_LEIDEN,
    OBS_CELLTYPE,
    OBSM_PCA,
    validate_counts_layer,
)


def load_h5ad(
    *,
    path: str | Path,
    validate_counts: bool = False,
    backed: str | None = None,
) -> tuple[ad.AnnData, dict[str, Any]]:
    """
    Load an AnnData object from H5AD file.

    Args:
        path: Path to .h5ad file
        validate_counts: If True, verify that layers["counts"] exists
        backed: If 'r' or 'r+', open in backed mode (lazy loading)

    Returns:
        (adata, report) where report contains:
            - path: absolute path to loaded file
            - n_obs: number of observations (cells)
            - n_vars: number of variables (genes)
            - layers: list of layer keys
            - obsm_keys: list of obsm keys
            - obs_columns: list of obs column names
            - backed: whether file was opened in backed mode

    Raises:
        FileNotFoundError: if path does not exist
        KeyError: if validate_counts=True and layers["counts"] missing
    """
    path = Path(path).resolve()
    if not path.exists():
        raise FileNotFoundError(
            f"H5AD file not found: {path}\n"
            "Check that the file path is correct and the file has been created."
        )

    adata = ad.read_h5ad(path, backed=backed)

    if validate_counts:
        validate_counts_layer(adata, layer_key=LAYER_COUNTS)

    report = {
        "path": str(path),
        "n_obs": adata.n_obs,
        "n_vars": adata.n_vars,
        "layers": list(adata.layers.keys()),
        "obsm_keys": list(adata.obsm.keys()),
        "obs_columns": list(adata.obs.columns),
        "backed": backed is not None,
    }

    return adata, report


def save_h5ad(
    *,
    adata: ad.AnnData,
    path: str | Path,
    compression: str | None = "gzip",
    compression_opts: int | None = None,
) -> dict[str, Any]:
    """
    Save an AnnData object to H5AD file.

    Args:
        adata: AnnData object to save
        path: Output path for .h5ad file
        compression: Compression algorithm (gzip, lzf, or None)
        compression_opts: Compression level (1-9 for gzip)

    Returns:
        Report dict containing:
            - path: absolute path to saved file
            - n_obs: number of observations saved
            - n_vars: number of variables saved
            - size_bytes: file size in bytes
            - layers: list of layer keys saved
            - obsm_keys: list of obsm keys saved

    Raises:
        ValueError: if adata is None or invalid
        OSError: if write fails (permissions, disk space, etc.)
    """
    if adata is None:
        raise ValueError("Cannot save None as AnnData object")

    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    adata.write_h5ad(
        path,
        compression=compression,
        compression_opts=compression_opts,
    )

    report = {
        "path": str(path),
        "n_obs": adata.n_obs,
        "n_vars": adata.n_vars,
        "size_bytes": path.stat().st_size,
        "layers": list(adata.layers.keys()),
        "obsm_keys": list(adata.obsm.keys()),
    }

    return report


def load_h5mu(
    *,
    path: str | Path,
    validate_counts: bool = False,
    backed: str | None = None,
) -> tuple[md.MuData, dict[str, Any]]:
    """
    Load a MuData object from H5MU file.

    Args:
        path: Path to .h5mu file
        validate_counts: If True, verify that each modality has layers["counts"]
        backed: If 'r' or 'r+', open in backed mode (lazy loading)

    Returns:
        (mdata, report) where report contains:
            - path: absolute path to loaded file
            - modalities: dict mapping modality name to shape info
            - n_obs: total number of observations
            - backed: whether file was opened in backed mode

    Raises:
        FileNotFoundError: if path does not exist
        KeyError: if validate_counts=True and any modality missing layers["counts"]
    """
    path = Path(path).resolve()
    if not path.exists():
        raise FileNotFoundError(
            f"H5MU file not found: {path}\n"
            "Check that the file path is correct and the file has been created."
        )

    mdata = md.read_h5mu(path, backed=backed)

    if validate_counts:
        for mod_name, mod_data in mdata.mod.items():
            try:
                validate_counts_layer(mod_data, layer_key=LAYER_COUNTS)
            except KeyError as e:
                raise KeyError(
                    f"Modality '{mod_name}' validation failed: {e}"
                ) from e

    modalities = {}
    for mod_name, mod_data in mdata.mod.items():
        modalities[mod_name] = {
            "n_obs": mod_data.n_obs,
            "n_vars": mod_data.n_vars,
            "layers": list(mod_data.layers.keys()),
            "obsm_keys": list(mod_data.obsm.keys()),
        }

    report = {
        "path": str(path),
        "modalities": modalities,
        "n_obs": mdata.n_obs,
        "backed": backed is not None,
    }

    return mdata, report


def save_h5mu(
    *,
    mdata: md.MuData,
    path: str | Path,
    compression: str | None = "gzip",
    compression_opts: int | None = None,
) -> dict[str, Any]:
    """
    Save a MuData object to H5MU file.

    Args:
        mdata: MuData object to save
        path: Output path for .h5mu file
        compression: Compression algorithm (gzip, lzf, or None)
        compression_opts: Compression level (1-9 for gzip)

    Returns:
        Report dict containing:
            - path: absolute path to saved file
            - n_obs: total number of observations
            - size_bytes: file size in bytes
            - modalities: dict mapping modality name to shape info

    Raises:
        ValueError: if mdata is None or invalid
        OSError: if write fails (permissions, disk space, etc.)
    """
    if mdata is None:
        raise ValueError("Cannot save None as MuData object")

    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    mdata.write_h5mu(
        path,
        compression=compression,
        compression_opts=compression_opts,
    )

    modalities = {}
    for mod_name, mod_data in mdata.mod.items():
        modalities[mod_name] = {
            "n_obs": mod_data.n_obs,
            "n_vars": mod_data.n_vars,
            "layers": list(mod_data.layers.keys()),
            "obsm_keys": list(mod_data.obsm.keys()),
        }

    report = {
        "path": str(path),
        "n_obs": mdata.n_obs,
        "size_bytes": path.stat().st_size,
        "modalities": modalities,
    }

    return report


def validate_processed_adata(
    adata: ad.AnnData,
    *,
    require_counts: bool = True,
    require_embedding: bool = True,
    require_clusters: bool = False,
) -> dict[str, Any]:
    """
    Validate that an AnnData object meets standard processing requirements.

    Args:
        adata: AnnData object to validate
        require_counts: If True, verify layers["counts"] exists
        require_embedding: If True, verify at least one X_* embedding in obsm
        require_clusters: If True, verify obs["leiden"] exists

    Returns:
        Validation report dict with keys:
            - valid: bool, True if all requirements met
            - errors: list of error messages (empty if valid)
            - warnings: list of warning messages
            - has_counts: bool
            - has_embedding: bool
            - has_clusters: bool
            - embeddings: list of found embedding keys

    Does not raise exceptions - returns validation status in report.
    """
    errors = []
    warnings = []

    has_counts = LAYER_COUNTS in adata.layers
    if require_counts and not has_counts:
        errors.append(
            f"Missing required layer '{LAYER_COUNTS}'. "
            f"Available layers: {list(adata.layers.keys())}"
        )

    embeddings = [k for k in adata.obsm.keys() if k.startswith("X_")]
    has_embedding = len(embeddings) > 0
    if require_embedding and not has_embedding:
        errors.append(
            "No embeddings found in obsm. "
            f"Expected at least one key starting with 'X_'. "
            f"Available obsm keys: {list(adata.obsm.keys())}"
        )

    has_clusters = OBS_LEIDEN in adata.obs.columns
    if require_clusters and not has_clusters:
        errors.append(
            f"Missing required obs column '{OBS_LEIDEN}'. "
            f"Available obs columns: {list(adata.obs.columns)}"
        )

    # Optional warnings for recommended keys
    if OBS_CELLTYPE not in adata.obs.columns:
        warnings.append(
            f"Recommended obs column '{OBS_CELLTYPE}' not found. "
            "Consider adding cell type annotations."
        )

    if OBSM_PCA not in adata.obsm.keys() and has_embedding:
        warnings.append(
            f"PCA embedding '{OBSM_PCA}' not found. "
            "Many downstream tools expect PCA coordinates."
        )

    report = {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "has_counts": has_counts,
        "has_embedding": has_embedding,
        "has_clusters": has_clusters,
        "embeddings": embeddings,
    }

    return report


def validate_layout(args):
    """CLI entry for validate_layout subcommand."""
    import sys
    import json

    # Load the dataset
    if args.input.endswith('.h5mu'):
        mdata, _ = load_h5mu(path=args.input)
        # Validate each modality
        all_reports = {}
        for mod_name, mod_data in mdata.mod.items():
            report = validate_processed_adata(
                mod_data,
                require_counts=True,
                require_embedding=False,
                require_clusters=False,
            )
            all_reports[mod_name] = report

        # Overall validation
        all_valid = all([r['valid'] for r in all_reports.values()])

        print(f"Validation report for {args.input}:")
        print(json.dumps(all_reports, indent=2))

        sys.exit(0 if all_valid else 1)
    else:
        adata, _ = load_h5ad(path=args.input)
        report = validate_processed_adata(
            adata,
            require_counts=True,
            require_embedding=False,
            require_clusters=False,
        )

        print(f"Validation report for {args.input}:")
        print(json.dumps(report, indent=2))

        sys.exit(0 if report['valid'] else 1)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Test I/O utilities')
    parser.add_argument('--input', required=True, help='Path to h5ad/h5mu file')
    args = parser.parse_args()
    validate_layout(args)
