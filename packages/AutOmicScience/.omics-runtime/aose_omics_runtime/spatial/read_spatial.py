"""
Spatial transcriptomics data loaders for Visium, Xenium, and MERFISH.

Provides:
- load_visium: Load 10x Visium spatial transcriptomics data
- load_xenium: Load 10x Xenium spatial transcriptomics data
- load_merfish: Load MERFISH spatial transcriptomics data
- validate_spatial_adata: Validate spatial data structure

All functions return AnnData with standardized spatial coordinate keys
and structured reports for provenance tracking.
"""

from pathlib import Path
from typing import Any, Literal, Optional
import warnings

import anndata as ad
import numpy as np
import pandas as pd
import scanpy as sc

from ..shared.conventions import (
    LAYER_COUNTS,
    OBSM_SPATIAL,
    OBS_BATCH,
)


def load_visium(
    *,
    path: str | Path,
    count_file: str = "filtered_feature_bc_matrix.h5",
    library_id: Optional[str] = None,
    load_images: bool = True,
    source_image_path: Optional[str | Path] = None,
) -> tuple[ad.AnnData, dict[str, Any]]:
    """
    Load 10x Visium spatial transcriptomics data.

    Args:
        path: Path to the Space Ranger output directory
        count_file: Name of the count matrix file (h5 or directory name)
        library_id: Library identifier (if None, inferred from path)
        load_images: Whether to load histology images
        source_image_path: Optional override for image path

    Returns:
        (adata, report) where adata contains:
            - X: normalized gene expression
            - layers["counts"]: raw count matrix
            - obsm["spatial"]: spot coordinates (array of shape [n_spots, 2])
            - obs: spot metadata (in_tissue, array_row, array_col)
            - uns["spatial"]: spatial metadata and images

        report contains:
            - path: absolute path to data directory
            - n_obs: number of spots
            - n_vars: number of genes
            - library_id: library identifier
            - images_loaded: whether images were loaded
            - coordinate_range: min/max of spatial coordinates

    Raises:
        FileNotFoundError: if path or required files do not exist
        ValueError: if data structure is invalid

    Example:
        >>> adata, report = load_visium(path="spaceranger_output/sample1")
        >>> print(adata.obsm["spatial"].shape)  # (n_spots, 2)
    """
    path = Path(path).resolve()
    if not path.exists():
        raise FileNotFoundError(
            f"Visium data directory not found: {path}\n"
            "Expected Space Ranger output directory with spatial/ subdirectory."
        )

    if library_id is None:
        library_id = path.name

    # Use scanpy's built-in Visium reader
    try:
        adata = sc.read_visium(
            path,
            count_file=count_file,
            library_id=library_id,
            load_images=load_images,
            source_image_path=source_image_path,
        )
    except Exception as e:
        raise ValueError(
            f"Failed to load Visium data from {path}: {e}\n"
            "Check that the directory contains Space Ranger outputs:\n"
            "  - filtered_feature_bc_matrix.h5 (or matrix.mtx.gz)\n"
            "  - spatial/tissue_positions_list.csv\n"
            "  - spatial/scalefactors_json.json"
        ) from e

    # Standardize: ensure raw counts are in layers["counts"]
    if LAYER_COUNTS not in adata.layers:
        adata.layers[LAYER_COUNTS] = adata.X.copy()

    # Ensure spatial coordinates are in obsm["spatial"]
    # scanpy puts them in uns["spatial"][library_id]["images"]
    if OBSM_SPATIAL not in adata.obsm:
        if "spatial" in adata.uns and library_id in adata.uns["spatial"]:
            spatial_key = adata.uns["spatial"][library_id]
            if "spatial" in adata.obsm:
                # scanpy already put it in obsm, just verify
                pass
            else:
                raise ValueError(
                    f"Spatial coordinates not found in expected location. "
                    f"Available obsm keys: {list(adata.obsm.keys())}"
                )
        else:
            raise ValueError(
                f"No spatial metadata found in uns['spatial']['{library_id}']. "
                "Check that spatial/ directory contains tissue_positions_list.csv"
            )

    # Compute coordinate range for report
    spatial_coords = adata.obsm[OBSM_SPATIAL]
    coord_range = {
        "x_min": float(np.min(spatial_coords[:, 0])),
        "x_max": float(np.max(spatial_coords[:, 0])),
        "y_min": float(np.min(spatial_coords[:, 1])),
        "y_max": float(np.max(spatial_coords[:, 1])),
    }

    # Count in-tissue spots
    n_in_tissue = adata.obs.get("in_tissue", pd.Series([1] * adata.n_obs)).sum()

    report = {
        "platform": "visium",
        "path": str(path),
        "library_id": library_id,
        "n_obs": adata.n_obs,
        "n_vars": adata.n_vars,
        "n_in_tissue": int(n_in_tissue),
        "images_loaded": load_images and "spatial" in adata.uns,
        "coordinate_range": coord_range,
        "layers": list(adata.layers.keys()),
        "obsm_keys": list(adata.obsm.keys()),
    }

    return adata, report


def load_xenium(
    *,
    path: str | Path,
    cell_feature_matrix: str = "cell_feature_matrix.h5",
    cells_table: str = "cells.csv.gz",
    min_counts: int = 0,
    min_genes: int = 0,
) -> tuple[ad.AnnData, dict[str, Any]]:
    """
    Load 10x Xenium spatial transcriptomics data.

    Xenium provides single-cell resolution spatial data with subcellular
    transcript detection.

    Args:
        path: Path to Xenium output directory
        cell_feature_matrix: Name of the cell-by-feature count matrix file
        cells_table: Name of the cell metadata table (contains x, y coordinates)
        min_counts: Minimum counts per cell for filtering
        min_genes: Minimum genes per cell for filtering

    Returns:
        (adata, report) where adata contains:
            - X: gene expression matrix
            - layers["counts"]: raw count matrix
            - obsm["spatial"]: cell centroid coordinates (array of shape [n_cells, 2])
            - obs: cell metadata (cell_id, nucleus_area, etc.)

        report contains:
            - path: absolute path to data directory
            - n_obs: number of cells (after filtering)
            - n_vars: number of genes
            - n_filtered_cells: number of cells removed by filters
            - coordinate_range: min/max of spatial coordinates

    Raises:
        FileNotFoundError: if path or required files do not exist
        ValueError: if data structure is invalid

    Example:
        >>> adata, report = load_xenium(
        ...     path="xenium_output/sample1",
        ...     min_counts=10,
        ...     min_genes=5
        ... )
    """
    path = Path(path).resolve()
    if not path.exists():
        raise FileNotFoundError(
            f"Xenium data directory not found: {path}\n"
            "Expected Xenium Analyzer output directory."
        )

    # Load count matrix
    matrix_path = path / cell_feature_matrix
    if not matrix_path.exists():
        raise FileNotFoundError(
            f"Cell feature matrix not found: {matrix_path}\n"
            f"Expected file: {cell_feature_matrix}"
        )

    adata = sc.read_10x_h5(matrix_path)

    # Load spatial coordinates from cells table
    cells_path = path / cells_table
    if not cells_path.exists():
        raise FileNotFoundError(
            f"Cells metadata table not found: {cells_path}\n"
            f"Expected file: {cells_table}"
        )

    cells_df = pd.read_csv(cells_path)

    # Xenium cells.csv typically has columns: cell_id, x_centroid, y_centroid, etc.
    if "x_centroid" not in cells_df.columns or "y_centroid" not in cells_df.columns:
        raise ValueError(
            f"Expected 'x_centroid' and 'y_centroid' columns in {cells_table}.\n"
            f"Found columns: {list(cells_df.columns)}"
        )

    # Match cell IDs between count matrix and metadata
    # Xenium cell IDs are typically in index or a 'cell_id' column
    if "cell_id" in cells_df.columns:
        cells_df = cells_df.set_index("cell_id")

    # Align cells (scanpy index should match cells.csv rows)
    common_cells = adata.obs_names.intersection(cells_df.index)
    if len(common_cells) == 0:
        warnings.warn(
            "No matching cell IDs between count matrix and cells.csv. "
            "Assuming row order matches."
        )
        if len(adata.obs_names) != len(cells_df):
            raise ValueError(
                f"Row count mismatch: count matrix has {len(adata.obs_names)} cells, "
                f"cells.csv has {len(cells_df)} rows."
            )
        cells_df.index = adata.obs_names
        common_cells = adata.obs_names

    adata = adata[common_cells, :].copy()
    cells_df = cells_df.loc[common_cells]

    # Add spatial coordinates
    adata.obsm[OBSM_SPATIAL] = cells_df[["x_centroid", "y_centroid"]].values

    # Add other cell metadata to obs
    for col in cells_df.columns:
        if col not in ["x_centroid", "y_centroid"]:
            adata.obs[col] = cells_df[col].values

    # Store raw counts
    if LAYER_COUNTS not in adata.layers:
        adata.layers[LAYER_COUNTS] = adata.X.copy()

    # Filter cells
    n_before = adata.n_obs
    if min_counts > 0 or min_genes > 0:
        sc.pp.filter_cells(adata, min_counts=min_counts, min_genes=min_genes)
    n_filtered = n_before - adata.n_obs

    # Compute coordinate range
    spatial_coords = adata.obsm[OBSM_SPATIAL]
    coord_range = {
        "x_min": float(np.min(spatial_coords[:, 0])),
        "x_max": float(np.max(spatial_coords[:, 0])),
        "y_min": float(np.min(spatial_coords[:, 1])),
        "y_max": float(np.max(spatial_coords[:, 1])),
    }

    report = {
        "platform": "xenium",
        "path": str(path),
        "n_obs": adata.n_obs,
        "n_vars": adata.n_vars,
        "n_filtered_cells": n_filtered,
        "coordinate_range": coord_range,
        "layers": list(adata.layers.keys()),
        "obsm_keys": list(adata.obsm.keys()),
        "obs_columns": list(adata.obs.columns),
    }

    return adata, report


def load_merfish(
    *,
    path: str | Path,
    counts_file: str,
    metadata_file: str,
    x_col: str = "x",
    y_col: str = "y",
    cell_id_col: str = "cell_id",
    delimiter: str = ",",
) -> tuple[ad.AnnData, dict[str, Any]]:
    """
    Load MERFISH spatial transcriptomics data from CSV files.

    MERFISH data typically comes as separate counts and metadata files.

    Args:
        path: Path to directory containing MERFISH data files
        counts_file: Name of counts matrix file (CSV/TSV with cells x genes)
        metadata_file: Name of metadata file (CSV/TSV with cell_id, x, y, etc.)
        x_col: Column name for x coordinates in metadata
        y_col: Column name for y coordinates in metadata
        cell_id_col: Column name for cell identifiers
        delimiter: Delimiter for CSV files (',' or '\t')

    Returns:
        (adata, report) where adata contains:
            - X: gene expression matrix
            - layers["counts"]: raw count matrix
            - obsm["spatial"]: cell coordinates (array of shape [n_cells, 2])
            - obs: cell metadata from metadata_file

        report contains:
            - path: absolute path to data directory
            - n_obs: number of cells
            - n_vars: number of genes
            - coordinate_range: min/max of spatial coordinates

    Raises:
        FileNotFoundError: if path or required files do not exist
        ValueError: if data structure is invalid or columns missing

    Example:
        >>> adata, report = load_merfish(
        ...     path="merfish_data/",
        ...     counts_file="counts.csv",
        ...     metadata_file="cell_metadata.csv",
        ... )
    """
    path = Path(path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"MERFISH data directory not found: {path}")

    counts_path = path / counts_file
    metadata_path = path / metadata_file

    if not counts_path.exists():
        raise FileNotFoundError(f"Counts file not found: {counts_path}")
    if not metadata_path.exists():
        raise FileNotFoundError(f"Metadata file not found: {metadata_path}")

    # Load counts matrix
    counts_df = pd.read_csv(counts_path, delimiter=delimiter, index_col=0)
    adata = ad.AnnData(X=counts_df.values)
    adata.obs_names = counts_df.index.astype(str)
    adata.var_names = counts_df.columns.astype(str)

    # Load metadata
    metadata_df = pd.read_csv(metadata_path, delimiter=delimiter)

    # Validate required columns
    required_cols = [cell_id_col, x_col, y_col]
    missing_cols = [col for col in required_cols if col not in metadata_df.columns]
    if missing_cols:
        raise ValueError(
            f"Missing required columns in metadata: {missing_cols}\n"
            f"Available columns: {list(metadata_df.columns)}"
        )

    # Set cell_id as index
    metadata_df = metadata_df.set_index(cell_id_col)
    metadata_df.index = metadata_df.index.astype(str)

    # Align with counts matrix
    common_cells = adata.obs_names.intersection(metadata_df.index)
    if len(common_cells) == 0:
        raise ValueError(
            f"No matching cell IDs between counts matrix and metadata.\n"
            f"Counts index sample: {adata.obs_names[:5].tolist()}\n"
            f"Metadata index sample: {metadata_df.index[:5].tolist()}"
        )

    adata = adata[common_cells, :].copy()
    metadata_df = metadata_df.loc[common_cells]

    # Add spatial coordinates
    adata.obsm[OBSM_SPATIAL] = metadata_df[[x_col, y_col]].values

    # Add other metadata to obs
    for col in metadata_df.columns:
        if col not in [x_col, y_col]:
            adata.obs[col] = metadata_df[col].values

    # Store raw counts
    if LAYER_COUNTS not in adata.layers:
        adata.layers[LAYER_COUNTS] = adata.X.copy()

    # Compute coordinate range
    spatial_coords = adata.obsm[OBSM_SPATIAL]
    coord_range = {
        "x_min": float(np.min(spatial_coords[:, 0])),
        "x_max": float(np.max(spatial_coords[:, 0])),
        "y_min": float(np.min(spatial_coords[:, 1])),
        "y_max": float(np.max(spatial_coords[:, 1])),
    }

    report = {
        "platform": "merfish",
        "path": str(path),
        "n_obs": adata.n_obs,
        "n_vars": adata.n_vars,
        "coordinate_range": coord_range,
        "layers": list(adata.layers.keys()),
        "obsm_keys": list(adata.obsm.keys()),
        "obs_columns": list(adata.obs.columns),
    }

    return adata, report


def validate_spatial_adata(
    adata: ad.AnnData,
    *,
    require_counts: bool = True,
    require_images: bool = False,
    platform: Optional[Literal["visium", "xenium", "merfish"]] = None,
) -> dict[str, Any]:
    """
    Validate that an AnnData object contains proper spatial data structure.

    Args:
        adata: AnnData object to validate
        require_counts: If True, verify layers["counts"] exists
        require_images: If True, verify uns["spatial"] contains images (Visium only)
        platform: If specified, check platform-specific requirements

    Returns:
        Validation report dict with keys:
            - valid: bool, True if all requirements met
            - errors: list of error messages (empty if valid)
            - warnings: list of warning messages
            - has_spatial_coords: bool
            - has_counts: bool
            - has_images: bool
            - coordinate_shape: tuple (n_obs, n_dims)
            - coordinate_range: dict with x/y min/max

    Does not raise exceptions - returns validation status in report.
    """
    errors = []
    warnings = []

    # Check spatial coordinates
    has_spatial_coords = OBSM_SPATIAL in adata.obsm
    if not has_spatial_coords:
        errors.append(
            f"Missing spatial coordinates in obsm['{OBSM_SPATIAL}']. "
            f"Available obsm keys: {list(adata.obsm.keys())}"
        )
        coord_shape = None
        coord_range = None
    else:
        spatial_coords = adata.obsm[OBSM_SPATIAL]
        coord_shape = spatial_coords.shape

        if spatial_coords.shape[1] != 2:
            errors.append(
                f"Spatial coordinates should have shape (n_obs, 2), "
                f"found {spatial_coords.shape}"
            )

        coord_range = {
            "x_min": float(np.min(spatial_coords[:, 0])),
            "x_max": float(np.max(spatial_coords[:, 0])),
            "y_min": float(np.min(spatial_coords[:, 1])),
            "y_max": float(np.max(spatial_coords[:, 1])),
        }

    # Check counts layer
    has_counts = LAYER_COUNTS in adata.layers
    if require_counts and not has_counts:
        errors.append(
            f"Missing required layer '{LAYER_COUNTS}'. "
            f"Available layers: {list(adata.layers.keys())}"
        )

    # Check images (Visium-specific)
    has_images = "spatial" in adata.uns
    if require_images and not has_images:
        errors.append(
            "Missing spatial images in uns['spatial']. "
            "Required for Visium data visualization."
        )

    # Platform-specific checks
    if platform == "visium":
        if "in_tissue" not in adata.obs.columns:
            warnings.append(
                "Missing 'in_tissue' column in obs. "
                "This is typically present in Visium data."
            )
        if not has_images:
            warnings.append(
                "No histology images found. "
                "Visium data typically includes tissue images in uns['spatial']."
            )

    elif platform == "xenium":
        # Xenium typically has nucleus/cell area measurements
        if not any(col.endswith("_area") for col in adata.obs.columns):
            warnings.append(
                "No area measurements found in obs. "
                "Xenium data typically includes nucleus_area, cell_area, etc."
            )

    elif platform == "merfish":
        # MERFISH-specific checks could go here
        pass

    report = {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "has_spatial_coords": has_spatial_coords,
        "has_counts": has_counts,
        "has_images": has_images,
        "coordinate_shape": coord_shape,
        "coordinate_range": coord_range,
    }

    return report


def main(args):
    """CLI entry for read_spatial subcommand."""
    import sys

    # Dispatch based on platform
    if args.platform == "visium":
        adata, report = load_visium(
            path=args.input,
            load_images=True,
        )
    elif args.platform == "xenium":
        adata, report = load_xenium(
            path=args.input,
            min_counts=0,
            min_genes=0,
        )
    elif args.platform == "merfish":
        # For MERFISH, args.input should be a directory with counts and metadata files
        adata, report = load_merfish(
            path=args.input,
            counts_file="counts.csv",
            metadata_file="cell_metadata.csv",
        )
    else:
        print(f"Error: Unknown platform '{args.platform}'", file=sys.stderr)
        sys.exit(1)

    # Save output
    adata.write_h5ad(args.output, compression='gzip')

    # Print summary
    print(f"Loaded {args.platform} data: {report['n_obs']} cells, {report['n_vars']} genes")
    print(f"Coordinate range: x=[{report['coordinate_range']['x_min']:.1f}, {report['coordinate_range']['x_max']:.1f}], "
          f"y=[{report['coordinate_range']['y_min']:.1f}, {report['coordinate_range']['y_max']:.1f}]")
    print(f"Saved to: {args.output}")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Load spatial transcriptomics data')
    parser.add_argument('--input', required=True, help='Path to spatial data directory')
    parser.add_argument('--output', required=True, help='Output h5ad file')
    parser.add_argument('--platform', required=True, choices=['visium', 'xenium', 'merfish'],
                        help='Spatial platform')
    args = parser.parse_args()
    main(args)
