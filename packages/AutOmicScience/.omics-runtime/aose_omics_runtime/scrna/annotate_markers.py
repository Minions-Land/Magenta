"""
Reference-overlap evidence for marker-based cell type annotation (Route 1).

Provides annotate_markers(): a transparent, frozen helper that scores each
cluster's top markers against a caller-supplied reference database of known
cell-type markers and returns the per-cluster overlap as auditable EVIDENCE.

This is NOT an autonomous annotator and is NOT the annotation endpoint. Per the
locked two-route annotation architecture (see skills/omics/scrna/method/
annotation.md), Route 1 = "markers as evidence -> LLM/expert biological
judgment". Black-box automated classifiers (CellTypist, scANVI, popV, scArches)
are deliberately excluded. Accordingly this helper:
  * computes only a deterministic, fully-inspectable overlap score (no model);
  * writes its calls to a SUGGESTION key (`cell_type_suggestion`), never the
    final `cell_type` key, so it cannot silently become the answer;
  * exists to FEED the Route-1 LLM/expert judgment and the "Validate" step
    (quantitative cross-check against canonical markers), not to replace it.
The final `cell_type` label is written only after LLM/expert judgment.
"""

from typing import Optional, Literal
from datetime import datetime, UTC
import pandas as pd
import scanpy as sc
from anndata import AnnData

from ..shared.conventions import OBS_LEIDEN, OBS_CELLTYPE

# Module-top constants
DEFAULT_TOP_N_MARKERS = 10
DEFAULT_MIN_SCORE = 0.5
DEFAULT_MIN_OVERLAP = 3
# Suggestions land on a derived, clearly-non-final key so the helper can never
# silently occupy the locked `cell_type` endpoint (Route-1 boundary). Derived
# from OBS_CELLTYPE rather than hard-coded, keeping the single source of truth.
DEFAULT_SUGGESTION_KEY = f"{OBS_CELLTYPE}_suggestion"


def annotate_markers(
    adata: AnnData,
    markers: pd.DataFrame,
    reference_db: dict[str, list[str]],
    *,
    cluster_key: str = OBS_LEIDEN,
    target_key: str = DEFAULT_SUGGESTION_KEY,
    top_n: int = DEFAULT_TOP_N_MARKERS,
    min_score: float = DEFAULT_MIN_SCORE,
    min_overlap: int = DEFAULT_MIN_OVERLAP,
    return_report: bool = True,
) -> tuple[AnnData, Optional[dict]]:
    """
    Score cluster markers against a reference DB and emit per-cluster overlap
    EVIDENCE (Route-1 helper, not an autonomous annotator).

    Compares each cluster's top marker genes against a caller-supplied reference
    database of known cell-type markers and records the overlap as a suggestion
    plus an auditable score breakdown. The result is *evidence for* the Route-1
    LLM/expert judgment and the "Validate" cross-check — NOT the final label.

    Parameters
    ----------
    adata : AnnData
        Annotated data matrix (modified in-place to add the suggestion column)
    markers : pd.DataFrame
        Marker table from marker_table() with columns: group, names, scores, ...
    reference_db : dict
        Mapping from cell type name to list of marker genes. Supplied by the
        caller (transparent, inspectable) — there is no built-in model.
        Example: {"T cell": ["CD3D", "CD3E", "CD8A"], "B cell": ["CD79A", "MS4A1"]}
    cluster_key : str, default=OBS_LEIDEN
        Key in adata.obs containing cluster labels
    target_key : str, default=DEFAULT_SUGGESTION_KEY ("cell_type_suggestion")
        Key in adata.obs to store the SUGGESTED cell types. Defaults to the
        non-final suggestion key so this helper never silently occupies the
        locked `cell_type` endpoint; the final `cell_type` is written only after
        LLM/expert judgment. A caller may override, but doing so is an explicit,
        auditable choice at the call site.
    top_n : int, default=10
        Number of top markers per cluster to consider
    min_score : float, default=0.5
        Minimum overlap score (0-1) to emit a (non-Unknown) suggestion
    min_overlap : int, default=3
        Minimum number of overlapping genes required
    return_report : bool, default=True
        Whether to return detailed report dict

    Returns
    -------
    adata : AnnData
        Input AnnData with suggested cell types added to obs[target_key]
    report : dict or None
        Structured report with overlap evidence per cluster (if return_report=True)

    Raises
    ------
    KeyError
        If cluster_key not found in adata.obs
    ValueError
        If markers DataFrame is invalid or reference_db is empty

    Notes
    -----
    Overlap score is computed as:
        score = len(cluster_markers ∩ celltype_markers) / min(len(cluster_markers), len(celltype_markers))

    Clusters with no confident match (score < min_score or overlap < min_overlap)
    are suggested as "Unknown". The agent/LLM remains free to override any
    suggestion using the full marker evidence and dataset context.
    """
    start_time = datetime.now(UTC)

    # Validate inputs
    if cluster_key not in adata.obs.columns:
        raise KeyError(
            f"Cluster key '{cluster_key}' not found in obs. "
            f"Available columns: {list(adata.obs.columns)}"
        )

    if not isinstance(reference_db, dict) or len(reference_db) == 0:
        raise ValueError(
            "reference_db must be a non-empty dict mapping cell type names to marker gene lists"
        )

    if 'group' not in markers.columns or 'names' not in markers.columns:
        raise ValueError(
            "markers DataFrame must have 'group' and 'names' columns. "
            f"Available columns: {list(markers.columns)}"
        )

    # Normalize reference DB gene names (uppercase for matching)
    reference_db_normalized = {
        celltype: [g.upper() for g in genes]
        for celltype, genes in reference_db.items()
    }

    # Build cluster-to-celltype mapping
    cluster_to_celltype = {}
    annotation_details = {}

    for cluster in markers['group'].unique():
        # Get top N markers for this cluster
        cluster_markers = markers[markers['group'] == cluster].head(top_n)
        cluster_genes = set(cluster_markers['names'].str.upper().tolist())

        # Compute overlap with each cell type
        best_celltype = None
        best_score = 0.0
        best_overlap = 0
        all_scores = {}

        for celltype, ref_genes in reference_db_normalized.items():
            ref_genes_set = set(ref_genes)
            overlap = cluster_genes & ref_genes_set
            n_overlap = len(overlap)

            # Jaccard-like score normalized by min set size
            denominator = min(len(cluster_genes), len(ref_genes_set))
            score = n_overlap / denominator if denominator > 0 else 0.0

            all_scores[celltype] = {
                "score": score,
                "n_overlap": n_overlap,
                "overlapping_genes": sorted(overlap),
            }

            if score > best_score and n_overlap >= min_overlap:
                best_score = score
                best_overlap = n_overlap
                best_celltype = celltype

        # Assign cell type if confidence threshold met
        if best_celltype and best_score >= min_score:
            cluster_to_celltype[cluster] = best_celltype
        else:
            cluster_to_celltype[cluster] = "Unknown"

        annotation_details[str(cluster)] = {
            "assigned_celltype": cluster_to_celltype[cluster],
            "best_score": best_score,
            "best_overlap": best_overlap,
            "all_scores": all_scores,
            "top_markers": cluster_markers['names'].tolist()[:5],
        }

    # Apply suggestions to adata (a non-final suggestion column by default;
    # the locked `cell_type` endpoint is written only after LLM/expert judgment).
    adata.obs[target_key] = adata.obs[cluster_key].map(cluster_to_celltype).astype('category')

    end_time = datetime.now(UTC)

    # Count assigned vs unknown
    n_unknown = (adata.obs[target_key] == "Unknown").sum()
    n_annotated = len(adata) - n_unknown

    if return_report:
        report = {
            "operation": "annotate_markers",
            # Route-1 boundary: this is reference-overlap EVIDENCE feeding
            # LLM/expert judgment, not an autonomous annotation endpoint.
            "role": "route1_overlap_evidence",
            "is_final": False,
            "n_clusters": len(cluster_to_celltype),
            "n_celltypes_in_reference": len(reference_db),
            "n_celltypes_assigned": len(set(cluster_to_celltype.values()) - {"Unknown"}),
            "parameters": {
                "cluster_key": cluster_key,
                "target_key": target_key,
                "top_n": top_n,
                "min_score": min_score,
                "min_overlap": min_overlap,
            },
            "cluster_to_celltype": cluster_to_celltype,
            "annotation_details": annotation_details,
            "n_cells_annotated": int(n_annotated),
            "n_cells_unknown": int(n_unknown),
            "celltype_counts": adata.obs[target_key].value_counts().to_dict(),
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "duration_seconds": (end_time - start_time).total_seconds(),
        }
        return adata, report
    else:
        return adata, None


def format_annotation_summary(report: dict) -> str:
    """
    Format annotation report as human-readable text summary.

    Parameters
    ----------
    report : dict
        Output from annotate_markers()

    Returns
    -------
    str
        Formatted text summary
    """
    lines = []
    lines.append("Cell Type Suggestion Summary (Route-1 overlap evidence — not final):")
    lines.append("")
    lines.append(f"  Total clusters: {report['n_clusters']}")
    lines.append(f"  Cell types suggested: {report['n_celltypes_assigned']}")
    lines.append(f"  Cells with a suggestion: {report['n_cells_annotated']}")
    lines.append(f"  Cells unknown: {report['n_cells_unknown']}")
    lines.append("")
    lines.append("Per-cluster overlap suggestions (for LLM/expert review):")

    for cluster, details in sorted(report['annotation_details'].items()):
        celltype = details['assigned_celltype']
        score = details['best_score']
        overlap = details['best_overlap']
        top_markers = ", ".join(details['top_markers'])

        if celltype == "Unknown":
            lines.append(f"  Cluster {cluster}: Unknown (score={score:.2f}, overlap={overlap})")
        else:
            lines.append(
                f"  Cluster {cluster}: {celltype} "
                f"(score={score:.2f}, overlap={overlap}, markers: {top_markers})"
            )

    return "\n".join(lines)


# Common reference databases for human tissue
HUMAN_PBMC_REFERENCE = {
    "T cell": ["CD3D", "CD3E", "CD3G", "CD8A", "CD8B", "CD4", "IL7R"],
    "CD8+ T cell": ["CD8A", "CD8B", "CD3D", "CD3E"],
    "CD4+ T cell": ["CD4", "IL7R", "CD3D", "CD3E"],
    "NK cell": ["GNLY", "NKG7", "GZMA", "GZMB", "KLRD1", "KLRF1"],
    "B cell": ["CD79A", "CD79B", "MS4A1", "CD19"],
    "Monocyte": ["CD14", "LYZ", "S100A8", "S100A9", "FCGR3A"],
    "CD14+ Monocyte": ["CD14", "LYZ", "S100A8", "S100A9"],
    "CD16+ Monocyte": ["FCGR3A", "MS4A7", "CD14"],
    "Dendritic cell": ["FCER1A", "CST3", "CLEC10A"],
    "Platelet": ["PPBP", "PF4", "GP9"],
}

HUMAN_BRAIN_REFERENCE = {
    "Excitatory neuron": ["SLC17A7", "NEUROD6", "SATB2", "TBR1"],
    "Inhibitory neuron": ["GAD1", "GAD2", "SLC32A1", "DLX1"],
    "Oligodendrocyte": ["MBP", "MOG", "PLP1", "MAG"],
    "OPC": ["PDGFRA", "CSPG4", "VCAN"],
    "Astrocyte": ["AQP4", "GFAP", "SLC1A2", "SLC1A3"],
    "Microglia": ["C1QA", "C1QB", "CSF1R", "CX3CR1"],
    "Endothelial": ["CLDN5", "FLT1", "VWF"],
}

MOUSE_BRAIN_REFERENCE = {
    "Excitatory neuron": ["Slc17a7", "Neurod6", "Satb2", "Tbr1"],
    "Inhibitory neuron": ["Gad1", "Gad2", "Slc32a1", "Dlx1"],
    "Oligodendrocyte": ["Mbp", "Mog", "Plp1", "Mag"],
    "OPC": ["Pdgfra", "Cspg4", "Vcan"],
    "Astrocyte": ["Aqp4", "Gfap", "Slc1a2", "Slc1a3"],
    "Microglia": ["C1qa", "C1qb", "Csf1r", "Cx3cr1"],
    "Endothelial": ["Cldn5", "Flt1", "Vwf"],
}


def main(args):
    """Not a standalone CLI subcommand. `annotate_markers()` requires a marker
    DataFrame + a reference marker DB (dict[cell_type -> gene list]) that a bare
    --input/--output CLI cannot supply, so it is intentionally not registered in
    __main__.py. Use the `annotate_markers()` function directly (it is the frozen
    helper the agent calls). Fail loud rather than fake a no-op success."""
    import sys

    print(
        "annotate_markers is a library helper, not a CLI subcommand: call "
        "annotate_markers(adata, markers, reference_db, ...) directly "
        "(needs a marker table + reference DB the CLI cannot provide).",
        file=sys.stderr,
    )
    sys.exit(1)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    main(parser.parse_args())
