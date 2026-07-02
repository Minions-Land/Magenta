#!/usr/bin/env python3
"""
Universal dataset loader - load ANY format into AnnData.

Design philosophy (Bitter Lesson):
- One atomic tool handles all formats via mature libraries (pandas/scanpy/anndata)
- LLM orchestrates parameters (transpose, column selection) instead of hardcoded logic
- Fail-loud with actionable hints when format is ambiguous

Supported formats:
- csv, tsv, txt → pandas → AnnData
- xlsx, xls → pandas (openpyxl/xlrd) → AnnData
- h5ad → anndata.read_h5ad (native)
- h5 → scanpy.read_10x_h5 (10x Genomics)
- mtx, mtx.gz → scanpy.read_10x_mtx (Matrix Market)
- loom → scanpy.read_loom
- zarr → scanpy.read_zarr

Output: always .h5ad for downstream compatibility
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import anndata as ad
import numpy as np
import pandas as pd
import scanpy as sc


def detect_format(path: Path) -> str:
    """Auto-detect file format from extension."""
    ext = path.suffix.lower()
    if path.name.endswith('.mtx.gz'):
        return 'mtx'

    format_map = {
        '.csv': 'csv',
        '.tsv': 'tsv',
        '.txt': 'txt',
        '.xlsx': 'excel',
        '.xls': 'excel',
        '.h5ad': 'h5ad',
        '.h5': 'h5',
        '.mtx': 'mtx',
        '.loom': 'loom',
        '.zarr': 'zarr',
    }

    return format_map.get(ext, 'unknown')


def load_tabular(
    path: Path,
    format: str,
    obs_names_col: int | str | None,
    var_names_col: int | str | None,
    transpose: bool,
    header: int | None,
    sep: str | None,
) -> ad.AnnData:
    """
    Load tabular data (csv/tsv/excel) into AnnData.

    Expected structure (default):
    - Rows = observations (cells)
    - Columns = variables (genes)
    - First column = cell/observation names
    - First row = gene/variable names

    If transpose=True:
    - Rows = genes, Columns = cells (will be transposed)
    """
    # Auto-detect separator for text files
    if sep is None:
        if format == 'tsv':
            sep = '\t'
        elif format == 'txt':
            # Try to detect from first line
            with open(path, 'r') as f:
                first_line = f.readline()
                sep = '\t' if '\t' in first_line else ','
        else:  # csv
            sep = ','

    # Load data
    if format == 'excel':
        try:
            df = pd.read_excel(path, index_col=obs_names_col, header=header)
        except Exception as e:
            raise ValueError(
                f"Failed to read Excel file: {e}\n"
                "Make sure openpyxl is declared in tools/omics-environment/pixi.toml, then run `pixi install -e <env>`"
            )
    else:
        df = pd.read_csv(path, sep=sep, index_col=obs_names_col, header=header)

    if df.empty:
        raise ValueError(
            f"Loaded DataFrame is empty. Check file format and delimiters.\n"
            f"Path: {path}\n"
            f"Format: {format}, separator: {repr(sep)}"
        )

    # Transpose if needed (genes as rows → cells as rows)
    if transpose:
        df = df.T

    # Convert to numeric (handle mixed types gracefully)
    # Some files have gene IDs as first column that should be index
    numeric_df = df.copy()
    for col in numeric_df.columns:
        try:
            numeric_df[col] = pd.to_numeric(numeric_df[col], errors='coerce')
        except Exception:
            pass

    # Check if conversion worked
    if numeric_df.select_dtypes(include=[np.number]).shape[1] == 0:
        raise ValueError(
            f"No numeric columns found after parsing.\n"
            f"DataFrame shape: {df.shape}\n"
            f"Sample data:\n{df.head()}\n"
            "Hint: Check if first row/column should be header/index (use --header/--obs-names-col)"
        )

    # Build AnnData
    X = numeric_df.values
    obs = pd.DataFrame(index=numeric_df.index)
    var = pd.DataFrame(index=numeric_df.columns)

    # Handle var_names if specified and different from default
    if var_names_col is not None and var_names_col != 0:
        # This is for when gene names are in a specific column rather than header
        # More complex logic needed - for now just document it
        pass

    adata = ad.AnnData(X=X, obs=obs, var=var)

    # Store raw counts in layers["counts"] (convention)
    adata.layers["counts"] = adata.X.copy()

    return adata


def load_h5ad(path: Path) -> ad.AnnData:
    """Load native h5ad file."""
    return ad.read_h5ad(path)


def load_10x_h5(path: Path) -> ad.AnnData:
    """Load 10x Genomics H5 file."""
    adata = sc.read_10x_h5(path)
    # Ensure counts layer exists
    if "counts" not in adata.layers:
        adata.layers["counts"] = adata.X.copy()
    return adata


def load_10x_mtx(path: Path) -> ad.AnnData:
    """Load 10x Genomics MTX directory (matrix.mtx + genes.tsv + barcodes.tsv)."""
    # If path is a .mtx file, use its parent directory
    if path.is_file():
        path = path.parent

    adata = sc.read_10x_mtx(path)
    # Ensure counts layer exists
    if "counts" not in adata.layers:
        adata.layers["counts"] = adata.X.copy()
    return adata


def load_loom(path: Path) -> ad.AnnData:
    """Load loom file."""
    adata = sc.read_loom(path)
    # Ensure counts layer exists
    if "counts" not in adata.layers:
        adata.layers["counts"] = adata.X.copy()
    return adata


def load_zarr(path: Path) -> ad.AnnData:
    """Load zarr store."""
    adata = sc.read_zarr(path)
    # Ensure counts layer exists
    if "counts" not in adata.layers:
        adata.layers["counts"] = adata.X.copy()
    return adata


def load_dataset(
    path: str,
    output: str,
    format: str = "auto",
    transpose: bool = False,
    obs_names_col: int | str | None = 0,
    var_names_col: int | str | None = None,
    header: int | None = 0,
    sep: str | None = None,
) -> dict[str, Any]:
    """
    Universal dataset loader.

    Args:
        path: Path to input file
        output: Path to output .h5ad file
        format: File format (auto/csv/tsv/excel/h5ad/h5/mtx/loom/zarr)
        transpose: If True, transpose matrix (genes as rows → cells as rows)
        obs_names_col: Column index/name for observation names (default: 0)
        var_names_col: Column index/name for variable names (default: header row)
        header: Row index for header (default: 0)
        sep: Column separator for text files (auto-detected if None)

    Returns:
        Report dict with file info and conversion stats
    """
    path = Path(path).resolve()
    output = Path(output).resolve()

    if not path.exists():
        raise FileNotFoundError(
            f"Input file not found: {path}\n"
            "Check that the file path is correct."
        )

    # Auto-detect format
    if format == "auto":
        format = detect_format(path)
        if format == "unknown":
            raise ValueError(
                f"Could not auto-detect format for: {path.name}\n"
                f"Please specify format explicitly with --format.\n"
                f"Supported: csv, tsv, excel, h5ad, h5, mtx, loom, zarr"
            )

    # Load based on format
    try:
        if format in ['csv', 'tsv', 'txt', 'excel']:
            adata = load_tabular(
                path,
                format=format,
                obs_names_col=obs_names_col,
                var_names_col=var_names_col,
                transpose=transpose,
                header=header,
                sep=sep,
            )
        elif format == 'h5ad':
            adata = load_h5ad(path)
        elif format == 'h5':
            adata = load_10x_h5(path)
        elif format == 'mtx':
            adata = load_10x_mtx(path)
        elif format == 'loom':
            adata = load_loom(path)
        elif format == 'zarr':
            adata = load_zarr(path)
        else:
            raise ValueError(
                f"Unsupported format: {format}\n"
                f"Supported: csv, tsv, txt, excel, h5ad, h5, mtx, loom, zarr"
            )
    except ValueError:
        # Deliberate validation errors (unsupported format, empty data) are already
        # actionable — let them propagate instead of masking them as a generic
        # RuntimeError.
        raise
    except Exception as e:
        raise RuntimeError(
            f"Failed to load {format} file: {e}\n"
            f"Path: {path}\n"
            f"Format: {format}\n"
            f"Transpose: {transpose}\n"
            "Check the file format and parameters."
        ) from e

    # Validate result
    if adata.n_obs == 0 or adata.n_vars == 0:
        raise ValueError(
            f"Loaded AnnData is empty: {adata.n_obs} obs × {adata.n_vars} vars\n"
            "Check if transpose is needed or if the file structure is correct."
        )

    # Save as h5ad
    output.parent.mkdir(parents=True, exist_ok=True)
    adata.write_h5ad(output, compression="gzip")

    # Build report
    report = {
        "success": True,
        "input_path": str(path),
        "output_path": str(output),
        "input_format": format,
        "n_obs": adata.n_obs,
        "n_vars": adata.n_vars,
        "obs_names_sample": list(adata.obs_names[:5]),
        "var_names_sample": list(adata.var_names[:5]),
        "layers": list(adata.layers.keys()),
        "obs_columns": list(adata.obs.columns),
        "var_columns": list(adata.var.columns),
        "transpose_applied": transpose,
        "size_bytes": output.stat().st_size,
    }

    return report


def main(args):
    """CLI entry point."""
    try:
        report = load_dataset(
            path=args.path,
            output=args.output,
            format=args.format,
            transpose=args.transpose,
            obs_names_col=args.obs_names_col,
            var_names_col=args.var_names_col,
            header=args.header,
            sep=args.sep,
        )

        # Print JSON report for Rust parsing
        print(json.dumps(report))
        sys.exit(0)
    except Exception as e:
        error_report = {
            "success": False,
            "error": str(e),
            "input_path": args.path,
        }
        print(json.dumps(error_report), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Universal dataset loader - convert ANY format to h5ad"
    )
    parser.add_argument("--path", required=True, help="Input file path")
    parser.add_argument("--output", required=True, help="Output .h5ad path")
    parser.add_argument(
        "--format",
        default="auto",
        choices=["auto", "csv", "tsv", "txt", "excel", "h5ad", "h5", "mtx", "loom", "zarr"],
        help="Input format (auto-detected if not specified)",
    )
    parser.add_argument(
        "--transpose",
        action="store_true",
        help="Transpose matrix (use if genes are rows instead of columns)",
    )
    parser.add_argument(
        "--obs-names-col",
        type=int,
        default=0,
        help="Column index for observation/cell names (0-based)",
    )
    parser.add_argument(
        "--var-names-col",
        type=int,
        default=None,
        help="Column index for variable/gene names (default: header row)",
    )
    parser.add_argument(
        "--header",
        type=int,
        default=0,
        help="Row index for header (default: 0, use None for no header)",
    )
    parser.add_argument(
        "--sep",
        type=str,
        default=None,
        help="Column separator for text files (auto-detected if not specified)",
    )

    args = parser.parse_args()
    main(args)
