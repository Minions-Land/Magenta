"""
MuData assembly for multiome (RNA + ATAC) datasets.

Handles:
- Loading paired RNA/ATAC modalities into MuData
- Fragment file integration for ATAC
- Quality metric computation across modalities
- Joint filtering on the MuData

Environment: sc-multiome (muon, scanpy)
"""

import json
import sys
from pathlib import Path
from typing import Optional

import muon as mu
import scanpy as sc


def load_multiome(
    rna_path: str,
    atac_path: str,
    fragments_path: Optional[str] = None,
    output_path: Optional[str] = None,
    min_genes: int = 200,
    min_peaks: int = 500,
    max_pct_mito: float = 20.0,
) -> dict:
    """
    Load paired RNA and ATAC modalities into a MuData object, then QC + filter
    on the MuData itself (MuData-first: assemble → intersect → joint filter).

    Args:
        rna_path: Path to RNA AnnData (.h5ad)
        atac_path: Path to ATAC AnnData (.h5ad)
        fragments_path: Optional path to fragments file (.tsv.gz) for ATAC
        output_path: Optional path to save assembled MuData (.h5mu)
        min_genes: Minimum genes per cell (RNA)
        min_peaks: Minimum peaks per cell (ATAC)
        max_pct_mito: Maximum mitochondrial percentage (RNA)

    Returns:
        dict with n_cells_{rna,atac,joint,filtered}, n_genes, n_peaks, mdata_path
    """
    rna = sc.read_h5ad(rna_path)
    atac = sc.read_h5ad(atac_path)
    n_cells_rna_orig = rna.n_obs
    n_cells_atac_orig = atac.n_obs

    if fragments_path:
        atac.uns["files"] = {"fragments": fragments_path}

    # Per-modality QC metrics (mt% on RNA, peak counts on ATAC)
    rna.var["mt"] = rna.var_names.str.startswith("MT-") | rna.var_names.str.startswith("mt-")
    sc.pp.calculate_qc_metrics(rna, qc_vars=["mt"], inplace=True)
    sc.pp.calculate_qc_metrics(atac, inplace=True)

    # Assemble the MuData first, then intersect to the shared cells (MuData-first).
    mdata = mu.MuData({"rna": rna, "atac": atac})
    mu.pp.intersect_obs(mdata)
    n_cells_joint = mdata.n_obs

    # Joint QC filter, applied to the MuData (propagates to both modalities).
    rna_keep = (mdata["rna"].obs["n_genes_by_counts"] >= min_genes) & (
        mdata["rna"].obs["pct_counts_mt"] <= max_pct_mito
    )
    atac_keep = mdata["atac"].obs["n_genes_by_counts"] >= min_peaks
    mu.pp.filter_obs(mdata, (rna_keep & atac_keep).to_numpy())
    n_cells_filtered = mdata.n_obs

    result = {
        "n_cells_rna": n_cells_rna_orig,
        "n_cells_atac": n_cells_atac_orig,
        "n_cells_joint": n_cells_joint,
        "n_cells_filtered": n_cells_filtered,
        "n_genes": mdata["rna"].n_vars,
        "n_peaks": mdata["atac"].n_vars,
    }

    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        mdata.write(output_path)
        result["mdata_path"] = output_path

    return result


def main(args):
    """CLI entry for the `load_multiome` subcommand (--rna / --atac / --output)."""
    result = load_multiome(
        rna_path=args.rna,
        atac_path=args.atac,
        output_path=args.output,
    )
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Load multiome RNA+ATAC into MuData")
    parser.add_argument("--rna", required=True, help="RNA AnnData path (.h5ad)")
    parser.add_argument("--atac", required=True, help="ATAC AnnData path (.h5ad)")
    parser.add_argument("--output", required=True, help="Output MuData path (.h5mu)")
    main(parser.parse_args())
